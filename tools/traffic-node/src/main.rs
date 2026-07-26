use anyhow::Context as _;
use clap::Parser;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::time::{Instant, MissedTickBehavior, timeout};

const ATTACK_PAYLOAD_BYTES: usize = 128;

#[derive(Debug, Clone, Parser)]
struct Opt {
    /// observation-hubのイベント受信先。
    #[arg(long, default_value = "127.0.0.1:9001")]
    hub: String,
    /// Raspberry Pi Aを識別する名前。
    #[arg(long, default_value = "traffic-pi-1")]
    node_id: String,
    /// 正常HTTP通信と負荷UDP通信の宛先。
    #[arg(long, default_value = "127.0.0.1")]
    target: String,
    #[arg(long, default_value_t = 8080)]
    http_port: u16,
    #[arg(long, default_value_t = 4000)]
    attack_port: u16,
    /// 正常HTTPヘルスチェックの間隔。
    #[arg(long, default_value_t = 1000)]
    health_interval_ms: u64,
    #[arg(long, default_value_t = 1500)]
    http_timeout_ms: u64,
    /// 展示用UDP負荷通信の目標pps。
    #[arg(long, default_value_t = 2000)]
    attack_pps: u64,
    /// xdp-helloの実行時モード変更API。
    #[arg(long, default_value = "127.0.0.1:9020")]
    defense_control: String,
    /// experiment-runnerから負荷を開始・停止する制御API。
    #[arg(long, default_value = "127.0.0.1:9030")]
    control_listen: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let opt = Arc::new(Opt::parse());
    let attack_active = Arc::new(AtomicBool::new(false));
    let packets_sent = Arc::new(AtomicU64::new(0));

    spawn_health_worker(opt.clone());
    spawn_attack_worker(opt.clone(), attack_active.clone(), packets_sent.clone()).await?;
    spawn_control_server(opt.clone(), attack_active.clone(), packets_sent.clone()).await?;

    println!("traffic-node:");
    println!("  normal HTTP: http://{}:{}/api/ping", opt.target, opt.http_port);
    println!("  attack UDP:  {}:{} ({} pps)", opt.target, opt.attack_port, opt.attack_pps);
    println!("commands: attack | stop | monitor | protect | status | quit");
    println!("experiment control: {}", opt.control_listen);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        match line.trim().to_ascii_lowercase().as_str() {
            "attack" => {
                attack_active.store(true, Ordering::Relaxed);
                publish_attack_state(&opt, true, packets_sent.load(Ordering::Relaxed), 0).await;
                println!("attack traffic started");
            }
            "stop" => {
                attack_active.store(false, Ordering::Relaxed);
                publish_attack_state(&opt, false, packets_sent.load(Ordering::Relaxed), 0).await;
                println!("attack traffic stopped");
            }
            "monitor" | "protect" => {
                let mode = line.trim().to_ascii_lowercase();
                match set_defense_mode(&opt.defense_control, &mode).await {
                    Ok(response) => println!("{response}"),
                    Err(error) => eprintln!("failed to change defense mode: {error}"),
                }
            }
            "status" => {
                println!(
                    "attack={} packets_sent={}",
                    attack_active.load(Ordering::Relaxed),
                    packets_sent.load(Ordering::Relaxed)
                );
            }
            "quit" | "exit" => break,
            "" => {}
            _ => println!("commands: attack | stop | monitor | protect | status | quit"),
        }
    }

    attack_active.store(false, Ordering::Relaxed);
    Ok(())
}

async fn spawn_control_server(
    opt: Arc<Opt>,
    attack_active: Arc<AtomicBool>,
    packets_sent: Arc<AtomicU64>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&opt.control_listen)
        .await
        .with_context(|| format!("failed to bind traffic control on {}", opt.control_listen))?;
    println!("traffic control listening on {}", opt.control_listen);

    tokio::spawn(async move {
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(error) => {
                    eprintln!("traffic control accept failed: {error}");
                    continue;
                }
            };
            let opt = opt.clone();
            let attack_active = attack_active.clone();
            let packets_sent = packets_sent.clone();
            tokio::spawn(async move {
                let (reader, mut writer) = socket.into_split();
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let command = serde_json::from_str::<serde_json::Value>(&line)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("command")
                                .and_then(|command| command.as_str())
                                .map(str::to_string)
                        })
                        .unwrap_or_else(|| line.trim().to_ascii_lowercase());

                    let (active, state_changed) = match command.as_str() {
                        "start" | "attack" => {
                            attack_active.store(true, Ordering::Relaxed);
                            (true, true)
                        }
                        "stop" => {
                            attack_active.store(false, Ordering::Relaxed);
                            (false, true)
                        }
                        "status" => (attack_active.load(Ordering::Relaxed), false),
                        _ => {
                            let response = json!({
                                "ok": false,
                                "error": "command must be start, stop, or status",
                            });
                            let _ = writer.write_all(response.to_string().as_bytes()).await;
                            let _ = writer.write_all(b"\n").await;
                            continue;
                        }
                    };

                    let total = packets_sent.load(Ordering::Relaxed);
                    if state_changed {
                        publish_attack_state(&opt, active, total, 0).await;
                    }
                    let response = json!({
                        "ok": true,
                        "active": active,
                        "packets_sent": total,
                        "target_pps": opt.attack_pps,
                        "payload_bytes": ATTACK_PAYLOAD_BYTES,
                    });
                    let _ = writer.write_all(response.to_string().as_bytes()).await;
                    let _ = writer.write_all(b"\n").await;
                    println!("traffic command from {peer}: {command}");
                }
            });
        }
    });

    Ok(())
}

