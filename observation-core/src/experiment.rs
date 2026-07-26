use serde::{Deserialize, Serialize};

/// 同じ負荷をどの層で捨てたか。文字列ではなく型で実験条件を固定する。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DropPoint {
    /// UDP socketまで届け、userspaceで読み捨てる。
    Application,
    /// Linux network stack内のnftablesで捨てる。
    Netfilter,
    /// driver entryにattachしたXDPで捨てる。
    Xdp,
}

impl DropPoint {
    pub const ALL: [Self; 3] = [Self::Application, Self::Netfilter, Self::Xdp];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Netfilter => "netfilter",
            Self::Xdp => "xdp",
        }
    }
}

/// XDPを実際にattachできたモード。要求値ではなく実行結果を記録する。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum XdpAttachMode {
    Native,
    Generic,
    NotUsed,
    Unknown,
}

impl Default for XdpAttachMode {
    fn default() -> Self {
        Self::Unknown
    }
}

/// 1条件ぶんの再現可能な実測結果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExperimentRun {
    pub experiment_id: String,
    pub run_id: String,
    pub repetition: u16,
    pub drop_point: DropPoint,
    pub duration_ms: u64,
    pub target_pps: u64,
    pub payload_bytes: u32,
    pub packets_sent: u64,
    pub packets_received_by_app: u64,
    pub cpu_busy_percent: f32,
    pub net_rx_softirq_delta: u64,
    #[serde(default)]
    pub xdp_attach_mode: XdpAttachMode,
}

impl ExperimentRun {
    pub fn app_receive_percent(&self) -> f32 {
        if self.packets_sent == 0 {
            return 0.0;
        }
        self.packets_received_by_app as f32 * 100.0 / self.packets_sent as f32
    }

    pub fn net_rx_softirq_per_10k(&self) -> f32 {
        if self.packets_sent == 0 {
            return 0.0;
        }
        self.net_rx_softirq_delta as f32 * 10_000.0 / self.packets_sent as f32
    }

    pub fn validate(&self) -> Result<(), ExperimentRunError> {
        if self.run_id.trim().is_empty() {
            return Err(ExperimentRunError::EmptyRunId);
        }
        if self.experiment_id.trim().is_empty() {
            return Err(ExperimentRunError::EmptyExperimentId);
        }
        if self.repetition == 0 {
            return Err(ExperimentRunError::ZeroRepetition);
        }
        if self.duration_ms == 0 {
            return Err(ExperimentRunError::ZeroDuration);
        }
        if self.target_pps == 0 {
            return Err(ExperimentRunError::ZeroTargetPps);
        }
        if self.payload_bytes == 0 {
            return Err(ExperimentRunError::ZeroPayload);
        }
        if !self.cpu_busy_percent.is_finite()
            || !(0.0..=100.0).contains(&self.cpu_busy_percent)
        {
            return Err(ExperimentRunError::InvalidCpuPercent);
        }
        if self.packets_received_by_app > self.packets_sent {
            return Err(ExperimentRunError::ReceivedMoreThanSent);
        }
        if self.drop_point == DropPoint::Xdp
            && matches!(
                self.xdp_attach_mode,
                XdpAttachMode::NotUsed | XdpAttachMode::Unknown
            )
        {
            return Err(ExperimentRunError::MissingXdpAttachMode);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExperimentRunError {
    EmptyExperimentId,
    EmptyRunId,
    ZeroRepetition,
    ZeroDuration,
    ZeroTargetPps,
    ZeroPayload,
    InvalidCpuPercent,
    ReceivedMoreThanSent,
    MissingXdpAttachMode,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(drop_point: DropPoint) -> ExperimentRun {
        ExperimentRun {
            experiment_id: "experiment-01".to_string(),
            run_id: "run-01".to_string(),
            repetition: 1,
            drop_point,
            duration_ms: 10_000,
            target_pps: 2_000,
            payload_bytes: 128,
            packets_sent: 20_000,
            packets_received_by_app: 0,
            cpu_busy_percent: 12.5,
            net_rx_softirq_delta: 10_000,
            xdp_attach_mode: if drop_point == DropPoint::Xdp {
                XdpAttachMode::Native
            } else {
                XdpAttachMode::NotUsed
            },
        }
    }

    #[test]
    fn normalizes_softirq_for_fair_comparison() {
        assert_eq!(run(DropPoint::Xdp).net_rx_softirq_per_10k(), 5_000.0);
    }

    #[test]
    fn xdp_run_must_record_the_actual_attach_mode() {
        let mut invalid = run(DropPoint::Xdp);
        invalid.xdp_attach_mode = XdpAttachMode::Unknown;
        assert_eq!(
            invalid.validate(),
            Err(ExperimentRunError::MissingXdpAttachMode)
        );
    }

    #[test]
    fn application_run_can_report_all_packets_reaching_userspace() {
        let mut application = run(DropPoint::Application);
        application.packets_received_by_app = application.packets_sent;
        assert_eq!(application.app_receive_percent(), 100.0);
        assert_eq!(application.validate(), Ok(()));
    }
}
