// Proves that a tab opened before a deploy recovers when it later opens
// Settings, whose loader imports a code-split chunk the deploy removed (local
// only; never contacts providers). Builds the thread page harness in
// production mode and serves it the way Cloudflare static assets do: a missing
// file answers with the HTML entry. A reference run records the chunks that
// opening Settings fetches; a fresh page then loses those chunks, opens
// Settings, and must reload once instead of showing an error view.
//
//   pnpm --filter @dx/web test:stale-chunk
//
// Writes report.json, a HAR, and console/page errors to
// .dx/journeys/stale-chunk/ and exits 1 unless the page reloaded.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/stale-chunk",
);
mkdirSync(output, { recursive: true });
const { build } = await import("vite");
await build({
  configFile: resolve(import.meta.dirname, "../vite.stress.config.ts"),
  logLevel: "warn",
});
const dist = resolve(import.meta.dirname, "../node_modules/.stress-dist");
const entry = readFileSync(join(dist, "thread-page-stress.html"));
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
};
const server = createServer((request, response) => {
  const path = join(
    dist,
    decodeURIComponent(new URL(request.url, "http://x").pathname),
  );
  if (path.startsWith(dist) && existsSync(path) && extname(path) !== "") {
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
    });
    response.end(readFileSync(path));
    return;
  }
  // notFoundHandling: "single-page-application"
  response.writeHead(200, { "content-type": "text/html" });
  response.end(entry);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const threadUrl = `http://127.0.0.1:${server.address().port}/thread-page-stress.html?turns=4&tool=200`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordHar: { path: join(output, "stale-chunk.har") },
});
const errors = [];
const openThread = async () => {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(threadUrl);
  await page.waitForSelector('textarea[aria-label="Message"]:not([disabled])');
  await page.waitForLoadState("networkidle");
  return page;
};
const openSettings = async (page) => {
  await page.click('[aria-label="Open account menu"]');
  await page.getByText("Personal Settings").click();
};

// Reference run: which chunks does opening Settings fetch?
const reference = await openThread();
const fetched = new Set();
reference.on("request", (request) => {
  const { pathname } = new URL(request.url());
  if (pathname.endsWith(".js")) fetched.add(pathname);
});
await openSettings(reference);
await reference.waitForSelector(".settings-shell");
await reference.waitForLoadState("networkidle");
await reference.close();
const removedChunks = [...fetched];

// Deploy: the tab is open, then those chunks disappear.
const page = await openThread();
await page.evaluate(() => {
  window.__openedBeforeDeploy = true;
});
for (const chunk of removedChunks)
  renameSync(join(dist, chunk), join(dist, `${chunk}.removed`));
await openSettings(page);
const reloaded = await page
  .waitForFunction(() => window.__openedBeforeDeploy === undefined, null, {
    timeout: 15_000,
  })
  .then(
    () => true,
    () => false,
  );
const errorViewShown =
  (await page.getByText("Something went wrong").count()) > 0;
for (const chunk of removedChunks)
  renameSync(join(dist, `${chunk}.removed`), join(dist, chunk));

await context.close();
await browser.close();
server.close();
const passed = reloaded && !errorViewShown && removedChunks.length > 0;
const report = { passed, reloaded, errorViewShown, removedChunks };
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(join(output, "errors.txt"), `${errors.join("\n")}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Evidence: ${output}`);
if (!passed) process.exitCode = 1;
