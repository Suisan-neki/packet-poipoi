use crate::experiment::ExperimentRun;
use serde::{Deserialize, Serialize};

/// observation-hubが1行のNDJSONとして配信するイベント。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Flow(FlowEvent),
    Alert(AlertEvent),
    Stats(StatsEvent),
    TrafficHealth(TrafficHealthEvent),
    AttackState(AttackStateEvent),
    DefenseMode(DefenseModeEvent),
    ExperimentRun(ExperimentRun),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowEvent {
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub src: String,
    pub src_port: u16,
    pub dst: String,
    pub dst_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlertEvent {
    pub dst: String,
    pub rate: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatsEvent {
    pub pps: u64,
    pub total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub pass: u64,
    #[serde(default)]
    pub drop: u64,
    #[serde(default)]
    pub interval_pass: u64,
    #[serde(default)]
    pub interval_drop: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrafficHealthEvent {
    pub node_id: String,
    pub success: bool,
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttackStateEvent {
    pub node_id: String,
    pub active: bool,
    pub packets_sent: u64,
    pub pps: u64,
    pub target: String,
    pub dst_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefenseModeEvent {
    pub mode: String,
    pub blocked_udp_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach_mode: Option<String>,
}

pub type UpstreamEvent = StreamEvent;

/// xdp-hello / traffic-node / experiment-runnerから届くNDJSONを型へ戻す。
pub fn parse_upstream_line(line: &str) -> Option<UpstreamEvent> {
    let event: StreamEvent = serde_json::from_str(line).ok()?;
    if let StreamEvent::ExperimentRun(run) = &event {
        run.validate().ok()?;
    }
    Some(event)
}

impl StreamEvent {
    pub fn to_stream_event(&self) -> Self {
        self.clone()
    }

    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).expect("stream event serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flow_line() {
        let event = parse_upstream_line(
            r#"{"type":"flow","protocol":"TCP","src":"10.0.0.2","src_port":1234,"dst":"10.0.0.1","dst_port":443}"#,
        )
        .expect("flow");
        assert!(matches!(event, StreamEvent::Flow(_)));
    }

    #[test]
    fn parses_interval_stats_and_attach_mode() {
        let event = parse_upstream_line(
            r#"{"type":"stats","pps":1900,"total":10000,"pass":500,"drop":9500,"interval_pass":25,"interval_drop":925,"interval_ms":500,"attach_mode":"native"}"#,
        )
        .expect("stats");
        let StreamEvent::Stats(stats) = event else {
            panic!("expected stats");
        };
        assert_eq!(stats.interval_drop, 925);
        assert_eq!(stats.attach_mode.as_deref(), Some("native"));
    }

    #[test]
    fn rejects_invalid_experiment_run() {
        let invalid = r#"{
          "type":"experiment_run",
          "experiment_id":"drop-point-1",
          "run_id":"xdp-1",
          "repetition":1,
          "drop_point":"xdp",
          "duration_ms":10000,
          "target_pps":2000,
          "payload_bytes":128,
          "packets_sent":20000,
          "packets_received_by_app":0,
          "cpu_busy_percent":12.0,
          "net_rx_softirq_delta":100,
          "xdp_attach_mode":"unknown"
        }"#;
        assert!(parse_upstream_line(invalid).is_none());
    }
}
