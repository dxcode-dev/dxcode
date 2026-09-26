// Local product proof against a supervised `pnpm dev`, driven through the
// browser launched by agent-browser. Never contacts deployed providers.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, checkout, variant, output] = process.argv.slice(2);
assert(new URL(base).hostname === "127.0.0.1", "Proof is local-only");
assert(["baseline", "updated"].includes(variant));
const browser = await chromium.connectOverCDP(process.env.DX_PROOF_CDP);
// Own the recording context so automation and video always target the same page.
const context = await browser.newContext({
  ...(process.env.DX_PROOF_VIDEO === undefined
    ? {}
    : {
        recordVideo: {
          dir: process.env.DX_PROOF_VIDEO,
          size: { width: 1440, height: 900 },
        },
      }),
});
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: base,
});
const credentials = parseEnv(
  readFileSync(resolve(checkout, "apps/core/.dev.vars"), "utf8"),
);
const request = async (path, method = "GET", data) => {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    data,
    headers: { origin: base },
  });
  assert(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.json();
};
await request("/api/auth/sign-in/email", "POST", {
  email: credentials.DX_LOCAL_AUTH_EMAIL,
  password: credentials.DX_LOCAL_AUTH_PASSWORD,
});
const project = (
  await request("/v1/projects", "POST", {
    name: `changes-proof-${variant}-${Date.now()}`,
    source: {
      kind: "github-url",
      url: "https://github.com/dxcode-dev/local-fixture.git",
    },
  })
).data;
const thread = (
  await request("/v1/threads", "POST", {
    projectId: project.id,
    title: `Changes verification: ${variant}`,
  })
).data;
const endpoint = `/v1/threads/${thread.id}`;
const events = [],
  errors = [],
  warnings = [];
const hideProfiler = () =>
  page.evaluate(() => {
    const internals = globalThis.__REACT_SCAN__?.ReactScanInternals;
    if (internals !== undefined) {
      internals.options.value = {
        ...internals.options.value,
        enabled: false,
        showToolbar: false,
      };
      if (
        internals.instrumentation !== undefined &&
        internals.instrumentation !== null
      )
        internals.instrumentation.isPaused.value = true;
    }
    globalThis.reactScanCleanupListeners?.();
    for (const element of document.querySelectorAll("[data-react-scan]"))
      element.remove();
  });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type()))
    warnings.push(message.text());
});
page.on("response", (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith("/v1/"))
    events.push({
      at: Date.now(),
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      durationMs: response.request().timing().responseEnd,
    });
});
page.on("websocket", (socket) => {
  if (!socket.url().includes("/changes/events")) return;
  events.push({ at: Date.now(), websocket: "connected" });
  socket.on("framereceived", () =>
    events.push({ at: Date.now(), websocket: "update" }),
  );
  socket.on("close", () =>
    events.push({ at: Date.now(), websocket: "closed" }),
  );
});
await page.goto(`${base}/threads/${thread.id}`);
await page
  .getByRole("textbox", { name: "Message", exact: true })
  .fill(
    "Reply with two short sentences confirming this synthetic model-stream check. Do not use tools.",
  );
await page
  .getByRole("textbox", { name: "Message", exact: true })
  .press("Enter");
await page
  .getByRole("button", { name: "Show Right Pane", exact: true })
  .waitFor({ timeout: 90_000 });
// Remove only the development profiler overlay, consistently in both variants.
await page.addStyleTag({
  content:
    "html > canvas, [data-react-scan], #react-scan-root, .tsqd-parent-container, .tsqd-open-btn-container { display: none !important; }",
});
await hideProfiler();
await page
  .getByRole("button", { name: "Show Right Pane", exact: true })
  .click();
