// Proves the full-window settings frame end to end against a running dx
// (local `pnpm dev` or a branch preview):
//
// - At 1440px and 1024px the frame fills the window with no backdrop margin:
//   a 48px top bar with Back to dx on the left and the scope switcher
//   centered, a 224px full-height rail with the footer card pinned to its
//   bottom, and content that scrolls on its own and caps its column width.
// - At 390px settings are a sheet 36px below the top with a grab handle and
//   no Back button; the switcher reads Personal / Workspace, the rail is one
//   scrolling row of section pills, and rail and content scroll together.
// - Back to dx, Escape, a tap on the handle, and a touch drag down the handle
//   each close settings; a short drag does not.
//
//   node apps/web/test/settings-shell-proof.mjs <base url> <output dir>
//
// Signs in with DX_PROOF_EMAIL and DX_PROOF_PASSWORD, or with the local
// account in apps/core/.dev.vars. Writes screenshots at each width in the
// account's appearance and in the other color scheme when the account
// follows the system, a HAR, console output, page errors, and summary.json,
// and exits 1 when a check fails.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [baseArgument, outputArgument] = process.argv.slice(2);
assert(baseArgument && outputArgument, "Usage: <base url> <output dir>");
const base = baseArgument.replace(/\/$/, "");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const localVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(localVars)
  ? parseEnv(readFileSync(localVars, "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? local.DX_LOCAL_AUTH_EMAIL;
const password = process.env.DX_PROOF_PASSWORD ?? local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "Set DX_PROOF_EMAIL and DX_PROOF_PASSWORD.");

const footerLinks = [
  ["GitHub", "https://github.com/dxcode-dev/dxcode"],
  ["@dxcode_dev", "https://x.com/dxcode_dev"],
  ["Report a Bug", "https://github.com/dxcode-dev/dxcode/issues/new"],
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
  // A POSIX host locale ("en-US@posix") breaks Intl.Locale in dev tooling.
  locale: "en-US",
  recordHar: { path: join(output, "network.har"), content: "omit" },
});
// The development-only render inspector draws over every frame.
await context.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent =
    "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
  document.addEventListener("DOMContentLoaded", () =>
    document.documentElement.append(style),
  );
});
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const failedApiResponses = [];
page.on("console", (message) =>
  consoleMessages.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("response", (response) => {
  if (
    new URL(response.url()).pathname.startsWith("/v1/") &&
    response.status() >= 400
  )
    failedApiResponses.push({ url: response.url(), status: response.status() });
});

const steps = [];
const step = async (name, run) => {
  try {
    const detail = await run();
    steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
    console.log(`✓ ${name}`);
  } catch (error) {
    steps.push({ name, ok: false, error: String(error) });
    console.error(`✗ ${name} at ${page.url()}\n${error}`);
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
    throw error;
  }
};
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) });
const settled = () =>
  page.locator(".settings-content[aria-busy='false']").waitFor();
