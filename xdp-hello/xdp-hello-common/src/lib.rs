#![no_std]

/// 通常のフロー観測イベント。
pub const EVENT_KIND_FLOW: u8 = 0;
/// パケットレート閾値超過アラート。
pub const EVENT_KIND_RATE_ALERT: u8 = 1;

pub const PACKET_ACTION_PASS: u8 = 0;
pub const PACKET_ACTION_DROP: u8 = 1;

pub const DEFENSE_MODE_MONITOR: u32 = 0;
pub const DEFENSE_MODE_PROTECT: u32 = 1;
pub const CONFIG_MODE_INDEX: u32 = 0;
pub const CONFIG_BLOCKED_UDP_PORT_INDEX: u32 = 1;

pub const COUNTER_PASS_INDEX: u32 = 0;
pub const COUNTER_DROP_INDEX: u32 = 1;

/// packet-poipoi 自身の観測・制御経路。
///
/// これらを XDP の可視化対象にすると、Dashboard stream の ACK を観測して
/// 新しい flow event を生成し、その event への ACK をまた観測するという
/// 自己観測ループを作れるため、実験トラフィックとは分離する。
pub const fn is_control_plane_flow(protocol: u8, dst_port: u16) -> bool {
    const IPPROTO_TCP: u8 = 6;

    protocol == IPPROTO_TCP
        && matches!(dst_port, 22 | 9000 | 9001 | 9010 | 9020 | 9030)
}

pub const fn packet_action(mode: u32, protocol: u8, dst_port: u16, blocked_udp_port: u32) -> u8 {
    const IPPROTO_UDP: u8 = 17;

    if mode == DEFENSE_MODE_PROTECT
        && protocol == IPPROTO_UDP
        && dst_port as u32 == blocked_udp_port
    {
        PACKET_ACTION_DROP
    } else {
        PACKET_ACTION_PASS
    }
}

/// 負荷通信は64パケットに1件だけRingBufへ送り、集計は全件を保持する。
pub const ATTACK_FLOW_SAMPLE_EVERY: u64 = 64;

pub const fn should_emit_flow_sample(
    protocol: u8,
    dst_port: u16,
    blocked_udp_port: u32,
    packet_count: u64,
) -> bool {
    const IPPROTO_UDP: u8 = 17;

    if is_control_plane_flow(protocol, dst_port) {
        return false;
    }

    protocol != IPPROTO_UDP
        || dst_port as u32 != blocked_udp_port
        || packet_count % ATTACK_FLOW_SAMPLE_EVERY == 1
}

/// eBPFからRingBuf経由でユーザー空間へ渡すサンプルイベント。
///
/// 集計値はCOUNTERS mapを正として扱う。RingBufは個々の通信を
/// 画面へ表示するためのサンプル経路であり、混雑時の全数保証はしない。
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct FlowEvent {
    pub kind: u8,
    pub protocol: u8,
    pub action: u8,
    pub _pad: u8,
    pub src_addr: [u8; 4],
    pub dst_addr: [u8; 4],
    pub src_port: u16,
    pub dst_port: u16,
    /// レートアラート時の1秒間の観測数。flowでは0。
    pub rate: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_never_drops_the_attack_port() {
        assert_eq!(
            packet_action(DEFENSE_MODE_MONITOR, 17, 4000, 4000),
            PACKET_ACTION_PASS
        );
    }

    #[test]
    fn attack_flow_is_sampled_without_losing_kernel_counts() {
        assert!(should_emit_flow_sample(17, 4000, 4000, 1));
        assert!(!should_emit_flow_sample(17, 4000, 4000, 2));
        assert!(should_emit_flow_sample(17, 4000, 4000, 65));
        assert!(should_emit_flow_sample(6, 4000, 4000, 2));
        assert!(should_emit_flow_sample(17, 4001, 4000, 2));
    }

    #[test]
    fn control_plane_tcp_is_not_emitted() {
        for port in [22, 9000, 9001, 9010, 9020, 9030] {
            assert!(is_control_plane_flow(6, port));
            assert!(!should_emit_flow_sample(6, port, 4000, 1));
        }
        assert!(!is_control_plane_flow(6, 8080));
        assert!(!is_control_plane_flow(17, 9010));
    }

    #[test]
    fn protect_drops_only_configured_udp_port() {
        assert_eq!(
            packet_action(DEFENSE_MODE_PROTECT, 17, 4000, 4000),
            PACKET_ACTION_DROP
        );
        assert_eq!(
            packet_action(DEFENSE_MODE_PROTECT, 17, 4001, 4000),
            PACKET_ACTION_PASS
        );
        assert_eq!(
            packet_action(DEFENSE_MODE_PROTECT, 6, 4000, 4000),
            PACKET_ACTION_PASS
        );
    }
}
