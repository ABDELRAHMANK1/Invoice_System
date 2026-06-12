import { test, expect, type Route } from "@playwright/test";

/**
 * E2E tests run against a real `next start` server (see playwright.config.ts).
 * Network calls to /api/* are intercepted so the tests don't depend on
 * Supabase, S3, or OpenAI being reachable.
 */

const SAMPLE_INVOICES = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    file_id: null,
    phone_number: "+31612345678",
    invoice_number: "INV-0001",
    client_name: "Nema Food B.V.",
    date: "2026-05-10",
    total_amount: 121,
    currency: "EUR",
    file_url: "s3://test/inv-1.pdf",
    status: "extracted",
    confidence: 0.94,
    created_at: "2026-05-10T08:30:00Z",
    invoice_direction: "inkoop",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    file_id: null,
    phone_number: "+31612345678",
    invoice_number: "INV-V-0001",
    client_name: "RAJEH FOOD",
    date: "2026-05-11",
    total_amount: 242,
    currency: "EUR",
    file_url: "s3://test/inv-v-1.pdf",
    status: "extracted",
    confidence: 0.91,
    created_at: "2026-05-11T08:30:00Z",
    invoice_direction: "verkoop",
  },
];

function paged(rows: typeof SAMPLE_INVOICES) {
  return {
    data: rows,
    total: rows.length,
    total_amount: rows.reduce((s, r) => s + (r.total_amount ?? 0), 0),
    page: 1,
    limit: 20,
    totalPages: 1,
  };
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test.describe("Invoices dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/invoices*", async (route) => {
      const url = new URL(route.request().url());
      const direction = url.searchParams.get("direction");
      const invoiceNo  = url.searchParams.get("invoice");
      let rows = SAMPLE_INVOICES;
      if (direction === "inkoop")  rows = rows.filter((r) => r.invoice_direction === "inkoop");
      if (direction === "verkoop") rows = rows.filter((r) => r.invoice_direction === "verkoop");
      if (invoiceNo)               rows = rows.filter((r) => r.invoice_number.includes(invoiceNo));
      await fulfillJson(route, paged(rows));
    });
  });

  test("loads and displays both invoices", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    await expect(page.getByText("INV-0001")).toBeVisible();
    await expect(page.getByText("INV-V-0001")).toBeVisible();
  });

  test("filter by Inkoop hides Verkoop rows", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByRole("button", { name: "Inkoop" }).click();
    await page.getByRole("button", { name: /apply search/i }).click();
    await expect(page.getByText("INV-0001")).toBeVisible();
    await expect(page.getByText("INV-V-0001")).toHaveCount(0);
  });

  test("filter by Verkoop hides Inkoop rows", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByRole("button", { name: "Verkoop" }).click();
    await page.getByRole("button", { name: /apply search/i }).click();
    await expect(page.getByText("INV-V-0001")).toBeVisible();
    await expect(page.getByText("INV-0001")).toHaveCount(0);
  });

  test("search by invoice number narrows results", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByLabel("Filter by invoice number").fill("INV-V-0001");
    await page.getByRole("button", { name: /apply search/i }).click();
    // Scope to the invoice rows (.cell-id) so we don't match the applied filter chip
    await expect(page.locator(".cell-id", { hasText: "INV-V-0001" })).toBeVisible();
    await expect(page.locator(".cell-id", { hasText: /^INV-0001$/ })).toHaveCount(0);
  });

  test("date range filter sends from/to query params", async ({ page }) => {
    let captured: { from?: string; to?: string } = {};
    await page.route("**/api/invoices*", async (route) => {
      const url = new URL(route.request().url());
      captured = { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined };
      await fulfillJson(route, paged(SAMPLE_INVOICES));
    });

    await page.goto("/invoices");
    await page.getByLabel("From date").fill("2026-05-01");
    await page.getByLabel("To date").fill("2026-05-31");
    await page.getByRole("button", { name: /apply search/i }).click();

    await expect.poll(() => captured.from).toBe("2026-05-01");
    expect(captured.to).toBe("2026-05-31");
  });
});

