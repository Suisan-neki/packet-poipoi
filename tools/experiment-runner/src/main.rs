use anyhow::{bail, Context as _};
use clap::Parser;
use observation_core::{DropPoint, ExperimentRun, XdpAttachMode};
use serde_json::{json, Value};
use std::fs;
use std::io::Write as _;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UdpSocket};

const NFT_FAMILY: &str = "inet";
const NFT_TABLE: &str = "packet_journey";

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
    #[arg(long, default_value_t = 15)]
    duration_secs: u64,
    /// 条件切替後、計測開始まで待つ時間。
    #[arg(long, default_value_t = 2)]
    settle_secs: u64,
    /// 条件ごとの反復回数。
    #[arg(long, default_value_t = 3)]
    repetitions: u16,
    /// nftablesで遮断するUDP宛先port。
    #[arg(long, default_value_t = 4000)]
    udp_port: u16,
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
}

struct NftGuard;

impl NftGuard {
    fn disable() -> anyhow::Result<()> {
        let output = Command::new("nft")
            .args(["delete", "table", NFT_FAMILY, NFT_TABLE])
            .output()
            .context("nft command is required for the netfilter condition")?;
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
    if opt.duration_secs == 0 || opt.repetitions == 0 {
        bail!("duration-secs and repetitions must be greater than zero");
    }

    let received = Arc::new(AtomicU64::new(0));
    spawn_udp_sink(&opt.udp_listen, received.clone()).await?;
    let _nft_guard = NftGuard;
    let experiment_id = format!(
        "drop-point-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );

    println!("Packet Journey drop-point experiment: {experiment_id}");
    println!(
        "same input, three drop points, {}s × {} repetitions",
        opt.duration_secs, opt.repetitions
    );

    for repetition in 1..=opt.repetitions {
        for drop_point in condition_order(repetition) {
            let run = run_condition(
                &opt,
                &experiment_id,
                repetition,
                drop_point,
                &received,
            )
            .await?;
            run.validate()
                .map_err(|error| anyhow::anyhow!("invalid experiment result: {error:?}"))?;
            publish_run(&opt.hub, &run).await?;
            println!(
                "{} r{}: sent={} app={} cpu={:.1}% NET_RX={}",
                drop_point.as_str(),
                repetition,
                run.packets_sent,
                run.packets_received_by_app,
                run.cpu_busy_percent,
                run.net_rx_softirq_delta
            );
        }
    }

    NftGuard::disable()?;
    let _ = set_xdp_mode(&opt.xdp_control, "monitor").await;
    let _ = traffic_command(&opt.traffic_control, "stop").await;
    println!("completed: {experiment_id}");
    Ok(())
}

fn condition_order(repetition: u16) -> [DropPoint; 3] {
    let mut order = DropPoint::ALL;
    order.rotate_left(usize::from(repetition.saturating_sub(1)) % order.len());
    order
}

async fn run_condition(
    opt: &Opt,
    experiment_id: &str,
    repetition: u16,
    drop_point: DropPoint,
    received: &AtomicU64,
) -> anyhow::Result<ExperimentRun> {
    let attach_mode = configure_drop_point(opt, drop_point).await?;
    tokio::time::sleep(Duration::from_secs(opt.settle_secs)).await;

    let traffic_before = traffic_command(&opt.traffic_control, "status").await?;
    let app_before = received.load(Ordering::Relaxed);
    let cpu_before = read_cpu_snapshot()?;
    let softirq_before = read_net_rx_softirq()?;

    traffic_command(&opt.traffic_control, "start").await?;
    tokio::time::sleep(Duration::from_secs(opt.duration_secs)).await;
    let traffic_after = traffic_command(&opt.traffic_control, "stop").await?;

    let cpu_after = read_cpu_snapshot()?;
    let softirq_after = read_net_rx_softirq()?;
    let app_after = received.load(Ordering::Relaxed);
    let run_id = format!(
        "{experiment_id}-{}-r{repetition}",
        drop_point.as_str()
    );

    Ok(ExperimentRun {
        experiment_id: experiment_id.to_string(),
        run_id,
        repetition,
        drop_point,
        duration_ms: opt.duration_secs.saturating_mul(1_000),
        target_pps: traffic_before.target_pps,
        payload_bytes: traffic_before.payload_bytes,
        packets_sent: traffic_after
            .packets_sent
            .saturating_sub(traffic_before.packets_sent),
        packets_received_by_app: app_after.saturating_sub(app_before),
        cpu_busy_percent: cpu_busy_percent(cpu_before, cpu_after),
        net_rx_softirq_delta: softirq_after.saturating_sub(softirq_before),
        xdp_attach_mode: attach_mode,
    })
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

async fn spawn_udp_sink(listen: &str, received: Arc<AtomicU64>) -> anyhow::Result<()> {
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
                Err(error) => {
                    eprintln!("UDP sink receive failed: {error}");
                    break;
                }
            }
        }
    });
    Ok(())
}

async fn traffic_command(target: &str, command: &str) -> anyhow::Result<TrafficStatus> {
    let value = request_json(target, json!({ "command": command })).await?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!("traffic-node rejected {command}: {value}");
    }
    Ok(TrafficStatus {
        packets_sent: required_u64(&value, "packets_sent")?,
        target_pps: required_u64(&value, "target_pps")?,
        payload_bytes: u32::try_from(required_u64(&value, "payload_bytes")?)
            .context("payload_bytes does not fit in u32")?,
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
    let mut stream = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to {target}"))?;
    stream.write_all(request.to_string().as_bytes()).await?;
    stream.write_all(b"\n").await?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).await?;
    serde_json::from_str(response.trim()).context("control API returned invalid JSON")
}

async fn publish_run(target: &str, run: &ExperimentRun) -> anyhow::Result<()> {
    let mut value = serde_json::to_value(run)?;
    value
        .as_object_mut()
        .context("ExperimentRun must serialize as an object")?
        .insert("type".to_string(), Value::String("experiment_run".to_string()));
    let mut stream = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to observation hub {target}"))?;
    stream.write_all(value.to_string().as_bytes()).await?;
    stream.write_all(b"\n").await?;
    Ok(())
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
        total: fields.iter().copied().sum(),
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
        let snapshot = parse_cpu_snapshot("cpu  10 2 3 40 5 0 0 0 0 0\ncpu0 1 1 1 1").unwrap();
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
}
