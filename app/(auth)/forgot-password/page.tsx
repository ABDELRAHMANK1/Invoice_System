import type { Metadata } from "next";
import { ForgotPasswordCard } from "@/app/components/ForgotPasswordCard";

export const metadata: Metadata = { title: "Reset password — Oranje" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordCard />;
}