test.describe("Export modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/invoices*", async (route) => fulfillJson(route, paged(SAMPLE_INVOICES)));
  });

  test("opens the Excel export modal from the toolbar", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByRole("button", { name: /export excel/i }).first().click();
    await expect(page.getByRole("dialog", { name: /export excel/i })).toBeVisible();
    await expect(page.getByText("Choose which invoices to include")).toBeVisible();
  });

  test("posts to /api/export with type=excel and triggers a download URL", async ({ page }) => {
    let requestedBody: { type?: string } = {};

    await page.route("**/api/export", async (route) => {
      requestedBody = JSON.parse(route.request().postData() || "{}");
      await fulfillJson(route, {
        jobId: "job-1",
        status: "done",
        type: "excel",
        download_url: "data:text/plain,fake",
        file_count: 2,
      });
    });

    await page.goto("/invoices");
    await page.getByRole("button", { name: /export excel/i }).first().click();
    await page.getByRole("button", { name: /^export excel$/i }).last().click();

    await expect.poll(() => requestedBody.type).toBe("excel");
  });

  test("bulk-bar Export sends only the selected invoice ids (no filters)", async ({ page }) => {
    let requestedBody: { type?: string; ids?: string[]; phone?: string; invoice?: string } = {};

    await page.route("**/api/export", async (route) => {
      requestedBody = JSON.parse(route.request().postData() || "{}");
      await fulfillJson(route, {
        jobId: "job-bulk",
        status: "done",
        type: "excel",
        download_url: "data:text/plain,fake",
        file_count: 1,
      });
    });

    await page.goto("/invoices");
    // Tick the checkbox on the first invoice row (the row's `cb` element)
    await page.locator(".t-row").first().locator(".cb").first().click();
    // BulkBar should appear; click its "Export" action
    await page.getByRole("toolbar", { name: /bulk actions/i }).getByRole("button", { name: /^export$/i }).click();
    // Confirm in the modal
    await page.getByRole("button", { name: /^export excel$/i }).last().click();

    await expect.poll(() => requestedBody.ids?.length).toBe(1);
    expect(requestedBody.ids?.[0]).toBe("11111111-1111-1111-1111-111111111111");
    // Filters must NOT leak in when ids are present
    expect(requestedBody.phone).toBeUndefined();
    expect(requestedBody.invoice).toBeUndefined();
  });
});

test.describe("Invoice number filter", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/invoices*", async (route) => {
      const url = new URL(route.request().url());
      const invoiceNo = url.searchParams.get("invoice");
      let rows = SAMPLE_INVOICES;
      if (invoiceNo) rows = rows.filter((r) => r.invoice_number.toLowerCase().includes(invoiceNo.toLowerCase()));
      await fulfillJson(route, paged(rows));
    });
  });

  test("pressing Enter in the Invoice # field submits the search", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByLabel("Filter by invoice number").fill("INV-V-0001");
    await page.getByLabel("Filter by invoice number").press("Enter");
    await expect(page.locator(".cell-id", { hasText: "INV-V-0001" })).toBeVisible();
    await expect(page.locator(".cell-id", { hasText: /^INV-0001$/ })).toHaveCount(0);
  });

  test("whitespace around the invoice number is trimmed before sending", async ({ page }) => {
    let captured: string | null | undefined;
    await page.route("**/api/invoices*", async (route) => {
      const url = new URL(route.request().url());
      captured = url.searchParams.get("invoice");
      await fulfillJson(route, paged(SAMPLE_INVOICES));
    });
    await page.goto("/invoices");
    await page.getByLabel("Filter by invoice number").fill("  INV-0001  ");
    await page.getByRole("button", { name: /apply search/i }).click();
    await expect.poll(() => captured).toBe("INV-0001");
  });
});

