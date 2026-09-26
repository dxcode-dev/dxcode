import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright-core";

const root = new URL("../dist/", import.meta.url).pathname;
const executablePath = process.env.CHROME_PATH;
assert(
  executablePath,
  "CHROME_PATH is required: set it to a Chromium or Chrome executable",
);
const csp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
};
const build = spawn("pnpm", ["build"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
});
assert.equal(
  await new Promise((resolve) => build.on("exit", resolve)),
  0,
  "production build failed",
);

const server = createServer(async (request, response) => {
  if (request.url === "/favicon.ico") return response.writeHead(204).end();
  const pathname = request.url === "/" ? "/ghostty-proof.html" : request.url;
  const path = normalize(join(root, pathname));
  if (!path.startsWith(root)) return response.writeHead(404).end();
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "content-security-policy": csp,
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");

const browser = await chromium.launch({
  executablePath,
  headless: true,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const violations = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      violations.push(message.text());
      console.error(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "networkidle",
  });
  const heartbeat = await Promise.race([
    page.evaluate(() => ({
      readyState: document.readyState,
      now: performance.now(),
    })),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error("unresponsive browser: CDP heartbeat timed out")),
        5_000,
      ),
    ),
  ]);
  assert.equal(
    heartbeat.readyState,
    "complete",
    "initialization failure: document did not load",
  );
  await page
    .getByRole("status")
    .filter({ hasText: "Terminal ready" })
    .waitFor({ timeout: 30_000 })
    .catch(() =>
      assert.fail(
        `initialization failure: Terminal ready was not reached: ${[...pageErrors, ...violations].join("\n")}`,
      ),
    );
  const canvas = page.locator("#terminal canvas");
  await canvas
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() =>
      assert.fail(
        "render failure: terminal canvas was not visible after readiness",
      ),
    );
  assert.equal(
    await page
      .locator("#terminal")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("caret-color"),
      ),
    "rgba(0, 0, 0, 0)",
    "browser editing caret remained visible over the terminal canvas",
  );
  const blankCanvas = await canvas.screenshot();
  await page.evaluate(() => {
    window.ghosttyProof.terminal.write(
      "\u001b[32mGhostty Web 0.4.0\u001b[0m\r\n" + "https://example.com\r\n",
    );
  });
  await page.waitForTimeout(100);
  const paintedCanvas = await canvas.screenshot();
  assert.notDeepEqual(
    paintedCanvas,
    blankCanvas,
    "render failure: canvas pixels did not change after known output",
  );
  const activatedLink = await page.evaluate(async () => {
    const proof = window.ghosttyProof;
    const terminal = proof.terminal;
    const detector = terminal.linkDetector;
    if (detector === undefined)
      throw new Error("link proof requires the mounted link detector");
    let openedUrl;
    const originalOpen = window.open;
    window.open = (url) => {
      openedUrl = String(url);
      return null;
    };
    try {
      let link;
      for (let row = 0; row < terminal.buffer.active.length && !link; row += 1)
        for (let column = 0; column < terminal.cols && !link; column += 1)
          link = await detector.getLinkAt(column, row);
      if (link === undefined)
        throw new Error("URL output did not produce a detected link");
      link.activate(new MouseEvent("click", { metaKey: true }));
      return openedUrl;
    } finally {
      window.open = originalOpen;
    }
  });
  assert.equal(
    activatedLink,
    "https://example.com",
    "link activation did not open the detected URL target",
  );

  const accessibility = await page.locator("#terminal").evaluate((element) => ({
    role: element.getAttribute("role"),
    label: element.getAttribute("aria-label"),
  }));
  assert.deepEqual(
    accessibility,
    { role: "application", label: "Terminal" },
    `accessibility mismatch: expected role=application aria-label=Terminal after open; received role=${accessibility.role} aria-label=${accessibility.label}`,
  );

  const result = await page.evaluate(async () => {
    const proof = window.ghosttyProof;
    const terminal = proof.terminal;
    const initial = { cols: terminal.cols, rows: terminal.rows };
    terminal.write(
      Array.from({ length: 120 }, (_, index) => `scrollback-${index}\r\n`).join(
        "",
      ),
    );
    terminal.write("\u001b[?2004h");
    terminal.paste("paste\ntext");
    terminal.input("typed", true);
    terminal.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" }),
    );
    terminal.textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "c",
        code: "KeyC",
        ctrlKey: true,
      }),
    );
    terminal.textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
    terminal.textarea.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    proof.element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
    );
    for (const type of ["mousemove", "mousedown", "mouseup"]) {
      proof.element.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 }),
      );
    }
    terminal.select(0, 0, 7);
    const selection = terminal.getSelection();
    terminal.scrollToTop();
    const scrollback = terminal.getScrollbackLength();
    const viewport = terminal.getViewportY();
    terminal.resize(91, 27);
    const resized = { cols: terminal.cols, rows: terminal.rows };
    const canvas = proof.element.querySelector("canvas");
    const highDpi =
      canvas instanceof HTMLCanvasElement && canvas.width > canvas.clientWidth;
    const input = [...window.ghosttyInput];
    proof.dispose();
    proof.dispose();
    const disposed = proof.element.childElementCount === 0;
    window.dispatchEvent(new Event("resize"));
    return {
      initial,
      resized,
      selection,
      scrollback,
      viewport,
      highDpi,
      input,
      disposed,
    };
  });
  await page.waitForTimeout(50);
  const observerCleaned = await page
    .locator("#terminal")
    .evaluate((element) => element.childElementCount === 0);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Terminal ready").waitFor();
  const remounted = await page
    .locator("#terminal")
    .evaluate(
      (element) =>
        element.querySelector("canvas") !== null &&
        element.getAttribute("role") === "application" &&
        element.getAttribute("aria-label") === "Terminal",
    );
  await page.evaluate(() => window.ghosttyProof.dispose());
  assert(
    result.initial.cols > 0 && result.initial.rows > 0,
    "fit did not establish dimensions",
  );
  assert.deepEqual(result.resized, { cols: 91, rows: 27 });
  assert(
    result.scrollback > 0 && result.viewport > 0,
    "scrollback did not move",
  );
  assert(result.selection.length > 0, "selection/copy source is empty");
  assert(result.highDpi, "canvas was not scaled for devicePixelRatio");
  assert(
    result.input.includes("\u001b[200~paste\ntext\u001b[201~"),
    "bracketed paste was not emitted",
  );
  assert(result.input.includes("typed"), "terminal input was not emitted");
  assert(
    result.input.some((data) => data.includes("日本語")),
    "IME composition was not emitted",
  );
  assert(result.disposed, "dispose left terminal DOM behind");
  assert(
    observerCleaned,
    "dispose left a resize observer or terminal DOM behind",
  );
  assert(remounted, "terminal did not remount after disposal");
  assert.equal(
    violations.filter((line) => line.includes("Content Security Policy"))
      .length,
    0,
    violations.join("\n"),
  );
  console.log(
    JSON.stringify(
      {
        package: "ghostty-web@0.4.0",
        browser: await browser.version(),
        csp,
        ...result,
        observerCleaned,
        remounted,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
