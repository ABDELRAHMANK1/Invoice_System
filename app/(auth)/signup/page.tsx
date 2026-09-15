import type { Metadata } from "next";
import { AuthCard } from "@/app/components/AuthCard";

export const metadata: Metadata = { title: "Sign up — Oranje" };

export default function SignupPage() {
  return <AuthCard initialTab="signup" />;
}
