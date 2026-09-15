import { Sidebar } from "@/app/components/Sidebar";
import { Topbar } from "@/app/components/Topbar";
import { ToastProvider } from "@/app/components/Toast";
import { requireActiveProfile } from "@/lib/auth/session";

/**
 * The gate every dashboard page passes through.
 *
 * Middleware already refused anonymous requests, so this is not the first line
 * of defence — it is the one that has the PROFILE in hand. It re-checks status
 * (a server-rendered page must never paint for an account disabled a second
 * ago) and hands the profile down so the sidebar and topbar can show only what
 * this person may actually open.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireActiveProfile();

  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar profile={profile} />
        <div className="main-col">
          <Topbar profile={profile} />
          {children}
        </div>
      </div>
    </ToastProvider>
  );
}
