// Keyboard Shortcuts journey against a running `pnpm dev` (local) or a branch
// preview. Rebinds "Open projects" through the settings page and runs it from
// another page with the new keys, records a key that another command already
// uses and checks the page refuses it, clears and resets single shortcuts,
// opens the keymap from Show All, and restores every default with Reset All.
// Shortcuts live in this browser's storage, so a reload keeps them and a
// second browser context (another device) opens with the defaults. Writes
// desktop (1440) and mobile (390) screenshots, a HAR without bodies or
// credentials, console.json, and summary.json to <output>.
//
//   node apps/web/test/keyboard-shortcuts-proof.mjs http://127.0.0.1:3000 out/
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CDP connects to an existing
// Chromium instead of launching headless.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, outputArgument] = process.argv.slice(2);
assert(base && outputArgument, "Usage: <base url> <output dir>");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const devVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(devVars)
  ? parseEnv(readFileSync(devVars, "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? local.DX_LOCAL_AUTH_EMAIL;
const password = process.env.DX_PROOF_PASSWORD ?? local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "No proof account credentials.");

const storageKey = "dx-keyboard-shortcuts-v1";
const browser =
  process.env.DX_PROOF_CDP === undefined
    ? await chromium.launch()
    : await chromium.connectOverCDP(process.env.DX_PROOF_CDP);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  colorScheme: "light",
  recordHar: { path: join(output, "network.har"), content: "omit" },
});
const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email, password },
});
assert.equal(signIn.status(), 200, "Password sign-in failed.");

const consoleMessages = [];
const pageErrors = [];
const steps = [];
const step = (name, detail = {}) => {
  steps.push({ name, ...detail });
  console.log(`✓ ${name}`);
};
const watch = (page) => {
  page.on("console", (message) =>
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      url: page.url(),
    }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ message: error.message, url: page.url() }),
  );
};
const shot = (page, name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const openShortcuts = async (page) => {
  await page.goto(`${base}/settings/keyboard-shortcuts`);
  await page.getByRole("heading", { name: "Keyboard Shortcuts" }).waitFor();
  await page.locator(".shortcut-list .settings-row").first().waitFor();
};
const row = (page, label) =>
  page
    .locator(".shortcut-list .settings-row")
    .filter({ has: page.locator("strong", { hasText: label }) })
    .first();
const keysOf = (page, label) =>
  row(page, label).locator(".shortcut-binding").innerText();
const button = (page, name) => page.getByRole("button", { name, exact: true });
const resetAll = (page) =>
  page.getByRole("button", { name: "Reset All Shortcuts" });
const stored = (page) =>
  page.evaluate((key) => {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value).overrides;
  }, storageKey);