await page.getByRole("region", { name: "Changes", exact: true }).waitFor();
const initial = (await request(`${endpoint}/files/README.md`)).data;
await page.screenshot({ path: output.replace(/\.json$/, "-empty.png") });
let version = initial.contentVersion;
const samples = [];
for (let count = 1; count <= 5; count++) {
  const content = `${initial.content}${Array.from({ length: count }, (_, i) => `capture sample ${i + 1}\n`).join("")}`;
  const started = performance.now();
  const saved = (
    await request(`${endpoint}/files/README.md`, "PATCH", {
      content,
      expectedVersion: version,
    })
  ).data;
  const savedMs = performance.now() - started;
  version = saved.contentVersion;
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll(".changes-file-trigger")].some(
        (row) =>
          row.textContent.includes("README.md") &&
          row.querySelector(".changes-additions")?.textContent ===
            `+${expected}`,
      ),
    count,
    { timeout: 20_000 },
  );
  samples.push({
    count,
    saveMs: Math.round(savedMs),
    visibleMs: Math.round(performance.now() - started),
  });
  if (count === 1)
    await page
      .locator(".changes-file-trigger")
      .filter({ hasText: "README.md" })
      .click();
}
const checks = { listUpdates: true };
if (variant === "updated") {
  await page
    .getByText("capture sample 5", { exact: true })
    .first()
    .waitFor({ timeout: 10_000 });
  checks.expandedDiffUpdates = true;
  const root = resolve(
    checkout,
    `.dx/local/workspaces/${thread.id}/home/workspace/repo`,
  );
  // Test input written outside Files/agent mutation wrappers, as a background command would.
  const started = performance.now();
  writeFileSync(
    resolve(root, "background-proof.txt"),
    "Captured without an editor save.\n",
  );
  await page
    .locator(".changes-file-trigger")
    .filter({ hasText: "background-proof.txt" })
    .waitFor({ timeout: 10_000 });
  checks.backgroundVisibleMs = Math.round(performance.now() - started);
  await page
    .locator(".changes-file-trigger")
    .filter({ hasText: "background-proof.txt" })
    .click();
  await page
    .getByText("Captured without an editor save.", { exact: true })
    .first()
    .waitFor();
  const capture = (await request(`${endpoint}/changes`)).data;
  await request(`${endpoint}/archive`, "PATCH", { archived: true });
  const paused = (await request(`${endpoint}/changes`)).data;
  assert.equal(paused.captureId, capture.captureId);
  const diff = (
    await request(
      `${endpoint}/changes/diff?path=background-proof.txt&captureId=${capture.captureId}`,
    )
  ).data;
  assert(diff.patch.includes("Captured without an editor save."));
  checks.archivedDiffRead = true;
  // Restoring metadata does not restart execution. Archived chat intentionally
  // hides workspace controls; reopen the pane on the now-paused thread.
  await request(`${endpoint}/archive`, "PATCH", { archived: false });
  await page.reload();
  await page.addStyleTag({
    content:
      "html > canvas, [data-react-scan], #react-scan-root, .tsqd-parent-container, .tsqd-open-btn-container { display: none !important; }",
  });
  await page
    .getByRole("button", { name: "Show Right Pane", exact: true })
    .click();
  await page
    .locator(".changes-file-trigger")
    .filter({ hasText: "background-proof.txt" })
    .waitFor({ timeout: 15_000 });
  await page
    .locator(".changes-file-trigger")
    .filter({ hasText: "background-proof.txt" })
    .click();
  await page
    .getByText("Captured without an editor save.", { exact: true })
    .first()
    .waitFor();
  checks.pausedReloadAndDiff = true;
}
assert.deepEqual(errors, [], "Browser page errors");
const medianVisibleMs = [...samples].sort(
  (a, b) => a.visibleMs - b.visibleMs,
)[2].visibleMs;
await hideProfiler();
await page.screenshot({ path: output.replace(/\.json$/, "-desktop.png") });
const fileActions = page.getByRole("button", {
  name: "Actions for background-proof.txt",
  exact: true,
});
await fileActions.click();
await page.getByRole("menuitem", { name: "Copy Path", exact: true }).waitFor();
await page.getByRole("menuitem", { name: "Open File", exact: true }).waitFor();
await page.screenshot({
  path: output.replace(/\.json$/, "-desktop-actions.png"),
});
await page.getByRole("menuitem", { name: "Copy Path", exact: true }).click();
assert.equal(
  await page.evaluate(() => navigator.clipboard.readText()),
  "background-proof.txt",
);
checks.copyPath = true;
await fileActions.click();
await page.getByRole("menuitem", { name: "Open File", exact: true }).click();
await page
  .getByRole("tab", { name: "background-proof.txt", exact: true })
  .waitFor();
await page.locator(".cm-editor").waitFor();
checks.openFile = true;
await hideProfiler();
await page.screenshot({
  path: output.replace(/\.json$/, "-selected-file.png"),
});
await page.getByRole("button", { name: "Wrap lines", exact: true }).click();
const resize = page.getByRole("slider", { name: "Resize right pane" });
for (let index = 0; index < 7; index++) await resize.press("ArrowRight");
await page.evaluate(
  () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    ),
);
await hideProfiler();
await page
  .locator(".changes-pane")
  .screenshot({ path: output.replace(/\.json$/, "-mobile-width.png") });
writeFileSync(
  output,
  JSON.stringify(
    {
      variant,
      threadId: thread.id,
      samples,
      medianVisibleMs,
      checks,
      errors,
      warnings,
      events,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    variant,
    samples,
    medianVisibleMs,
    checks,
    errors,
    warnings,
  }),
);
await context.close();
// Disconnect automation; agent-browser still owns the browser process.
await browser.close();
