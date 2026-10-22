// Appearance journey against a running `pnpm dev` (local) or a branch preview.
// Changes Light or Dark, Color Palette, and the terminal Color Scheme through
// the settings page and checks that the theme applies to the page at once,
// that the API holds the new values, that a reload keeps them, and that a
// second browser context (another device) opens with them, since all three
// are stored on the account. Writes desktop (1440) and mobile (390)
// screenshots, a HAR without bodies, console.json, and summary.json to
// <output>, then restores the original values.
//
//   node apps/web/test/appearance-settings-proof.mjs http://127.0.0.1:3000 out/
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

const accountPath = "/v1/settings/personal/account";
const api = async (method, path, data) => {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    headers: { origin: base },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  assert(
    response.ok(),
    `${method} ${path} answered ${response.status()}: ${JSON.stringify(body)}`,
  );
  return body.data;
};
const appearanceOf = ({ appearance, palette, terminalTheme }) => ({
  appearance,
  palette,
  terminalTheme,
});

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

/** What the page applied: the root dataset and the body's painted color. */
const applied = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return {
      appearance: root.dataset.appearance,
      resolvedAppearance: root.dataset.resolvedAppearance,
      palette: root.dataset.palette,
      background: getComputedStyle(document.body).backgroundColor,
    };
  });
const select = (page, label) => page.getByRole("combobox", { name: label });
const controls = (page) => ({
  theme: select(page, "Light or Dark"),
  palette: select(page, "Color Palette"),
  terminal: select(page, "Terminal Color Scheme"),
});
const shown = async (page) => {
  const { theme, palette, terminal } = controls(page);
  return {
    appearance: await theme.inputValue(),
    palette: await palette.inputValue(),
    terminalTheme: await terminal.inputValue(),
  };
};
/** Waits until the API holds `expected`; the page saves in the background. */
const persisted = async (expected) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = appearanceOf(await api("GET", accountPath));
    if (JSON.stringify(current) === JSON.stringify(expected)) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`The account never held ${JSON.stringify(expected)}.`);
};
const openAppearance = async (page) => {
  await page.goto(`${base}/settings/appearance`);
  await page.getByRole("heading", { name: "Appearance" }).waitFor();
  await select(page, "Light or Dark").waitFor();
};

const original = appearanceOf(await api("GET", accountPath));
// Start from a known state so every change below is a real change.
const start = {
  appearance: "light",
  palette: "daydream",
  terminalTheme: "github",
};
await api("PATCH", `${accountPath}/appearance`, start);
const summary = { base, original, start, steps };
try {
  const page = await context.newPage();
  watch(page);
  await openAppearance(page);
  for (const card of ["Theme", "Terminal"])
    await page.getByRole("heading", { name: card, exact: true }).waitFor();
  assert.equal(
    await page.getByText("sync across your devices").count(),
    1,
    "The page does not say the options sync.",
  );
  assert.deepEqual(await shown(page), start);
  const light = await applied(page);
  assert.equal(light.resolvedAppearance, "light");
  assert.equal(light.palette, "daydream");
  await shot(page, "01-start.desktop");
  step("page shows the account's values grouped as Theme and Terminal", {
    applied: light,
  });

  const { theme, palette, terminal } = controls(page);
  await theme.selectOption("dark");
  const dark = await applied(page);
  assert.equal(dark.appearance, "dark");
  assert.equal(dark.resolvedAppearance, "dark");
  assert.notEqual(dark.background, light.background);
  await persisted({ ...start, appearance: "dark" });
  step("Light or Dark applies at once and saves", { applied: dark });

  await palette.selectOption("deadpan");
  const deadpan = await applied(page);
  assert.equal(deadpan.palette, "deadpan");
  assert.notEqual(deadpan.background, dark.background);
  await persisted({ ...start, appearance: "dark", palette: "deadpan" });
  step("Color Palette applies at once and saves", { applied: deadpan });

  await terminal.selectOption("gruvbox");
  const changed = {
    appearance: "dark",
    palette: "deadpan",
    terminalTheme: "gruvbox",
  };
  await persisted(changed);
  step("terminal Color Scheme saves", { account: changed });
  await shot(page, "02-changed.desktop");

  await theme.selectOption("system");
  const system = await applied(page);
  assert.equal(system.appearance, "system");
  assert.equal(
    system.resolvedAppearance,
    "light",
    "System should follow the browser's light color scheme.",
  );
  const resolvesTo = (scheme) =>
    page.waitForFunction(
      (expected) =>
        document.documentElement.dataset.resolvedAppearance === expected,
      scheme,
      { timeout: 5_000 },
    );
  await page.emulateMedia({ colorScheme: "dark" });
  await resolvesTo("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await resolvesTo("light");
  const synced = { ...changed, appearance: "system" };
  await persisted(synced);
  step("System follows the device's color scheme as it changes");

  await page.reload();
  await select(page, "Light or Dark").waitFor();
  assert.deepEqual(await shown(page), synced);
  assert.equal((await applied(page)).palette, "deadpan");
  step("a reload keeps every value");

  // Another device: a fresh context with the same session, dark by default.
  const device = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    colorScheme: "dark",
    storageState: await context.storageState(),
  });
  const phone = await device.newPage();
  watch(phone);
  await openAppearance(phone);
  assert.deepEqual(await shown(phone), synced);
  const phoneApplied = await applied(phone);
  assert.equal(phoneApplied.palette, "deadpan");
  assert.equal(
    phoneApplied.resolvedAppearance,
    "dark",
    "System should follow the second device's own color scheme.",
  );
  await shot(phone, "03-other-device.mobile");
  step(
    "a second device opens with the synced values and its own system scheme",
    {
      applied: phoneApplied,
    },
  );
  await controls(phone).theme.selectOption("light");
  await persisted({ ...synced, appearance: "light" });
  await page.reload();
  await select(page, "Light or Dark").waitFor();
  assert.equal(await controls(page).theme.inputValue(), "light");
  await shot(phone, "04-light.mobile");
  await device.close();
  step("a change on the second device reaches the first after a reload");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await api("PATCH", `${accountPath}/appearance`, original);
  summary.restored = true;
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
    `${JSON.stringify(summary, (key, value) => (key === "email" ? "[redacted]" : value), 2)}\n`,
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
