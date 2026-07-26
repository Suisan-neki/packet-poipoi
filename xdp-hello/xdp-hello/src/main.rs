use anyhow::Context as _;
use aya::maps::{Array, PerCpuArray, RingBuf};
use aya::programs::{Xdp, XdpFlags};
use clap::{Parser, ValueEnum};
#[rustfmt::skip]
use log::{debug, warn};
use std::mem::size_of;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::signal;
use tokio::sync::{Mutex, broadcast};
use xdp_hello_common::{
    CONFIG_BLOCKED_UDP_PORT_INDEX, CONFIG_MODE_INDEX, COUNTER_DROP_INDEX, COUNTER_PASS_INDEX,
    DEFENSE_MODE_MONITOR, DEFENSE_MODE_PROTECT, EVENT_KIND_RATE_ALERT, FlowEvent,
    PACKET_ACTION_DROP,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum DefenseMode {
    Monitor,
    Protect,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum XdpModePreference {
    Auto,
    Native,
    Generic,
}

#[derive(Debug, Clone, Copy)]
enum XdpAttachMode {
    Native,
    Generic,
}

impl XdpAttachMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Generic => "generic",
        }
    }
}

impl DefenseMode {
    fn as_u32(self) -> u32 {
        match self {
            Self::Monitor => DEFENSE_MODE_MONITOR,
            Self::Protect => DEFENSE_MODE_PROTECT,
        }
    }

    fn from_u32(value: u32) -> Self {
        if value == DEFENSE_MODE_PROTECT {
            Self::Protect
        } else {
            Self::Monitor
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "monitor" => Some(Self::Monitor),
            "protect" => Some(Self::Protect),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Monitor => "monitor",
            Self::Protect => "protect",
        }
    }
}

#[derive(Debug, Parser)]
struct Opt {
    #[clap(short, long, default_value = "eth0")]
    iface: String,
    /// 地上（Tauri ダッシュボード）へ NDJSON を配信する TCP の待受アドレス。
    /// Lima のポート転送で macOS ホストの同ポートに出る。
    #[clap(short, long, default_value = "127.0.0.1:9000")]
    listen: String,
    /// 実行中にmonitor/protectを変更する制御API。
    #[clap(long, default_value = "127.0.0.1:9020")]
    control_listen: String,
    /// monitorは観測のみ。protectは指定UDPポートをXDP_DROPする。
    #[clap(long, value_enum, default_value = "monitor")]
    defense_mode: DefenseMode,
    /// protect時に遮断する負荷通信専用UDPポート。
    #[clap(long, default_value_t = 4000)]
    blocked_udp_port: u16,
    /// autoはnativeを試し、NIC/driverが非対応ならgenericへフォールバックする。
    #[clap(long, value_enum, default_value = "auto")]
    xdp_mode: XdpModePreference,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let opt = Opt::parse();

    env_logger::init();

    // Bump the memlock rlimit. This is needed for older kernels that don't use the
    // new memcg based accounting, see https://lwn.net/Articles/837122/
    let rlim = libc::rlimit {
        rlim_cur: libc::RLIM_INFINITY,
        rlim_max: libc::RLIM_INFINITY,
    };
    let ret = unsafe { libc::setrlimit(libc::RLIMIT_MEMLOCK, &rlim) };
    if ret != 0 {
        debug!("remove limit on locked memory failed, ret is: {ret}");
    }

    // This will include your eBPF object file as raw bytes at compile-time and load it at
    // runtime. This approach is recommended for most real-world use cases. If you would
    // like to specify the eBPF program at runtime rather than at compile-time, you can
    // reach for `Bpf::load_file` instead.
    let mut ebpf = aya::Ebpf::load(aya::include_bytes_aligned!(concat!(
        env!("OUT_DIR"),
        "/xdp-hello"
    )))?;
    match aya_log::EbpfLogger::init(&mut ebpf) {
        Err(e) => {
            // This can happen if you remove all log statements from your eBPF program.
            warn!("failed to initialize eBPF logger: {e}");
        }
        Ok(logger) => {
            let mut logger =
                tokio::io::unix::AsyncFd::with_interest(logger, tokio::io::Interest::READABLE)?;
            tokio::task::spawn(async move {
                loop {
                    let mut guard = logger.readable_mut().await.unwrap();
                    guard.get_inner_mut().flush();
                    guard.clear_ready();
                }
            });
        }
    }

