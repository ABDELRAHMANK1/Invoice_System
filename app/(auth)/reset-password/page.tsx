import type { Metadata } from "next";
import { ResetPasswordCard } from "@/app/components/ResetPasswordCard";

export const metadata: Metadata = { title: "New password — Oranje" };

export default function ResetPasswordPage() {
  return <ResetPasswordCard />;
}
