// Proves Take Screenshot in both composers in the real production build
// (local only; never contacts providers). Headless browsers have no screen to
// share, so the page's getDisplayMedia is replaced with one that enforces
// Safari's rule: a call that does not run on the tap's own call stack is
// rejected with "getDisplayMedia must be called from a user gesture handler."
// The proof shows that:
//
// - each tap calls getDisplayMedia from the tap itself;
// - closing the picker shows no error and leaves the menu working, every time;
// - a picker that never answers does not hold up the next screenshot;
// - a shared screen becomes an attachment;
// - no uncaptured screenshot shows an error card, notice, or toast: not a
//   source that fails to start, an aborted picker, a browser without screen
//   capture, or a full composer; and Take Screenshot still works after them.
//
// Builds the thread page harness, serves it, and drives WebKit (iPhone 13) and
// Chromium (desktop); `npx playwright@1.55.0 install chromium webkit` once.
//
//   pnpm --filter @dx/web test:screenshot-capture
//
// Writes report.json, a video per composer and context, a HAR per context, screenshots, console
// output, and page errors to .dx/journeys/screenshot-capture/ and exits 1
// when any check fails.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, devices, webkit } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/screenshot-capture",
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

/**
 * The screen picker. `window.__picker.mode` chooses how the next request
 * ends: "cancel" closes the picker, "hang" never answers, "share" shares a
 * drawn screen, "fail" fails to start the capture, and "abort" aborts the
 * picker. "unsupported" removes getDisplayMedia. `strict: false`
 * relaxes the gesture rule to Chromium's, which allows a call for a few
 * seconds after the tap.
 */
const installPicker = () => {
  const picker = { mode: "cancel", strict: true, calls: [] };
  // V8 keeps 10 frames by default; the tap's dispatch sits deeper.
  Error.stackTraceLimit = Number.POSITIVE_INFINITY;
  window.__picker = picker;
  const sharedScreen = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    const draw = () => {
      context.fillStyle = "#1f6feb";
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#ffffff";
      context.font = "48px sans-serif";
      context.fillText("Shared screen", 160, 200);
    };
    draw();
    const stream = canvas.captureStream(30);
    const timer = setInterval(draw, 33);
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => clearInterval(timer));
    const stop = MediaStreamTrack.prototype.stop;
    for (const track of stream.getTracks())
      track.stop = function () {
        picker.stopped = (picker.stopped ?? 0) + 1;
        clearInterval(timer);
        return stop.call(this);
      };
    return stream;
  };
  MediaDevices.prototype.getDisplayMedia = () => {
    // React's root listener is on the stack only while the tap dispatches.
    const duringTap = /dispatchDiscreteEvent/.test(new Error().stack ?? "");
    const call = { mode: picker.mode, duringTap };
    picker.calls.push(call);
    if (picker.strict && !duringTap)
      return Promise.reject(
        new DOMException(
          "getDisplayMedia must be called from a user gesture handler.",
          "InvalidStateError",
        ),
      );
    if (picker.mode === "cancel")
      return Promise.reject(
        new DOMException("Permission denied", "NotAllowedError"),
      );
    if (picker.mode === "hang") return new Promise(() => {});
    if (picker.mode === "fail")
      return Promise.reject(
        new DOMException("Could not start video source", "NotReadableError"),
      );
    if (picker.mode === "abort")
      return Promise.reject(
        new DOMException("The picker was aborted", "AbortError"),
      );
    return Promise.resolve(sharedScreen());
  };
};

const composers = [
  {
    name: "follow-up composer",
    slug: "follow-up",
    route: `/threads/${threadId}`,
    textbox: { name: "Message" },
  },
  {
    name: "new-thread composer",
    slug: "new-thread",
    route: "/new",
    textbox: { name: "Prompt" },
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
    label: "desktop 1280px (Chromium)",
    slug: "desktop",
    engine: chromium,
    options: { viewport: { width: 1280, height: 800 } },
    touch: false,
  },
];

