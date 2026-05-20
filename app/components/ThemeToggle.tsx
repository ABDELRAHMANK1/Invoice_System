"use client";

import { useEffect, useState } from "react";
import { Icon, I } from "./Icon";

type Theme = "light" | "dark";

const STORAGE_KEY = "oranji-theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore quota / private mode */ }
}

export function ThemeToggle() {
  // SSR-safe: render placeholder until mounted so server/client agree.
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      className="iconbtn"
      aria-label={label}
      title={label}
      // Avoid hydration mismatch — render an empty button on the server
      suppressHydrationWarning
    >
      {mounted && <Icon d={isDark ? I.sun : I.moon} size={16} />}
    </button>
  );
}
