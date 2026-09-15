"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { createBrowserSupabase } from "@/lib/supabase/session-client";

export function ForgotPasswordCard() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: resetError } = await createBrowserSupabase().auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password` }
      );
      if (resetError) throw resetError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="auth-title">Reset your password</div>
        <div className="auth-sub">We&apos;ll email you a link to set a new one.</div>
      </div>

      <div className="auth-card">
        {sent ? (
          <div className="auth-form">
            {/* Deliberately does not say whether the address has an account —
                that would turn this form into an email-enumeration oracle. */}
            <div className="auth-note good">
              <Icon d={I.check} size={14} stroke={2.5} />
              <span>If <b>{email.trim()}</b> has an account, a reset link is on its way.</span>
            </div>
            <Link className="btn" href="/login" style={{ justifyContent: "center" }}>Back to log in</Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            {error && (
              <div className="auth-note error" role="alert">
                <Icon d={I.alert} size={14} />
                <span>{error}</span>
              </div>
            )}
            <div className="form-group">
              <label className="form-label" htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                className="form-input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? <><span className="spinner-sm" /> Sending…</> : "Send reset link"}
            </button>
          </form>
        )}

        <div className="auth-foot">
          <Link className="auth-link" href="/login">Back to log in</Link>
        </div>
      </div>
    </div>
  );
}
