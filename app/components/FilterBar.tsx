"use client";

import { Icon, I } from "./Icon";

export type FilterQuery = {
  phone: string;
  client: string;
  invoice: string;
  from: string;
  to: string;
  type: "Alle" | "Inkoop" | "Verkoop";
};

export type AppliedChip = { k: string; v: string };

const QUICK_CHIPS = [
  { k: "today",   label: "Today" },
  { k: "week",    label: "This week" },
  { k: "month",   label: "This month" },
  { k: "pending", label: "Pending review" },
  { k: "high",    label: "Above €500" },
];

interface FilterBarProps {
  q: FilterQuery;
  setQ: (q: FilterQuery) => void;
  quickOn: string;
  setQuickOn: (k: string) => void;
  applied: AppliedChip[];
  removeApplied: (k: string) => void;
  onSearch: () => void;
  onClear: () => void;
}

export function FilterBar({
  q, setQ, quickOn, setQuickOn, applied, removeApplied, onSearch, onClear,
}: FilterBarProps) {
  return (
    <div className="filters">
      <div className="fbar">
        <div className="field">
          <Icon d={I.phone} size={14} />
          <span className="field-lab">Phone</span>
          <div className="field-sep" />
          <input
            value={q.phone}
            onChange={(e) => setQ({ ...q, phone: e.target.value })}
            placeholder="+31 6 12 34 56 78"
            aria-label="Filter by phone"
          />
        </div>

        <div className="field">
          <Icon d={I.user} size={14} />
          <span className="field-lab">Client</span>
          <div className="field-sep" />
          <input
            value={q.client}
            onChange={(e) => setQ({ ...q, client: e.target.value })}
            placeholder="NemaFood B.V."
            aria-label="Filter by client"
          />
        </div>

        <div className="field">
          <Icon d={I.hash} size={14} />
          <span className="field-lab">Invoice #</span>
          <div className="field-sep" />
          <input
            value={q.invoice}
            onChange={(e) => setQ({ ...q, invoice: e.target.value })}
            placeholder="261502"
            aria-label="Filter by invoice number"
          />
        </div>

        <div className="field">
          <Icon d={I.calendar} size={14} />
          <span className="field-lab">From</span>
          <div className="field-sep" />
          <input
            type="date"
            value={q.from}
            onChange={(e) => setQ({ ...q, from: e.target.value })}
            aria-label="From date"
          />
        </div>

        <div className="field">
          <Icon d={I.calendar} size={14} />
          <span className="field-lab">To</span>
          <div className="field-sep" />
          <input
            type="date"
            value={q.to}
            onChange={(e) => setQ({ ...q, to: e.target.value })}
            aria-label="To date"
          />
        </div>

        <div className="seg" role="group" aria-label="Invoice type">
          {(["Alle", "Inkoop", "Verkoop"] as const).map((t) => (
            <button
              key={t}
              className={q.type === t ? "on" : ""}
              onClick={() => setQ({ ...q, type: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="quick" role="group" aria-label="Quick filters">
        <span className="quick-lbl" aria-hidden="true">Quick</span>

        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip.k}
            className={`chip${quickOn === chip.k ? " on" : ""}`}
            onClick={() => setQuickOn(quickOn === chip.k ? "" : chip.k)}
            aria-pressed={quickOn === chip.k}
          >
            {quickOn === chip.k && <Icon d={I.check} size={11} stroke={2.4} />}
            {chip.label}
          </button>
        ))}

        {applied.length > 0 && (
          <span className="quick-divider" aria-hidden="true" />
        )}

        {applied.map((a) => (
          <span key={a.k} className="chip applied">
            <span className="chip-key">{a.k}:</span>
            <span className="chip-val">{a.v}</span>
            <button
              className="chip-x"
              onClick={() => removeApplied(a.k)}
              aria-label={`Remove ${a.k} filter`}
            >
              <Icon d={I.x} size={11} stroke={2.2} />
            </button>
          </span>
        ))}

        <span style={{ flex: 1 }} />

        <button className="btn sm" onClick={onClear} aria-label="Clear all filters">
          <Icon d={I.refresh} size={12} stroke={2} /> Clear
        </button>
        <button className="btn sm primary" onClick={onSearch} aria-label="Apply search">
          <Icon d={I.search} size={12} stroke={2.2} /> Search
        </button>
      </div>
    </div>
  );
}
