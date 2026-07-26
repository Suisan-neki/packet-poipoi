#![no_std]
#![no_main]

use aya_ebpf::{
    bindings::{BPF_ANY, xdp_action},
    helpers::bpf_ktime_get_ns,
    macros::{map, xdp},
    maps::{Array, HashMap, PerCpuArray, RingBuf},
    programs::XdpContext,
};
use aya_log_ebpf::warn;
use core::mem;
use xdp_hello_common::{
    CONFIG_BLOCKED_UDP_PORT_INDEX, CONFIG_MODE_INDEX, COUNTER_DROP_INDEX, COUNTER_PASS_INDEX,
    EVENT_KIND_FLOW, EVENT_KIND_RATE_ALERT, FlowEvent, PACKET_ACTION_DROP,
    PACKET_ACTION_PASS, packet_action, should_emit_flow_sample,
};

const ETH_HDR_LEN: usize = 14;
const ETH_P_IP: u16 = 0x0800;
const IPPROTO_ICMP: u8 = 1;
const IPPROTO_TCP: u8 = 6;
const IPPROTO_UDP: u8 = 17;

const ETH_TYPE_OFFSET: usize = 12;
const IPV4_VERSION_IHL_OFFSET: usize = ETH_HDR_LEN;
const IPV4_PROTOCOL_OFFSET: usize = ETH_HDR_LEN + 9;
const IPV4_SRC_ADDR_OFFSET: usize = ETH_HDR_LEN + 12;
const IPV4_DST_ADDR_OFFSET: usize = ETH_HDR_LEN + 16;
const IPV4_MIN_HDR_LEN: usize = 20;
const TRANSPORT_OFFSET_WITHOUT_IPV4_OPTIONS: usize = ETH_HDR_LEN + IPV4_MIN_HDR_LEN;
const PACKET_RATE_WINDOW_NS: u64 = 1_000_000_000;
const PACKET_RATE_THRESHOLD: u32 = 100;

#[repr(C)]
#[derive(Clone, Copy)]
struct PacketWindow {
    window_start_ns: u64,
    count: u32,
    warned: u32,
}

#[map]
static EVENTS: RingBuf = RingBuf::with_byte_size(1 << 20, 0);

/// index 0: defense mode, index 1: blocked UDP destination port.
#[map]
static DEFENSE_CONFIG: Array<u32> = Array::with_max_entries(2, 0);

/// index 0: XDP_PASS, index 1: XDP_DROP. CPUごとに競合せず加算する。
#[map]
static COUNTERS: PerCpuArray<u64> = PerCpuArray::with_max_entries(2, 0);

#[map]
static PACKET_WINDOWS: HashMap<u32, PacketWindow> = HashMap::with_max_entries(1024, 0);

#[xdp]
pub fn xdp_hello(ctx: XdpContext) -> u32 {
    match try_xdp_hello(ctx) {
        Ok(ret) => ret,
        Err(_) => xdp_action::XDP_ABORTED,
    }
}

fn try_xdp_hello(ctx: XdpContext) -> Result<u32, u32> {
    let eth_type = read_be_u16(&ctx, ETH_TYPE_OFFSET)?;
    if eth_type != ETH_P_IP {
        return Ok(xdp_action::XDP_PASS);
    }

    ptr_at::<[u8; IPV4_MIN_HDR_LEN]>(&ctx, ETH_HDR_LEN)?;

    let version_ihl = unsafe { *ptr_at::<u8>(&ctx, IPV4_VERSION_IHL_OFFSET)? };
    let version = version_ihl >> 4;
    let ihl = version_ihl & 0x0f;
    if version != 4 || ihl < 5 {
        return Ok(xdp_action::XDP_PASS);
    }
    if ihl != 5 {
        return Ok(xdp_action::XDP_PASS);
    }

    let protocol = read_u8(&ctx, IPV4_PROTOCOL_OFFSET)?;
    let src_addr = read_ipv4_addr(&ctx, IPV4_SRC_ADDR_OFFSET)?;
    let dst_addr = read_ipv4_addr(&ctx, IPV4_DST_ADDR_OFFSET)?;
    detect_packet_rate(&ctx, dst_addr);
    let transport_offset = TRANSPORT_OFFSET_WITHOUT_IPV4_OPTIONS;
    match protocol {
        IPPROTO_ICMP => {
            ptr_at::<u8>(&ctx, transport_offset)?;
            record_packet(
                src_addr,
                dst_addr,
                0,
                0,
                IPPROTO_ICMP,
                PACKET_ACTION_PASS,
            );
        }
        IPPROTO_TCP => {
            let ports = ptr_at::<[u8; 4]>(&ctx, transport_offset)? as *const u8;
            let src_port = read_be_u16_at(ports);
            let dst_port = read_be_u16_at(unsafe { ports.add(2) });
            record_packet(
                src_addr,
                dst_addr,
                src_port,
                dst_port,
                IPPROTO_TCP,
                PACKET_ACTION_PASS,
            );
        }
        IPPROTO_UDP => {
            let ports = ptr_at::<[u8; 4]>(&ctx, transport_offset)? as *const u8;
            let src_port = read_be_u16_at(ports);
            let dst_port = read_be_u16_at(unsafe { ports.add(2) });
            let action = udp_action(dst_port);
            record_packet(src_addr, dst_addr, src_port, dst_port, IPPROTO_UDP, action);
            if action == PACKET_ACTION_DROP {
                return Ok(xdp_action::XDP_DROP);
            }
        }
        _ => {}
    }

    Ok(xdp_action::XDP_PASS)
}

