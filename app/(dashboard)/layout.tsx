import { Sidebar } from "@/app/components/Sidebar";
import { Topbar } from "@/app/components/Topbar";
import { ToastProvider } from "@/app/components/Toast";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar />
        <div className="main-col">
          <Topbar />
          {children}
        </div>
      </div>
    </ToastProvider>
  );
}
