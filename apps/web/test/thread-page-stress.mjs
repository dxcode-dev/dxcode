// Main-thread budget check for the real thread page (local only; never
// contacts providers). Builds the harness in production mode, serves it, and
// drives typing, resizing, scrolling, and Flue streaming in Chromium.
//
//   pnpm --filter @dx/web test:thread-perf            # build, serve, measure
//   node test/thread-page-stress.mjs <url> [--out f]  # measure a running preview
//
// Reports React commits, per-component render counts, long tasks, script time,
// and worst input latency per interaction. Exits 1 when any long task exceeds
// DX_PERF_BUDGET_MS (default 200) or streamed text fails to reach the DOM.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const urlArgument = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : undefined;
const budgetMs = Number(process.env.DX_PERF_BUDGET_MS ?? 200);
let server;
if (urlArgument === undefined) {
  const { build, preview } = await import("vite");
  const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
  await build({ configFile, logLevel: "warn" });
  server = await preview({ configFile, preview: { port: 0 } });
}
const base = urlArgument ?? server.resolvedUrls.local[0].replace(/\/$/, "");
const turns = Number(process.env.DX_STRESS_TURNS ?? 40);
const tool = Number(process.env.DX_STRESS_TOOL_CHARS ?? 2000);
// Memoized components render under their inner function names.
const WATCH = [
  "AgentPanel",
  "TranscriptViewport",
  "TranscriptTurn",
  "TranscriptTurnContent",
  "TranscriptRowShell",
  "TranscriptRowShellContent",
  "RichMarkdown",
  "CodeBlock",
  "ToolEvent",
  "TranscriptActivityList",
  "AgentComposer",
  "ThreadHeader",
  "AppSidebar",
  "SidebarThreadRows",
  "SidebarThreadRow",
  "ThreadContextMenu",
  "ChangesPane",
  "OrbIcon",
  "SettingsPage",
  "ProjectPage",
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const metric = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { script: get("ScriptDuration"), task: get("TaskDuration") };
};

await page.goto(`${base}/thread-page-stress.html?turns=${turns}&tool=${tool}`);
await page.waitForSelector('textarea[aria-label="Message"]:not([disabled])');
await page.waitForFunction(
  () =>
    document.querySelectorAll(".transcript-turn").length > 0 &&
    document.querySelectorAll(".product-sidebar .thread-row").length > 20,
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__long = [];
  window.__events = [];
  new PerformanceObserver((list) =>
    window.__long.push(...list.getEntries().map((e) => e.duration)),
  ).observe({ type: "longtask" });
  new PerformanceObserver((list) =>
    window.__events.push(...list.getEntries().map((e) => e.duration)),
  ).observe({ type: "event", durationThreshold: 16 });
});

const measure = async (name, action) => {
  await page.evaluate(() => {
    window.__long.length = 0;
    window.__events.length = 0;
    window.dxRenders.start();
  });
  const before = await metric();
  const detail = await action();
  await page.waitForTimeout(300);
  const after = await metric();
  const result = await page.evaluate(() => ({
    renders: window.dxRenders.stop(),
    long: [...window.__long],
    events: [...window.__events],
  }));
  const row = {
    scenario: name,
    commits: result.renders.commits,
    ...Object.fromEntries(WATCH.map((k) => [k, result.renders.counts[k] ?? 0])),
    totalRenders: Object.values(result.renders.counts).reduce(
      (a, b) => a + b,
      0,
    ),
    top: Object.entries(result.renders.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}:${v}`)
      .join(" "),
    longTasks: result.long.length,
    longestMs: Math.round(Math.max(0, ...result.long)),
    blockedMs: Math.round(result.long.reduce((a, b) => a + b, 0)),
    scriptMs: Math.round((after.script - before.script) * 1000),
    worstInputMs: Math.round(Math.max(0, ...result.events)),
    ...(detail ?? {}),
  };
  return row;
};

const drag = async (selector, dx) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`No element for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // One pointer move per frame; the user releases at the new width.
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(x + (dx * i) / 30, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

const results = [];
results.push(
  await measure("type 40 chars", async () => {
    await page.click('textarea[aria-label="Message"]');
    await page.keyboard.type("Please refactor the checkout flow quickly", {
      delay: 30,
    });
  }),
);
await page.fill('textarea[aria-label="Message"]', "");
// Open the right pane so both drags narrow the transcript enough to rewrap.
await page.click('button[aria-label="Show Right Pane"]');
await page.waitForTimeout(500);
results.push(
  await measure("drag left sidebar", () =>
    drag('[aria-label="Resize navigation"]', 180),
  ),
);
results.push(
  await measure("drag right pane", () =>
    drag(".right-pane-resize-handle", -300),
  ),
);
results.push(
  await measure("drag right pane back", () =>
    drag(".right-pane-resize-handle", 300),
  ),
);
results.push(
  await measure("toggle right pane", async () => {
    await page.click('button[aria-label="Hide Right Pane"]');
    await page.waitForTimeout(200);
    await page.click('button[aria-label="Show Right Pane"]');
  }),
);
results.push(
  await measure("scroll transcript", async () => {
    const box = await page.locator(".transcript-viewport").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(16);
    }
  }),
);
results.push(
  await measure("sidebar refetch x5 (no change)", () =>
    page.evaluate(() => window.dxPerf.refetchSidebar(5)),
  ),
);
results.push(
  await measure("sidebar one thread -> working", async () => {
    await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "working"));
    await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "idle"));
  }),
);
results.push(
  await measure("hover 15 sidebar rows (preview open)", async () => {
    const rows = page.locator(".product-sidebar .thread-row");
    // Pausing past the intent delay opens the preview; later rows update it.
    await rows.nth(1).hover();
    await page.waitForTimeout(700);
    for (let i = 2; i <= 15; i++) {
      await rows.nth(i).hover();
      await page.waitForTimeout(120);
    }
    await page.mouse.move(700, 450);
    await page.waitForTimeout(300);
  }),
);
results.push(
  await measure("idle 2s (no working orbs)", () => page.waitForTimeout(2000)),
);
await page.evaluate(async () => {
  for (let i = 1; i <= 10; i++)
    await window.dxPerf.setSidebarStatus(i, "working");
});
await page.waitForTimeout(500);
results.push(
  await measure("10 working orbs, idle 2s", () => page.waitForTimeout(2000)),
);
await page.evaluate(async () => {
  for (let i = 1; i <= 10; i++) await window.dxPerf.setSidebarStatus(i, "idle");
});

