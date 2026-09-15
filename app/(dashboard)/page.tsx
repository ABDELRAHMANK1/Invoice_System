import Link from "next/link";
import { Icon, I } from "@/app/components/Icon";
import { requireActiveProfile } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { Overview } from "./Overview";

/**
 * The landing route, and the fallback every permission denial redirects to —
 * which is why it is gated on nothing but an active account. Gating it on
 * `view_invoices` would bounce a denied employee back to "/" forever.
 *
 * An approved employee holding no permissions yet has nowhere else to be, so
 * they get an explanation here rather than an overview whose every fetch 403s.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const profile = await requireActiveProfile();
  const { denied } = await searchParams;
  const canView = can(profile, "view_invoices");

  if (!canView) {
    return (
      <main className="main">
        <div className="page-h">
          <div>
            <h1>Welcome, {profile.full_name || profile.email}</h1>
            <div className="sub">Your account is approved.</div>
          </div>
        </div>
        <div className="clients-empty">
          <div className="auth-state-icon"><Icon d={I.clock} size={20} /></div>
          <div>
            <b>No permissions yet</b>
            <div style={{ marginTop: 6, maxWidth: 420 }}>
              An owner still has to grant you access to invoices, clients or exports.
              Once they do, everything shows up in the sidebar.
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {denied && (
        <div className="main" style={{ paddingBottom: 0 }}>
          <div className="auth-note error" role="alert">
            <Icon d={I.alert} size={14} />
            <span>
              You don&apos;t have permission to open that page. Ask an owner for access from{" "}
              <Link href="/settings" style={{ textDecoration: "underline" }}>Settings</Link>.
            </span>
          </div>
        </div>
      )}
      <Overview />
    </>
  );
}
