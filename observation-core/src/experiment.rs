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

/// 実測値の解釈に必要なPi B側の実行環境。
///
/// 古いrunも読めるよう各項目は空値を許す。比較結果を公開するときは、
/// dashboardの計測方法パネルでunknownが残っていないことを確認する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ExperimentEnvironment {
    #[serde(default)]
    pub receiver_model: String,
    #[serde(default)]
    pub kernel_release: String,
    #[serde(default)]
    pub network_interface: String,
    #[serde(default)]
    pub mtu: Option<u32>,
    #[serde(default)]
    pub cpu_governor: String,
}

/// 1つの負荷条件で繰り返したHTTP probeの集計。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceHealthSummary {
    pub checks: u64,
    pub successes: u64,
    pub latency_p95_ms: u64,
    pub latency_max_ms: u64,
    pub min_success_percent: f32,
    pub max_p95_latency_ms: u64,
}

impl ServiceHealthSummary {
    pub fn success_percent(&self) -> f32 {
        if self.checks == 0 {
            return 0.0;
        }
        self.successes as f32 * 100.0 / self.checks as f32
    }

    pub fn service_maintained(&self) -> bool {
        self.checks > 0
            && self.success_percent() >= self.min_success_percent
            && self.latency_p95_ms <= self.max_p95_latency_ms
    }

    fn validate(&self) -> Result<(), ExperimentRunError> {
        if self.checks == 0 {
            return Err(ExperimentRunError::ZeroHealthChecks);
        }
        if self.successes > self.checks {
            return Err(ExperimentRunError::HealthSuccessesExceedChecks);
        }
        if !self.min_success_percent.is_finite()
            || !(0.0..=100.0).contains(&self.min_success_percent)
        {
            return Err(ExperimentRunError::InvalidHealthSuccessThreshold);
        }
        if self.max_p95_latency_ms == 0 {
            return Err(ExperimentRunError::ZeroHealthLatencyThreshold);
        }
        if self.latency_p95_ms > self.latency_max_ms {
            return Err(ExperimentRunError::HealthP95ExceedsMaximum);
        }
        Ok(())
    }
}

/// 段階的に負荷を上げる実験全体の条件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SweepPlan {
    pub pps_steps: Vec<u64>,
    pub repetitions: u16,
    /// 送信側が目標rateを実際に出せたとみなす最低割合。
    #[serde(default = "default_min_load_delivery_percent")]
    pub min_load_delivery_percent: u8,
}

impl SweepPlan {
    fn validate(&self, target_pps: u64) -> Result<(), ExperimentRunError> {
        if self.repetitions == 0 {
            return Err(ExperimentRunError::ZeroSweepRepetitions);
        }
        if !(1..=100).contains(&self.min_load_delivery_percent) {
            return Err(ExperimentRunError::InvalidLoadDeliveryThreshold);
        }
        if self.pps_steps.is_empty()
            || self.pps_steps.iter().any(|pps| *pps == 0)
            || self.pps_steps.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(ExperimentRunError::InvalidSweepSteps);
        }
        if !self.pps_steps.contains(&target_pps) {
            return Err(ExperimentRunError::TargetMissingFromSweep);
        }
        Ok(())
    }
}

const fn default_min_load_delivery_percent() -> u8 {
    90
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
    #[serde(default)]
    pub environment: ExperimentEnvironment,
    /// 古い固定rate実験との互換性を保つため、sweep実験だけ値を持つ。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_health: Option<ServiceHealthSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sweep: Option<SweepPlan>,
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

    /// 設定値ではなく、計測時間と送信数から求めた実送信rate。
    pub fn actual_pps(&self) -> f32 {
        if self.duration_ms == 0 {
            return 0.0;
        }
        self.packets_sent as f32 * 1_000.0 / self.duration_ms as f32
    }

    /// 目標rateに対して、送信側が実際に出せた割合。
    pub fn load_delivery_percent(&self) -> f32 {
        if self.target_pps == 0 {
            return 0.0;
        }
        self.actual_pps() * 100.0 / self.target_pps as f32
    }

    /// 送信側の限界を、受信側サービスの限界と誤認しないための判定。
    pub fn load_rate_achieved(&self) -> bool {
        match &self.sweep {
            Some(sweep) => {
                self.load_delivery_percent() >= f32::from(sweep.min_load_delivery_percent)
            }
            None => true,
        }
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
        if let Some(service_health) = &self.service_health {
            service_health.validate()?;
        }
        if let Some(sweep) = &self.sweep {
            sweep.validate(self.target_pps)?;
            if self.repetition > sweep.repetitions {
                return Err(ExperimentRunError::RepetitionExceedsSweep);
            }
            if self.service_health.is_none() {
                return Err(ExperimentRunError::SweepMissingServiceHealth);
            }
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
    ZeroHealthChecks,
    HealthSuccessesExceedChecks,
    InvalidHealthSuccessThreshold,
    ZeroHealthLatencyThreshold,
    HealthP95ExceedsMaximum,
    ZeroSweepRepetitions,
    InvalidLoadDeliveryThreshold,
    InvalidSweepSteps,
    TargetMissingFromSweep,
    RepetitionExceedsSweep,
    SweepMissingServiceHealth,
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
            environment: ExperimentEnvironment::default(),
            service_health: None,
            sweep: None,
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

    #[test]
    fn decides_whether_the_service_met_its_thresholds() {
        let health = ServiceHealthSummary {
            checks: 50,
            successes: 50,
            latency_p95_ms: 42,
            latency_max_ms: 70,
            min_success_percent: 99.0,
            max_p95_latency_ms: 100,
        };
        assert_eq!(health.success_percent(), 100.0);
        assert!(health.service_maintained());
    }

    #[test]
    fn sweep_run_records_plan_and_service_health() {
        let mut sweep_run = run(DropPoint::Xdp);
        sweep_run.service_health = Some(ServiceHealthSummary {
            checks: 50,
            successes: 49,
            latency_p95_ms: 80,
            latency_max_ms: 120,
            min_success_percent: 98.0,
            max_p95_latency_ms: 100,
        });
        sweep_run.sweep = Some(SweepPlan {
            pps_steps: vec![500, 2_000, 5_000],
            repetitions: 3,
            min_load_delivery_percent: 90,
        });
        assert_eq!(sweep_run.validate(), Ok(()));
    }

    #[test]
    fn records_actual_load_instead_of_trusting_the_target() {
        let mut measured = run(DropPoint::Application);
        measured.duration_ms = 10_000;
        measured.target_pps = 2_000;
        measured.packets_sent = 18_000;
        measured.sweep = Some(SweepPlan {
            pps_steps: vec![500, 2_000, 5_000],
            repetitions: 3,
            min_load_delivery_percent: 90,
        });
        measured.service_health = Some(ServiceHealthSummary {
            checks: 50,
            successes: 50,
            latency_p95_ms: 20,
            latency_max_ms: 25,
            min_success_percent: 99.0,
            max_p95_latency_ms: 100,
        });

        assert_eq!(measured.actual_pps(), 1_800.0);
        assert_eq!(measured.load_delivery_percent(), 90.0);
        assert!(measured.load_rate_achieved());

        measured.packets_sent = 17_999;
        assert!(!measured.load_rate_achieved());
    }
}
