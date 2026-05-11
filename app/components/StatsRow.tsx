import { Icon, I, Sparkline } from "./Icon";

const SPARK_INVOICES = [4,6,5,8,7,9,11,10,12,14,13,16,15,18];
const SPARK_AMOUNT   = [320,410,380,520,470,610,580,720,690,840,810,960,930,1049];
const SPARK_PENDING  = [3,2,4,3,5,4,6,5,4,3,4,2,3,1];
const SPARK_CONF     = [82,85,84,88,87,90,89,92,91,93,94,95,96,97];

function fmtEUR(n: number) {
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
}

interface StatCardProps {
  label: string;
  value: string;
  delta: string;
  up?: boolean;
  spark?: number[];
  sparkColor?: string;
}

function StatCard({ label, value, delta, up = true, spark, sparkColor }: StatCardProps) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      <div className="stat-footer">
        <span className={`delta ${up ? "up" : "dn"}`}>
          <Icon d={up ? I.arrowUp : I.arrowDown} size={11} stroke={2.4} />
          {delta}
        </span>
        {spark && (
          <span style={{ color: sparkColor }}>
            <Sparkline data={spark} color="currentColor" w={88} h={26} fill />
          </span>
        )}
      </div>
    </div>
  );
}

interface StatsRowProps {
  total: number;
  totalAmount: number;
  pending: number;
  avgConfidence: number;
}

export function StatsRow({ total, totalAmount, pending, avgConfidence }: StatsRowProps) {
  return (
    <div className="stats">
      <StatCard
        label="Total invoices"
        value={String(total)}
        delta="+12% MTD"
        up
        spark={SPARK_INVOICES}
        sparkColor="var(--accent)"
      />
      <StatCard
        label="Total amount"
        value={fmtEUR(totalAmount)}
        delta="+8.4% MTD"
        up
        spark={SPARK_AMOUNT}
        sparkColor="#1f8a5b"
      />
      <StatCard
        label="Pending review"
        value={String(pending)}
        delta="-2 vs last week"
        up
        spark={SPARK_PENDING}
        sparkColor="#b45309"
      />
      <StatCard
        label="Avg. confidence"
        value={`${avgConfidence}%`}
        delta="+1.2 pts"
        up
        spark={SPARK_CONF}
        sparkColor="#2563eb"
      />
    </div>
  );
}
