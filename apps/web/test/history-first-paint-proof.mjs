// First paint of a recorded heavy Thread (local only; never contacts
// providers). The thread page opens with the product's own Flue client and
// session; history reads are answered from pages recorded by the Core
// lifecycle fixture:
//
//   DX_HISTORY_BUDGET_ARTIFACTS=<dir> pnpm --filter @dx/core test:lifecycle
//   node test/history-first-paint-proof.mjs <dir> [--out result.json]
//
// <dir> holds page-0.json (the first page), page-1.json, ... in the order
// their `before` cursors chain. Reports the first page's bytes, its
// JSON.parse time, the time from the history request to the first painted
// transcript turn, long tasks while opening, and how many older pages load
// as the transcript scrolls to the top. Runs each CPU rate three times and
// keeps the median.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { chromium } from "playwright-core";

const directory = process.argv[2];
if (directory === undefined || directory.startsWith("--"))
  throw new Error("Usage: history-first-paint-proof.mjs <pages-dir> [--out f]");
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const harIndex = process.argv.indexOf("--har");
const har = harIndex > 0 ? process.argv[harIndex + 1] : undefined;

const pages = readdirSync(directory)
  .filter((name) => /^page-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  .map((name) => readFileSync(join(directory, name)));
if (pages.length === 0) throw new Error(`No recorded pages in ${directory}.`);
// Page n+1 answers the `before` cursor page n returned.
const byCursor = new Map(
  pages.flatMap((body, index) => {
    const cursor = JSON.parse(body.toString()).olderCursor;
    return cursor === null || index + 1 >= pages.length
      ? []
      : [[cursor, pages[index + 1]]];
  }),
);
const first = pages[0];
const sizes = {
  raw: first.byteLength,
  gzip: gzipSync(first, { level: 6 }).byteLength,
  br: brotliCompressSync(first, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  }).byteLength,
};

const { build, preview } = await import("vite");
const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
await build({ configFile, logLevel: "warn" });
const server = await preview({ configFile, preview: { port: 0 } });
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch();
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const open = async (rate, recordHar) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(recordHar ? { recordHar: { path: har, content: "omit" } } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  const console = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) =>
    console.push(`${message.type()}: ${message.text()}`),
  );
  const queries = [];
  await page.route("**/__history?*", (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    const before = url.searchParams.get("before");
    const body = before === null ? first : byCursor.get(before);
    return body === undefined
      ? route.fulfill({ status: 400, body: "unknown cursor" })
      : route.fulfill({ contentType: "application/json", body });
  });
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((list) =>
      window.__long.push(
        ...list.getEntries().map((entry) => ({
          start: entry.startTime,
          duration: entry.duration,
        })),
      ),
    ).observe({ type: "longtask", buffered: true });
    new MutationObserver((_, observer) => {
      if (document.querySelector(".transcript-turn") === null) return;
      window.__turnInDom = performance.now();
      requestAnimationFrame(() =>
        setTimeout(() => {
          window.__turnPainted = performance.now();
        }),
      );
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.goto(`${base}/thread-page-stress.html?history=1`);
  await page.waitForFunction(() => window.__turnPainted !== undefined, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1_000);
  const timing = await page.evaluate(() => {
    const request = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/__history?"));
    return {
      requestStart: request.startTime,
      responseEnd: request.responseEnd,
      turnInDom: window.__turnInDom,
      turnPainted: window.__turnPainted,
      long: window.__long,
    };
  });
  // JSON.parse of the first page in this renderer, median of five.
  const parseMs = await page.evaluate(async () => {
    // The harness answers `fetch`; read the recorded page over the network.
    const text = await window
      .__networkFetch("/__history?view=history")
      .then((response) => response.text());
    const runs = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      JSON.parse(text);
      runs.push(performance.now() - started);
    }
    return runs.sort((a, b) => a - b)[2];
  });
  const opening = timing.long.filter(
    (task) => task.start >= timing.requestStart,
  );
  const turnsAtOpen = await page.locator(".transcript-turn").count();
  // Older history loads as the transcript scrolls to the top.
  const viewport = page.locator(".transcript-viewport");
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 40; step += 1) {
    await page.mouse.wheel(0, -4_000);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const result = {
    historyMs: Math.round(timing.responseEnd - timing.requestStart),
    firstPaintMs: Math.round(timing.turnPainted - timing.requestStart),
    parseMs: Math.round(parseMs * 10) / 10,
    longTasks: opening.length,
    longestTaskMs: Math.round(Math.max(0, ...opening.map((t) => t.duration))),
    blockedMs: Math.round(opening.reduce((sum, t) => sum + t.duration, 0)),
    turnsAtOpen,
    olderPagesLoaded: queries.filter((query) => query.includes("before="))
      .length,
    turnsAfterScroll: await page.locator(".transcript-turn").count(),
    firstQuery: queries[0],
    errors,
    console: console.filter((line) => line.startsWith("error")),
  };
  await context.close();
  return result;
};

const results = {};
for (const rate of [1, 4]) {
  const runs = [];
  // One warm-up load, then three measured loads.
  await open(rate, false);
  for (let run = 0; run < 3; run += 1)
    runs.push(await open(rate, har !== undefined && rate === 1 && run === 0));
  const pick = (key) => median(runs.map((run) => run[key]));
  results[`cpu${rate}x`] = {
    historyMs: pick("historyMs"),
    parseMs: pick("parseMs"),
    firstPaintMs: pick("firstPaintMs"),
    longTasks: pick("longTasks"),
    longestTaskMs: pick("longestTaskMs"),
    blockedMs: pick("blockedMs"),
    turnsAtOpen: runs[0].turnsAtOpen,
    olderPagesLoaded: runs[0].olderPagesLoaded,
    turnsAfterScroll: runs[0].turnsAfterScroll,
    firstQuery: runs[0].firstQuery,
    errors: runs.flatMap((run) => run.errors),
    consoleErrors: runs.flatMap((run) => run.console),
  };
}
await browser.close();
await server.close();

const report = { directory, pages: pages.length, firstPage: sizes, ...results };
console.log(JSON.stringify(report, null, 2));
if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
const failed = Object.values(results).some(
  (result) => result.errors.length > 0 || result.turnsAtOpen === 0,
);
process.exit(failed ? 1 : 0);
