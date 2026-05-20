import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Oranji — Invoices",
  description: "Invoice extraction and management dashboard.",
};

// Runs inline in <head> before React hydrates to prevent a light→dark flash.
const NO_FLASH_THEME_SCRIPT = `
try {
  var t = localStorage.getItem('oranji-theme');
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
} catch (e) {}
`.trim();

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