const summary = { base, steps };
try {
  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/`);
  await page.evaluate((key) => localStorage.removeItem(key), storageKey);
  await openShortcuts(page);
  assert(
    (await page.locator(".settings-heading p").innerText()).includes(
      "stored on this device",
    ),
    "The page does not say shortcuts are stored on this device.",
  );
  assert(await resetAll(page).isDisabled(), "Reset All starts enabled.");
  assert.equal(
    await page.locator(".shortcut-list button[aria-label^='Reset ']").count(),
    0,
    "A row offers Reset before anything is customized.",
  );
  const rows = await page.locator(".shortcut-list .settings-row").count();
  assert.equal(await keysOf(page, "Open projects"), "Not set");
  await shot(page, "01-list.desktop");
  step("one list of commands with key chips; Reset All is off", { rows });

  await page
    .getByRole("button", { name: /Show All Keyboard Shortcuts/ })
    .click();
  const keymap = page.getByRole("dialog", { name: "Keymap" });
  await keymap.waitFor();
  await keymap.evaluate((dialog) =>
    Promise.all(
      dialog.getAnimations({ subtree: true }).map(({ finished }) => finished),
    ),
  );
  await shot(page, "02-show-all.desktop");
  await page.keyboard.press("Escape");
  await keymap.waitFor({ state: "hidden" });
  step("Show All opens the keymap dialog");

  await button(page, "Edit Open projects").click();
  await page.getByText("Recording…").waitFor();
  await page.keyboard.press("Control+Shift+O");
  await page.locator(".shortcut-editor kbd").first().waitFor();
  await button(page, "Save shortcut").click();
  await page.getByText("Shortcut saved and active on this device.").waitFor();
  const rebound = await keysOf(page, "Open projects");
  assert.match(rebound, /Ctrl[\s\S]*Shift[\s\S]*O/);
  assert.deepEqual(await stored(page), {
    "navigation.projects": "Mod+Shift+O",
  });
  assert(!(await resetAll(page).isDisabled()), "Reset All stays disabled.");
  await button(page, "Reset Open projects").waitFor();
  await shot(page, "03-rebound.desktop");
  step("rebinding Open projects to Ctrl+Shift+O saves to this device");

  // Shortcuts never fire while typing, so leave the home composer first.
  await page.goto(`${base}/`);
  await page
    .locator('[data-command-action="search-threads"]')
    .first()
    .waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press("Control+Shift+O");
  await page.waitForURL(`${base}/projects`, { waitUntil: "commit" });
  step("the new keys open projects from another page");

  await openShortcuts(page);
  await button(page, "Edit Open projects").click();
  await page.getByText("Recording…").waitFor();
  await page.keyboard.press("Control+K");
  const conflict = page.locator(".shortcut-validation-error");
  await conflict.waitFor();
  const conflictText = await conflict.innerText();
  assert.match(conflictText, /conflicts with “Open command palette”/);
  assert(await button(page, "Save shortcut").isDisabled());
  await shot(page, "04-conflict.desktop");
  await button(page, "Cancel").click();
  assert.match(await keysOf(page, "Open projects"), /Ctrl[\s\S]*Shift[\s\S]*O/);
  step("a key another command uses is refused before saving", {
    message: conflictText,
  });

  await button(page, "Clear Go to home screen").click();
  assert.equal(await keysOf(page, "Go to home screen"), "Not set");
  await page.reload();
  await page.locator(".shortcut-list .settings-row").first().waitFor();
  assert.equal(await keysOf(page, "Go to home screen"), "Not set");
  assert.match(await keysOf(page, "Open projects"), /Ctrl[\s\S]*Shift[\s\S]*O/);
  assert.deepEqual(await stored(page), {
    "navigation.projects": "Mod+Shift+O",
    "navigation.home": null,
  });
  step("clearing a shortcut saves, and a reload keeps both changes");

  // Another device: a fresh context with the same session but its own storage.
  const device = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    colorScheme: "light",
    storageState: {
      cookies: (await context.storageState()).cookies,
      origins: [],
    },
  });
  const phone = await device.newPage();
  watch(phone);
  await openShortcuts(phone);
  assert.equal(await keysOf(phone, "Open projects"), "Not set");
  assert.match(await keysOf(phone, "Go to home screen"), /G\s*G/);
  assert(await resetAll(phone).isDisabled());
  await shot(phone, "05-other-device.mobile");
  await button(phone, "Edit Open projects").click();
  await phone.getByText("Recording…").waitFor();
  await shot(phone, "06-recording.mobile");
  await button(phone, "Cancel").click();
  await device.close();
  step("another device keeps its own defaults");

  await button(page, "Reset Go to home screen").click();
  assert.match(await keysOf(page, "Go to home screen"), /G\s*G/);
  assert.deepEqual(await stored(page), {
    "navigation.projects": "Mod+Shift+O",
  });
  step("Reset restores one shortcut's default");

  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "07-customized.mobile");
  await page.setViewportSize({ width: 1440, height: 900 });

  await resetAll(page).click();
  await page
    .getByText("All keyboard shortcuts restored to their defaults.")
    .waitFor();
  assert.equal(await keysOf(page, "Open projects"), "Not set");
  assert(await resetAll(page).isDisabled());
  assert.equal(await stored(page), null);
  await shot(page, "08-reset-all.desktop");
  step("Reset All restores every default and clears device storage");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  summary.pageErrors = pageErrors;
  summary.consoleErrors = consoleMessages.filter(
    ({ type }) => type === "error",
  ).length;
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify({ console: consoleMessages, pageErrors }, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await context.close();
  await browser.close();

  // The HAR is shareable evidence: drop credentials and client addresses.
  const privateHeaders = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "cf-access-jwt-assertion",
    "cf-access-client-id",
    "cf-access-client-secret",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
  ]);
  const harPath = join(output, "network.har");
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    if (entry.request.postData?.text?.includes(password)) {
      entry.request.postData.text = "[redacted]";
    }
  }
  writeFileSync(harPath, JSON.stringify(har));
}
