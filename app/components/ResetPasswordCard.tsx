"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, I } from "@/app/components/Icon";
import { PasswordField } from "@/app/components/PasswordField";
import { createBrowserSupabase } from "@/lib/supabase/session-client";

/**
 * Lands here from the emailed recovery link, which /auth/callback has already
 * exchanged for a session. So this form only has to set the new password —
 * `updateUser` acts on whoever that recovery session belongs to.
 */
export function ResetPasswordCard() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: updateError } = await createBrowserSupabase().auth.updateUser({ password });
      if (updateError) throw updateError;
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the new password.");
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="auth-title">Choose a new password</div>
      </div>

      <div className="auth-card">
        <form className="auth-form" onSubmit={handleSubmit}>
          {error && (
            <div className="auth-note error" role="alert">
              <Icon d={I.alert} size={14} />
              <span>{error}</span>
            </div>
          )}
          <PasswordField
            id="new-password"
            label="New password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            hint="At least 8 characters."
          />
          <PasswordField
            id="confirm-password"
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            minLength={8}
          />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? <><span className="spinner-sm" /> Saving…</> : "Save password"}
          </button>
        </form>
      </div>
    </div>
  );
}
