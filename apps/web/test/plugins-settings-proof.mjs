// Plugins settings journey against a running `pnpm dev` (local) or a branch
// preview. On the personal page it checks the heading, intro, and link to the
// workspace page, turns a plugin off and on, and saves and removes a provider
// key, checking each change over the API and after a reload. On the
// workspace page it does the same and checks that a plugin the workspace
// turns off shows as a locked, hinted switch on the personal page. Writes
// desktop (1440) and mobile (390) screenshots, a HAR without bodies or
// credentials, console.json, and summary.json to <output>, then restores
// every setting it touched.
//
//   node apps/web/test/plugins-settings-proof.mjs http://127.0.0.1:3000 out/
//
// The key is a fake: saving a key only encrypts and stores it. A scope that
// already has a key is left alone, since the proof could not restore it. The
// workspace half runs only when the account owns or administers a workspace.
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
  recordHar: { path: join(output, "network.har"), content: "omit" },
});
const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email, password },
});
assert.equal(signIn.status(), 200, "Password sign-in failed.");

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

const { workspace } = await api("GET", "/v1/settings/personal");
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const personalApi = "/v1/settings/personal/first-party-plugins";
const workspaceApi =
  workspaceSlug === undefined
    ? undefined
    : `/v1/settings/workspaces/${workspaceSlug}/first-party-plugins`;
const personalPage = `${base}/settings/plugins`;
const workspacePage =
  workspace === undefined
    ? undefined
    : `${base}/workspaces/${workspace.shortName}/plugins`;

const findPlugin = (list, id) => {
  const plugin = list.plugins.find((candidate) => candidate.id === id);
  assert(plugin, `Plugin ${id} is missing.`);
  return plugin;
};
const originalPersonal = await api("GET", personalApi);
// The first plugin a person can switch and bring a key for (Web search).
const target = originalPersonal.plugins.find(
  ({ alwaysOn, providers }) =>
    alwaysOn !== true &&
    providers.some(({ credentialLabel }) => credentialLabel !== null),
);
assert(target, "No switchable plugin with a provider key is installed.");
const originalWorkspace =
  workspaceApi === undefined ? undefined : await api("GET", workspaceApi);
const before = {
  personal: findPlugin(originalPersonal, target.id),
  workspace:
    originalWorkspace === undefined
      ? undefined
      : findPlugin(originalWorkspace, target.id),
};
const keyed = target.providers.find(
  ({ credentialLabel }) => credentialLabel !== null,
);
const toggle = (page, state) =>
  page.getByRole("button", {
    name: `${target.displayName} ${state}`,
    exact: true,
  });
const status = (page, text) =>
  page.locator(".settings-heading [aria-live]").filter({ hasText: text });
const heading = (page, name) => page.getByRole("heading", { name }).waitFor();
// Off, then back on. Each change is checked on the server and after reload.
const switchOffAndOn = async (page, scope, apiPath, url) => {
  const initiallyOn = (await toggle(page, "on").count()) === 1;
  if (!initiallyOn) {
    await toggle(page, "off").click();
    await status(page, "turned on.").waitFor();
  }
  await toggle(page, "on").click();
  await status(page, `${target.displayName} turned off.`).waitFor();
  assert.equal(
    findPlugin(await api("GET", apiPath), target.id).enablement,
    "disabled",
    `The ${scope} switch did not store disabled.`,
  );
  await page.goto(url);
  await toggle(page, "off").waitFor();
  await shot(page, `${scope}-plugin-off.desktop`);
  await toggle(page, "off").click();
  await status(page, `${target.displayName} turned on.`).waitFor();
  assert.equal(
    findPlugin(await api("GET", apiPath), target.id).enablement,
    "enabled",
    `The ${scope} switch did not store enabled.`,
  );
  await page.goto(url);
  await toggle(page, "on").waitFor();
  step(`${scope} switch turns ${target.displayName} off and on`, {
    plugin: target.id,
  });
};
// Save a fake key in the dialog, then remove it again.
const saveAndRemoveKey = async (page, scope, apiPath, url) => {
  await page
    .getByRole("button", { name: `${target.displayName} settings` })
    .click();
  const dialog = page.getByRole("dialog", { name: target.displayName });
  await dialog.waitFor();
  const input = dialog.getByLabel(keyed.credentialLabel);
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  assert(await save.isDisabled(), "Save is enabled before a key is typed.");
  await input.fill(`plugins-proof-${Date.now().toString(36)}`);
  await shot(page, `${scope}-key-typed.desktop`);
  await save.click();
  await status(page, `${keyed.displayName} key saved.`).waitFor();
  await dialog.waitFor({ state: "hidden" });
  const saved = findPlugin(await api("GET", apiPath), target.id);
  assert.equal(
    saved.configuration?.providerId,
    keyed.id,
    `The ${scope} key was not stored.`,
  );
  await page.goto(url);
  await page
    .getByRole("button", { name: `${target.displayName} settings` })
    .click();
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel(keyed.credentialLabel).getAttribute("placeholder"),
    "Key saved. Enter a new key to replace it.",
  );
  await shot(page, `${scope}-key-saved.desktop`);
  await dialog.getByRole("button", { name: "Remove key" }).click();
  await status(page, `${target.displayName} key removed.`).waitFor();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    findPlugin(await api("GET", apiPath), target.id).configuration,
    null,
    `The ${scope} key was not removed.`,
  );
  step(`${scope} ${keyed.displayName} key saves and removes`, {
    configuredAt: saved.configuration.configuredAt,
  });
};

