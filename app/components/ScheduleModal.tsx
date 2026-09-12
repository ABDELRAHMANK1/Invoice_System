"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import { DEFAULT_WORKING_DAYS, DUTCH_MONTHS, formatHoursNL } from "@/lib/workforce/domain";
import type {
  Employee,
  EmployeeMonthlySchedule,
  ScheduleDay,
  ScheduleOvertime,
  ScheduleTotals,
  ScheduleWarning,
  ScheduleWarningKind,
} from "@/lib/workforce/domain";

/**
 * Generate + review one employee's monthly Urenlijst.
 *
 * Hours only — this modal never shows or asks for a rate. The table below is the
 * same document the PDF prints: every calendar day in order, worked days tinted,
 * weekend rows tinted and marked, holidays and unselected weekdays blank.
 */

const EMPTY_TOTALS: ScheduleTotals = { hours: 0, overtime_hours: 0, km_allowance: 0, worked_days: 0 };

/** The generator's output as it comes back out of `schedule_data`. */
type ScheduleData = {
  days?: ScheduleDay[];
  totals?: ScheduleTotals;
  overtime?: ScheduleOvertime;
  warnings?: string[];
  warning_details?: ScheduleWarning[];
};

/**
 * How each class of warning is presented. The distinction matters to the reader:
 * an `action` warning means the schedule is INCOMPLETE until they do something
 * (the overtime form below is rendered for exactly these), an `input` one means
 * "go re-check what you typed", and a `capacity` one means the input may be
 * right and the month simply cannot hold it.
 */
const WARNING_STYLES: Record<ScheduleWarningKind, { label: string; icon: string | string[]; bg: string; fg: string }> = {
  action:   { label: "Needs your input", icon: I.alert, bg: "var(--danger-soft)", fg: "var(--danger)" },
  input:    { label: "Check the input",  icon: I.alert, bg: "var(--danger-soft)", fg: "var(--danger)" },
  capacity: { label: "Month is full",    icon: I.calendar, bg: "var(--warn-soft)", fg: "var(--warn)" },
  info:     { label: "Adjusted",         icon: I.check, bg: "var(--surface-2)", fg: "var(--muted)" },
};

const WARNING_ORDER: ScheduleWarningKind[] = ["action", "input", "capacity", "info"];

/** One row of the manual overtime-assignment form. */
type OvertimeRow = { date: string; hours: string };

interface ScheduleModalProps {
  clientId: string;
  employees: Employee[];
  /** Pre-selects a row's employee; falls back to the first one. */
  initialEmployeeId?: string | null;
  open: boolean;
  onClose: () => void;
}