    let mut config: Array<aya::maps::MapData, u32> = ebpf
        .take_map("DEFENSE_CONFIG")
        .context("DEFENSE_CONFIG map not found")?
        .try_into()?;
    config.set(CONFIG_MODE_INDEX, opt.defense_mode.as_u32(), 0)?;
    config.set(
        CONFIG_BLOCKED_UDP_PORT_INDEX,
        u32::from(opt.blocked_udp_port),
        0,
    )?;
    let config = Arc::new(Mutex::new(config));
    let current_mode = Arc::new(AtomicU32::new(opt.defense_mode.as_u32()));

    let program: &mut Xdp = ebpf.program_mut("xdp_hello").unwrap().try_into()?;
    program.load()?;
    let attach_mode = attach_xdp(program, &opt.iface, opt.xdp_mode)?;

    println!(
        "defense mode={} blocked_udp_port={} attach_mode={}",
        opt.defense_mode.as_str(),
        opt.blocked_udp_port,
        attach_mode.as_str(),
    );

    // 地上へ流す NDJSON 行をブロードキャストするチャネル。
    // 1イベント = 1行。複数のダッシュボードが同時接続してもよい。
    let (tx, _rx) = broadcast::channel::<String>(4096);

    spawn_event_server(opt.listen.clone(), tx.clone()).await?;
    spawn_control_server(
        opt.control_listen.clone(),
        config,
        current_mode.clone(),
        opt.blocked_udp_port,
        attach_mode,
        tx.clone(),
    )
    .await?;

    let counters: PerCpuArray<_, u64> = ebpf
        .take_map("COUNTERS")
        .context("COUNTERS map not found")?
        .try_into()?;
    spawn_stats_ticker(tx.clone(), counters, current_mode, attach_mode);

    let ring_buf: RingBuf<_> = ebpf
        .take_map("EVENTS")
        .context("EVENTS ring buffer not found")?
        .try_into()?;
    let mut ring_buf =
        tokio::io::unix::AsyncFd::with_interest(ring_buf, tokio::io::Interest::READABLE)?;
    {
        let tx = tx.clone();
        tokio::task::spawn(async move {
            loop {
                let mut guard = ring_buf.readable_mut().await.unwrap();
                while let Some(item) = guard.get_inner_mut().next() {
                    match parse_flow_event(&item) {
                        Some(event) => {
                            print_flow_event(&event);
                            // 黒い画面に出していたデータを、そのまま地上へ投函する。
                            let _ = tx.send(event_to_json(&event));
                        }
                        None => warn!("received malformed flow event: len={}", item.len()),
                    }
                }
                guard.clear_ready();
            }
        });
    }

    let ctrl_c = signal::ctrl_c();
    println!("Waiting for Ctrl-C...");
    ctrl_c.await?;
    println!("Exiting...");

    Ok(())
}

fn attach_xdp(
    program: &mut Xdp,
    iface: &str,
    preference: XdpModePreference,
) -> anyhow::Result<XdpAttachMode> {
    match preference {
        XdpModePreference::Native => {
            program
                .attach(iface, XdpFlags::DRV_MODE)
                .with_context(|| format!("failed to attach XDP in native mode to {iface}"))?;
            Ok(XdpAttachMode::Native)
        }
        XdpModePreference::Generic => {
            program
                .attach(iface, XdpFlags::SKB_MODE)
                .with_context(|| format!("failed to attach XDP in generic mode to {iface}"))?;
            Ok(XdpAttachMode::Generic)
        }
        XdpModePreference::Auto => match program.attach(iface, XdpFlags::DRV_MODE) {
            Ok(_) => Ok(XdpAttachMode::Native),
            Err(native_error) => {
                warn!("native XDP attach failed ({native_error}); falling back to generic mode");
                program
                    .attach(iface, XdpFlags::SKB_MODE)
                    .with_context(|| format!("failed to attach XDP in generic mode to {iface}"))?;
                Ok(XdpAttachMode::Generic)
            }
        },
    }
}

