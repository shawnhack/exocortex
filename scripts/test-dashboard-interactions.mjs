#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 13212;
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP_DB = path.join(ROOT, ".ui-interactions-test.db");
const OUTPUT_DIR = path.join(ROOT, ".ui-test-output");

function cleanupDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = TEMP_DB + suffix;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function envWith(overrides) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  );
  return { ...env, ...overrides };
}

async function waitForServer(baseUrl, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(350);
  }
  throw new Error(`Server did not start within ${maxWaitMs}ms`);
}

async function createMemory(payload) {
  const res = await fetch(`${BASE}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Failed to seed memory (${res.status})`);
  }
  return res.json();
}

function safeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function runStep(page, stepName, fn, viewportLabel) {
  try {
    await fn();
    console.log(`PASS ${viewportLabel} ${stepName}`);
  } catch (error) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const shotPath = path.join(
      OUTPUT_DIR,
      `${safeName(stepName)}-${viewportLabel}.png`
    );
    await page.screenshot({ path: shotPath, fullPage: true });
    throw new Error(`[${viewportLabel}] ${stepName}: ${String(error)} (screenshot: ${shotPath})`);
  }
}

async function searchFor(page, text) {
  const input = page.getByPlaceholder("Search memories...");
  await input.fill(text);
  await input.press("Enter");
  await page.getByTestId("memory-card").first().waitFor({ state: "visible", timeout: 10000 });
}

async function runDesktopScenario(browser, seed) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const label = "desktop";

  try {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 15000 });

    await runStep(page, "edit-save-cancel-tag-flow", async () => {
      await searchFor(page, seed.editToken);

      await Promise.all([
        page.waitForURL(/\/memory\/.+/, { timeout: 10000 }),
        page.getByTestId("memory-card").first().click(),
      ]);

      await page.getByTestId("memory-edit-button").click();
      await page
        .getByTestId("memory-edit-textarea")
        .fill(`Edited content ${seed.editToken}`);
      await page.getByTestId("memory-edit-save").click();
      await page.getByTestId("memory-content").waitFor({ state: "visible" });
      await page.getByText(`Edited content ${seed.editToken}`).waitFor();

      await page.getByTestId("memory-edit-button").click();
      await page
        .getByTestId("memory-edit-textarea")
        .fill(`Unsaved content ${seed.editToken}`);
      await page.getByTestId("memory-edit-cancel").click();
      await page.getByTestId("memory-content").waitFor({ state: "visible" });
      const contentText = await page.getByTestId("memory-content").innerText();
      if (contentText.includes("Unsaved content")) {
        throw new Error("Cancel did not discard textarea edits");
      }

      await page.getByTestId("memory-edit-button").click();
      const tagInput = page.getByTestId("memory-edit-tag-input");
      await tagInput.fill(seed.addedTag);
      await tagInput.press("Enter");
      await page.getByTestId("memory-edit-save").click();
      await page.getByText(seed.addedTag).waitFor({ timeout: 10000 });
    }, label);

    await runStep(page, "search-filters-flow", async () => {
      await page.getByRole("button", { name: "Back" }).click();
      await page.waitForURL(`${BASE}/`);

      await searchFor(page, seed.filterToken);
      await page.getByTestId("search-filters-toggle").click();
      await page.getByTestId("search-filter-content-type").selectOption("summary");
      await page.getByTestId("memory-card").first().waitFor({ timeout: 10000 });

      const summaryCount = await page.getByText("summary / api").count();
      if (summaryCount === 0) {
        throw new Error("Summary filter did not yield summary cards");
      }

      const noteCount = await page.getByText("note / api").count();
      if (noteCount > 0) {
        throw new Error("Content type filter still shows note cards");
      }

      await page.getByTestId("search-filter-content-type").selectOption("");
    }, label);

    await runStep(page, "pagination-flow", async () => {
      await searchFor(page, seed.paginationToken);
      const next = page.getByRole("button", { name: "Next" });
      if (!(await next.isEnabled())) {
        throw new Error("Next button is disabled; pagination dataset may be too small");
      }
      await next.click();
      await page.getByText("Page 2", { exact: true }).waitFor({ timeout: 10000 });
    }, label);

    await runStep(page, "bulk-delete-restore-flow", async () => {
      await searchFor(page, seed.bulkToken);
      await page.getByRole("button", { name: "Select" }).click();
      await page.getByRole("button", { name: "Select all" }).click();
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.getByText(/0 result/).waitFor({ timeout: 10000 });

      await page.getByRole("link", { name: "Trash" }).click();
      await page.waitForURL(/\/trash/, { timeout: 10000 });
      const restoreButtons = page.getByRole("button", { name: "Restore" });
      if (await restoreButtons.count() > 0) {
        await restoreButtons.first().click();
        await page.getByRole("link", { name: "Search" }).click();
        await page.waitForURL(`${BASE}/`);
        await searchFor(page, seed.bulkToken);
        return;
      }

      await page.getByText("Trash is empty").waitFor({ timeout: 10000 });
      await page.getByRole("link", { name: "Search" }).click();
      await page.waitForURL(`${BASE}/`);
    }, label);
  } finally {
    await context.close();
  }
}

