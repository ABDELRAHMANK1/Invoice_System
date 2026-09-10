"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import { DEFAULT_WORKING_DAYS, DUTCH_MONTHS, formatHoursNL } from "@/lib/workforce/domain";
import type { Employee, EmployeeMonthlySchedule, ScheduleDay, ScheduleTotals } from "@/lib/workforce/domain";

/**
 * Generate + review one employee's monthly Urenlijst.
 *
 * Hours only — this modal never shows or asks for a rate. The table below is the
 * same document the PDF prints: every calendar day in order, worked days tinted,
 * weekend rows tinted and marked, holidays and unselected weekdays blank.
 */

const EMPTY_TOTALS: ScheduleTotals = { hours: 0, overtime_hours: 0, km_allowance: 0, worked_days: 0 };

/** The generator's output as it comes back out of `schedule_data`. */
type ScheduleData = { days?: ScheduleDay[]; totals?: ScheduleTotals; warnings?: string[] };

interface ScheduleModalProps {
  clientId: string;
  employees: Employee[];
  /** Pre-selects a row's employee; falls back to the first one. */
  initialEmployeeId?: string | null;
  open: boolean;
  onClose: () => void;
}

function fmtDateNL(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

export default function ScheduleModal({ clientId, employees, initialEmployeeId, open, onClose }: ScheduleModalProps) {
  const { toast } = useToast();
  const now = new Date();

  const [employeeId, setEmployeeId] = useState("");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [totalHours, setTotalHours] = useState("160");
  const [workingDays, setWorkingDays] = useState(DEFAULT_WORKING_DAYS);
  const [loading, setLoading] = useState(false);
  const [schedule, setSchedule] = useState<EmployeeMonthlySchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const employee = employees.find((e) => e.id === employeeId) ?? null;

  useEffect(() => {
    if (!open) return;
    const pick = initialEmployeeId || employees.find((e) => e.active)?.id || employees[0]?.id || "";
    setEmployeeId(pick);
    setSchedule(null);
    setError(null);
  }, [open, initialEmployeeId, employees]);

  // Working days follows the selected employee's own monthly default, and stays
  // overridable for this one generation.
  useEffect(() => {
    const selected = employees.find((e) => e.id === employeeId);
    if (selected) setWorkingDays(selected.default_working_days);
  }, [employeeId, employees]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open && !loading) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, loading]);

  /** Show what was already generated for this period, if anything. 404 = none. */
  const loadExisting = useCallback(async () => {
    if (!open || !employeeId) return;
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/employees/${employeeId}/schedule?year=${year}&month=${month}`);
      setSchedule(res.ok ? await res.json() : null);
    } catch {
      setSchedule(null);
    }
  }, [open, clientId, employeeId, year, month]);

  useEffect(() => { loadExisting(); }, [loadExisting]);

  async function generate() {
    const hours = Number(totalHours);
    if (!employeeId) { setError("Pick an employee first"); return; }
    if (!Number.isFinite(hours) || hours < 0) { setError("Total hours must be a positive number"); return; }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/employees/${employeeId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, month, total_hours: hours, working_days: workingDays }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Generation failed (${res.status})`);
      setSchedule(data);
      toast(`Schedule generated for ${DUTCH_MONTHS[month - 1]} ${year}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  function downloadPdf() {
    // A programmatic <a download> click: window.open() after an await is
    // popup-blocked, the same reason the invoice modal does it this way.
    const a = document.createElement("a");
    a.href = `/api/clients/${clientId}/employees/${employeeId}/schedule/pdf?year=${year}&month=${month}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (!open) return null;

  const data = (schedule?.schedule_data ?? {}) as ScheduleData;
  const days = data.days ?? [];
  const totals = data.totals ?? EMPTY_TOTALS;
  const warnings = data.warnings ?? [];

  return (
    <div className="modal-backdrop" onClick={loading ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Generate monthly schedule"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(1040px, 100%)", maxHeight: "92vh" }}
      >
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.calendar} size={16} />
            Urenlijst — monthly schedule
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>

        <div style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", borderBottom: "1px solid var(--line)" }}>
          <div className="form-group" style={{ minWidth: 200, flex: 1 }}>
            <label className="form-label" htmlFor="sc-employee">Employee</label>
            <select
              id="sc-employee"
              className="form-input"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.active ? "" : " (inactive)"}</option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ width: 140 }}>
            <label className="form-label" htmlFor="sc-month">Month</label>
            <select id="sc-month" className="form-input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {DUTCH_MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
            </select>
          </div>

          <div className="form-group" style={{ width: 92 }}>
            <label className="form-label" htmlFor="sc-year">Year</label>
            <input id="sc-year" className="form-input" type="number" min="2000" max="2100"
              value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>

          <div className="form-group" style={{ width: 110 }}>
            <label className="form-label" htmlFor="sc-hours">Total hours</label>
            <input id="sc-hours" className="form-input" type="number" min="0" step="0.25"
              value={totalHours} onChange={(e) => setTotalHours(e.target.value)} />
          </div>

          <div className="form-group" style={{ width: 128 }}>
            {/* A MONTH total, like Total hours next to it — not a weekly count. */}
            <label className="form-label" htmlFor="sc-days">Working days</label>
            <input id="sc-days" className="form-input" type="number" min="0" max="31"
              value={workingDays} onChange={(e) => setWorkingDays(Number(e.target.value))} />
          </div>

          <button className="btn primary" onClick={generate} disabled={loading || !employeeId} style={{ marginBottom: 2 }}>
            {loading ? <><span className="spinner-sm" /> Generating…</> : <><Icon d={I.calendar} size={13} /> Generate</>}
          </button>
          <button className="btn" onClick={downloadPdf} disabled={!schedule || days.length === 0} style={{ marginBottom: 2 }}>
            <Icon d={I.download} size={13} /> Download PDF
          </button>
        </div>

        {error && <div className="modal-error" style={{ marginTop: 12 }}><Icon d={I.alert} size={13} />{error}</div>}

        <div style={{ overflow: "auto", padding: "12px 18px", flex: 1 }}>
          {!schedule ? (
            <div className="t-empty">
              {employee
                ? `No schedule generated for ${employee.name} in ${DUTCH_MONTHS[month - 1]} ${year} yet.`
                : "This client has no employees yet."}
            </div>
          ) : (
            <>
              {warnings.length > 0 && (
                <ul style={{ margin: "0 0 12px 0", padding: "10px 12px 10px 28px", borderRadius: "var(--r-sm)", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}>
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}

              <table className="t" style={{ width: "100%", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Dag</th>
                    <th>Begintijd</th>
                    <th>Eindtijd</th>
                    <th>Pauze (min)</th>
                    <th>Gewerkte uren</th>
                    <th>Overuren</th>
                    <th>Km vergoeding</th>
                    <th>Bijzonderheden</th>
                    <th>Handtekening</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr
                      key={d.date}
                      style={{
                        background: d.kind === "worked" ? "var(--good-soft)"
                                  : d.kind === "weekend" ? "var(--surface-2)"
                                  : undefined,
                      }}
                    >
                      <td className="mono">{fmtDateNL(d.date)}</td>
                      <td>{d.day_name}</td>
                      <td>{d.kind === "worked" ? d.start : ""}</td>
                      <td>{d.kind === "worked" ? d.end : ""}</td>
                      <td>{d.kind === "worked" ? d.break_minutes : ""}</td>
                      <td>{d.kind === "worked" ? formatHoursNL(d.hours) : ""}</td>
                      {/* Overuren + Km vergoeding are manual columns, out of scope. */}
                      <td />
                      <td />
                      <td style={{ color: "var(--muted)" }}>{d.kind === "weekend" ? "Weekend" : ""}</td>
                      <td />
                    </tr>
                  ))}
                  {/* Totals in order: hours, worked days, overuren, km. The day
                      count sits between the hours and the two static columns, so
                      each value carries its own unit — it no longer lines up with
                      the header above it. */}
                  <tr style={{ fontWeight: 600 }}>
                    <td colSpan={5}>TOTAAL {DUTCH_MONTHS[month - 1].toUpperCase()} {year}</td>
                    <td>{formatHoursNL(totals.hours)}</td>
                    <td>{totals.worked_days} dagen</td>
                    <td>{formatHoursNL(totals.overtime_hours)} overuren</td>
                    <td>{formatHoursNL(totals.km_allowance)} km</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={loading}>Close</button>
        </div>
      </div>
    </div>
  );
}
