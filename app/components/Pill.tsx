import { Icon, I } from "./Icon";

export type StatusTone = "good" | "info" | "warn" | "danger";

interface PillProps {
  tone?: StatusTone;
  children: React.ReactNode;
}

export function Pill({ tone = "info", children }: PillProps) {
  return (
    <span className={`pill s-${tone}`}>
      <span className="pill-dot" />
      {children}
    </span>
  );
}

interface TypePillProps {
  type: "Inkoop" | "Verkoop";
}

export function TypePill({ type }: TypePillProps) {
  return (
    <span className={`pill ${type === "Inkoop" ? "t-inkoop" : "t-verkoop"}`}>
      <Icon d={type === "Inkoop" ? I.inflow : I.outflow} size={11} stroke={2} />
      {type}
    </span>
  );
}

export function statusTone(status: string): StatusTone {
  if (status === "extracted" || status === "done") return "good";
  if (status === "pending" || status === "processing") return "info";
  if (status === "review") return "warn";
  return "danger";
}

export function statusLabel(status: string): string {
  if (status === "extracted") return "extracted";
  if (status === "done") return "extracted";
  if (status === "pending") return "pending";
  if (status === "processing") return "processing";
  if (status === "review") return "needs review";
  return "failed";
}
