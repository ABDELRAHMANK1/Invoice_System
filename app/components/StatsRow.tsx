import type { CSSProperties } from "react";

export interface StatCardProps {
  label:  string;
  value:  string;
  sub?:   string;
  accent: string;
  /** Makes the card a filter toggle. Omit for a plain, non-interactive card. */
  onClick?: () => void;
  /** Pressed state — only meaningful together with onClick. */
  active?: boolean;
  title?: string;
}

function StatCard({ label, value, sub, accent, onClick, active, title }: StatCardProps) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      <span
        className="stat-bar"
        style={{ ["--stat-accent" as string]: accent } as CSSProperties}
      />
    </>
  );

  // A card that filters the table is a real control, so it renders as a button
  // (focusable, keyboard-activatable, announced as pressed). A card that only
  // reports a number stays a plain div — nothing should look clickable unless
  // it is.
  if (!onClick) return <div className="stat">{body}</div>;

  return (
    <button type="button" className="stat clickable" onClick={onClick} aria-pressed={!!active} title={title}>
      {body}
    </button>
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