/// NDJSON を配信する TCP サーバを起動する。接続ごとにブロードキャストを購読し、
/// 受け取った行をそのままソケットへ書き出す。
async fn spawn_event_server(listen: String, tx: broadcast::Sender<String>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("failed to bind event server on {listen}"))?;
    println!("event stream listening on {listen} (NDJSON)");

    tokio::task::spawn(async move {
        loop {
            let (mut socket, peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    warn!("event server accept failed: {e}");
                    continue;
                }
            };
            println!("dashboard connected: {peer}");
            let mut rx = tx.subscribe();
            tokio::task::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(line) => {
                            if socket.write_all(line.as_bytes()).await.is_err()
                                || socket.write_all(b"\n").await.is_err()
                            {
                                break;
                            }
                        }
                        // ダッシュボードの読み取りが遅れて溢れたぶんは捨てて継続する。
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                println!("dashboard disconnected: {peer}");
            });
        }
    });

    Ok(())
}

async fn spawn_control_server(
    listen: String,
    config: Arc<Mutex<Array<aya::maps::MapData, u32>>>,
    current_mode: Arc<AtomicU32>,
    blocked_udp_port: u16,
    attach_mode: XdpAttachMode,
    tx: broadcast::Sender<String>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("failed to bind control server on {listen}"))?;
    println!("defense control listening on {listen}");

    tokio::spawn(async move {
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(error) => {
                    warn!("defense control accept failed: {error}");
                    continue;
                }
            };
            let config = config.clone();
            let current_mode = current_mode.clone();
            let tx = tx.clone();

            tokio::spawn(async move {
                let (reader, mut writer) = socket.into_split();
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let requested = serde_json::from_str::<serde_json::Value>(&line)
                        .ok()
                        .and_then(|value| value.get("mode")?.as_str().map(str::to_string))
                        .unwrap_or_else(|| line.clone());

                    let Some(mode) = DefenseMode::parse(&requested) else {
                        let _ = writer
                            .write_all(b"{\"ok\":false,\"error\":\"mode must be monitor or protect\"}\n")
                            .await;
                        continue;
                    };

                    let update = {
                        let mut config = config.lock().await;
                        config.set(CONFIG_MODE_INDEX, mode.as_u32(), 0)
                    };
                    match update {
                        Ok(()) => {
                            current_mode.store(mode.as_u32(), Ordering::Relaxed);
                            let event = serde_json::json!({
                                "type": "defense_mode",
                                "mode": mode.as_str(),
                                "blocked_udp_port": blocked_udp_port,
                                "attach_mode": attach_mode.as_str(),
                            })
                            .to_string();
                            let _ = tx.send(event.clone());
                            let response = serde_json::json!({
                                "ok": true,
                                "mode": mode.as_str(),
                                "blocked_udp_port": blocked_udp_port,
                                "attach_mode": attach_mode.as_str(),
                            })
                            .to_string();
                            let _ = writer.write_all(response.as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                            println!("defense mode changed by {peer}: {}", mode.as_str());
                        }
                        Err(error) => {
                            let response = serde_json::json!({
                                "ok": false,
                                "error": error.to_string(),
                            })
                            .to_string();
                            let _ = writer.write_all(response.as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                        }
                    }
                }
            });
        }
    });

    Ok(())
}

