function fmtEUR(n: number) {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
}

interface StatCardProps {
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
        style={{ ["--stat-accent" as string]: accent } as React.CSSProperties}
      />
    </div>
  );
}

interface StatsRowProps {
  total:         number;
  totalAmount:   number;
  pending:       number;
  avgConfidence: number;
}

export function StatsRow({ total, totalAmount, pending, avgConfidence }: StatsRowProps) {
  return (
    <div className="stats">
      <StatCard
        label="Invoices this month"
        value={String(total)}
        sub={`of ${total} total`}
        accent="#0ea5e9"
      />
      <StatCard
        label="Value this month"
        value={fmtEUR(totalAmount)}
        sub="net total"
        accent="#10b981"
      />
      <StatCard
        label="Pending review"
        value={String(pending)}
        sub="needs your attention"
        accent="#f59e0b"
      />
      <StatCard
        label="Avg. confidence"
        value={`${avgConfidence}%`}
        sub={total > 0 ? `across ${total} invoices` : ""}
        accent="#6366f1"
      />
    </div>
  );
}
