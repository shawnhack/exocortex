#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 13211;
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP_DB = path.join(ROOT, ".ui-layout-test.db");
const OUTPUT_DIR = path.join(ROOT, ".ui-test-output");
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "mobile", width: 390, height: 844 },
];

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

async function waitForServer(baseUrl, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server did not start within ${maxWaitMs}ms`);
}

function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function createMemory(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create memory (${res.status}): ${body}`);
  }

  const memory = await res.json();
  if (!memory?.id) {
    throw new Error("Create memory response missing id");
  }
  return memory.id;
}

async function assertNoHorizontalOverflow(locator, label) {
  const hasHorizontalOverflow = await locator.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1
  );
  if (hasHorizontalOverflow) {
    throw new Error(`${label} overflows horizontally`);
  }
}

async function assertMemoryDetailLayout(page, viewportLabel) {
  const editButton = page.getByTestId("memory-edit-button");
  const content = page.getByTestId("memory-content");

  await editButton.waitFor({ state: "visible", timeout: 10000 });
  await content.waitFor({ state: "visible", timeout: 10000 });

  const [buttonBox, contentBox] = await Promise.all([
    editButton.boundingBox(),
    content.boundingBox(),
  ]);

  if (!buttonBox || !contentBox) {
    throw new Error(`[${viewportLabel}] Could not read element bounds`);
  }

  if (intersects(buttonBox, contentBox)) {
    throw new Error(
      `[${viewportLabel}] Edit button overlaps content area`
    );
  }

  await assertNoHorizontalOverflow(
    content,
    `[${viewportLabel}] Memory content`
  );

  const metadataValues = page.getByTestId("memory-metadata-value");
  const metadataCount = await metadataValues.count();
  if (metadataCount === 0) {
    throw new Error(`[${viewportLabel}] Missing metadata values`);
  }
  for (let i = 0; i < metadataCount; i++) {
    await assertNoHorizontalOverflow(
      metadataValues.nth(i),
      `[${viewportLabel}] Metadata value #${i + 1}`
    );
  }
}

async function assertCardsLayout(page, viewportLabel, pageLabel) {
  const cards = page.getByTestId("memory-card");
  await cards.first().waitFor({ state: "visible", timeout: 10000 });
  const cardCount = await cards.count();
  if (cardCount === 0) {
    throw new Error(`[${viewportLabel}] No memory cards found on ${pageLabel}`);
  }

  const inspectCount = Math.min(cardCount, 10);
  for (let i = 0; i < inspectCount; i++) {
    const card = cards.nth(i);
    await assertNoHorizontalOverflow(
      card,
      `[${viewportLabel}] ${pageLabel} card #${i + 1}`
    );
    await assertNoHorizontalOverflow(
      card.getByTestId("memory-card-content"),
      `[${viewportLabel}] ${pageLabel} card content #${i + 1}`
    );
  }
}

async function runCheck(browser, viewport, testName, fn) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await fn(page, viewport.label);
    console.log(`PASS ${viewport.label} ${testName}`);
  } catch (error) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const shotPath = path.join(
      OUTPUT_DIR,
      `${sanitizeName(testName)}-${viewport.label}.png`
    );
    await page.screenshot({ path: shotPath, fullPage: true });
    throw new Error(`[${viewport.label}] ${testName}: ${String(error)} (screenshot: ${shotPath})`);
  } finally {
    await context.close();
  }
}

async function main() {
  cleanupDbFiles();

  const cliEntry = path.join(ROOT, "packages/cli/dist/index.js");
  const dashboardIndex = path.join(ROOT, "packages/dashboard/dist/index.html");
  if (!fs.existsSync(cliEntry)) {
    throw new Error(
      "Missing packages/cli/dist/index.js. Run: pnpm build"
    );
  }
  if (!fs.existsSync(dashboardIndex)) {
    throw new Error(
      "Missing dashboard build. Run: pnpm --filter @exocortex/dashboard build"
    );
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  );
  env.EXOCORTEX_DB_PATH = TEMP_DB;

  const server = spawn(
    process.execPath,
    [cliEntry, "serve", "-p", String(PORT)],
    {
      cwd: ROOT,
      env,
      stdio: "ignore",
    }
  );

  let browser;
  try {
    await waitForServer(BASE);

    const longUnbrokenToken =
      "THISISALONGUNBROKENTOKENFORWRAPTEST".repeat(8);
    const searchToken = "UI_LAYOUT_REGRESSION_TARGET";
    const detailContent =
      "2026-02-20 baseline established: defined Golden Query Set v1 (8 core queries) and recorded top-10 retrieval IDs for each query in memory 01KHYF1CP73X1PVT17E555TMV1. Initial canary: Q6 shows topic bleed; Q3/Q4 are strong-signal. " +
      longUnbrokenToken;
    const longSourceUri = `https://example.com/${"verylongsegment".repeat(20)}`;

    const detailMemoryId = await createMemory(BASE, {
      content: detailContent,
      content_type: "note",
      source: "api",
      source_uri: longSourceUri,
      importance: 0.7,
      tags: ["ui", "regression", "detail"],
      metadata: {
        context: "baseline",
        long_value: longUnbrokenToken.repeat(2),
      },
    });

    await createMemory(BASE, {
      content: `${searchToken} baseline memory for layout checks. ${longUnbrokenToken}`,
      content_type: "note",
      source: "api",
      importance: 0.65,
      tags: ["ui", "regression", "search"],
    });
    await createMemory(BASE, {
      content: `${searchToken} second result to validate multiple cards in search and timeline.`,
      content_type: "note",
      source: "api",
      importance: 0.6,
      tags: ["ui", "regression"],
    });

    browser = await chromium.launch({ headless: true });
    for (const viewport of VIEWPORTS) {
      await runCheck(browser, viewport, "memory-detail-layout", async (page, label) => {
        await page.goto(`${BASE}/memory/${detailMemoryId}`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        await assertMemoryDetailLayout(page, label);
      });

      await runCheck(browser, viewport, "search-cards-layout", async (page, label) => {
        await page.goto(`${BASE}/`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        const input = page.getByPlaceholder("Search memories...");
        await input.fill(searchToken);
        await input.press("Enter");
        await assertCardsLayout(page, label, "search");
      });

      await runCheck(browser, viewport, "timeline-cards-layout", async (page, label) => {
        await page.goto(`${BASE}/timeline`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        await assertCardsLayout(page, label, "timeline");
      });
    }

    console.log("UI layout checks passed.");
  } finally {
    if (browser) await browser.close();
    server.kill();
    await sleep(1500);
    cleanupDbFiles();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
