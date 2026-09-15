/**
 * Layout for the signed-out screens. Deliberately bare — no Sidebar, no Topbar,
 * no ToastProvider: there is nothing to navigate to yet, and an auth error has
 * to stay on screen rather than fade out of a toast.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
