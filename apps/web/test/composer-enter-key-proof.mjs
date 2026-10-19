// Proves the composers' Enter key per input modality in the real production
// build (local only; never contacts providers). On a touch device with an
// on-screen keyboard, Enter adds a line; the send button and Cmd/Ctrl+Enter send. On a
// desktop, at any width, Enter sends and Shift+Enter adds a line. Builds the
// thread page harness, serves it, and drives Chromium and WebKit
// (`npx playwright@1.55.0 install chromium webkit` once).
//
//   pnpm --filter @dx/web test:composer-enter-key
//
// Writes report.json, screenshots, a HAR per context, console output, and
// page errors to .dx/journeys/composer-enter-key/ and exits 1 when any check
// fails. The harness answers the page's fetches in the page, so sends are read
// from its request and Flue send logs (window.__requests, window.__sends).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, devices, webkit } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/composer-enter-key",
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

/** Thread creations and follow-up messages the page has sent so far. */
const sent = (page) =>
  page.evaluate(() => ({
    threadCreations: window.__requests.filter(
      ({ method, url }) => method === "POST" && url.startsWith("/v1/threads"),
    ).length,
    messages: window.__sends.length,
  }));

const composers = [
  {
    name: "new-thread composer",
    slug: "new-thread",
    route: "/new",
    textbox: { name: "Prompt" },
    send: { name: "Create thread and send" },
    sentBy: (count) => count.threadCreations,
  },
  {
    name: "follow-up composer",
    slug: "follow-up",
    route: `/threads/${threadId}`,
    textbox: { name: "Message" },
    send: { name: "Send message" },
    sentBy: (count) => count.messages,
  },
];

const contexts = [
  {
    label: "Pixel 7 (Chromium)",
    slug: "pixel-7",
    engine: chromium,
    options: devices["Pixel 7"],
    touch: true,
  },
  {
    label: "iPhone 13 (WebKit)",
    slug: "iphone-13",
    engine: webkit,
    options: devices["iPhone 13"],
    touch: true,
  },
  {
    label: "desktop 1440px (Chromium)",
    slug: "desktop-1440",
    engine: chromium,
    options: { viewport: { width: 1440, height: 900 } },
    touch: false,
  },
  {
    label: "desktop 500px (Chromium)",
    slug: "desktop-500",
    engine: chromium,
    options: { viewport: { width: 500, height: 900 } },
    touch: false,
  },
];

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
      const modality = await textbox.evaluate((element) => ({
        touchKeyboard: matchMedia("(hover: none) and (pointer: coarse)")
          .matches,
        enterKeyHint: element.getAttribute("enterkeyhint"),
      }));
      check(
        `${label}: reports ${target.touch ? "a touch" : "a hardware"} keyboard`,
        modality.touchKeyboard === target.touch &&
          modality.enterKeyHint === (target.touch ? "enter" : null),
        modality,
      );

      const before = composer.sentBy(await sent(page));
      if (target.touch) await textbox.tap();
      else await textbox.click();
      await page.keyboard.type("line one");
      await page.keyboard.press(target.touch ? "Enter" : "Shift+Enter");
      await page.keyboard.type("line two");
      await page.waitForTimeout(300);
      const typed = {
        value: await textbox.inputValue(),
        sent: composer.sentBy(await sent(page)) - before,
      };
      await page.screenshot({
        path: join(output, `${target.slug}-${composer.slug}-typed.png`),
      });
      check(
        `${label}: ${target.touch ? "Enter" : "Shift+Enter"} adds a line without sending`,
        typed.value === "line one\nline two" && typed.sent === 0,
        typed,
      );

      const send = page.getByRole("button", composer.send);
      if (target.touch) {
        await send.tap({ timeout: 5_000 });
      } else {
        await textbox.press("Enter");
      }
      await page
        .waitForFunction(
          (slug) =>
            slug === "follow-up"
              ? window.__sends.length > 0
              : window.__requests.some(
                  ({ method, url }) =>
                    method === "POST" && url.startsWith("/v1/threads"),
                ),
          composer.slug,
          { timeout: 5_000 },
        )
        .catch(() => undefined);
      const after = composer.sentBy(await sent(page)) - before;
      await page.screenshot({
        path: join(output, `${target.slug}-${composer.slug}-sent.png`),
      });
      check(
        `${label}: ${target.touch ? "the send button" : "Enter"} sends once`,
        after === 1,
        { sent: after },
      );
      if (target.touch) {
        // A keyboard attached to a tablet still sends with Cmd/Ctrl+Enter.
        await page.goto(harness(composer.route));
        const fresh = page.getByRole("textbox", composer.textbox);
        await fresh.tap();
        const start = composer.sentBy(await sent(page));
        await page.keyboard.type("from a keyboard");
        await page.keyboard.press("ControlOrMeta+Enter");
        await page.waitForTimeout(300);
        check(
          `${label}: Cmd/Ctrl+Enter sends once`,
          composer.sentBy(await sent(page)) - start === 1,
          { sent: composer.sentBy(await sent(page)) - start },
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