#[inline(always)]
fn ptr_at<T>(ctx: &XdpContext, offset: usize) -> Result<*const T, u32> {
    let start = ctx.data();
    let end = ctx.data_end();
    let len = mem::size_of::<T>();

    if start + offset + len > end {
        return Err(xdp_action::XDP_ABORTED);
    }

    Ok((start + offset) as *const T)
}

#[inline(always)]
fn read_u8(ctx: &XdpContext, offset: usize) -> Result<u8, u32> {
    Ok(unsafe { *ptr_at::<u8>(ctx, offset)? })
}

#[inline(always)]
fn read_be_u16(ctx: &XdpContext, offset: usize) -> Result<u16, u32> {
    let high = read_u8(ctx, offset)? as u16;
    let low = read_u8(ctx, offset + 1)? as u16;

    Ok((high << 8) | low)
}

#[inline(always)]
fn read_ipv4_addr(ctx: &XdpContext, offset: usize) -> Result<[u8; 4], u32> {
    let addr = ptr_at::<[u8; 4]>(ctx, offset)? as *const u8;

    Ok([
        unsafe { *addr },
        unsafe { *addr.add(1) },
        unsafe { *addr.add(2) },
        unsafe { *addr.add(3) },
    ])
}

#[inline(always)]
fn read_be_u16_at(ptr: *const u8) -> u16 {
    let high = unsafe { *ptr } as u16;
    let low = unsafe { *ptr.add(1) } as u16;

    (high << 8) | low
}

#[inline(always)]
fn udp_action(dst_port: u16) -> u8 {
    let mode = DEFENSE_CONFIG
        .get(CONFIG_MODE_INDEX)
        .copied()
        .unwrap_or_default();
    let blocked_port = DEFENSE_CONFIG
        .get(CONFIG_BLOCKED_UDP_PORT_INDEX)
        .copied()
        .unwrap_or_default();

    packet_action(mode, IPPROTO_UDP, dst_port, blocked_port)
}

#[inline(always)]
fn increment_counter(action: u8) -> u64 {
    let index = if action == PACKET_ACTION_DROP {
        COUNTER_DROP_INDEX
    } else {
        COUNTER_PASS_INDEX
    };
    if let Some(value) = COUNTERS.get_ptr_mut(index) {
        unsafe {
            *value += 1;
            *value
        }
    } else {
        0
    }
}

#[inline(always)]
fn record_packet(
    src_addr: [u8; 4],
    dst_addr: [u8; 4],
    src_port: u16,
    dst_port: u16,
    protocol: u8,
    action: u8,
) {
    let packet_count = increment_counter(action);
    let blocked_port = DEFENSE_CONFIG
        .get(CONFIG_BLOCKED_UDP_PORT_INDEX)
        .copied()
        .unwrap_or_default();
    if !should_emit_flow_sample(protocol, dst_port, blocked_port, packet_count) {
        return;
    }

    let Some(mut entry) = EVENTS.reserve::<FlowEvent>(0) else {
        return;
    };

    entry.write(FlowEvent {
        kind: EVENT_KIND_FLOW,
        protocol,
        action,
        _pad: 0,
        src_addr,
        dst_addr,
        src_port,
        dst_port,
        rate: 0,
    });
    entry.submit(0);
}

#[inline(always)]
fn emit_rate_alert(dst_addr: [u8; 4], rate: u32) {
    let Some(mut entry) = EVENTS.reserve::<FlowEvent>(0) else {
        return;
    };

    entry.write(FlowEvent {
        kind: EVENT_KIND_RATE_ALERT,
        protocol: 0,
        action: PACKET_ACTION_PASS,
        _pad: 0,
        src_addr: [0; 4],
        dst_addr,
        src_port: 0,
        dst_port: 0,
        rate,
    });
    entry.submit(0);
}

#[inline(always)]
fn detect_packet_rate(ctx: &XdpContext, dst_addr: [u8; 4]) {
    let now_ns = unsafe { bpf_ktime_get_ns() };
    let key = ipv4_addr_key(dst_addr);

    match PACKET_WINDOWS.get_ptr_mut(&key) {
        Some(window) => unsafe {
            if now_ns - (*window).window_start_ns >= PACKET_RATE_WINDOW_NS {
                (*window).window_start_ns = now_ns;
                (*window).count = 1;
                (*window).warned = 0;
                return;
            }

            (*window).count += 1;
            if (*window).count >= PACKET_RATE_THRESHOLD && (*window).warned == 0 {
                (*window).warned = 1;
                let rate = (*window).count;
                warn!(
                    ctx,
                    "high packet rate: dst={}.{}.{}.{}, count={} in 1s",
                    dst_addr[0],
                    dst_addr[1],
                    dst_addr[2],
                    dst_addr[3],
                    rate
                );
                emit_rate_alert(dst_addr, rate);
            }
        },
        None => {
            let window = PacketWindow {
                window_start_ns: now_ns,
                count: 1,
                warned: 0,
            };
            let _ = PACKET_WINDOWS.insert(&key, &window, BPF_ANY as u64);
        }
    }
}

#[inline(always)]
fn ipv4_addr_key(addr: [u8; 4]) -> u32 {
    ((addr[0] as u32) << 24) | ((addr[1] as u32) << 16) | ((addr[2] as u32) << 8) | addr[3] as u32
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[unsafe(link_section = "license")]
#[unsafe(no_mangle)]
static LICENSE: [u8; 13] = *b"Dual MIT/GPL\0";
