use anyhow::{bail, Context as _};
use clap::Parser;
use observation_core::{
    DropPoint, ExperimentEnvironment, ExperimentRun, ServiceHealthSummary, StreamEvent,
    SweepPlan, XdpAttachMode,
};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::io::Write as _;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UdpSocket};

const NFT_FAMILY: &str = "inet";
const NFT_TABLE: &str = "packet_journey";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
const UDP_DRAIN_TIME: Duration = Duration::from_millis(100);
const HEALTH_DRAIN_TIME: Duration = Duration::from_secs(2);

#[derive(Debug, Parser)]
struct Opt {
    /// Pi Aで動くtraffic-nodeの制御API。
    #[arg(long, default_value = "192.168.1.11:9030")]
    traffic_control: String,
    /// Pi Bで動くxdp-helloの制御API。
    #[arg(long, default_value = "127.0.0.1:9020")]
    xdp_control: String,
    /// observation-hubのイベント受信先。
    #[arg(long, default_value = "127.0.0.1:9001")]
    hub: String,
    /// userspaceまで届いたpacketを数えるUDP socket。
    #[arg(long, default_value = "0.0.0.0:4000")]
    udp_listen: String,
    /// 1条件の計測時間。
    #[arg(long, default_value_t = 10)]
    duration_secs: u64,
    /// 条件切替後、計測開始まで待つ時間。
    #[arg(long, default_value_t = 1)]
    settle_secs: u64,
    /// 条件ごとの反復回数。
    #[arg(long, default_value_t = 3)]
    repetitions: u16,
    /// サービス維持限界を探すUDP負荷の段階（pps、カンマ区切り）。
    #[arg(long, default_value = "500,2000,5000,10000,20000,50000")]
    pps_steps: String,
    /// HTTP probe成功率がこの値以上ならサービス維持と判定する。
    #[arg(long, default_value_t = 99.0)]
    service_min_success_percent: f32,
    /// HTTP p95 latencyがこの値以下ならサービス維持と判定する。
    #[arg(long, default_value_t = 100)]
    service_max_p95_ms: u64,
    /// 目標ppsのうち、実際に送れた割合がこの値未満なら測定未成立とする。
    #[arg(long, default_value_t = 90)]
    min_load_delivery_percent: u8,
    /// nftablesで遮断するUDP宛先port。
    #[arg(long, default_value_t = 4000)]
    udp_port: u16,
    /// Pi Bで実験対象にしているnetwork interface。
    #[arg(long, default_value = "eth0")]
    interface: String,
}

#[derive(Debug, Clone, Copy)]
struct CpuSnapshot {
    total: u64,
    idle: u64,
}

#[derive(Debug)]
struct TrafficStatus {
    packets_sent: u64,
    target_pps: u64,
    payload_bytes: u32,
    health_checks: u64,
    health_successes: u64,
    health_latency_p95_ms: u64,
    health_latency_max_ms: u64,
}

struct NftGuard;

impl NftGuard {
    fn disable() -> anyhow::Result<()> {
        let output = match Command::new("nft")
            .args(["delete", "table", NFT_FAMILY, NFT_TABLE])
            .output()
        {
            Ok(output) => output,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).context("failed to execute nft cleanup"),
        };
        if output.status.success() || stderr_says_missing(&output.stderr) {
            return Ok(());
        }
        bail!("failed to remove experiment nft table: {}", String::from_utf8_lossy(&output.stderr));
    }

    fn enable(udp_port: u16) -> anyhow::Result<()> {
        Self::disable()?;
        let script = format!(
            "add table {NFT_FAMILY} {NFT_TABLE}\n\
             add chain {NFT_FAMILY} {NFT_TABLE} input {{ type filter hook input priority 0; policy accept; }}\n\
             add rule {NFT_FAMILY} {NFT_TABLE} input udp dport {udp_port} drop\n"
        );
        run_nft_script(&script)
    }
}