async function runMobileScenario(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const label = "mobile";

  try {
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 15000 });
    await runStep(page, "mobile-nav-flow", async () => {
      await page.locator(".mobile-hamburger").click();
      await page.getByRole("link", { name: "Timeline" }).click();
      await page.waitForURL(/\/timeline/, { timeout: 10000 });
      await page.getByRole("heading", { name: "Timeline" }).waitFor({ timeout: 10000 });
    }, label);
  } finally {
    await context.close();
  }
}

async function seed() {
  const suffix = Date.now();
  const editToken = `UI-EDIT-${suffix}`;
  const filterToken = `UI-FILTER-${suffix}`;
  const paginationToken = `UI-PAGE-${suffix}`;
  const bulkToken = `UI-BULK-${suffix}`;
  const addedTag = `ui-added-${suffix}`;

  await createMemory({
    content: `Editable baseline memory ${editToken}`,
    content_type: "note",
    source: "api",
    importance: 0.7,
    tags: ["ui", "edit"],
  });

  for (let i = 0; i < 25; i++) {
    await createMemory({
      content: `Pagination record ${paginationToken} index ${i}`,
      content_type: "text",
      source: "api",
      importance: 0.5,
      tags: ["ui", "pagination"],
    });
  }

  for (let i = 0; i < 3; i++) {
    await createMemory({
      content: `Filter summary ${filterToken} ${i}`,
      content_type: "summary",
      source: "api",
      importance: 0.6,
      tags: ["ui", "filter", "summary"],
    });
  }
  for (let i = 0; i < 2; i++) {
    await createMemory({
      content: `Filter note ${filterToken} ${i}`,
      content_type: "note",
      source: "api",
      importance: 0.6,
      tags: ["ui", "filter", "note"],
    });
  }

  for (let i = 0; i < 3; i++) {
    await createMemory({
      content: `Bulk delete restore item ${bulkToken} ${i}`,
      content_type: "note",
      source: "api",
      importance: 0.55,
      tags: ["ui", "bulk"],
    });
  }

  return { editToken, filterToken, paginationToken, bulkToken, addedTag };
}

async function main() {
  cleanupDbFiles();

  const dashboardIndex = path.join(ROOT, "packages/dashboard/dist/index.html");
  if (!fs.existsSync(dashboardIndex)) {
    throw new Error(
      "Missing dashboard build. Run: pnpm --filter @exocortex/dashboard build"
    );
  }

  const server = spawn(
    process.execPath,
    ["packages/cli/dist/index.js", "serve", "-p", String(PORT)],
    {
      cwd: ROOT,
      env: envWith({ EXOCORTEX_DB_PATH: TEMP_DB }),
      stdio: "ignore",
    }
  );

  let browser;
  try {
    await waitForServer(BASE);
    const seeded = await seed();

    browser = await chromium.launch({ headless: true });
    await runDesktopScenario(browser, seeded);
    await runMobileScenario(browser);

    console.log("UI interaction checks passed.");
  } finally {
    if (browser) await browser.close();
    server.kill();
    await sleep(1200);
    cleanupDbFiles();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
