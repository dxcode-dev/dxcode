// Proves that opening the Multiplayer menu from the Thread header's
// participant avatars leaves every header control where it was. Opening a
// Base UI menu puts focus-guard spans beside its trigger, so header CSS that
// keys off sibling position (`:first-child`) can move the controls.
//
// Runs against a supervised local `pnpm dev`, with fresh accounts each run,
// and drives a real Chromium over CDP. Owen shares a Thread for Contribute
// with his workspace and Bea opens it; each of them then opens and closes the
// Multiplayer menu at desktop, narrow, tablet, and phone widths while the
// script measures every header control. The Thread menu (`…`) is the
// control case: it opened without moving anything before the fix too.
//
//   DX_PROOF_CDP=http://127.0.0.1:9222 \
//     node apps/web/test/header-menu-layout-proof.mjs http://127.0.0.1:3000 <output dir>
//
// Writes screenshots, a video of the desktop run, header layouts
// (layout.json), a HAR, console output, page errors, and summary.json to
// <output dir>; exits 1 when any check fails.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const [base, outputArgument = ".dx/journeys/header-menu-layout"] =
  process.argv.slice(2);
assert(new URL(base).hostname === "127.0.0.1", "The journey is local-only.");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });

const run = Date.now().toString(36);
const browser = await chromium.connectOverCDP(
  process.env.DX_PROOF_CDP ?? "http://127.0.0.1:9222",
);
const VIEWPORTS = [
  { key: "desktop", width: 1280, height: 820 },
  { key: "narrow", width: 1000, height: 820 },
  { key: "tablet", width: 700, height: 820 },
  { key: "phone", width: 390, height: 844 },
];

const ATTEMPTS = 6;
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const consoleMessages = [];
const pageErrors = [];
const contexts = [];
const layouts = {};

const hideDevOverlays = (context) =>
  context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () =>
      document.documentElement.append(style),
    );
  });

const account = async (key, name) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    colorScheme: "dark",
    recordHar: { path: join(output, `${key}.har`), content: "omit" },
  });
  contexts.push(context);
  await hideDevOverlays(context);
  const call = async (method, path, data) => {
    const response = await context.request.fetch(`${base}${path}`, {
      method,
      headers: { origin: base, "content-type": "application/json" },
      ...(data === undefined ? {} : { data }),
    });
    const body = await response.json().catch(() => undefined);
    assert(
      response.ok(),
      `${method} ${path} ${response.status()} ${JSON.stringify(body)}`,
    );
    return body?.data ?? body;
  };
  await call("POST", "/api/auth/sign-up/email", {
    name,
    email: `${key}-${run}@dx.local`,
    password: `proof-${run}-password`,
  });
  return { key, name, context, call };
};

const watch = (page, key) => {
  page.on("console", (message) =>
    consoleMessages.push({ key, type: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ key, error: String(error) }),
  );
};

/** Every visible header control, by a stable label, with its box. */
const measure = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".thread-title-bar");
    const label = (element) =>
      `${element.className.split(" ")[0] || element.tagName}: ${(
        element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          (element.textContent.trim() ||
            element.className.split(" ")[0] ||
            element.tagName)
      ).slice(0, 40)}`;
    const controls = [
      ...bar.querySelectorAll(
        ".thread-title-group, .thread-title, .thread-header-actions > :not([data-base-ui-focus-guard])",
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          label: label(element),
          x: Math.round(box.x * 100) / 100,
          y: Math.round(box.y * 100) / 100,
          width: Math.round(box.width * 100) / 100,
        };
      });
    return {
      controls,
      focusGuardsInActions: bar.querySelectorAll(
        ".thread-header-actions > [data-base-ui-focus-guard]",
      ).length,
      titleText: bar.querySelector(".thread-title")?.textContent,
    };
  });

const largestShift = (before, after) =>
  Math.max(
    0,
    ...before.controls.map((control) => {
      const moved = after.controls.find(({ label }) => label === control.label);
      return moved === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(
            Math.abs(moved.x - control.x),
            Math.abs(moved.y - control.y),
            Math.abs(moved.width - control.width),
          );
    }),
  );

const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );

/** Moves the real pointer onto an element and clicks it. */
const pointAndClick = async (page, locator) => {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
};

/**
 * Opens a header menu, measures with it open, closes it, measures again.
 * Returns the three layouts and the largest move of any control.
 */
const openAndClose = async (page, trigger, popup, shots) => {
  await page.mouse.move(5, 400);
  await settle(page);
  const closed = await measure(page);
  await pointAndClick(page, page.locator(trigger));
  const opened = await page
    .locator(popup)
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    if (shots !== undefined) await page.screenshot({ path: shots.open });
    return { opened, closed, openShift: Number.POSITIVE_INFINITY };
  }
  // Past the popup's open transition.
  await page.waitForTimeout(400);
  const open = await measure(page);
  if (shots !== undefined) await page.screenshot({ path: shots.open });
  await page.keyboard.press("Escape");
  await page.locator(popup).waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  const reclosed = await measure(page);
  return {
    opened,
    closed,
    open,
    reclosed,
    openShift: largestShift(closed, open),
    reclosedShift: largestShift(closed, reclosed),
  };
};