/// 500msごとにカーネルのper-CPU counterを合算して配信する。
fn spawn_stats_ticker(
    tx: broadcast::Sender<String>,
    counters: PerCpuArray<aya::maps::MapData, u64>,
    current_mode: Arc<AtomicU32>,
    attach_mode: XdpAttachMode,
) {
    tokio::task::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        let mut previous_total = 0_u64;
        let mut previous_pass = 0_u64;
        let mut previous_drop = 0_u64;

        loop {
            interval.tick().await;
            let pass = sum_counter(&counters, COUNTER_PASS_INDEX);
            let drop_count = sum_counter(&counters, COUNTER_DROP_INDEX);
            let total = pass.saturating_add(drop_count);
            let pps = total.saturating_sub(previous_total).saturating_mul(2);
            let interval_pass = pass.saturating_sub(previous_pass);
            let interval_drop = drop_count.saturating_sub(previous_drop);
            previous_total = total;
            previous_pass = pass;
            previous_drop = drop_count;

            let line = serde_json::json!({
                "type": "stats",
                "mode": DefenseMode::from_u32(current_mode.load(Ordering::Relaxed)).as_str(),
                "pps": pps,
                "total": total,
                "pass": pass,
                "drop": drop_count,
                "interval_pass": interval_pass,
                "interval_drop": interval_drop,
                "interval_ms": 500,
                "attach_mode": attach_mode.as_str(),
            })
            .to_string();
            let _ = tx.send(line);
        }
    });
}

fn sum_counter(
    counters: &PerCpuArray<aya::maps::MapData, u64>,
    index: u32,
) -> u64 {
    counters
        .get(&index, 0)
        .map(|values| values.iter().copied().sum())
        .unwrap_or_default()
}

fn parse_flow_event(bytes: &[u8]) -> Option<FlowEvent> {
    if bytes.len() != size_of::<FlowEvent>() {
        return None;
    }

    Some(FlowEvent {
        kind: bytes[0],
        protocol: bytes[1],
        action: bytes[2],
        _pad: bytes[3],
        src_addr: bytes[4..8].try_into().ok()?,
        dst_addr: bytes[8..12].try_into().ok()?,
        src_port: u16::from_ne_bytes(bytes[12..14].try_into().ok()?),
        dst_port: u16::from_ne_bytes(bytes[14..16].try_into().ok()?),
        rate: u32::from_ne_bytes(bytes[16..20].try_into().ok()?),
    })
}

fn print_flow_event(event: &FlowEvent) {
    if event.kind == EVENT_KIND_RATE_ALERT {
        println!(
            "rate alert: dst={}.{}.{}.{}, rate={}/s",
            event.dst_addr[0], event.dst_addr[1], event.dst_addr[2], event.dst_addr[3], event.rate
        );
        return;
    }

    println!(
        "flow event: action={}, proto={}, src={}.{}.{}.{}:{}, dst={}.{}.{}.{}:{}",
        action_name(event.action),
        protocol_name(event.protocol),
        event.src_addr[0],
        event.src_addr[1],
        event.src_addr[2],
        event.src_addr[3],
        event.src_port,
        event.dst_addr[0],
        event.dst_addr[1],
        event.dst_addr[2],
        event.dst_addr[3],
        event.dst_port
    );
}

/// FlowEvent を 1 行の JSON 文字列に変換する。
fn event_to_json(event: &FlowEvent) -> String {
    if event.kind == EVENT_KIND_RATE_ALERT {
        return serde_json::json!({
            "type": "alert",
            "dst": ipv4_string(event.dst_addr),
            "rate": event.rate,
        })
        .to_string();
    }

    serde_json::json!({
        "type": "flow",
        "protocol": protocol_name(event.protocol),
        "action": action_name(event.action),
        "src": ipv4_string(event.src_addr),
        "src_port": event.src_port,
        "dst": ipv4_string(event.dst_addr),
        "dst_port": event.dst_port,
    })
    .to_string()
}

fn ipv4_string(addr: [u8; 4]) -> String {
    format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
}

fn action_name(action: u8) -> &'static str {
    if action == PACKET_ACTION_DROP {
        "DROP"
    } else {
        "PASS"
    }
}

fn protocol_name(protocol: u8) -> &'static str {
    match protocol {
        1 => "ICMP",
        6 => "TCP",
        17 => "UDP",
        _ => "OTHER",
    }
}
