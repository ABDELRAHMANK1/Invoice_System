"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { Menu, type MenuEntry } from "@/app/components/Menu";
import { StatsRow } from "@/app/components/StatsRow";
import type { StatusTone } from "@/app/components/Pill";
import { useToast } from "@/app/components/Toast";

type TaskStatus = "new" | "in_progress" | "waiting" | "done" | "cancelled";
type TaskPriority = "low" | "normal" | "high" | "urgent";
type TaskSource = "dashboard" | "telegram" | "whatsapp" | "manual" | "n8n";

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  client_id: string | null;
  client_name: string | null;
  related_invoice_number: string | null;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
  telegram_from: string | null;
  due_at: string | null;
  remind_at: string | null;
  reminded_at: string | null;
  reminder_count: number;
  snoozed_until: string | null;
  created_at: string;
  updated_at: string;
};

type Paged<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };
type ClientOption = { id: string; name: string };
type Stats = { open: number; due: number; urgent: number; done: number };

const STATUS_LABEL: Record<TaskStatus, string> = {
  new: "New",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const SOURCE_LABEL: Record<TaskSource, string> = {
  dashboard: "Dashboard",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  manual: "Manual",
  n8n: "n8n",
};

// Statuses offered in the inline row dropdown. "Cancelled" is deliberately not
// here — cancelling is a deliberate act that lives in the row menu — but it is
// appended when a task already holds that value so the select can show it.
const INLINE_STATUSES: TaskStatus[] = ["new", "in_progress", "waiting", "done"];

const GRID = "minmax(240px,2.2fr) 146px 128px 150px 132px 84px";
const PAGE_SIZE = 50;
const emptyPage: Paged<TaskRow> = { data: [], total: 0, page: 1, limit: PAGE_SIZE, totalPages: 0 };
const emptyStats: Stats = { open: 0, due: 0, urgent: 0, done: 0 };

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function statusTone(status: TaskStatus): StatusTone | "muted" {
  if (status === "done") return "good";
  if (status === "waiting") return "warn";
  if (status === "cancelled") return "muted";
  return "info";
}

function priorityTone(priority: TaskPriority): StatusTone | "muted" {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warn";
  if (priority === "low") return "muted";
  return "info";
}

function isOpen(task: TaskRow): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function isOverdue(task: TaskRow): boolean {
  if (!task.remind_at || !isOpen(task)) return false;
  return new Date(task.remind_at).getTime() <= Date.now();
}

function fmtExact(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// Reminders are scanned, not read. "in 2h" / "3d ago" answers "do I act now?"
// at a glance in a way a dd-mm-yyyy timestamp never does; the exact value stays
// available as the cell's tooltip.
function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";

  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;

  if (abs < MIN) return past ? "just now" : "in a moment";
  if (abs < HOUR) {
    const m = Math.round(abs / MIN);
    return past ? `${m} min ago` : `in ${m} min`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  if (abs < 7 * DAY) {
    const days = Math.round(abs / DAY);
    return past ? `${days}d ago` : `in ${days}d`;
  }
  return d.toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" });
}

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function inHours(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

function tomorrowAt9(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function nextMondayAt9(): Date {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d;
}

type TaskForm = {
  title: string;
  description: string;
  priority: TaskPriority;
  client_id: string;
  due_at: string;
  remind_at: string;
};

const emptyForm: TaskForm = {
  title: "",
  description: "",
  priority: "normal",
  client_id: "",
  due_at: "",
  remind_at: "",
};

export default function TasksPage() {
  const { toast } = useToast();

  const [tasks, setTasks] = useState<Paged<TaskRow>>(emptyPage);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [priority, setPriority] = useState<"" | TaskPriority>("");
  const [source, setSource] = useState<"" | TaskSource>("");
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);

  const [menu, setMenu] = useState<{ task: TaskRow; anchor: DOMRect } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [form, setForm] = useState<TaskForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TaskRow | null>(null);

  // Search applies itself shortly after typing stops, so the filter bar behaves
  // consistently: no filter here needs a separate "apply" click.
  useEffect(() => {
    const t = setTimeout(() => {
      setCommittedQuery((prev) => {
        if (prev === query.trim()) return prev;
        setPage(1);
        return query.trim();
      });
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    apiJson<{ data: ClientOption[] }>("/api/clients?limit=500")
      .then((r) => setClients(r.data || []))
      .catch(() => setClients([]));
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setStats(await apiJson<Stats>("/api/tasks/stats"));
    } catch {
      // Stats are decoration — a failure here must not blank the table.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (status) qs.set("status", status);
      if (priority) qs.set("priority", priority);
      if (source) qs.set("source", source);
      if (committedQuery) qs.set("q", committedQuery);
      if (dueOnly) qs.set("reminder_due", "1");
      if (openOnly) qs.set("open", "1");
      setTasks(await apiJson<Paged<TaskRow>>(`/api/tasks?${qs}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tasks");
    } finally {
      setLoading(false);
    }
  }, [page, status, priority, source, committedQuery, dueOnly, openOnly]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  const filtersActive = Boolean(status || priority || source || committedQuery || dueOnly || openOnly);

  function clearFilters() {
    setQuery("");
    setCommittedQuery("");
    setStatus("");
    setPriority("");
    setSource("");
    setDueOnly(false);
    setOpenOnly(false);
    setPage(1);
  }

  /**
   * Apply a change locally first, then persist. The row updates on the very
   * next frame instead of after a round-trip plus a full list refetch, and the
   * previous values are restored if the request fails.
   */
  async function updateTask(task: TaskRow, patch: Partial<TaskRow>, successMsg?: string) {
    const before = task;
    setTasks((p) => ({ ...p, data: p.data.map((t) => (t.id === task.id ? { ...t, ...patch } : t)) }));
    try {
      const saved = await apiJson<TaskRow>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setTasks((p) => ({ ...p, data: p.data.map((t) => (t.id === task.id ? saved : t)) }));
      if (successMsg) toast(successMsg, "success");
      loadStats();
      // The row may no longer belong in the current view — refetch so it leaves.
      if (filtersActive) load();
    } catch (e) {
      setTasks((p) => ({ ...p, data: p.data.map((t) => (t.id === task.id ? before : t)) }));
      toast(e instanceof Error ? e.message : "Update failed", "error");
    }
  }

  function setStatusOf(task: TaskRow, next: TaskStatus) {
    updateTask(task, { status: next }, `Moved to ${STATUS_LABEL[next]}`);
  }

  // Reminder times are pushed forward on both fields: remind_at is what the n8n
  // poller reads, snoozed_until is what suppresses it until then.
  function remindAt(task: TaskRow, when: Date, label: string) {
    const iso = when.toISOString();
    updateTask(task, { remind_at: iso, snoozed_until: iso }, `Reminder set for ${label}`);
  }

  function clearReminder(task: TaskRow) {
    updateTask(task, { remind_at: null, snoozed_until: null }, "Reminder cleared");
  }

  async function doDelete(task: TaskRow) {
    setConfirmDelete(null);
    const before = tasks.data;
    setTasks((p) => ({ ...p, data: p.data.filter((t) => t.id !== task.id), total: Math.max(0, p.total - 1) }));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed: ${res.status}`);
      }
      toast("Task deleted", "success");
      loadStats();
    } catch (e) {
      setTasks((p) => ({ ...p, data: before }));
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  }

  function openEdit(task: TaskRow) {
    setEditing(task);
    setForm({
      title: task.title,
      description: task.description ?? "",
      priority: task.priority,
      client_id: task.client_id ?? "",
      due_at: toDatetimeLocalValue(task.due_at),
      remind_at: toDatetimeLocalValue(task.remind_at),
    });
    setModalOpen(true);
  }

  async function saveTask() {
    const title = form.title.trim();
    if (!title) return;
    setSaving(true);
    try {
      const payload = {
        title,
        description: form.description.trim() || null,
        priority: form.priority,
        client_id: form.client_id || null,
        client_name: form.client_id ? clients.find((c) => c.id === form.client_id)?.name ?? null : null,
        due_at: fromDatetimeLocalValue(form.due_at),
        remind_at: fromDatetimeLocalValue(form.remind_at),
      };
      await apiJson<TaskRow>(editing ? `/api/tasks/${editing.id}` : "/api/tasks", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(editing ? "Task updated" : "Task created", "success");
      setModalOpen(false);
      setEditing(null);
      await Promise.all([load(), loadStats()]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  function menuItems(task: TaskRow): MenuEntry[] {
    const items: MenuEntry[] = [
      { kind: "item", label: "Edit details", icon: I.pencil, onSelect: () => openEdit(task) },
    ];

    // Reminder actions only make sense while a task is still actionable.
    if (isOpen(task)) {
      items.push({ kind: "label", text: "Remind me" });
      items.push({ kind: "item", label: "In 1 hour", icon: I.clock, onSelect: () => remindAt(task, inHours(1), "in 1 hour") });
      items.push({ kind: "item", label: "Tomorrow 09:00", icon: I.calendar, onSelect: () => remindAt(task, tomorrowAt9(), "tomorrow 09:00") });
      items.push({ kind: "item", label: "Next Monday 09:00", icon: I.calendar, onSelect: () => remindAt(task, nextMondayAt9(), "next Monday 09:00") });
      if (task.remind_at) {
        items.push({ kind: "item", label: "Clear reminder", icon: I.bellOff, onSelect: () => clearReminder(task) });
      }
      items.push({ kind: "sep" });
      if (task.status !== "cancelled") {
        items.push({ kind: "item", label: "Cancel task", icon: I.ban, onSelect: () => setStatusOf(task, "cancelled") });
      }
    } else {
      items.push({ kind: "sep" });
    }

    items.push({ kind: "item", label: "Delete task", icon: I.trash, danger: true, onSelect: () => setConfirmDelete(task) });
    return items;
  }

  const pageNums = Array.from({ length: Math.min(tasks.totalPages, 5) }, (_, i) => {
    if (tasks.totalPages <= 5) return i + 1;
    if (page <= 3) return i + 1;
    if (page >= tasks.totalPages - 2) return tasks.totalPages - 4 + i;
    return page - 2 + i;
  });

  const appliedChips: Array<{ k: string; v: string; clear: () => void }> = [];
  if (committedQuery) appliedChips.push({ k: "Search", v: committedQuery, clear: () => { setQuery(""); setCommittedQuery(""); setPage(1); } });
  if (status) appliedChips.push({ k: "Status", v: STATUS_LABEL[status], clear: () => { setStatus(""); setPage(1); } });
  if (priority) appliedChips.push({ k: "Priority", v: PRIORITY_LABEL[priority], clear: () => { setPriority(""); setPage(1); } });
  if (source) appliedChips.push({ k: "Source", v: SOURCE_LABEL[source], clear: () => { setSource(""); setPage(1); } });
  if (dueOnly) appliedChips.push({ k: "Only", v: "Due now", clear: () => { setDueOnly(false); setPage(1); } });
  if (openOnly) appliedChips.push({ k: "Only", v: "Open", clear: () => { setOpenOnly(false); setPage(1); } });

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Tasks</h1>
          <div className="sub">Follow-ups captured from Telegram and the dashboard.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={openCreate}>
            <Icon d={I.plus} size={14} stroke={2.2} /> New task
          </button>
        </div>
      </div>

      {error && (
        <div className="notice-error">
          <Icon d={I.alert} size={14} />
          {error}
          <button className="btn sm" onClick={load} style={{ marginLeft: "auto" }}>Retry</button>
        </div>
      )}

      <StatsRow
        cards={[
          {
            label: "Open", value: String(stats.open), accent: "#0ea5e9",
            sub: "Not done or cancelled", title: "Show only open tasks",
            active: openOnly, onClick: () => { setOpenOnly((v) => !v); setStatus(""); setPage(1); },
          },
          {
            label: "Due now", value: String(stats.due), accent: "#f59e0b",
            sub: "Reminder time passed", title: "Show only tasks whose reminder is due",
            active: dueOnly, onClick: () => { setDueOnly((v) => !v); setPage(1); },
          },
          {
            label: "Urgent", value: String(stats.urgent), accent: "#c0392b",
            sub: "Open and urgent", title: "Show only urgent tasks",
            active: priority === "urgent", onClick: () => { setPriority((p) => (p === "urgent" ? "" : "urgent")); setPage(1); },
          },
          {
            label: "Done", value: String(stats.done), accent: "#1f8a5b",
            sub: "Completed", title: "Show completed tasks",
            active: status === "done", onClick: () => { setStatus((s) => (s === "done" ? "" : "done")); setOpenOnly(false); setPage(1); },
          },
        ]}
      />

      <div className="filters">
        <div className="fbar">
          <div className="field" style={{ flex: 2 }}>
            <Icon d={I.search} size={14} />
            <span className="field-lab">Search</span>
            <div className="field-sep" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, description or invoice number"
              aria-label="Search tasks"
            />
          </div>

          <div className="field">
            <Icon d={I.filter} size={14} />
            <span className="field-lab">Status</span>
            <div className="field-sep" />
            <select value={status} onChange={(e) => { setStatus(e.target.value as "" | TaskStatus); setOpenOnly(false); setPage(1); }} aria-label="Filter by status">
              <option value="">All</option>
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <Icon d={I.arrowUp} size={14} />
            <span className="field-lab">Priority</span>
            <div className="field-sep" />
            <select value={priority} onChange={(e) => { setPriority(e.target.value as "" | TaskPriority); setPage(1); }} aria-label="Filter by priority">
              <option value="">Any</option>
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <Icon d={I.send} size={14} />
            <span className="field-lab">Source</span>
            <div className="field-sep" />
            <select value={source} onChange={(e) => { setSource(e.target.value as "" | TaskSource); setPage(1); }} aria-label="Filter by source">
              <option value="">Any</option>
              {(Object.keys(SOURCE_LABEL) as TaskSource[]).map((s) => (
                <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
              ))}
            </select>
          </div>
        </div>

        {appliedChips.length > 0 && (
          <div className="quick" role="group" aria-label="Active filters">
            <span className="quick-lbl" aria-hidden="true">Filtered by</span>
            {appliedChips.map((c) => (
              <span key={`${c.k}-${c.v}`} className="chip applied">
                <span className="chip-key">{c.k}:</span>
                <span className="chip-val">{c.v}</span>
                <button className="chip-x" onClick={c.clear} aria-label={`Remove ${c.k} filter`}>
                  <Icon d={I.x} size={11} stroke={2.2} />
                </button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={clearFilters}>
              <Icon d={I.refresh} size={12} stroke={2} /> Clear all
            </button>
          </div>
        )}
      </div>

      <div className="table-card">
        <div className="t-head" style={{ gridTemplateColumns: GRID }}>
          <div>Task</div>
          <div>Status</div>
          <div>Priority</div>
          <div>Reminder</div>
          <div>Due</div>
          <div style={{ textAlign: "right" }}>Actions</div>
        </div>

        {loading && tasks.data.length === 0 ? (
          <div className="t-empty">Loading tasks…</div>
        ) : tasks.data.length === 0 ? (
          <div className="t-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "56px 16px" }}>
            <span style={{ color: "var(--faint)" }}><Icon d={I.inbox} size={30} stroke={1.3} /></span>
            {filtersActive ? (
              <>
                <div style={{ fontWeight: 600, color: "var(--ink)" }}>No tasks match these filters</div>
                <div>Try widening the search, or clear the filters to see everything.</div>
                <button className="btn sm" onClick={clearFilters} style={{ marginTop: 4 }}>
                  <Icon d={I.refresh} size={12} stroke={2} /> Clear filters
                </button>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, color: "var(--ink)" }}>No tasks yet</div>
                <div>Send a message to the Telegram bot, or add the first one here.</div>
                <button className="btn sm primary" onClick={openCreate} style={{ marginTop: 4 }}>
                  <Icon d={I.plus} size={12} stroke={2.2} /> New task
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .12s" }}>
            {tasks.data.map((task) => {
              const overdue = isOverdue(task);
              const context = [
                task.source !== "dashboard" ? SOURCE_LABEL[task.source] : null,
                task.client_name,
                task.telegram_from,
                task.related_invoice_number,
                task.description,
              ].filter(Boolean).join(" · ");

              return (
                <div key={task.id} className={`t-row${overdue ? " overdue" : ""}`} style={{ gridTemplateColumns: GRID, cursor: "default" }}>
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2, paddingRight: 12 }}>
                    <button
                      onClick={() => openEdit(task)}
                      title={`${task.title} — click to edit`}
                      style={{
                        border: 0, background: "transparent", padding: 0, textAlign: "left", font: "inherit",
                        fontWeight: 600, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        color: task.status === "done" || task.status === "cancelled" ? "var(--muted)" : "var(--ink)",
                        textDecoration: task.status === "cancelled" ? "line-through" : "none",
                      }}
                    >
                      {task.title}
                    </button>
                    {context && (
                      <span style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {context}
                      </span>
                    )}
                  </div>

                  <div>
                    <span className={`pill-sel s-${statusTone(task.status)}`}>
                      <select
                        value={task.status}
                        onChange={(e) => setStatusOf(task, e.target.value as TaskStatus)}
                        aria-label={`Status of ${task.title}`}
                      >
                        {INLINE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        {task.status === "cancelled" && <option value="cancelled">{STATUS_LABEL.cancelled}</option>}
                      </select>
                      <span className="pill-chev"><Icon d={I.chev} size={11} stroke={2.2} /></span>
                    </span>
                  </div>

                  <div>
                    <span className={`pill-sel s-${priorityTone(task.priority)}`}>
                      <select
                        value={task.priority}
                        onChange={(e) => updateTask(task, { priority: e.target.value as TaskPriority }, "Priority updated")}
                        aria-label={`Priority of ${task.title}`}
                      >
                        {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                          <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
                        ))}
                      </select>
                      <span className="pill-chev"><Icon d={I.chev} size={11} stroke={2.2} /></span>
                    </span>
                  </div>

                  {/* No reminder pending but some were sent → report the history
                      instead of an empty dash with a stray counter beside it. */}
                  <div style={{ fontSize: 12.5, color: overdue ? "var(--danger)" : "var(--muted)", fontWeight: overdue ? 600 : 400 }} title={fmtExact(task.remind_at)}>
                    {task.remind_at ? (
                      <>
                        {fmtWhen(task.remind_at)}
                        {task.reminder_count > 0 && (
                          <span style={{ color: "var(--faint)", fontWeight: 400 }} title={`${task.reminder_count} reminder(s) sent`}> · {task.reminder_count}×</span>
                        )}
                      </>
                    ) : task.reminder_count > 0 ? (
                      <span style={{ color: "var(--faint)" }}>sent {task.reminder_count}×</span>
                    ) : (
                      "—"
                    )}
                  </div>

                  <div style={{ fontSize: 12.5, color: "var(--muted)" }} title={fmtExact(task.due_at)}>
                    {fmtWhen(task.due_at)}
                  </div>

                  <div className="row-actions pinned">
                    {isOpen(task) ? (
                      <button className="act act-good" title="Mark as done" aria-label={`Mark ${task.title} as done`} onClick={() => setStatusOf(task, "done")}>
                        <Icon d={I.check} size={15} stroke={2.2} />
                      </button>
                    ) : (
                      <button className="act" title="Reopen task" aria-label={`Reopen ${task.title}`} onClick={() => setStatusOf(task, "new")}>
                        <Icon d={I.refresh} size={14} stroke={2} />
                      </button>
                    )}
                    <button
                      className={`act${menu?.task.id === task.id ? " on" : ""}`}
                      title="More actions"
                      aria-label={`More actions for ${task.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.task.id === task.id}
                      onClick={(e) => setMenu({ task, anchor: e.currentTarget.getBoundingClientRect() })}
                    >
                      <Icon d={I.more} size={16} stroke={2.6} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="t-foot">
          <div>
            Showing <strong style={{ color: "var(--ink)" }}>{tasks.data.length}</strong> of{" "}
            <strong style={{ color: "var(--ink)" }}>{tasks.total}</strong> tasks
          </div>
          {tasks.totalPages > 1 && (
            <nav className="pgr" aria-label="Pagination">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <Icon d={I.chevL} size={13} />
              </button>
              {pageNums.map((n) => (
                <button key={n} className={n === page ? "on" : ""} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button disabled={page >= tasks.totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <Icon d={I.chevR} size={13} />
              </button>
            </nav>
          )}
        </div>
      </div>

      {menu && (
        <Menu
          anchor={menu.anchor}
          items={menuItems(menu.task)}
          onClose={() => setMenu(null)}
          ariaLabel={`Actions for ${menu.task.title}`}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete task"
          body={<>Delete <strong>{confirmDelete.title}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => doDelete(confirmDelete)}
        />
      )}

      {modalOpen && (
        <TaskModal
          editing={editing}
          form={form}
          setForm={setForm}
          clients={clients}
          saving={saving}
          onClose={() => setModalOpen(false)}
          onSave={saveTask}
        />
      )}
    </main>
  );
}

function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
}

function ConfirmDialog({
  title, body, confirmLabel, onCancel, onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscape(onCancel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <div className="modal-title"><Icon d={I.alert} size={16} /> {title}</div>
          <button className="iconbtn" onClick={onCancel} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>
        <div style={{ padding: "16px 18px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>{body}</div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn" onClick={onConfirm} style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}>
            <Icon d={I.trash} size={13} /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskModal({
  editing, form, setForm, clients, saving, onClose, onSave,
}: {
  editing: TaskRow | null;
  form: TaskForm;
  setForm: React.Dispatch<React.SetStateAction<TaskForm>>;
  clients: ClientOption[];
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  useEscape(() => { if (!saving) onClose(); });
  const canSave = form.title.trim().length > 0 && !saving;

  // The reminder is the whole point of a task, and typing a datetime is the
  // slowest possible way to set one. These cover the common cases in one click.
  const presets: Array<[string, () => Date]> = [
    ["In 1 hour", () => inHours(1)],
    ["Tomorrow 09:00", tomorrowAt9],
    ["Next Monday 09:00", nextMondayAt9],
  ];

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? "Edit task" : "New task"} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={editing ? I.pencil : I.plus} size={16} />
            {editing ? "Edit task" : "New task"}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" disabled={saving}><Icon d={I.x} size={14} /></button>
        </div>

        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="task-title">Title <span className="req">*</span></label>
            <input
              id="task-title"
              className="form-input"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) onSave(); }}
              placeholder="Call Diaa about the July invoices"
              autoFocus
            />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="task-desc">Notes</label>
            <textarea
              id="task-desc"
              className="form-input"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              style={{ resize: "vertical" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="task-priority">Priority</label>
              <select
                id="task-priority"
                className="form-input"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))}
              >
                {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="task-client">Client</label>
              <select
                id="task-client"
                className="form-input"
                value={form.client_id}
                onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}
              >
                <option value="">No linked client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="task-remind">Remind me at</label>
            <input
              id="task-remind"
              type="datetime-local"
              className="form-input"
              value={form.remind_at}
              onChange={(e) => setForm((f) => ({ ...f, remind_at: e.target.value }))}
            />
            <div className="quick" style={{ marginTop: 8 }}>
              {presets.map(([label, make]) => (
                <button
                  key={label}
                  type="button"
                  className="chip"
                  onClick={() => setForm((f) => ({ ...f, remind_at: toDatetimeLocalValue(make().toISOString()) }))}
                >
                  {label}
                </button>
              ))}
              {form.remind_at && (
                <button type="button" className="chip" onClick={() => setForm((f) => ({ ...f, remind_at: "" }))}>
                  <Icon d={I.x} size={11} stroke={2.2} /> Clear
                </button>
              )}
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="task-due">Due date <span style={{ color: "var(--faint)", fontWeight: 400 }}>(optional)</span></label>
            <input
              id="task-due"
              type="datetime-local"
              className="form-input"
              value={form.due_at}
              onChange={(e) => setForm((f) => ({ ...f, due_at: e.target.value }))}
            />
          </div>

          {editing && editing.source !== "dashboard" && (
            <div style={{ fontSize: 12, color: "var(--muted)", borderTop: "1px solid var(--line-2)", paddingTop: 12 }}>
              Captured from <strong style={{ color: "var(--ink-2)" }}>{SOURCE_LABEL[editing.source]}</strong>
              {editing.telegram_from ? ` by ${editing.telegram_from}` : ""}
              {editing.client_name && !editing.client_id ? ` · client “${editing.client_name}”` : ""}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={onSave} disabled={!canSave} title={form.title.trim() ? undefined : "Add a title first"}>
            {saving ? <><span className="spinner-sm" /> Saving…</> : <><Icon d={I.check} size={13} /> {editing ? "Save changes" : "Create task"}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