let failed = false;
try {
  const owen = await account("owen", "Owen Owner");
  const bea = await account("bea", "Bea Bajaj");
  const workspace = await owen.call("POST", "/v1/settings/workspaces", {
    displayName: `Header proof ${run}`,
    shortName: `header-${run}`,
  });
  const invite = await owen.call(
    "POST",
    `/v1/settings/workspaces/${workspace.shortName}/invite-links`,
    { title: "header proof" },
  );
  await bea.call(
    "POST",
    `/v1/invites/${new URL(invite.url).pathname.split("/").pop()}/accept`,
    {},
  );
  await owen.call("POST", "/v1/settings/personal/model-routing/connections", {
    name: "Header proof placeholder (never called)",
    kind: "provider",
    providerId: "openai",
    apiKey: "sk-header-proof-never-called",
  });
  const thread = await owen.call("POST", "/v1/threads", {
    title: "Cart payload propagation",
    generateTitle: false,
  });
  await owen.call("PUT", `/v1/threads/${thread.id}/sharing`, {
    workspaceAccess: "contribute",
  });

  // Bea opens it first, so Owen's header shows both people, as reported.
  const visit = await bea.context.newPage();
  watch(visit, "bea");
  await visit.goto(`${base}/threads/${thread.id}`);
  await visit.locator(".thread-participants-trigger").waitFor();
  await visit.close();

  // Which stylesheet ran, so a stale dev server cannot pass for a fix.
  const stylesheetRules = async (page) =>
    page.evaluate(() => {
      const rules = [...document.styleSheets].flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      });
      return {
        actionsFirstChildAutoMargin: rules.some((rule) =>
          rule.startsWith(".thread-header-actions > :first-child"),
        ),
        titleGroup: rules.find((rule) =>
          rule.startsWith(".thread-title-group {"),
        ),
      };
    });

  for (const person of [owen, bea]) {
    for (const viewport of VIEWPORTS) {
      const key = `${person.key}-${viewport.key}`;
      const recording = person === owen && viewport.key === "desktop";
      const context = recording
        ? await browser.newContext({
            viewport,
            colorScheme: "dark",
            storageState: await person.context.storageState(),
            recordVideo: {
              dir: join(output, "video"),
              size: { width: viewport.width, height: viewport.height },
            },
          })
        : person.context;
      if (recording) {
        contexts.push(context);
        await hideDevOverlays(context);
      }
      const page = await context.newPage();
      watch(page, key);
      await page.setViewportSize(viewport);
      await page.goto(`${base}/threads/${thread.id}`);
      await page.locator(".thread-participants-trigger").waitFor();
      await page.waitForTimeout(600);
      if (person === owen && viewport.key === "desktop") {
        layouts.stylesheet = await stylesheetRules(page);
        console.log("stylesheet", JSON.stringify(layouts.stylesheet));
      }
      await page.screenshot({ path: join(output, `${key}-closed.png`) });

      // Several single clicks per size: before the fix the trigger could
      // jump out from under the pointer between press and release.
      const attempts = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        attempts.push(
          await openAndClose(
            page,
            ".thread-participants-trigger",
            ".thread-participants-menu",
            attempt === 0
              ? { open: join(output, `${key}-multiplayer-open.png`) }
              : undefined,
          ),
        );
      }
      const opened = attempts.filter((attempt) => attempt.opened);
      layouts[key] = { multiplayer: attempts };
      check(
        `${key}: every single click on the avatars opens the Multiplayer menu`,
        opened.length === ATTEMPTS,
        { opened: opened.length, attempts: ATTEMPTS },
      );
      check(
        `${key}: opening the Multiplayer menu moves no header control`,
        opened.length > 0 && opened.every((attempt) => attempt.openShift < 0.5),
        {
          largestShiftPx: opened.map((attempt) => attempt.openShift),
          focusGuardsWhileOpen: opened.map(
            (attempt) => attempt.open.focusGuardsInActions,
          ),
        },
      );
      check(
        `${key}: closing it returns every control to where it was`,
        opened.every((attempt) => attempt.reclosedShift < 0.5),
        { largestShiftPx: opened.map((attempt) => attempt.reclosedShift) },
      );
      check(
        `${key}: Base UI's focus guards were in the header while it was open`,
        opened.length > 0 &&
          opened.every(
            (attempt) =>
              attempt.open.focusGuardsInActions > 0 &&
              attempt.reclosed.focusGuardsInActions === 0,
          ),
        {
          open: opened.map((attempt) => attempt.open.focusGuardsInActions),
          closed: opened.map(
            (attempt) => attempt.reclosed.focusGuardsInActions,
          ),
        },
      );

      // Control: the Thread menu lives in the title group, not the actions.
      if (person === owen) {
        const threadMenu = await openAndClose(
          page,
          '.thread-title-group [aria-label="Thread actions"]',
          '[role="menu"]',
          { open: join(output, `${key}-thread-menu-open.png`) },
        );
        layouts[key].threadMenu = threadMenu;
        check(
          `${key}: control: opening the Thread menu moves no header control`,
          threadMenu.opened && threadMenu.openShift < 0.5,
          { opened: threadMenu.opened, largestShiftPx: threadMenu.openShift },
        );
      }
      await page.close();
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
  pageErrors.push({ key: "script", error: String(error?.stack ?? error) });
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  writeFileSync(
    join(output, "layout.json"),
    `${JSON.stringify(layouts, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify(consoleMessages, null, 2)}\n`,
  );
  const summary = {
    run,
    base,
    passed: !failed && checks.every((entry) => entry.pass),
    checks,
    pageErrors,
  };
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await browser.close().catch(() => {});
  console.log(summary.passed ? "PASSED" : "FAILED", output);
  process.exit(summary.passed ? 0 : 1);
}
