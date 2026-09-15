"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/session-client";

/**
 * Signs out in the browser (clears the Supabase cookies) and then refreshes so
 * middleware re-runs and sends the now-anonymous request to /login. A plain
 * router.push would render the cached signed-in tree first.
 */
export function SignOutButton({ className = "btn", label = "Log out" }: { className?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await createBrowserSupabase().auth.signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button type="button" className={className} onClick={signOut} disabled={busy}>
      {busy ? "Logging out…" : label}
    </button>
  );
}
