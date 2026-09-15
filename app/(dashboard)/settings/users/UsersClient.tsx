"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, I } from "@/app/components/Icon";
import { useToast } from "@/app/components/Toast";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import {
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLES,
  hasFullAccess,
  type PermissionKey,
  type Role,
  type UserStatus,
} from "@/lib/auth/permissions";

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  status: UserStatus;
  created_at: string | null;
  last_sign_in_at: string | null;
  permissions: PermissionKey[];
}

const STATUS_TONE: Record<UserStatus, string> = {
  pending: "s-warn",
  active: "s-good",
  disabled: "s-danger",
};

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  developer: "Developer",
  employee: "Employee",
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" });
}

export function UsersClient({ currentUserId }: { currentUserId: string }) {
  const { toast } = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [confirming, setConfirming] = useState<UserRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load users");
      setUsers(json.data as UserRow[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Every mutation goes through here. Optimistic like the Tasks and Employees
   * tables: apply locally, revert the row on failure — a permission toggle that
   * waits on a round trip feels broken.
   */
  const patchUser = useCallback(
    async (id: string, patch: Record<string, unknown>, optimistic: Partial<UserRow>) => {
      const previous = users;
      setUsers((rows) => rows.map((r) => (r.id === id ? { ...r, ...optimistic } : r)));
      setBusyId(id);
      try {
        const res = await fetch(`/api/users/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Update failed");
        return true;
      } catch (err) {
        setUsers(previous);
        toast(err instanceof Error ? err.message : "Update failed", "error");
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [users, toast]
  );

  const pendingCount = useMemo(() => users.filter((u) => u.status === "pending").length, [users]);

  async function approve(user: UserRow, permissions: Record<PermissionKey, boolean>) {
    const granted = PERMISSION_KEYS.filter((k) => permissions[k]);
    const ok = await patchUser(
      user.id,
      { status: "active", permissions },
      { status: "active", permissions: granted }
    );
    if (ok) {
      toast(`${user.full_name || user.email} approved`, "success");
      setEditing(null);
    }
  }

  async function savePermissions(user: UserRow, permissions: Record<PermissionKey, boolean>) {
    const granted = PERMISSION_KEYS.filter((k) => permissions[k]);
    const ok = await patchUser(user.id, { permissions }, { permissions: granted });
    if (ok) {
      toast("Permissions updated", "success");
      setEditing(null);
    }
  }

  async function changeRole(user: UserRow, role: Role) {
    const ok = await patchUser(user.id, { role }, { role });
    if (ok) toast(`Role set to ${ROLE_LABELS[role]}`, "success");
  }

  async function setStatus(user: UserRow, status: UserStatus) {
    const ok = await patchUser(user.id, { status }, { status });
    if (ok) toast(status === "disabled" ? "User disabled" : "User enabled", "success");
    setConfirming(null);
  }

  const COLS = "1.6fr 1.3fr 130px 110px 1.5fr 150px";

  return (
    <main className="main">
      <div className="page-h">
        <div>
          <h1>Users</h1>
          <div className="sub">
            Who can sign in, and what they can do.
            {pendingCount > 0 && ` ${pendingCount} waiting for approval.`}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => void load()} disabled={loading}>
            <Icon d={I.refresh} size={13} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="auth-note error" role="alert" style={{ marginBottom: 16 }}>
          <Icon d={I.alert} size={14} /> <span>{error}</span>
        </div>
      )}

      <div className="table-card">
        <div className="t-head" style={{ gridTemplateColumns: COLS }}>
          <div>User</div>
          <div>Email</div>
          <div>Role</div>
          <div>Status</div>
          <div>Permissions</div>
          <div style={{ textAlign: "right" }}>Actions</div>
        </div>

        {loading && <div className="t-empty">Loading users…</div>}
        {!loading && users.length === 0 && <div className="t-empty">No accounts yet.</div>}

        {!loading && users.map((user) => {
          const isSelf = user.id === currentUserId;
          const fullAccess = hasFullAccess(user.role);
          return (
            <div
              key={user.id}
              className="t-row"
              style={{ gridTemplateColumns: COLS, cursor: "default", opacity: busyId === user.id ? 0.6 : 1 }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="client-name">
                  {user.full_name || "—"}
                  {isSelf && <span className="chip-key" style={{ marginLeft: 6 }}>you</span>}
                </div>
                <div className="client-phone">Joined {formatDate(user.created_at)}</div>
              </div>

              <div className="cell-phone" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {user.email || "—"}
              </div>

              <div>
                {/* Changing your own role is refused by the API; disabling the
                    control says so before the click instead of after. */}
                <span className={`pill-sel ${fullAccess ? "s-info" : "s-muted"}`}>
                  <select
                    value={user.role}
                    disabled={isSelf || busyId === user.id}
                    aria-label={`Role for ${user.full_name || user.email}`}
                    onChange={(e) => void changeRole(user, e.target.value as Role)}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <span className="pill-chev"><Icon d={I.chev} size={11} /></span>
                </span>
              </div>

              <div>
                <span className={`pill ${STATUS_TONE[user.status]}`}>
                  <span className="pill-dot" />
                  {user.status === "pending" ? "Pending" : user.status === "active" ? "Active" : "Disabled"}
                </span>
              </div>

              <div style={{ fontSize: 12, color: "var(--muted)", minWidth: 0 }}>
                {fullAccess
                  ? <span style={{ color: "var(--info)" }}>Full access (by role)</span>
                  : user.permissions.length === 0
                    ? "None"
                    : user.permissions.map((p) => PERMISSION_LABELS[p].label).join(", ")}
              </div>

              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {user.status === "pending" ? (
                  <button className="btn sm primary" onClick={() => setEditing(user)} disabled={busyId === user.id}>
                    <Icon d={I.check} size={12} /> Approve
                  </button>
                ) : (
                  <button
                    className="btn sm"
                    onClick={() => setEditing(user)}
                    disabled={fullAccess || busyId === user.id}
                    title={fullAccess ? "Owners and developers always have full access" : undefined}
                  >
                    <Icon d={I.pencil} size={12} /> Permissions
                  </button>
                )}

                {!isSelf && user.status === "disabled" && (
                  <button className="btn sm" onClick={() => void setStatus(user, "active")} disabled={busyId === user.id}>
                    <Icon d={I.refresh} size={12} /> Enable
                  </button>
                )}
                {!isSelf && user.status !== "disabled" && (
                  <button
                    className="btn sm"
                    onClick={() => setConfirming(user)}
                    disabled={busyId === user.id}
                    style={{ color: "var(--danger)", borderColor: "var(--danger-soft)" }}
                  >
                    <Icon d={I.ban} size={12} /> Disable
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <PermissionsModal
          user={editing}
          onCancel={() => setEditing(null)}
          busy={busyId === editing.id}
          onSave={(perms) =>
            editing.status === "pending" ? approve(editing, perms) : savePermissions(editing, perms)
          }
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="Disable this account?"
          confirmLabel="Disable"
          busy={busyId === confirming.id}
          onCancel={() => setConfirming(null)}
          body={
            <>
              <b>{confirming.full_name || confirming.email}</b> will be signed out of the dashboard on their
              next request and will see the &quot;account disabled&quot; screen. Their data and permissions are kept,
              so this can be undone.
            </>
          }
          onConfirm={() => void setStatus(confirming, "disabled")}
        />
      )}
    </main>
  );
}

/**
 * Approve / edit-permissions dialog. Same form for both — approving is just
 * "grant these, and set the status to active" — so a pending user can never be
 * activated without someone having looked at the checkboxes.
 */
function PermissionsModal({
  user,
  onSave,
  onCancel,
  busy,
}: {
  user: UserRow;
  onSave: (permissions: Record<PermissionKey, boolean>) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [checked, setChecked] = useState<Record<PermissionKey, boolean>>(() =>
    Object.fromEntries(PERMISSION_KEYS.map((k) => [k, user.permissions.includes(k)])) as Record<PermissionKey, boolean>
  );

  const approving = user.status === "pending";

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Permissions" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Icon d={I.users} size={16} />
            {approving ? "Approve account" : "Edit permissions"}
          </div>
          <button className="iconbtn" onClick={onCancel} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>

        <p className="modal-sub">
          {user.full_name || user.email}
          {approving && " will be able to sign in as soon as you approve."}
        </p>

        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          {PERMISSION_KEYS.map((key) => (
            <label
              key={key}
              style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={checked[key]}
                onChange={(e) => setChecked((c) => ({ ...c, [key]: e.target.checked }))}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
                  {PERMISSION_LABELS[key].label}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>
                  {PERMISSION_LABELS[key].description}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(checked)} disabled={busy}>
            {busy
              ? <><span className="spinner-sm" /> Saving…</>
              : approving ? "Approve & grant" : "Save permissions"}
          </button>
        </div>
      </div>
    </div>
  );
}
