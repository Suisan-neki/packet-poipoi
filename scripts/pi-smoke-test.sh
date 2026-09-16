#!/usr/bin/env bash
# Linux VM 上で Pi A→Pi B 相当の短時間 smoke を実行する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${STATE_DIR:-/tmp/packet-poipoi-smoke}"
TOOLS_TARGET="$REPO_ROOT/tools/target/release"
EVENT_ADDR="127.0.0.1:19001"
STREAM_ADDR="127.0.0.1:19010"
HTTP_PORT=18080
XDP_CONTROL_ADDR="127.0.0.1:19020"
TRAFFIC_CONTROL_ADDR="127.0.0.1:19030"
UDP_PORT=4000
EXPECTED_RUNS=3

mkdir -p "$STATE_DIR"

if [[ "$EUID" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "pi-smoke-test requires root or sudo for nftables netfilter verification." >&2
  exit 1
fi

cleanup() {
  local status=$?
  for pid_file in "$STATE_DIR"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    kill "$(cat "$pid_file")" 2>/dev/null || true
  done
  "${SUDO[@]}" nft delete table inet packet_poipoi_experiment 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

cargo build --release --manifest-path "$REPO_ROOT/tools/Cargo.toml" \
  -p observation-hub \
  -p traffic-node \
  -p experiment-runner

python3 - "$XDP_CONTROL_ADDR" >"$STATE_DIR/fake-xdp.log" 2>&1 <<'PY' &
import json
import socket
import sys
import threading

host, port = sys.argv[1].split(":")
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind((host, int(port)))
server.listen()

def handle(conn):
    with conn:
        for raw in conn.makefile():
            try:
                request = json.loads(raw)
                mode = request.get("mode", "monitor")
            except json.JSONDecodeError:
                mode = raw.strip()
            ok = mode in ("monitor", "protect")
            response = {"ok": ok, "mode": mode, "blocked_udp_port": 4000, "attach_mode": "generic"}
            if not ok:
                response["error"] = "mode must be monitor or protect"
            conn.sendall((json.dumps(response) + "\n").encode())

while True:
    conn, _addr = server.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
PY
echo $! >"$STATE_DIR/fake-xdp.pid"

"$TOOLS_TARGET/observation-hub" \
  --ebpf-source "$XDP_CONTROL_ADDR" \
  --event-listen "$EVENT_ADDR" \
  --listen "$STREAM_ADDR" \
  --http-listen "127.0.0.1:${HTTP_PORT}" \
  >"$STATE_DIR/observation-hub.log" 2>&1 &
echo $! >"$STATE_DIR/observation-hub.pid"

"$TOOLS_TARGET/traffic-node" \
  --hub "$EVENT_ADDR" \
  --target 127.0.0.1 \
  --http-port "$HTTP_PORT" \
  --attack-port "$UDP_PORT" \
  --defense-control "$XDP_CONTROL_ADDR" \
  --control-listen "$TRAFFIC_CONTROL_ADDR" \
  --health-interval-ms 200 \
  --attack-pps 50 \
  >"$STATE_DIR/traffic-node.log" 2>&1 &
echo $! >"$STATE_DIR/traffic-node.pid"

sleep 1

python3 - "$STREAM_ADDR" "$EXPECTED_RUNS" >"$STATE_DIR/stream-capture.log" 2>&1 <<'PY' &
import json
import socket
import sys
import time

host, port = sys.argv[1].split(":")
expected = int(sys.argv[2])
deadline = time.time() + 45
count = 0
with socket.create_connection((host, int(port)), timeout=5) as sock:
    sock.settimeout(5)
    stream = sock.makefile()
    while time.time() < deadline and count < expected:
        line = stream.readline()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "experiment_run":
            count += 1
if count < expected:
    raise SystemExit(f"expected {expected} experiment_run events, got {count}")
PY
echo $! >"$STATE_DIR/stream-capture.pid"

"${SUDO[@]}" "$TOOLS_TARGET/experiment-runner" \
  --traffic-control "$TRAFFIC_CONTROL_ADDR" \
  --xdp-control "$XDP_CONTROL_ADDR" \
  --hub "$EVENT_ADDR" \
  --udp-listen "0.0.0.0:${UDP_PORT}" \
  --interface lo \
  --pps-steps 50 \
  --duration-secs 1 \
  --settle-secs 0 \
  --repetitions 1 \
  --service-min-success-percent 99 \
  --service-max-p95-ms 100 \
  --min-load-delivery-percent 50 \
  >"$STATE_DIR/experiment-runner.log" 2>&1

wait "$(cat "$STATE_DIR/stream-capture.pid")"

echo "smoke passed: Pi A traffic-node -> Pi B observation-hub/service/runner -> dashboard stream"