fn spawn_health_worker(opt: Arc<Opt>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(
            opt.health_interval_ms.max(100),
        ));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            let started = Instant::now();
            let result = probe_http(&opt.target, opt.http_port, opt.http_timeout_ms).await;
            let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let (success, status_code) = match result {
                Ok(status_code) => (status_code == 200, Some(status_code)),
                Err(error) => {
                    eprintln!("health probe failed: {error}");
                    (false, None)
                }
            };
            let event = json!({
                "type": "traffic_health",
                "node_id": opt.node_id,
                "success": success,
                "latency_ms": latency_ms,
                "status_code": status_code,
            });
            if let Err(error) = publish_event(&opt.hub, &event).await {
                eprintln!("failed to publish health event: {error}");
            }
        }
    });
}

async fn spawn_attack_worker(
    opt: Arc<Opt>,
    active: Arc<AtomicBool>,
    packets_sent: Arc<AtomicU64>,
) -> anyhow::Result<()> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .context("failed to bind UDP attack socket")?;

    tokio::spawn(async move {
        let pps = opt.attack_pps.clamp(1, 100_000);
        let nanos = (1_000_000_000_u64 / pps).max(1);
        let mut send_interval = tokio::time::interval(Duration::from_nanos(nanos));
        send_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut report_interval = tokio::time::interval(Duration::from_secs(1));
        report_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let payload = [0x50_u8; ATTACK_PAYLOAD_BYTES];
        let mut previous_total = 0_u64;

        loop {
            tokio::select! {
                _ = send_interval.tick() => {
                    if active.load(Ordering::Relaxed) {
                        match socket.send_to(&payload, (&*opt.target, opt.attack_port)).await {
                            Ok(_) => {
                                packets_sent.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(error) => eprintln!("UDP attack send failed: {error}"),
                        }
                    }
                }
                _ = report_interval.tick() => {
                    let total = packets_sent.load(Ordering::Relaxed);
                    let current_pps = total.saturating_sub(previous_total);
                    previous_total = total;
                    publish_attack_state(
                        &opt,
                        active.load(Ordering::Relaxed),
                        total,
                        current_pps,
                    )
                    .await;
                }
            }
        }
    });

    Ok(())
}

async fn probe_http(host: &str, port: u16, timeout_ms: u64) -> anyhow::Result<u16> {
    let operation = async {
        let mut stream = TcpStream::connect((host, port))
            .await
            .with_context(|| format!("failed to connect to {host}:{port}"))?;
        let request = format!(
            "GET /api/ping HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await?;

        let mut response = vec![0_u8; 1024];
        let size = stream.read(&mut response).await?;
        let first_line = String::from_utf8_lossy(&response[..size])
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        parse_status_code(&first_line)
    };

    timeout(Duration::from_millis(timeout_ms.max(100)), operation)
        .await
        .context("HTTP probe timed out")?
}

fn parse_status_code(status_line: &str) -> anyhow::Result<u16> {
    status_line
        .split_whitespace()
        .nth(1)
        .context("HTTP response did not contain a status code")?
        .parse()
        .context("HTTP status code was invalid")
}

async fn publish_attack_state(opt: &Opt, active: bool, packets_sent: u64, pps: u64) {
    let event = json!({
        "type": "attack_state",
        "node_id": opt.node_id,
        "active": active,
        "packets_sent": packets_sent,
        "pps": pps,
        "target": opt.target,
        "dst_port": opt.attack_port,
    });
    if let Err(error) = publish_event(&opt.hub, &event).await {
        eprintln!("failed to publish attack state: {error}");
    }
}

async fn publish_event(target: &str, event: &serde_json::Value) -> anyhow::Result<()> {
    let mut stream = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to observation hub {target}"))?;
    stream.write_all(event.to_string().as_bytes()).await?;
    stream.write_all(b"\n").await?;
    Ok(())
}

async fn set_defense_mode(target: &str, mode: &str) -> anyhow::Result<String> {
    let mut stream = TcpStream::connect(target)
        .await
        .with_context(|| format!("failed to connect to defense control {target}"))?;
    let command = json!({ "mode": mode }).to_string();
    stream.write_all(command.as_bytes()).await?;
    stream.write_all(b"\n").await?;

    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).await?;
    Ok(response.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_status() {
        assert_eq!(parse_status_code("HTTP/1.1 200 OK").unwrap(), 200);
        assert!(parse_status_code("not-http").is_err());
    }
}
