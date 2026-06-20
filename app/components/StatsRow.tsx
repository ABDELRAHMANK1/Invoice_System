import type { CSSProperties } from "react";

export interface StatCardProps {
  label:  string;
  value:  string;
  sub?:   string;
  accent: string;
}

function StatCard({ label, value, sub, accent }: StatCardProps) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      <span
        className="stat-bar"
        style={{ ["--stat-accent" as string]: accent } as CSSProperties}
      />
    </div>
  );
}

export function StatsRow({ cards }: { cards: StatCardProps[] }) {
  return (
    <div className="stats">
      {cards.map((c) => (
        <StatCard key={c.label} {...c} />
      ))}
    </div>
  );
}
