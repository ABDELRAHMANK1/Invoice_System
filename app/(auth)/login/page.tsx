import type { Metadata } from "next";
import { AuthCard } from "@/app/components/AuthCard";

export const metadata: Metadata = { title: "Log in — Oranje" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <AuthCard initialTab="login" next={next} />;
}
