#!/usr/bin/env bash
# Pi A/Pi B の実行プロセスを共通設定から起動・停止する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/packet-poipoi.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

ROLE="${1:-}"
COMMAND="${2:-start}"
BIN_DIR="${BIN_DIR:-$SCRIPT_DIR}"
STATE_DIR="${STATE_DIR:-/tmp/packet-poipoi}"
PI_A_IP="${PI_A_IP:-192.168.50.10}"
PI_B_IP="${PI_B_IP:-192.168.50.20}"
PI_IFACE="${PI_IFACE:-eth0}"
PACKET_POIPOI_STREAM_ADDR="${PACKET_POIPOI_STREAM_ADDR:-${PI_B_IP}:9010}"
PACKET_POIPOI_EVENT_ADDR="${PACKET_POIPOI_EVENT_ADDR:-${PI_B_IP}:9001}"
PACKET_POIPOI_EBPF_ADDR="${PACKET_POIPOI_EBPF_ADDR:-127.0.0.1:9000}"
PACKET_POIPOI_XDP_CONTROL="${PACKET_POIPOI_XDP_CONTROL:-127.0.0.1:9020}"
PACKET_POIPOI_TRAFFIC_CONTROL="${PACKET_POIPOI_TRAFFIC_CONTROL:-${PI_A_IP}:9030}"
PACKET_POIPOI_HTTP_TARGET="${PACKET_POIPOI_HTTP_TARGET:-$PI_B_IP}"
PACKET_POIPOI_HTTP_PORT="${PACKET_POIPOI_HTTP_PORT:-8080}"
PACKET_POIPOI_ATTACK_PORT="${PACKET_POIPOI_ATTACK_PORT:-4000}"
PACKET_POIPOI_PPS_STEPS="${PACKET_POIPOI_PPS_STEPS:-500,2000,5000,10000,20000,50000}"
PACKET_POIPOI_DURATION_SECS="${PACKET_POIPOI_DURATION_SECS:-10}"
PACKET_POIPOI_REPETITIONS="${PACKET_POIPOI_REPETITIONS:-3}"
PACKET_POIPOI_XDP_MODE="${PACKET_POIPOI_XDP_MODE:-auto}"

usage() {
  echo "Usage: $0 [pi-a|pi-b|experiment|dashboard] [start|stop|status]" >&2
  exit 1
}

require_private_target() {
  case "$PACKET_POIPOI_HTTP_TARGET" in
    127.*|10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) ;;
    *)
      echo "Refusing to target non-private address: $PACKET_POIPOI_HTTP_TARGET" >&2
      echo "Set PACKET_POIPOI_HTTP_TARGET to the isolated LAN Pi B address." >&2
      exit 1
      ;;
  esac
}

pid_file() {
  echo "$STATE_DIR/$1.pid"
}

start_daemon() {
  local name="$1"
  shift
  mkdir -p "$STATE_DIR"
  local pidfile
  pidfile="$(pid_file "$name")"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi
  nohup "$@" >"$STATE_DIR/$name.log" 2>&1 &
  echo $! >"$pidfile"
  echo "started $name (pid $(cat "$pidfile"))"
}

stop_daemon() {
  local name="$1"
  local pidfile
  pidfile="$(pid_file "$name")"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
    echo "stopped $name"
  fi
}

status_daemon() {
  local name="$1"
  local pidfile
  pidfile="$(pid_file "$name")"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name running (pid $(cat "$pidfile"))"
  else
    echo "$name stopped"
  fi
}

start_pi_a() {
  require_private_target
  start_daemon traffic-node "$BIN_DIR/traffic-node" \
    --hub "$PACKET_POIPOI_EVENT_ADDR" \
    --target "$PACKET_POIPOI_HTTP_TARGET" \
    --http-port "$PACKET_POIPOI_HTTP_PORT" \
    --attack-port "$PACKET_POIPOI_ATTACK_PORT" \
    --defense-control "${PI_B_IP}:9020" \
    --control-listen "0.0.0.0:9030" \
    --health-interval-ms 200
}

start_pi_b() {
  start_daemon observation-hub "$BIN_DIR/observation-hub" \
    --ebpf-source "$PACKET_POIPOI_EBPF_ADDR" \
    --event-listen "0.0.0.0:9001" \
    --listen "0.0.0.0:9010" \
    --http-listen "0.0.0.0:${PACKET_POIPOI_HTTP_PORT}"
  start_daemon xdp-hello sudo "$BIN_DIR/xdp-hello" \
    --iface "$PI_IFACE" \
    --listen "127.0.0.1:9000" \
    --control-listen "0.0.0.0:9020" \
    --defense-mode monitor \
    --blocked-udp-port "$PACKET_POIPOI_ATTACK_PORT" \
    --xdp-mode "$PACKET_POIPOI_XDP_MODE"
}

run_experiment() {
  sudo "$BIN_DIR/experiment-runner" \
    --traffic-control "$PACKET_POIPOI_TRAFFIC_CONTROL" \
    --xdp-control "$PACKET_POIPOI_XDP_CONTROL" \
    --hub "127.0.0.1:9001" \
    --interface "$PI_IFACE" \
    --udp-port "$PACKET_POIPOI_ATTACK_PORT" \
    --pps-steps "$PACKET_POIPOI_PPS_STEPS" \
    --duration-secs "$PACKET_POIPOI_DURATION_SECS" \
    --repetitions "$PACKET_POIPOI_REPETITIONS" \
    --service-min-success-percent 99 \
    --service-max-p95-ms 100 \
    --min-load-delivery-percent 90
}

case "$ROLE:$COMMAND" in
  pi-a:start) start_pi_a ;;
  pi-b:start) start_pi_b ;;
  experiment:start) run_experiment ;;
  dashboard:start)
    export PACKET_POIPOI_STREAM_ADDR
    cd "$BIN_DIR/../dashboard"
    npm run tauri dev
    ;;
  pi-a:stop) stop_daemon traffic-node ;;
  pi-b:stop)
    stop_daemon xdp-hello
    stop_daemon observation-hub
    sudo nft delete table inet packet_poipoi_experiment 2>/dev/null || true
    ;;
  pi-a:status) status_daemon traffic-node ;;
  pi-b:status)
    status_daemon observation-hub
    status_daemon xdp-hello
    ;;
  *)
    usage
    ;;
esac
