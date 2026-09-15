"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { PasswordField } from "@/app/components/PasswordField";
import { createBrowserSupabase } from "@/lib/supabase/session-client";

type Tab = "login" | "signup";

/**
 * The Log in / Sign up card.
 *
 * One component for both tabs: they share the email + password fields, the
 * error strip and the submit button, and switching between them must not
 * remount the inputs or blow away what was typed. /login and /signup are still
 * separate ROUTES (deep links, and middleware treats them as public) — they
 * just render this with a different `initialTab`.
 */
export function AuthCard({ initialTab = "login", next }: { initialTab?: Tab; next?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUp, setSignedUp] = useState(false);

  function switchTab(nextTab: Tab) {
    setTab(nextTab);
    setError(null);
    setSignedUp(false);
    // Keep the URL honest so a refresh (or the back button) lands on the tab
    // that is actually showing. replace, not push — tabbing back and forth
    // should not fill the history stack.
    router.replace(nextTab === "login" ? "/login" : "/signup");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const supabase = createBrowserSupabase();

      if (tab === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          // Read by the handle_new_auth_user() trigger (migration 016) to fill
          // user_profiles.full_name. The trigger — not this form — decides the
          // role and status, so a signup can never grant itself access.
          options: { data: { full_name: fullName.trim() } },
        });
        if (signUpError) throw signUpError;

        // With email confirmation ON, signUp returns no session: the account
        // exists but cannot sign in yet. Say so instead of redirecting into a
        // login loop.
        if (!data.session) {
          setSignedUp(true);
          return;
        }
        router.replace("/pending");
        router.refresh();
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;

      // The session cookie is set, but the dashboard is server-rendered behind
      // middleware — refresh() re-runs it so the redirect target is decided
      // with the new session, not the signed-out one.
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const isSignup = tab === "signup";

  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="auth-title">Oranje</div>
      </div>

      <div className="auth-card">
        <div className="auth-tabs" role="tablist" aria-label="Authentication">
          <button
            type="button"
            role="tab"
            aria-selected={!isSignup}
            className={`auth-tab${!isSignup ? " on" : ""}`}
            onClick={() => switchTab("login")}
          >
            Log in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isSignup}
            className={`auth-tab${isSignup ? " on" : ""}`}
            onClick={() => switchTab("signup")}
          >
            Sign up
          </button>
        </div>

        {signedUp ? (
          <div className="auth-form">
            <div className="auth-note good">
              <Icon d={I.check} size={14} stroke={2.5} />
              <span>
                Account created. Check <b>{email.trim()}</b> for a confirmation link, then log in.
                An owner still has to approve the account before the dashboard opens.
              </span>
            </div>
            <button type="button" className="btn" onClick={() => switchTab("login")}>
              Back to log in
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            {error && (
              <div className="auth-note error" role="alert">
                <Icon d={I.alert} size={14} />
                <span>{error}</span>
              </div>
            )}

            {isSignup && (
              <div className="form-group">
                <label className="form-label" htmlFor="auth-name">Name</label>
                <input
                  id="auth-name"
                  className="form-input"
                  autoComplete="name"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                className="form-input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <PasswordField
              id="auth-password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete={isSignup ? "new-password" : "current-password"}
              minLength={isSignup ? 8 : undefined}
              hint={isSignup ? "At least 8 characters." : undefined}
            />

            <button className="btn primary" type="submit" disabled={busy}>
              {busy
                ? <><span className="spinner-sm" /> {isSignup ? "Creating account…" : "Logging in…"}</>
                : (isSignup ? "Create account" : "Log in")}
            </button>
          </form>
        )}

        {!isSignup && !signedUp && (
          <div className="auth-foot">
            <Link className="auth-link" href="/forgot-password">Forgot password?</Link>
          </div>
        )}
      </div>
    </div>
  );
}

