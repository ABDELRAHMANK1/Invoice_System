import { test as setup, expect } from "@playwright/test";
import path from "node:path";

export const STORAGE_STATE = path.join(__dirname, ".auth", "dashboard.json");

/**
 * Signs in once and saves the session cookies for every other spec.
 *
 * The dashboard is behind Supabase Auth now, so there is no Basic Auth header
 * to fake — a real session cookie is the only way past middleware.ts. The specs
 * still stub /api/* (see dashboard.spec.ts), so this is the ONLY part of the
 * suite that talks to a live Supabase project.
 *
 * Needs an approved (status = 'active') account:
 *   E2E_EMAIL=... E2E_PASSWORD=... npx playwright test
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  expect(
    email && password,
    "Set E2E_EMAIL and E2E_PASSWORD to an approved dashboard account before running the e2e suite."
  ).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Log in" }).click();

  // Landing anywhere other than /login means the session cookie stuck. /pending
  // would mean the account was never approved — fail loudly rather than saving
  // a session that cannot open a single page.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/pending/);

  await page.context().storageState({ path: STORAGE_STATE });
});
