import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Runs against a fresh in-memory e2e server (see playwright.config.ts and
// e2e/server.ts). Serial: the journey builds on its own state (memory storage
// persists per server) — e.g. the export and the erasure are self-audited
// into the tenant's log before the later verification runs.
test.describe.configure({ mode: "serial" });

const rows = (page: Page) => page.getByTestId("event-row");
const drawer = (page: Page) => page.getByTestId("drawer");

test("loads the dashboard shell and the overview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("@xtandard/audit e2e").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  // Two seeded tenants; recent events across them; streams declared.
  await expect(page.getByText("Tenants", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Recent events")).toBeVisible();
  await expect(page.getByRole("button", { name: /support\.impersonated/ })).toBeVisible();
  await expect(page.getByText("Stream health")).toBeVisible();
  // Every operator tab is allowed (no auth/authorization configured).
  for (const tab of ["Overview", "Events", "Tenants", "Actions", "Integrity", "Streams"]) {
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: tab }),
    ).toBeVisible();
  }
});

test("filters the explorer and keeps the filters in the URL", async ({ page }) => {
  await page.goto("/events?tenant=acme");
  await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
  await expect(rows(page).first()).toBeVisible();

  // Action family from the catalog autocomplete.
  const actionInput = page.getByRole("combobox", { name: "Filter by action" });
  await actionInput.fill("invo");
  await page.getByRole("option", { name: /invoice\.\*/ }).click();
  await expect(page).toHaveURL(/actions=invoice\.\*/);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "document.viewed" })).toHaveCount(0);

  // Outcome narrows further; a reload restores the same view from the URL.
  await page.getByRole("button", { name: "Failure", exact: true }).click();
  await expect(page).toHaveURL(/outcome=failure/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("invoice.voided");
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove invoice.*" })).toBeVisible();

  // Clear, then free-text search over targets.
  await page.getByRole("button", { name: /Clear filters/ }).click();
  await expect(page).not.toHaveURL(/actions=/);
  await page.getByLabel("Search events").fill("INV-1001");
  await expect(page).toHaveURL(/q=INV-1001/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("invoice.paid");

  // A time-range preset hides the old filler events.
  await page.getByLabel("Search events").fill("");
  await expect(page).not.toHaveURL(/q=/);
  await page.getByLabel("Time range").click();
  await page.getByRole("option", { name: "Last 24 hours" }).click();
  await expect(page).toHaveURL(/range=24h/);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "document.viewed" })).toHaveCount(0);

  // Actor filter.
  await page.getByLabel("Actor id").fill("user_bob");
  await expect(page).toHaveURL(/actor=user_bob/);
  await expect(rows(page)).toHaveCount(1);
});

test("pages through the log with keyset pagination", async ({ page }) => {
  await page.goto("/events?tenant=acme");
  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  // Scrolling to the end of the list loads the next keyset page by itself.
  await page.getByText("50 events loaded").scrollIntoViewIfNeeded();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(60);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("the cross-tenant listing shows every tenant", async ({ page }) => {
  await page.goto("/events?actions=invoice.paid");
  await expect(rows(page).filter({ hasText: "globex" }).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "acme" }).first()).toBeVisible();
  // Exports are per tenant.
  await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();
});

test("opens the detail drawer with the integrity block", async ({ page }) => {
  await page.goto("/events?tenant=acme&actions=member.role_changed");
  await rows(page).first().click();
  await expect(page).toHaveURL(/event=evt_/);
  const sheet = drawer(page);
  await expect(sheet.getByRole("heading", { name: "member.role_changed" })).toBeVisible();
  await expect(sheet.getByText("Alice Admin")).toBeVisible();
  await expect(sheet.getByText("Medellín, CO")).toBeVisible();
  await expect(sheet.locator(".cm-content").first()).toContainText('"to": "admin"');
  await expect(sheet.getByText(/^sha256:[0-9a-f]{64}$/).first()).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Copy hash" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Copy event id" })).toBeVisible();

  // Deep link: a reload reopens the same event.
  await page.reload();
  await expect(drawer(page).getByRole("heading", { name: "member.role_changed" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/event=/);
});

test("exports the filtered log as a download", async ({ page }) => {
  await page.goto("/events?tenant=acme&actions=invoice.*");
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Export" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^JSONL/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.jsonl$/);
  const body = await readFile((await download.path())!, "utf8");
  const lines = body.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(body).toContain("invoice.paid");
  expect(body).not.toContain("document.viewed");
  await expect(page.getByText("Export ready")).toBeVisible();
});