impl Drop for NftGuard {
    fn drop(&mut self) {
        let _ = Self::disable();
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let opt = Opt::parse();
    if opt.duration_secs == 0
        || opt.repetitions == 0
        || opt.service_max_p95_ms == 0
        || !(1..=100).contains(&opt.min_load_delivery_percent)
        || !opt.service_min_success_percent.is_finite()
        || !(0.0..=100.0).contains(&opt.service_min_success_percent)
    {
        bail!("duration, repetitions, and service thresholds must be valid");
    }
    let pps_steps = parse_pps_steps(&opt.pps_steps)?;
    let sweep = SweepPlan {
        pps_steps: pps_steps.clone(),
        repetitions: opt.repetitions,
        min_load_delivery_percent: opt.min_load_delivery_percent,
    };

    let received = Arc::new(AtomicU64::new(0));
    let sink_failed = Arc::new(AtomicBool::new(false));
    spawn_udp_sink(&opt.udp_listen, received.clone(), sink_failed.clone()).await?;
    let _nft_guard = NftGuard;
    let environment = read_experiment_environment(&opt.interface);
    let experiment_id = format!(
        "service-limit-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );

    println!("Packet Poipoi service-limit experiment: {experiment_id}");
    println!(
        "rates={pps_steps:?}, three drop points, {}s × {} repetitions",
        opt.duration_secs, opt.repetitions,
    );
    println!(
        "service maintained = success >= {:.1}% and p95 <= {}ms",
        opt.service_min_success_percent, opt.service_max_p95_ms,
    );
    println!(
        "load measurement valid = actual rate >= {}% of target",
        opt.min_load_delivery_percent,
    );

    let experiment_result: anyhow::Result<()> = async {
        for repetition in 1..=opt.repetitions {
            for target_pps in rate_order(&pps_steps, repetition) {
                for drop_point in condition_order(repetition) {
                    let run = run_condition(
                        &opt,
                        &experiment_id,
                        repetition,
                        drop_point,
                        target_pps,
                        &received,
                        &sink_failed,
                        &environment,
                        &sweep,
                    )
                    .await?;
                    run.validate()
                        .map_err(|error| anyhow::anyhow!("invalid experiment result: {error:?}"))?;
                    publish_run(&opt.hub, &run).await?;
                    let health = run
                        .service_health
                        .as_ref()
                        .context("sweep result is missing service health")?;
                    println!(
                        "{} target={:>6}pps actual={:>7.0}pps ({:>5.1}%) r{}: HTTP={:.1}% p95={}ms maintained={} load_valid={} cpu={:.1}% NET_RX={}",
                        drop_point.as_str(),
                        target_pps,
                        run.actual_pps(),
                        run.load_delivery_percent(),
                        repetition,
                        health.success_percent(),
                        health.latency_p95_ms,
                        health.service_maintained(),
                        run.load_rate_achieved(),
                        run.cpu_busy_percent,
                        run.net_rx_softirq_delta
                    );
                }
            }
        }
        Ok(())
    }
    .await;

    let nft_cleanup = NftGuard::disable();
    let xdp_cleanup = set_xdp_mode(&opt.xdp_control, "monitor").await;
    let traffic_cleanup = traffic_command(&opt.traffic_control, "stop").await;
    if let Err(error) = &nft_cleanup {
        eprintln!("nft cleanup failed: {error}");
    }
    if let Err(error) = &xdp_cleanup {
        eprintln!("XDP cleanup failed: {error}");
    }
    if let Err(error) = &traffic_cleanup {
        eprintln!("traffic cleanup failed: {error}");
    }
    experiment_result?;
    nft_cleanup?;
    xdp_cleanup.context("failed to restore XDP monitor mode")?;
    traffic_cleanup.context("failed to stop traffic generator")?;
    println!("completed: {experiment_id}");
    Ok(())
}

fn condition_order(repetition: u16) -> [DropPoint; 3] {
    let mut order = DropPoint::ALL;
    let rotation = usize::from(repetition.saturating_sub(1)) % order.len();
    order.rotate_left(rotation);
    order
}

fn rate_order(pps_steps: &[u64], repetition: u16) -> Vec<u64> {
    let mut order = pps_steps.to_vec();
    if repetition % 2 == 0 {
        order.reverse();
    }
    order
}

fn parse_pps_steps(value: &str) -> anyhow::Result<Vec<u64>> {
    let steps = value
        .split(',')
        .map(str::trim)
        .map(|part| {
            part.parse::<u64>()
                .with_context(|| format!("invalid pps step: {part}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    if steps.is_empty()
        || steps.iter().any(|step| !(1..=100_000).contains(step))
        || steps.windows(2).any(|pair| pair[0] >= pair[1])
    {
        bail!("pps-steps must be strictly increasing values between 1 and 100000");
    }
    Ok(steps)
}

async fn run_condition(
    opt: &Opt,
    experiment_id: &str,
    repetition: u16,
    drop_point: DropPoint,
    target_pps: u64,
    received: &AtomicU64,
    sink_failed: &AtomicBool,
    environment: &ExperimentEnvironment,
    sweep: &SweepPlan,
) -> anyhow::Result<ExperimentRun> {
    if sink_failed.load(Ordering::Relaxed) {
        bail!("userspace UDP sink is not running");
    }
    let attach_mode = configure_drop_point(opt, drop_point).await?;
    tokio::time::sleep(Duration::from_secs(opt.settle_secs)).await;

    let app_before = received.load(Ordering::Relaxed);
    let cpu_before = read_cpu_snapshot()?;
    let softirq_before = read_net_rx_softirq()?;

    let traffic_before = start_traffic(&opt.traffic_control, target_pps).await?;
    let measurement_started = Instant::now();
    tokio::time::sleep(Duration::from_secs(opt.duration_secs)).await;
    traffic_command(&opt.traffic_control, "stop").await?;
    let duration_ms =
        u64::try_from(measurement_started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let cpu_after = read_cpu_snapshot()?;
    let softirq_after = read_net_rx_softirq()?;
    // stop直前に開始したtimeout probeが同じrunへ集計されるのを待つ。
    // traffic-nodeは停止後に始まったprobeをwindowへ記録しない。
    tokio::time::sleep(HEALTH_DRAIN_TIME).await;
    let traffic_after = traffic_command(&opt.traffic_control, "status").await?;
    tokio::time::sleep(UDP_DRAIN_TIME).await;
    if sink_failed.load(Ordering::Relaxed) {
        bail!("userspace UDP sink failed during the experiment");
    }
    let app_after = received.load(Ordering::Relaxed);
    let run_id = format!(
        "{experiment_id}-{}-{target_pps}pps-r{repetition}",
        drop_point.as_str(),
    );

    let service_health = ServiceHealthSummary {
        checks: traffic_after.health_checks,
        successes: traffic_after.health_successes,
        latency_p95_ms: traffic_after.health_latency_p95_ms,
        latency_max_ms: traffic_after.health_latency_max_ms,
        min_success_percent: opt.service_min_success_percent,
        max_p95_latency_ms: opt.service_max_p95_ms,
    };

    Ok(ExperimentRun {
        experiment_id: experiment_id.to_string(),
        run_id,
        repetition,
        drop_point,
        duration_ms,
        target_pps,
        payload_bytes: traffic_before.payload_bytes,
        packets_sent: traffic_after
            .packets_sent
            .saturating_sub(traffic_before.packets_sent),
        packets_received_by_app: app_after.saturating_sub(app_before),
        cpu_busy_percent: cpu_busy_percent(cpu_before, cpu_after),
        net_rx_softirq_delta: softirq_after.saturating_sub(softirq_before),
        xdp_attach_mode: attach_mode,
        environment: environment.clone(),
        service_health: Some(service_health),
        sweep: Some(sweep.clone()),
    })
}

fn read_experiment_environment(interface: &str) -> ExperimentEnvironment {
    ExperimentEnvironment {
        receiver_model: read_trimmed("/sys/firmware/devicetree/base/model"),
        kernel_release: read_trimmed("/proc/sys/kernel/osrelease"),
        network_interface: interface.to_string(),
        mtu: read_trimmed(&format!("/sys/class/net/{interface}/mtu"))
            .parse::<u32>()
            .ok(),
        cpu_governor: read_trimmed(
            "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
        ),
    }
}

fn read_trimmed(path: &str) -> String {
    fs::read_to_string(path)
        .map(|value| {
            value
                .trim_matches(|character: char| {
                    character == '\0' || character.is_whitespace()
                })
                .to_string()
        })
        .unwrap_or_else(|_| "unknown".to_string())
}

async fn configure_drop_point(opt: &Opt, drop_point: DropPoint) -> anyhow::Result<XdpAttachMode> {
    match drop_point {
        DropPoint::Application => {
            NftGuard::disable()?;
            set_xdp_mode(&opt.xdp_control, "monitor").await
        }
        DropPoint::Netfilter => {
            set_xdp_mode(&opt.xdp_control, "monitor").await?;
            NftGuard::enable(opt.udp_port)?;
            Ok(XdpAttachMode::NotUsed)
        }
        DropPoint::Xdp => {
            NftGuard::disable()?;
            set_xdp_mode(&opt.xdp_control, "protect").await
        }
    }
}

async fn spawn_udp_sink(
    listen: &str,
    received: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let socket = UdpSocket::bind(listen)
        .await
        .with_context(|| format!("failed to bind userspace UDP sink on {listen}"))?;
    println!("userspace UDP sink listening on {listen}");
    tokio::spawn(async move {
        let mut buffer = [0_u8; 2048];
        loop {
            match socket.recv_from(&mut buffer).await {
                Ok(_) => {
                    received.fetch_add(1, Ordering::Relaxed);
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::Interrupted | ErrorKind::WouldBlock) =>
                {
                    eprintln!("transient UDP sink receive error: {error}");
                    continue;
                }
                Err(error) => {
                    eprintln!("UDP sink receive failed: {error}");
                    failed.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    });
    Ok(())
}

async fn traffic_command(target: &str, command: &str) -> anyhow::Result<TrafficStatus> {
    let value = request_json(target, json!({ "command": command })).await?;
    parse_traffic_status(command, &value)
}

async fn start_traffic(target: &str, target_pps: u64) -> anyhow::Result<TrafficStatus> {
    let value = request_json(
        target,
        json!({
            "command": "start",
            "target_pps": target_pps,
            "reset_health": true,
        }),
    )
    .await?;
    let status = parse_traffic_status("start", &value)?;
    if status.target_pps != target_pps {
        bail!(
            "traffic-node accepted an unexpected rate: requested={target_pps}, actual={}",
            status.target_pps
        );
    }
    Ok(status)
}

fn parse_traffic_status(command: &str, value: &Value) -> anyhow::Result<TrafficStatus> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!("traffic-node rejected {command}: {value}");
    }
    Ok(TrafficStatus {
        packets_sent: required_u64(&value, "packets_sent")?,
        target_pps: required_u64(&value, "target_pps")?,
        payload_bytes: u32::try_from(required_u64(&value, "payload_bytes")?)
            .context("payload_bytes does not fit in u32")?,
        health_checks: required_u64(value, "health_checks")?,
        health_successes: required_u64(value, "health_successes")?,
        health_latency_p95_ms: required_u64(value, "health_latency_p95_ms")?,
        health_latency_max_ms: required_u64(value, "health_latency_max_ms")?,
    })
}

async fn set_xdp_mode(target: &str, mode: &str) -> anyhow::Result<XdpAttachMode> {
    let value = request_json(target, json!({ "mode": mode })).await?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!("xdp-hello rejected {mode}: {value}");
    }
    if mode != "protect" {
        return Ok(XdpAttachMode::NotUsed);
    }
    Ok(match value.get("attach_mode").and_then(Value::as_str) {
        Some("native") => XdpAttachMode::Native,
        Some("generic") => XdpAttachMode::Generic,
        _ => XdpAttachMode::Unknown,
    })
}

async fn request_json(target: &str, request: Value) -> anyhow::Result<Value> {
    let operation = async {
        let mut stream = TcpStream::connect(target)
            .await
            .with_context(|| format!("failed to connect to {target}"))?;
        stream.write_all(request.to_string().as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).await?;
        serde_json::from_str(response.trim()).context("control API returned invalid JSON")
    };
    tokio::time::timeout(CONTROL_TIMEOUT, operation)
        .await
        .with_context(|| format!("control API timed out after 3s: {target}"))?
}

async fn publish_run(target: &str, run: &ExperimentRun) -> anyhow::Result<()> {
    let line = StreamEvent::ExperimentRun(run.clone()).to_json_line();
    let operation = async {
        let mut stream = TcpStream::connect(target)
            .await
            .with_context(|| format!("failed to connect to observation hub {target}"))?;
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        Ok(())
    };
    tokio::time::timeout(CONTROL_TIMEOUT, operation)
        .await
        .with_context(|| format!("observation hub timed out after 3s: {target}"))?
}

fn read_cpu_snapshot() -> anyhow::Result<CpuSnapshot> {
    let stat = fs::read_to_string("/proc/stat").context("failed to read /proc/stat")?;
    parse_cpu_snapshot(&stat).context("failed to parse aggregate CPU counters")
}

fn parse_cpu_snapshot(stat: &str) -> Option<CpuSnapshot> {
    let fields: Vec<u64> = stat
        .lines()
        .next()?
        .split_whitespace()
        .skip(1)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if fields.len() < 5 {
        return None;
    }
    Some(CpuSnapshot {
        // /proc/statのguestとguest_niceはuser/niceへ既に含まれるため二重加算しない。
        total: fields.iter().take(8).copied().sum(),
        idle: fields[3].saturating_add(fields[4]),
    })
}

fn cpu_busy_percent(before: CpuSnapshot, after: CpuSnapshot) -> f32 {
    let total = after.total.saturating_sub(before.total);
    if total == 0 {
        return 0.0;
    }
    let idle = after.idle.saturating_sub(before.idle);
    (total.saturating_sub(idle) as f32 * 100.0 / total as f32).clamp(0.0, 100.0)
}

fn read_net_rx_softirq() -> anyhow::Result<u64> {
    let softirqs =
        fs::read_to_string("/proc/softirqs").context("failed to read /proc/softirqs")?;
    parse_net_rx_softirq(&softirqs).context("NET_RX row was missing from /proc/softirqs")
}

fn parse_net_rx_softirq(softirqs: &str) -> Option<u64> {
    let row = softirqs.lines().find(|line| line.trim_start().starts_with("NET_RX:"))?;
    row.split_whitespace()
        .skip(1)
        .map(str::parse::<u64>)
        .try_fold(0_u64, |total, value| value.ok().map(|value| total.saturating_add(value)))
}

fn run_nft_script(script: &str) -> anyhow::Result<()> {
    let mut child = Command::new("nft")
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("nft command is required for the netfilter condition")?;
    child
        .stdin
        .as_mut()
        .context("failed to open nft stdin")?
        .write_all(script.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!("failed to install experiment nft table: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}

fn stderr_says_missing(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    stderr.contains("No such file") || stderr.contains("does not exist")
}

fn required_u64(value: &Value, field: &'static str) -> anyhow::Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .with_context(|| format!("control response is missing {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_cpu_counters() {
        let snapshot =
            parse_cpu_snapshot("cpu  10 2 3 40 5 0 0 0 100 50\ncpu0 1 1 1 1").unwrap();
        assert_eq!(snapshot.total, 60);
        assert_eq!(snapshot.idle, 45);
    }

    #[test]
    fn computes_busy_cpu_from_counter_deltas() {
        let before = CpuSnapshot { total: 100, idle: 70 };
        let after = CpuSnapshot { total: 200, idle: 110 };
        assert_eq!(cpu_busy_percent(before, after), 60.0);
    }

    #[test]
    fn sums_net_rx_across_cpus() {
        let sample = "                    CPU0       CPU1\nNET_RX:             10         25\n";
        assert_eq!(parse_net_rx_softirq(sample), Some(35));
    }

    #[test]
    fn rotates_condition_order_between_repetitions() {
        assert_eq!(
            condition_order(1),
            [DropPoint::Application, DropPoint::Netfilter, DropPoint::Xdp]
        );
        assert_eq!(
            condition_order(2),
            [DropPoint::Netfilter, DropPoint::Xdp, DropPoint::Application]
        );
        assert_eq!(
            condition_order(3),
            [DropPoint::Xdp, DropPoint::Application, DropPoint::Netfilter]
        );
    }

    #[test]
    fn alternates_rate_direction_between_repetitions() {
        let steps = [500, 2_000, 5_000];
        assert_eq!(rate_order(&steps, 1), vec![500, 2_000, 5_000]);
        assert_eq!(rate_order(&steps, 2), vec![5_000, 2_000, 500]);
    }

    #[test]
    fn accepts_only_increasing_rate_steps() {
        assert_eq!(
            parse_pps_steps("500, 2000,5000").unwrap(),
            vec![500, 2_000, 5_000]
        );
        assert!(parse_pps_steps("500,500").is_err());
        assert!(parse_pps_steps("0,500").is_err());
        assert!(parse_pps_steps("500,100001").is_err());
    }

    #[test]
    fn trims_device_tree_null_terminator() {
        let value = "Raspberry Pi 5 Model B Rev 1.0\0\n";
        assert_eq!(
            value.trim_matches(|character: char| {
                character == '\0' || character.is_whitespace()
            }),
            "Raspberry Pi 5 Model B Rev 1.0"
        );
    }
}