test.describe("Upload modal — batch", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/invoices*", async (route) => fulfillJson(route, paged(SAMPLE_INVOICES)));
  });

  test("picks multiple files, lists them, uploads with concurrency cap 5", async ({ page }) => {
    // Hooks for verifying the batch flow
    let inFlight = 0;
    let maxInFlight = 0;
    let uploadCount = 0;
    let filesCount = 0;
    const phonesSeen = new Set<string>();
    const directionsSeen = new Set<string>();

    await page.route("**/api/upload", async (route) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      uploadCount += 1;
      // Capture phone from multipart form
      const body = route.request().postData() || "";
      const phoneMatch = body.match(/name="phone_number"\s*\r?\n\s*\r?\n([^\r\n]+)/);
      if (phoneMatch) phonesSeen.add(phoneMatch[1]);
      // Hold each upload open briefly so concurrency is observable
      await new Promise((r) => setTimeout(r, 80));
      inFlight -= 1;
      await fulfillJson(route, {
        file_key:  `files/2026/06/u-${uploadCount}.pdf`,
        file_url:  `s3://bucket/files/2026/06/u-${uploadCount}.pdf`,
        file_name: `file-${uploadCount}.pdf`,
        file_size: 1234,
        mime_type: "application/pdf",
      });
    });

    await page.route("**/api/files", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      filesCount += 1;
      const json = JSON.parse(route.request().postData() || "{}");
      if (json.invoice_direction) directionsSeen.add(json.invoice_direction);
      await fulfillJson(route, { id: `f-${filesCount}`, status: "pending" });
    });

    await page.goto("/invoices");
    await page.getByRole("button", { name: /^upload$/i }).click();
    await expect(page.getByRole("dialog", { name: /upload invoice/i })).toBeVisible();

    // Build 12 in-memory PDFs and pick them all at once
    const N = 12;
    const fakeFiles = Array.from({ length: N }, (_, i) => ({
      name: `inv-${String(i + 1).padStart(2, "0")}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from(`%PDF-1.4\n% test file ${i + 1}\n`),
    }));

    await page.locator('input[type="file"]').setInputFiles(fakeFiles);

    // The file list should show every selected file
    for (const f of fakeFiles) {
      await expect(page.getByText(f.name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/12 selected/)).toBeVisible();

    // Fill in the phone + pick direction (scope direction to the modal — the filter bar also has Verkoop)
    await page.getByLabel(/phone number/i).fill("+31 6 99 88 77 66");
    await page.getByRole("dialog", { name: /upload invoice/i }).getByRole("button", { name: /verkoop/i }).click();

    // Kick off the batch
    await page.getByRole("button", { name: /upload 12 files/i }).click();

    // Wait until every row reports "done"
    await expect.poll(async () => uploadCount, { timeout: 15_000 }).toBe(N);
    await expect.poll(async () => filesCount, { timeout: 15_000 }).toBe(N);

    // Concurrency cap = 5
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // proves the worker pool actually parallelised

    // All N got the same phone + direction
    expect([...phonesSeen]).toEqual(["+31 6 99 88 77 66"]);
    expect([...directionsSeen]).toEqual(["verkoop"]);

    // Primary button collapses to "Close" once every file is done/failed
    // (scope past the X iconbtn which also has aria-label="Close")
    await expect(
      page.getByRole("dialog", { name: /upload invoice/i })
        .locator(".modal-foot")
        .getByRole("button", { name: /^close$/i })
    ).toBeVisible();
  });

  test("one bad file is isolated and Retry failed re-runs only it", async ({ page }) => {
    const failedNames = new Set(["inv-02.pdf"]);
    let uploadCalls = 0;

    await page.route("**/api/upload", async (route) => {
      uploadCalls += 1;
      const body = route.request().postData() || "";
      const nameMatch = body.match(/filename="([^"]+)"/);
      const name = nameMatch?.[1] ?? "";
      if (failedNames.has(name)) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
        return;
      }
      await fulfillJson(route, {
        file_key: `k/${name}`, file_url: `s3://b/${name}`, file_name: name, file_size: 100, mime_type: "application/pdf",
      });
    });
    await page.route("**/api/files", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await fulfillJson(route, { id: "f-x", status: "pending" });
    });

    await page.goto("/invoices");
    await page.getByRole("button", { name: /^upload$/i }).click();

    const N = 3;
    await page.locator('input[type="file"]').setInputFiles(
      Array.from({ length: N }, (_, i) => ({
        name: `inv-${String(i + 1).padStart(2, "0")}.pdf`,
        mimeType: "application/pdf",
        buffer: Buffer.from(`%PDF-1.4\n%t\n`),
      }))
    );
    await page.getByLabel(/phone number/i).fill("+31600000000");
    await page.getByRole("button", { name: /upload 3 files/i }).click();

    // Wait for the batch to settle (2 ok, 1 failed)
    await expect(page.getByRole("button", { name: /retry failed/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("2 of 3 uploaded")).toBeVisible();
    await expect(page.getByText(/1 failed/)).toBeVisible();

    // Stop failing the second file, then retry
    failedNames.clear();
    const callsBefore = uploadCalls;
    await page.getByRole("button", { name: /retry failed/i }).click();

    // Only the failed one should be retried (not the two that already succeeded)
    await expect.poll(() => uploadCalls - callsBefore, { timeout: 10_000 }).toBe(1);
    await expect(page.getByText("3 of 3 uploaded")).toBeVisible();
  });
});
