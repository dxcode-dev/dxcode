// Proves that focusing a composer on a touch device does not zoom the page, in
// the real production build (local only; never contacts providers). iOS
// Safari zooms into a focused text field to
// clamp(16 / fontSize, minimumScale, maximumScale): WebKit's
// -[WKWebView _zoomToFocusRect:...] in Source/WebKit/UIProcess/API/ios/
// WKWebViewIOS.mm, with webViewStandardFontSize = 16. Playwright's Linux WebKit
// does not run that iOS UIKit path, so this proof taps each composer and
// applies the same formula to the focused field's computed font size and the
// page's viewport scale limits. It also sweeps every text field on the page,
// and checks that desktop composers keep their size. Builds the thread page
// harness, serves it, and drives Chromium and WebKit
// (`npx playwright@1.55.0 install chromium webkit` once).
//
//   pnpm --filter @dx/web test:composer-focus-zoom
//
// Writes report.json, screenshots, a HAR per context, console output, and
// page errors to .dx/journeys/composer-focus-zoom/ and exits 1 when any check
// fails.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, devices, webkit } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/composer-focus-zoom",
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const { build, preview } = await import("vite");
const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
await build({ configFile, logLevel: "warn" });
const server = await preview({ configFile, preview: { port: 0 } });
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const threadId = "thr_00000000-0000-4000-8000-000000000147";
const harness = (route) =>
  `${base}/thread-page-stress.html?turns=2&tool=50&sidebar=4&route=${encodeURIComponent(route)}`;

const checks = [];
const errors = [];
const consoleLog = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

const composers = [
  {
    name: "new-thread composer",
    slug: "new-thread",
    route: "/new",
    textbox: { name: "Prompt" },
    desktopFontSize: "14px",
  },
  {
    name: "follow-up composer",
    slug: "follow-up",
    route: `/threads/${threadId}`,
    textbox: { name: "Message" },
    desktopFontSize: "12px",
  },
];

const contexts = [
  {
    label: "iPhone 13 (WebKit)",
    slug: "iphone-13",
    engine: webkit,
    options: devices["iPhone 13"],
    touch: true,
  },
  {
    label: "iPhone 13 landscape (WebKit)",
    slug: "iphone-13-landscape",
    engine: webkit,
    options: devices["iPhone 13 landscape"],
    touch: true,
  },
  {
    label: "iPad Mini (WebKit)",
    slug: "ipad-mini",
    engine: webkit,
    options: devices["iPad Mini"],
    touch: true,
  },
  {
    label: "Pixel 7 (Chromium)",
    slug: "pixel-7",
    engine: chromium,
    options: devices["Pixel 7"],
    touch: true,
  },
  {
    label: "desktop 1440px (Chromium)",
    slug: "desktop-1440",
    engine: chromium,
    options: { viewport: { width: 1440, height: 900 } },
    touch: false,
  },
];

/** iOS Safari's zoom on focus for the focused field, per WKWebViewIOS.mm. */
const focusZoom = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    const viewport =
      document.querySelector('meta[name="viewport"]')?.content ?? "";
    const limit = (key, fallback) => {
      const match = viewport.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)`));
      return match ? Number(match[1]) : fallback;
    };
    const minimumScale = limit("minimum-scale", 0.25);
    const maximumScale = limit("maximum-scale", 5);
    const zoom = Math.min(Math.max(16 / fontSize, minimumScale), maximumScale);
    return {
      focused: element.getAttribute("aria-label"),
      fontSize,
      viewport,
      safariZoom: Math.round(Math.max(zoom, 1) * 1000) / 1000,
      visualViewportScale: window.visualViewport?.scale ?? null,
    };
  });

/** Every visible text field on the page that iOS Safari would zoom into. */
const smallFields = (page) =>
  page.evaluate(() => {
    const textTypes = new Set([
      "",
      "text",
      "search",
      "email",
      "password",
      "url",
      "tel",
      "number",
      "date",
      "datetime-local",
      "month",
      "time",
      "week",
    ]);
    const fields = [...document.querySelectorAll("input, textarea, select")]
      .filter(
        (element) =>
          element.tagName !== "INPUT" ||
          textTypes.has(element.getAttribute("type") ?? ""),
      )
      .filter(
        (element) =>
          element.getClientRects().length > 0 &&
          element.closest('[aria-hidden="true"]') === null,
      );
    return {
      fields: fields.length,
      under16px: fields
        .map((element) => ({
          field:
            element.getAttribute("aria-label") ??
            element.getAttribute("placeholder") ??
            element.outerHTML.slice(0, 80),
          fontSize: getComputedStyle(element).fontSize,
        }))
        .filter(({ fontSize }) => Number.parseFloat(fontSize) < 16),
    };
  });

const browsers = new Map();
for (const target of contexts) {
  const engineName = target.engine.name();
  if (!browsers.has(engineName))
    browsers.set(engineName, await target.engine.launch());
  const context = await browsers.get(engineName).newContext({
    ...target.options,
    recordHar: { path: join(output, `${target.slug}.har`) },
  });
  for (const composer of composers) {
    const label = `${composer.name} on ${target.label}`;
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      errors.push(`${label}: pageerror: ${error}`),
    );
    page.on("console", (message) => {
      consoleLog.push(`${label}: [${message.type()}] ${message.text()}`);
      if (message.type() === "error")
        errors.push(`${label}: console: ${message.text()}`);
    });
    try {
      await page.goto(harness(composer.route));
      const textbox = page.getByRole("textbox", composer.textbox);
      await textbox.waitFor();
      if (target.touch) await textbox.tap();
      else await textbox.click();
      await page.keyboard.type("focus zoom check");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("a second line");
      await page.waitForTimeout(300);
      const zoom = await focusZoom(page);
      await page.screenshot({
        path: join(output, `${target.slug}-${composer.slug}-focused.png`),
      });
      if (target.touch) {
        check(
          `${label}: focusing the composer leaves Safari's zoom at 1`,
          zoom.focused === composer.textbox.name && zoom.safariZoom === 1,
          zoom,
        );
        const sweep = await smallFields(page);
        check(
          `${label}: every visible text field is at least 16px`,
          sweep.fields > 0 && sweep.under16px.length === 0,
          sweep,
        );
      } else {
        check(
          `${label}: the composer keeps its ${composer.desktopFontSize} desktop size`,
          `${zoom.fontSize}px` === composer.desktopFontSize,
          zoom,
        );
      }
    } catch (error) {
      // A step that times out fails its composer; the others still run.
      check(`${label}: runs to the end`, false, String(error).split("\n")[0]);
    }
    await page.close();
  }
  await context.close();
}
for (const browser of browsers.values()) await browser.close();
await new Promise((done) => server.httpServer.close(done));

check("no console or page errors", errors.length === 0, errors);
writeFileSync(join(output, "console.log"), `${consoleLog.join("\n")}\n`);
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify({ checks, errors }, null, 2)}\n`,
);
const failed = checks.filter(({ pass }) => !pass);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; artifacts in ${output}`,
);
process.exit(failed.length === 0 ? 0 : 1);
