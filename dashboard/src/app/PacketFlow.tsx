import { createElement } from "react";
import "./packet-diagram.js";

type DropPoint = "xdp" | "netfilter" | "application";

interface PacketFlowProps {
  selected: DropPoint;
  senderStatus: string;
  senderPps: string;
  attachMode: string;
  healthText: string;
  healthState: "waiting" | "ok" | "down";
}

export default function PacketFlow({
  selected,
  attachMode,
  healthText,
  healthState,
  senderStatus,
  senderPps,
}: PacketFlowProps) {
  return createElement("packet-network-diagram", {
    "data-stop": selected,
    "sender-status": senderStatus,
    "sender-pps": senderPps,
    "attach-mode": attachMode,
    "health-text": healthText,
    "health-state": healthState,
  });
}
