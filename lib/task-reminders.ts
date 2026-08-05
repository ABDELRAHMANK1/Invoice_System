// Reminder scheduling rules for the Tasks inbox.
//
// Pure — no env, DB or IO — so both the n8n polling route
// (/api/tasks/reminders/due) and the unit tests can share it.

export type ReminderTask = {
  remind_at: string | null;
  reminded_at: string | null;
  snoozed_until: string | null;
};

/**
 * A task is still pending if its reminder time has passed, it is not snoozed
 * into the future, and it has not already been delivered for that same
 * remind_at.
 *
 * The last clause is the idempotency guard: n8n can poll every minute and a
 * reminder it already sent will not come back, even in the window before
 * remind_at is cleared. A reminder that was rescheduled (remind_at moved past
 * the previous reminded_at) becomes pending again, which is what makes repeat
 * reminders and snoozes work.
 */
export function isReminderPending(task: ReminderTask, nowMs: number): boolean {
  if (!task.remind_at) return false;

  const remindMs = new Date(task.remind_at).getTime();
  if (Number.isNaN(remindMs) || remindMs > nowMs) return false;

  if (task.snoozed_until) {
    const snoozeMs = new Date(task.snoozed_until).getTime();
    if (!Number.isNaN(snoozeMs) && snoozeMs > nowMs) return false;
  }

  if (task.reminded_at) {
    const sentMs = new Date(task.reminded_at).getTime();
    if (!Number.isNaN(sentMs) && sentMs >= remindMs) return false;
  }

  return true;
}