const open = async (path) => {
  await page.goto(`${base}${path}`);
  await page.getByRole("navigation", { name: "Settings scope" }).waitFor();
  await settled();
};
const near = (actual, expected, label, tolerance = 1) =>
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label} is ${actual}, expected ${expected}`,
  );

/** The frame's geometry, read from the rendered page. */
const readFrame = () =>
  page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0,
        radius: style.borderTopLeftRadius,
      };
    };
    const content = document.querySelector(".settings-content");
    const column = content?.querySelector(
      ".settings-heading, .settings-card, .settings-form-actions",
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      frame: box(".dx-app-frame"),
      topBar: box(".settings-top-bar"),
      back: box(".settings-back"),
      handle: box(".settings-sheet-handle"),
      scope: box(".settings-scope-tabs"),
      rail: box(".settings-sidebar"),
      footer: box(".settings-rail-footer"),
      content: box(".settings-content"),
      columnWidth:
        column === null || column === undefined
          ? null
          : Math.round(column.getBoundingClientRect().width),
      footerLinks: [
        ...document.querySelectorAll(".settings-rail-footer a"),
      ].map((link) => [link.textContent.trim(), link.href, link.target]),
      scopeText: document
        .querySelector(".settings-scope-tabs")
        .innerText.split(/\s+/)
        .filter(Boolean),
      sidewaysOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });

const assertFullWindow = (frame, { footer }) => {
  const { viewport } = frame;
  assert.deepEqual(
    [frame.frame.top, frame.frame.left, frame.frame.width, frame.frame.height],
    [0, 0, viewport.width, viewport.height],
    "the frame fills the window",
  );
  assert.equal(frame.frame.radius, "0px", "the frame has square corners");
  near(frame.topBar.height, 49, "top bar height (48px and a 1px border)");
  assert(frame.back.visible, "Back to dx shows");
  assert(frame.back.left <= 16, `Back to dx sits left at ${frame.back.left}`);
  assert(!frame.handle.visible, "no grab handle");
  near(
    frame.scope.left + frame.scope.width / 2,
    viewport.width / 2,
    "switcher center",
  );
  assert.deepEqual(frame.scopeText.slice(-2), ["Workspace", "Settings"]);
  if (footer) {
    near(frame.rail.width, 224, "rail width");
    assert.equal(frame.rail.top, frame.topBar.bottom, "rail starts under bar");
    assert.equal(frame.rail.bottom, viewport.height, "rail is full height");
    assert(frame.footer.visible, "footer card shows");
    near(frame.footer.bottom, viewport.height - 8, "footer card bottom");
    assert.deepEqual(
      frame.footerLinks,
      footerLinks.map(([label, href]) => [label, href, "_blank"]),
    );
    assert.equal(frame.content.left, frame.rail.width, "content follows rail");
  }
  assert.equal(
    frame.content.left + frame.content.width,
    viewport.width,
    "content reaches the right edge",
  );
  assert.equal(frame.content.bottom, viewport.height, "content is full height");
  assert.equal(frame.sidewaysOverflow, 0, "the page does not scroll sideways");
};

const closesTo = async (action, label) => {
  await open("/settings/integrations");
  await action();
  await page.waitForURL((url) => !url.pathname.startsWith("/settings"));
  assert.equal(new URL(page.url()).pathname, "/", `${label} returns home`);
};

/** A touch drag on the grab handle, sent as real touch input. */
const dragHandle = async (distance) => {
  const handle = await page.locator(".settings-sheet-handle").boundingBox();
  const x = Math.round(handle.x + handle.width / 2);
  const y = Math.round(handle.y + handle.height / 2);
  const cdp = await context.newCDPSession(page);
  const touch = (type, dy) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y: y + dy }],
    });
  await touch("touchStart", 0);
  for (let dy = 8; dy <= distance; dy += 8) await touch("touchMove", dy);
  const sheetTop = await page.evaluate(() =>
    Math.round(
      document.querySelector(".dx-app-frame").getBoundingClientRect().top,
    ),
  );
  await touch("touchEnd", distance);
  await cdp.detach();
  return sheetTop;
};

let appearance;
try {
  await step("signs in with a password", async () => {
    await page.goto(`${base}/signin?next=%2Fsettings`);
    const passwordForm = page.getByLabel("Password");
    const passwordButton = page.getByRole("button", {
      name: "Sign in with a password",
    });
    await passwordForm.or(passwordButton).first().waitFor();
    if (await passwordButton.isVisible()) await passwordButton.click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/settings"));
    await settled();
    appearance = await page.evaluate(
      () => document.documentElement.dataset.appearance,
    );
    return { appearance };
  });

  await step("fills a 1440px window", async () => {
    await open("/settings");
    const frame = await readFrame();
    assertFullWindow(frame, { footer: true });
    await shot("desktop-account");
    return frame;
  });

  await step("content scrolls on its own and caps its width", async () => {
    await open("/settings/integrations");
    const frame = await readFrame();
    assert(
      frame.columnWidth !== null && frame.columnWidth <= 1160,
      `content column is ${frame.columnWidth}px`,
    );
    const before = await readFrame();
    const scrolled = await page.evaluate(() => {
      const content = document.querySelector(".settings-content");
      content.scrollTop = 400;
      return content.scrollTop;
    });
    assert(scrolled > 0, "the content scrolls");
    const after = await readFrame();
    assert.deepEqual(after.rail, before.rail, "the rail stays put");
    assert.deepEqual(after.topBar, before.topBar, "the top bar stays put");
    await page.evaluate(() => {
      document.querySelector(".settings-content").scrollTop = 0;
    });
    await shot("desktop-integrations");
    return { columnWidth: frame.columnWidth, scrolled };
  });

  await step("the workspace switcher keeps the frame", async () => {
    await page.getByRole("link", { name: "Workspace Settings" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/workspaces"));
    await settled();
    assertFullWindow(await readFrame(), { footer: true });
    await shot("desktop-workspace");
  });

  await step("fills a 1024px window with the rail", async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await open("/settings/environment-variables");
    assertFullWindow(await readFrame(), { footer: true });
    await shot("tablet-environment-variables");
  });

  await step("is a sheet with section pills at 390px", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open("/settings/environment-variables");
    const frame = await readFrame();
    assert.equal(frame.frame.top, 36, "the sheet starts 36px down");
    assert.equal(frame.frame.height, 844 - 36, "the sheet reaches the bottom");
    assert.equal(frame.frame.radius, "24px", "the sheet has round top corners");
    assert(frame.handle.visible, "the grab handle shows");
    assert(!frame.back.visible, "no Back button");
    assert(!frame.footer.visible, "no footer card");
    assert.deepEqual(frame.scopeText, ["Personal", "W", "Workspace"]);
    assert.equal(
      frame.sidewaysOverflow,
      0,
      "the page does not scroll sideways",
    );
    const pills = await page.evaluate(() => {
      const scroller = document.querySelector(".settings-navigation-scroller");
      const links = [
        ...scroller.querySelectorAll(".settings-navigation-link"),
      ].map((link) => Math.round(link.getBoundingClientRect().top));
      return {
        oneRow: links.every((top) => top === links[0]),
        scrolls: scroller.scrollWidth > scroller.clientWidth,
      };
    });
    assert(pills.oneRow, "section pills share one row");
    assert(pills.scrolls, "the pill row scrolls sideways");
    await shot("mobile-environment-variables");
    await open("/settings/integrations");
    const moved = await page.evaluate(() => {
      const body = document.querySelector(".settings-shell-body");
      const rail = document.querySelector(".settings-sidebar");
      const top = rail.getBoundingClientRect().top;
      body.scrollTop = 200;
      return top - rail.getBoundingClientRect().top;
    });
    assert(moved > 0, "the rail scrolls with the content");
    return { pills, moved };
  });

  await step("a short handle drag springs back", async () => {
    await open("/settings/integrations");
    const during = await dragHandle(40);
    assert.equal(during, 36 + 40, "the sheet follows the finger");
    await page.waitForTimeout(300);
    assert(new URL(page.url()).pathname.startsWith("/settings"), "still open");
    assert.equal((await readFrame()).frame.top, 36, "the sheet springs back");
  });

  await step("a long handle drag closes settings", () =>
    closesTo(() => dragHandle(160), "a long drag"),
  );

  await step("a tap on the handle closes settings", () =>
    closesTo(
      () => page.getByRole("button", { name: "Close settings" }).tap(),
      "a tap",
    ),
  );

  await step("Back to dx closes settings", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await closesTo(
      () => page.getByRole("button", { name: "Back to dx" }).click(),
      "Back to dx",
    );
  });

  await step("Escape closes settings", () =>
    closesTo(() => page.keyboard.press("Escape"), "Escape"),
  );

  if (appearance === "system") {
    await step("the other color scheme renders the frame", async () => {
      const current = await page.evaluate(
        () => document.documentElement.dataset.resolvedAppearance,
      );
      const other = current === "dark" ? "light" : "dark";
      await page.emulateMedia({ colorScheme: other });
      for (const [name, width, height] of [
        ["desktop", 1440, 900],
        ["tablet", 1024, 768],
        ["mobile", 390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await open("/settings/integrations");
        await shot(`${other}-${name}-integrations`);
      }
      await page.emulateMedia({ colorScheme: null });
      return { other };
    });
  }
} finally {
  await context.close();
  await browser.close();
  const failed =
    steps.some(({ ok }) => !ok) ||
    pageErrors.length > 0 ||
    failedApiResponses.length > 0;
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify({ base, ok: !failed, steps, pageErrors, failedApiResponses }, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify(consoleMessages, null, 2)}\n`,
  );
  if (failed) process.exitCode = 1;
}