const errorText = [
  "Screenshot not captured",
  "screenshot could not be captured",
  "screen could not be captured",
  "user gesture",
  "cancelled",
  "denied",
  "Permission denied",
  "Could not start video source",
  "aborted",
  "not supported",
  "Attach no more than",
];
const errorSurfaces = '.thread-error-card, .error-notice, [role="alert"]';

const browsers = new Map();
for (const target of contexts) {
  const engineName = target.engine.name();
  if (!browsers.has(engineName))
    browsers.set(engineName, await target.engine.launch());
  const context = await browsers.get(engineName).newContext({
    ...target.options,
    recordHar: { path: join(output, `${target.slug}.har`) },
    recordVideo: {
      dir: join(output, "raw-video"),
      size: target.options.viewport,
    },
  });
  // Attachment parts go to storage by XHR PUT; answer them like R2 does.
  await context.route("**/__upload/**", (route) =>
    route.fulfill({ status: 200, headers: { etag: '"proof-etag"' }, body: "" }),
  );
  await context.addInitScript(installPicker);
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
    const press = (locator) =>
      target.touch ? locator.tap({ timeout: 5_000 }) : locator.click();
    const picker = () => page.evaluate(() => window.__picker);
    const setMode = (mode) =>
      page.evaluate((value) => {
        const proto = MediaDevices.prototype;
        window.__picker.getDisplayMedia ??= proto.getDisplayMedia;
        proto.getDisplayMedia =
          value === "unsupported" ? undefined : window.__picker.getDisplayMedia;
        window.__picker.mode = value;
      }, mode);
    /** Error text and error cards or notices on screen. */
    const shownErrors = async () => {
      // The page's text without the proof's own step caption.
      const text = await page.evaluate(() => {
        const caption = document.getElementById("proof-caption");
        const label = caption?.textContent ?? "";
        const body = document.body.innerText;
        return label === "" ? body : body.replace(label, "");
      });
      const surfaces = await page.locator(errorSurfaces).count();
      return [
        ...errorText.filter((phrase) => text.includes(phrase)),
        ...(surfaces === 0 ? [] : [`${surfaces} error card or notice`]),
      ];
    };
    const attachments = () => page.locator(".composer-attachment").count();
    /** Opens the attach menu and taps Take Screenshot; false if it fails. */
    const takeScreenshot = async () => {
      const trigger = page
        .getByRole("button", { name: "Add Images & Files" })
        .last();
      await press(trigger);
      const item = page.getByRole("menuitem", { name: "Take Screenshot" });
      const opened = await item.waitFor({ timeout: 3_000 }).then(
        () => true,
        () => false,
      );
      // Long enough for the video to show the open menu.
      if (opened) await page.waitForTimeout(400);
      if (opened) await press(item);
      await page.waitForTimeout(600);
      return opened;
    };
    /** Names the step in the video; it ignores taps and is not an alert. */
    const caption = (text) =>
      page.evaluate((value) => {
        let node = document.getElementById("proof-caption");
        if (node === null) {
          node = document.createElement("div");
          node.id = "proof-caption";
          node.setAttribute("aria-hidden", "true");
          node.style.cssText =
            "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;padding:6px 12px;border-radius:8px;background:#1f6feb;color:#fff;font:600 14px system-ui;white-space:nowrap";
          document.body.append(node);
        }
        node.textContent = value;
      }, text);
    const thumbnails = () =>
      page.locator('button[aria-label^="Preview Screenshot"]').count();
    try {
      await page.goto(harness(composer.route));
      await page.getByRole("textbox", composer.textbox).waitFor();

      for (let attempt = 1; attempt <= 3; attempt++) {
        await caption(`Close the picker (${attempt}/3)`);
        const before = (await picker()).calls.length;
        const opened = await takeScreenshot();
        const state = await picker();
        const call = state.calls[before];
        const shown = await shownErrors();
        await page.screenshot({
          path: join(
            output,
            `${target.slug}-${composer.slug}-cancel-${attempt}.png`,
          ),
        });
        check(
          `${label}: cancel ${attempt}: the menu opens and the tap reaches the picker`,
          opened &&
            state.calls.length === before + 1 &&
            call?.duringTap === true,
          {
            opened,
            calls: state.calls.length - before,
            duringTap: call?.duringTap,
          },
        );
        check(
          `${label}: cancel ${attempt}: closing the picker shows no error`,
          shown.length === 0 && (await thumbnails()) === 0,
          { shown, thumbnails: await thumbnails() },
        );
      }

      // Under Chromium's looser rule, so the gesture is not what fails.
      await page.evaluate(() => {
        window.__picker.strict = false;
      });
      await caption("Picker never answers");
      await setMode("hang");
      const hungOpened = await takeScreenshot();
      await caption("Share a screen");
      await setMode("share");
      const before = (await picker()).calls.length;
      const sharedOpened = await takeScreenshot();
      await page
        .locator('button[aria-label^="Preview Screenshot"]')
        .first()
        .waitFor({ timeout: 8_000 })
        .catch(() => undefined);
      const afterShare = await picker();
      await page.screenshot({
        path: join(output, `${target.slug}-${composer.slug}-shared.png`),
      });
      check(
        `${label}: a picker that never answers does not hold up the next screenshot`,
        hungOpened && sharedOpened && afterShare.calls.length === before + 1,
        {
          hungOpened,
          sharedOpened,
          calls: afterShare.calls.length - before,
        },
      );
      check(
        `${label}: a shared screen becomes one attachment and its tracks stop`,
        (await thumbnails()) === 1 && (afterShare.stopped ?? 0) >= 1,
        { thumbnails: await thumbnails(), stoppedTracks: afterShare.stopped },
      );

      await page.evaluate(() => {
        window.__picker.strict = true;
      });
      for (const mode of ["fail", "abort", "unsupported"]) {
        await caption(
          {
            fail: "Source fails to start",
            abort: "Picker aborted",
            unsupported: "Browser without screen capture",
          }[mode],
        );
        await setMode(mode);
        const opened = await takeScreenshot();
        const shown = await shownErrors();
        await page.screenshot({
          path: join(output, `${target.slug}-${composer.slug}-${mode}.png`),
        });
        check(
          `${label}: ${mode}: no error card, notice, or toast`,
          opened && shown.length === 0 && (await thumbnails()) === 1,
          { opened, shown, thumbnails: await thumbnails() },
        );
      }

      // Take Screenshot still works after every kind of failure.
      await caption("Share again after the failures");
      await setMode("share");
      await takeScreenshot();
      await page
        .locator('button[aria-label^="Preview Screenshot"]')
        .nth(1)
        .waitFor({ timeout: 8_000 })
        .catch(() => undefined);
      check(
        `${label}: after the failures, the next screenshot is attached`,
        (await thumbnails()) === 2 && (await shownErrors()).length === 0,
        { thumbnails: await thumbnails(), shown: await shownErrors() },
      );

      // A full composer has no room for a screenshot; that is not an error.
      await page
        .locator('input[aria-label="Choose files"]')
        .last()
        .setInputFiles(
          Array.from({ length: 8 }, (_, index) => ({
            name: `file-${index}.png`,
            mimeType: "image/png",
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          })),
        );
      await page.waitForTimeout(600);
      const calls = (await picker()).calls.length;
      const full = await attachments();
      await caption("Composer full (10 files)");
      const fullOpened = await takeScreenshot();
      await page.waitForTimeout(600);
      const shown = await shownErrors();
      await page.screenshot({
        path: join(output, `${target.slug}-${composer.slug}-full.png`),
      });
      check(
        `${label}: a full composer: no picker and no error`,
        full === 10 &&
          fullOpened &&
          (await picker()).calls.length === calls &&
          (await attachments()) === 10 &&
          shown.length === 0,
        { attachments: full, opened: fullOpened, shown },
      );
    } catch (error) {
      check(`${label}: runs to the end`, false, String(error).split("\n")[0]);
    }
    const video = page.video();
    await page.close();
    await video?.saveAs(join(output, `${target.slug}-${composer.slug}.webm`));
    await video?.delete();
  }
  await context.close();
}
for (const browser of browsers.values()) await browser.close();
rmSync(join(output, "raw-video"), { recursive: true, force: true });
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