// Watch the stream from the live edge, like a user following the answer.
const toLiveEdge = () =>
  page.evaluate(async () => {
    const viewport = document.querySelector(".transcript-viewport");
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
  });
await toLiveEdge();
results.push(
  await measure("stream steady (1/16ms)", () =>
    page.evaluate(() =>
      window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
    ),
  ),
);
await toLiveEdge();
results.push(
  await measure("stream bursts (50/batch)", () =>
    page.evaluate(() => window.dxPerf.stream({ chars: 6_000, batchSize: 50 })),
  ),
);
await toLiveEdge();
results.push(
  await measure("type while streaming", async () => {
    const streaming = page.evaluate(() =>
      window.dxPerf.stream({ chars: 3_000, batchSize: 1, intervalMs: 16 }),
    );
    await page.click('textarea[aria-label="Message"]');
    await page.keyboard.type("steer: also add tests", { delay: 30 });
    return streaming;
  }),
);
// Other visible pages, through the same router and seeded cache.
const openRoute = async (route, ready) => {
  await page.goto(
    `${base}/thread-page-stress.html?turns=${turns}&tool=${tool}&route=${encodeURIComponent(route)}`,
  );
  await page.waitForFunction(ready);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__long = [];
    window.__events = [];
    new PerformanceObserver((list) =>
      window.__long.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask" });
    new PerformanceObserver((list) =>
      window.__events.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "event", durationThreshold: 16 });
  });
};
await openRoute("/projects/prj_00000000-0000-4000-8000-000000000147", () =>
  document.body.innerText.includes("Recent Threads"),
);
results.push(
  await measure("project page: refetch x5 + status", async () => {
    await page.evaluate(() => window.dxPerf.refetchSidebar(5));
    await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "working"));
    await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "idle"));
  }),
);
await openRoute("/settings", () =>
  document.body.innerText.includes("Perf User"),
);
await page.getByRole("button", { name: "Edit" }).first().click();
await page.waitForTimeout(200);
results.push(
  await measure("account settings: type 40 chars", async () => {
    await page.locator("main input, [role=dialog] input").first().click();
    await page.keyboard.type("Please refactor the checkout flow quickly", {
      delay: 30,
    });
  }),
);
await browser.close();

console.table(
  results.map(
    ({
      scenario,
      commits,
      longTasks,
      longestMs,
      blockedMs,
      scriptMs,
      worstInputMs,
      worstBatchMs,
      renderedChars,
    }) => ({
      scenario,
      commits,
      longTasks,
      longestMs,
      blockedMs,
      scriptMs,
      worstInputMs,
      worstBatchMs,
      renderedChars,
    }),
  ),
);
console.table(
  results.map((r) => ({
    scenario: r.scenario,
    totalRenders: r.totalRenders,
    AgentPanel: r.AgentPanel,
    Viewport: r.TranscriptViewport,
    Turn: r.TranscriptTurn + r.TranscriptTurnContent,
    Markdown: r.RichMarkdown,
    Composer: r.AgentComposer,
    SidebarRows: r.SidebarThreadRows,
    ContextMenu: r.ThreadContextMenu,
    Orb: r.OrbIcon,
    SettingsPage: r.SettingsPage,
  })),
);
for (const r of results) console.log(`${r.scenario.padEnd(26)} top: ${r.top}`);
if (errors.length)
  console.error("page errors:", [...new Set(errors)].slice(0, 8));
if (out) writeFileSync(out, JSON.stringify({ turns, tool, results }, null, 2));
await server?.close();
const overBudget = results.filter((r) => r.longestMs > budgetMs);
const missingText = results.filter((r) => r.renderedChars === 0);
for (const r of overBudget)
  console.error(
    `over budget: ${r.scenario} longest task ${r.longestMs}ms > ${budgetMs}ms`,
  );
for (const r of missingText)
  console.error(`streamed text did not render: ${r.scenario}`);
process.exit(
  overBudget.length + missingText.length + errors.length > 0 ? 1 : 0,
);
