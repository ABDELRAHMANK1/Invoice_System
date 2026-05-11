interface ConfidenceBarProps {
  /** 0–100 integer */
  pct: number;
}

export function ConfidenceBar({ pct }: ConfidenceBarProps) {
  const tone = pct >= 95 ? "" : pct >= 80 ? "" : pct >= 60 ? "warn" : "danger";
  return (
    <div className={`conf${tone ? ` ${tone}` : ""}`}>
      <div className="conf-bar">
        <span className="conf-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="conf-pct">{pct}%</div>
    </div>
  );
}