const summary = {
  base,
  plugin: target.id,
  workspace: workspace?.shortName ?? null,
  workspaceAdmin: workspaceSlug !== undefined,
  steps,
};
try {
  const page = await context.newPage();
  watch(page);
  await page.goto(personalPage);
  await heading(page, "Personal Plugins");
  await toggle(page, "on").or(toggle(page, "off")).waitFor();
  await page.getByText("Plugins add tools to your dx Threads.").waitFor();
  await shot(page, "01-personal.desktop");
  step("personal page shows its heading, intro, and plugin row");

  await switchOffAndOn(page, "personal", personalApi, personalPage);
  if (
    before.personal.configuration === null &&
    before.personal.personalOverridesAllowed
  ) {
    await saveAndRemoveKey(page, "personal", personalApi, personalPage);
  } else {
    step("personal key step skipped: a key exists or the workspace decides");
  }

  if (workspacePage !== undefined) {
    await page.getByRole("link", { name: "Workspace Plugins" }).click();
    await heading(page, "Workspace Plugins");
    assert.equal(new URL(page.url()).pathname, new URL(workspacePage).pathname);
    await page
      .getByText("Plugins add tools to dx Threads for everyone in this")
      .waitFor();
    await page.getByRole("link", { name: "Personal Plugins" }).waitFor();
    await toggle(page, "on").or(toggle(page, "off")).waitFor();
    await shot(page, "02-workspace.desktop");
    step(
      "the Workspace Plugins link opens the workspace page, which links back",
    );
  }

  if (workspaceSlug !== undefined) {
    await switchOffAndOn(page, "workspace", workspaceApi, workspacePage);
    if (before.workspace.configuration === null) {
      await saveAndRemoveKey(page, "workspace", workspaceApi, workspacePage);
    } else {
      step("workspace key step skipped: the workspace already has a key");
    }

    // A workspace off is absolute: the personal switch locks with a hint.
    await toggle(page, "on").click();
    await status(page, `${target.displayName} turned off.`).waitFor();
    await page.getByRole("link", { name: "Personal Plugins" }).click();
    await heading(page, "Personal Plugins");
    const locked = toggle(page, "off");
    await locked.waitFor();
    assert(await locked.isDisabled(), "The personal switch is not locked.");
    await page.getByText("Disabled by your workspace").waitFor();
    await shot(page, "03-personal-locked-by-workspace.desktop");
    step("a workspace off locks the personal switch with a hint");
  }

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    storageState: await context.storageState(),
  });
  const phone = await mobile.newPage();
  watch(phone);
  const fits = async (name) => {
    const width = await phone.evaluate(
      () => document.scrollingElement.scrollWidth,
    );
    assert(width <= 390, `${name} overflows to ${width}px on a phone.`);
  };
  await phone.goto(personalPage);
  await heading(phone, "Personal Plugins");
  await toggle(phone, "on").or(toggle(phone, "off")).waitFor();
  await fits("Personal Plugins");
  await shot(phone, "04-personal.mobile");
  if (workspacePage !== undefined) {
    await phone.goto(workspacePage);
    await heading(phone, "Workspace Plugins");
    await toggle(phone, "on").or(toggle(phone, "off")).waitFor();
    await fits("Workspace Plugins");
    await shot(phone, "05-workspace.mobile");
  }
  await mobile.close();
  step("mobile pages fit 390px");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  const restore = async (apiPath, original) => {
    await api("PUT", `${apiPath}/${target.id}/enablement`, {
      enablement: original.enablement,
    });
    const current = findPlugin(await api("GET", apiPath), target.id);
    if (original.configuration === null && current.configuration !== null)
      await api("DELETE", `${apiPath}/${target.id}/configuration`);
  };
  if (before.workspace !== undefined)
    await restore(workspaceApi, before.workspace);
  await restore(personalApi, before.personal);
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
  // Vite dev serves every source module separately; they prove nothing here.
  har.log.entries = har.log.entries.filter(
    ({ request }) =>
      !/^\/(@|src\/|node_modules\/)/.test(new URL(request.url).pathname),
  );
  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    const body = entry.request.postData?.text;
    if (body?.includes(password) || body?.includes("plugins-proof-")) {
      entry.request.postData.text = "[redacted]";
    }
  }
  writeFileSync(harPath, JSON.stringify(har));
}