test("verifies a tenant's chain and creates a checkpoint", async ({ page, request }) => {
  await page.goto("/integrity?tenant=acme");
  await expect(page.getByRole("heading", { name: "Integrity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chain head" })).toBeVisible();

  await page.getByRole("button", { name: "Verify chain" }).click();
  const summary = page.getByTestId("verify-summary");
  await expect(summary).toContainText(/Verified through #\d+/);
  await expect(summary).toContainText("Signed by key e2e-key-1");
  await expect(page.getByText("Genesis (seq 1)")).toBeVisible();

  const table = page.getByRole("table", { name: "Checkpoints" });
  const before = await table.locator("tbody tr").count();
  await page.getByRole("button", { name: "Create checkpoint" }).click();
  await expect(page.getByText("Checkpoint created")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(before + 1);

  // The JWKS link resolves to the signer's public key.
  const href = await page.getByRole("link", { name: /Public keys/ }).getAttribute("href");
  expect(href).toContain("api/integrity/keys");
  const jwks = (await (await request.get("/api/integrity/keys")).json()) as {
    keys: { kid: string }[];
  };
  expect(jwks.keys.map((k) => k.kid)).toContain("e2e-key-1");
});

test("erases sections of an event and the chain still verifies", async ({ page }) => {
  await page.goto("/events?tenant=acme&actions=user.login");
  await rows(page).first().click();
  const sheet = drawer(page);
  await expect(sheet.getByText("203.0.113.7")).toBeVisible();

  await sheet.getByRole("button", { name: "Erase" }).click();
  const dialog = page.getByRole("dialog", { name: "Erase event data" });
  // Keep the actor; erase the rest.
  await dialog.getByRole("checkbox", { name: "actor" }).uncheck();
  await dialog.getByPlaceholder(/GDPR/).fill("GDPR request #42");
  await dialog.getByRole("button", { name: "Erase", exact: true }).click();
  await expect(page.getByText("Event erased")).toBeVisible();

  await expect(sheet.getByText("203.0.113.7")).toHaveCount(0);
  await expect(sheet.getByText("Alice Admin")).toBeVisible();
  await expect(sheet.getByText("erased", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/integrity?tenant=acme");
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByTestId("verify-summary")).toContainText(/Verified through #\d+/);
  await expect(page.getByText("Erased sections")).toBeVisible();
});

test("edits a panel-defined catalog entry; code entries are read-only", async ({ page }) => {
  await page.goto("/actions");
  await expect(page.getByRole("heading", { name: "Actions" })).toBeVisible();
  await expect(page.getByText("Billing", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit invoice.paid" })).toHaveCount(0);

  await page.getByRole("button", { name: "Edit report.exported" }).click();
  await page
    .getByPlaceholder("What does this action mean?")
    .fill("A PDF report left the building.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Action saved")).toBeVisible();
  await expect(page.getByText("A PDF report left the building.")).toBeVisible();

  await page.getByRole("button", { name: "New action" }).click();
  await page.getByPlaceholder("invoice.paid").fill("export.scheduled");
  await page.getByRole("button", { name: "Create action" }).click();
  await expect(page.getByText('Action "export.scheduled" created')).toBeVisible();
  await expect(page.getByText("export.scheduled", { exact: true })).toBeVisible();
});

test("shows stream lag and failures and retries a failing cursor", async ({ page }) => {
  await page.goto("/streams");
  const siem = page.getByRole("region", { name: "Stream siem" });
  await expect(siem.getByText(/SIEM endpoint unreachable/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(siem.getByText("failing").first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Stream archive" }).getByText("healthy").first(),
  ).toBeVisible({ timeout: 15_000 });

  await siem.getByRole("button", { name: "Retry siem for acme" }).click();
  await expect(page.getByText("Retry scheduled")).toBeVisible();
});

test("a portal token renders the tenant-scoped portal chrome", async ({ page, request }) => {
  const { token } = (await (await request.get("/e2e/portal-token?tenant=acme")).json()) as {
    token: string;
  };
  expect(token).toMatch(/^audpt_/);

  // ?token= is the bundled SPA's portal affordance: the API client sends it as
  // a Bearer credential; /config then reports portal mode. The token leaves the
  // address bar (no bookmarking, sharing or Referer leak).
  await page.goto(`/events?token=${token}`);
  await expect(page.getByText("Portal", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("token=");
  await expect(page.getByText("acme", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Tenant")).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const tab of ["Overview", "Tenants", "Streams"]) {
    await expect(nav.getByRole("button", { name: tab })).toHaveCount(0);
  }

  // Only the token's tenant; no erase.
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "globex" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Filter by action" }).fill("member.role_changed");
  await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(drawer(page).getByRole("heading", { name: "member.role_changed" })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: "Erase" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Customers can check their own log.
  await page.getByRole("button", { name: "Verify log integrity" }).click();
  await expect(page.getByTestId("verify-summary")).toContainText(/Verified through #\d+/);
  await expect(page.getByTestId("verify-summary")).toContainText("Signed by key e2e-key-1");
});

test("a filtered portal token cannot see excluded actions", async ({ page, request }) => {
  const { token } = (await (
    await request.get("/e2e/portal-token?tenant=acme&exclude=document.*")
  ).json()) as { token: string };
  await page.goto(`/events?token=${token}`);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "document.viewed" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});