/** A day carries worked time when it has distributed hours, overtime, or both. */
function worked(d: ScheduleDay): boolean {
  return d.hours > 0 || d.overtime_hours > 0;
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
  // The manual overtime-assignment form; one row per date the leftover is split
  // across. Seeded from whatever is already stored the first time it is shown.
  const [overtimeRows, setOvertimeRows] = useState<OvertimeRow[] | null>(null);
  const [savingOvertime, setSavingOvertime] = useState(false);

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
      setOvertimeRows(null);
    } catch {
      setSchedule(null);
      setOvertimeRows(null);
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
      setOvertimeRows(null);
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
  // Schedules generated before warnings were classified only have the flat
  // strings; show them as plain notes rather than dropping them.
  const warnings: ScheduleWarning[] = data.warning_details
    ?? (data.warnings ?? []).map((message) => ({ code: "holidays_skipped" as const, kind: "info" as const, message }));
  const warningsByKind = WARNING_ORDER
    .map((kind) => ({ kind, items: warnings.filter((w) => w.kind === kind) }))
    .filter((group) => group.items.length > 0);

  const overtime = data.overtime;
  const workedDates = days.filter((d) => d.hours > 0).map((d) => d.date);
  // Show the form whenever there is leftover to place OR something already
  // assigned (so an assignment can be edited or cleared afterwards).
  const showOvertimeForm = !!overtime && (overtime.leftover_hours > 0 || overtime.assignments.length > 0);

  /**
   * Seed the form: whatever is already assigned, else a single row pre-filled
   * with the full outstanding amount on the last worked day — the sensible
   * default, which the user can then edit or split.
   */
  const seededRows: OvertimeRow[] = overtime && overtime.assignments.length > 0
    ? overtime.assignments.map((a) => ({ date: a.date, hours: String(a.hours) }))
    : [{
        date: workedDates.at(-1) ?? days.at(-1)?.date ?? "",
        hours: overtime ? String(overtime.unassigned_hours) : "",
      }];
  const rows = overtimeRows ?? seededRows;

  const rowsTotal = rows.reduce((sum, r) => {
    const n = Number(r.hours);
    return sum + (Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0);
  }, 0) / 100;

  function setRow(i: number, patch: Partial<OvertimeRow>) {
    setOvertimeRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function saveOvertime() {
    const assignments = rows
      .map((r) => ({ date: r.date, hours: Number(r.hours) }))
      .filter((a) => a.date && Number.isFinite(a.hours) && a.hours > 0);

    setSavingOvertime(true);
    setError(null);
    try {
      // A full replace of the month's assignment set — an empty list clears it.
      const res = await fetch(`/api/clients/${clientId}/employees/${employeeId}/schedule/overtime`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, month, assignments }),
      });
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error || `Assignment failed (${res.status})`);
      setSchedule(saved);
      setOvertimeRows(null);
      toast(assignments.length === 0 ? "Overtime cleared" : "Overtime assigned", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed");
    } finally {
      setSavingOvertime(false);
    }
  }

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
              {warningsByKind.map(({ kind, items }) => {
                const style = WARNING_STYLES[kind];
                return (
                  <div
                    key={kind}
                    role={kind === "action" || kind === "input" ? "alert" : undefined}
                    style={{
                      display: "flex", gap: 8, alignItems: "flex-start",
                      margin: "0 0 8px 0", padding: "10px 12px",
                      borderRadius: "var(--r-sm)",
                      background: style.bg, color: style.fg, fontSize: 12.5,
                      border: kind === "action" || kind === "input"
                        ? "1px solid currentColor" : "1px solid transparent",
                    }}
                  >
                    <Icon d={style.icon} size={14} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, marginBottom: items.length > 1 ? 4 : 2 }}>{style.label}</div>
                      <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                        {items.map((w) => <li key={w.code}>{w.message}</li>)}
                      </ul>
                    </div>
                  </div>
                );
              })}

              {showOvertimeForm && (
                <div style={{
                  margin: "0 0 12px 0", padding: "12px 14px",
                  border: "1px solid var(--accent-line)", borderRadius: "var(--r-sm)",
                  background: "var(--accent-soft)",
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>Assign overtime</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
                    Every scheduled day is capped at the client&apos;s daily maximum, so{" "}
                    {formatHoursNL(overtime!.leftover_hours)} hours spilled over. Pick the date(s)
                    they were actually worked — add a row to split them across more than one.
                  </div>

                  {rows.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8 }}>
                      <div className="form-group" style={{ flex: 1, minWidth: 150, margin: 0 }}>
                        <label className="form-label" htmlFor={`ot-date-${i}`}>Date</label>
                        <select
                          id={`ot-date-${i}`}
                          className="form-input"
                          value={r.date}
                          onChange={(e) => setRow(i, { date: e.target.value })}
                        >
                          {/* Any date in the month, not just the scheduled ones —
                              overtime is often worked on a day the plan left free. */}
                          {days.map((d) => (
                            <option key={d.date} value={d.date}>
                              {fmtDateNL(d.date)} — {d.day_name}
                              {d.hours > 0 ? ` (${formatHoursNL(d.hours)} h)` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group" style={{ width: 120, margin: 0 }}>
                        <label className="form-label" htmlFor={`ot-hours-${i}`}>Overtime hours</label>
                        <input
                          id={`ot-hours-${i}`}
                          className="form-input"
                          type="number" min="0" max="24" step="0.25"
                          value={r.hours}
                          onChange={(e) => setRow(i, { hours: e.target.value })}
                        />
                      </div>
                      <button
                        className="btn"
                        aria-label={`Remove overtime row ${i + 1}`}
                        onClick={() => setOvertimeRows(rows.filter((_, idx) => idx !== i))}
                        disabled={rows.length === 1}
                        style={{ marginBottom: 1 }}
                      >
                        <Icon d={I.trash} size={13} />
                      </button>
                    </div>
                  ))}

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      className="btn"
                      onClick={() => setOvertimeRows([...rows, { date: workedDates.at(-1) ?? days[0]?.date ?? "", hours: "" }])}
                    >
                      + Add date
                    </button>
                    <button className="btn primary" onClick={saveOvertime} disabled={savingOvertime}>
                      {savingOvertime ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} /> Save overtime</>}
                    </button>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {formatHoursNL(rowsTotal)} of {formatHoursNL(overtime!.leftover_hours)} hours assigned
                      {Math.abs(rowsTotal - overtime!.leftover_hours) > 0.001 && (
                        <strong style={{ color: "var(--warn)" }}>
                          {" "}— {formatHoursNL(Math.abs(rowsTotal - overtime!.leftover_hours))} h
                          {rowsTotal > overtime!.leftover_hours ? " over" : " still unassigned"}
                        </strong>
                      )}
                    </span>
                  </div>
                </div>
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
                        background: d.hours > 0 || d.overtime_hours > 0 ? "var(--good-soft)"
                                  : d.kind === "weekend" ? "var(--surface-2)"
                                  : undefined,
                      }}
                    >
                      <td className="mono">{fmtDateNL(d.date)}</td>
                      <td>{d.day_name}</td>
                      {/* Times show for any day carrying worked time, including a
                          date that only received manually assigned overtime. */}
                      <td>{worked(d) ? d.start : ""}</td>
                      <td>{worked(d) ? d.end : ""}</td>
                      <td>{worked(d) ? d.break_minutes : ""}</td>
                      <td>{d.hours > 0 ? formatHoursNL(d.hours) : ""}</td>
                      <td style={{ fontWeight: d.overtime_hours > 0 ? 600 : undefined }}>
                        {d.overtime_hours > 0 ? formatHoursNL(d.overtime_hours) : ""}
                      </td>
                      {/* Km vergoeding stays a manual column, out of scope. */}
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
