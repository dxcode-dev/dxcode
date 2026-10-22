// Mode Dial journey against a running `pnpm dev` (local) or a branch preview.
// Adds a personal and a workspace custom connection so models are served,
// then drives one mode through the settings pages and checks each step over
// the profile API:
//
// - an unpinned mode shows Auto and the model Auto resolves to;
// - choosing a model and effort pins them; Discard drops the change and
//   leaving with it asks first;
// - Save stores the pin, and it survives a reload;
// - a workspace pin does not replace the member's own pin;
// - Reset to default clears the personal pin at once, and the mode then
//   follows the workspace pin;
// - Auto plus Save clears a pin the same way;
// - resetting the workspace pin returns the mode to dx's default.
//
// Writes desktop (1440) and mobile (390) screenshots, a HAR without bodies,
// console.json, and summary.json to <output>, then restores the mode's
// original pins and deletes the connections it added.
//
//   node apps/web/test/mode-dial-proof.mjs http://127.0.0.1:3000 out/
//
// The account must own or administer a workspace. Credentials come from
// DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local account in
// apps/core/.dev.vars. DX_PROOF_CHROMIUM picks the Chromium binary;
// DX_PROOF_CDP connects to an existing Chromium instead of launching one.
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
    ? await chromium.launch(
        process.env.DX_PROOF_CHROMIUM === undefined
          ? {}
          : { executablePath: process.env.DX_PROOF_CHROMIUM },
      )
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
assert(
  workspace !== undefined && ["owner", "admin"].includes(workspace.role),
  "The proof account must own or administer a workspace.",
);
const workspaceSlug = workspace.shortName;
const personalRouting = "/v1/settings/personal/model-routing";
const workspaceRouting = `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/model-routing`;
const MODE = "high";
const modePath = (routing) => `${routing}/profile/modes/${MODE}`;
const personalMode = async () =>
  (await api("GET", `${personalRouting}/profile`)).modes[MODE];
const workspaceMode = async () =>
  (await api("GET", `${workspaceRouting}/profile`)).modes[MODE];
const originalPersonal = await personalMode();
const originalWorkspace = await workspaceMode();

// Three catalog models with reasoning, served by an endpoint nothing calls.
const SERVED = [
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "openai/gpt-6-astra",
];
const stamp = Date.now().toString(36);
const connection = (scope) => ({
  name: `Mode Dial proof ${scope} ${stamp}`,
  kind: "custom",
  providerId: "dx-custom",
  baseUrl: "https://mode-dial-proof.invalid/v1",
  format: "openai-responses",
  apiKey: "mode-dial-proof-key",
  models: SERVED.map((canonical) => ({ canonical })),
});
const created = [];

const summary = { base, workspace: workspaceSlug, mode: MODE, steps };
try {
  created.push([
    personalRouting,
    (
      await api(
        "POST",
        `${personalRouting}/connections`,
        connection("personal"),
      )
    ).id,
  ]);
  created.push([
    workspaceRouting,
    (
      await api(
        "POST",
        `${workspaceRouting}/connections`,
        connection("workspace"),
      )
    ).id,
  ]);
  // Start from no pins on either scope.
  await api("DELETE", modePath(personalRouting));
  await api("DELETE", modePath(workspaceRouting));
  const shipped = (await personalMode()).config.agent;
  assert.equal((await personalMode()).source, "default");
  // Pins that differ from the shipped default and from each other.
  const [personalModel, workspaceModel] = SERVED.filter(
    (model) => model !== shipped.model,
  );
  const personalPin = { model: personalModel, thinking: "xhigh" };
  const workspacePin = { model: workspaceModel, thinking: "low" };
  step("added served connections and cleared the mode's pins", {
    shipped,
    personalPin,
    workspacePin,
  });

  const page = await context.newPage();
  watch(page);
  const select = page.locator("#mode-dial-model");
  const effort = page.getByRole("slider", {
    name: "Main Agent reasoning effort",
  });
  const save = page.getByRole("button", { name: "Save", exact: true });
  const discard = page.getByRole("button", { name: "Discard" });
  const reset = page.getByRole("button", { name: "Reset to default" });
  const modeHeading = page.locator(".tuning-mode-heading h2");
  // The settings shell owns the unsaved-changes indicator.
  const unsaved = page.locator(".settings-dirty-state");
  const selectedLabel = () =>
    select.evaluate((element) => element.selectedOptions[0]?.textContent);
  const shortName = (canonical) => canonical.split("/").at(-1);
  const open = async (path) => {
    await page.goto(`${base}${path}?mode=${MODE}`);
    await page.getByRole("heading", { name: "Mode Dial" }).waitFor();
    await select.waitFor();
    await page.locator("#mode-dial-model:enabled").waitFor();
  };
  const pin = async ({ model, thinking }) => {
    await select.selectOption(model);
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    await effort.fill(String(levels.indexOf(thinking)));
  };
  const saveChanges = async () => {
    assert(await save.isEnabled(), "Save is disabled after a change.");
    await save.click();
    await unsaved.waitFor({ state: "detached" });
    assert(await save.isDisabled(), "Save stays enabled after saving.");
  };

  await open("/settings/mode-dial");
  assert.equal(await select.inputValue(), "auto");
  assert.equal(await selectedLabel(), `Auto · ${shortName(shipped.model)}`);
  assert(await save.isDisabled(), "Save is enabled before a change.");
  assert.equal(await reset.count(), 0, "Reset shows on an unpinned mode.");
  await shot(page, "01-personal-auto.desktop");
  step("an unpinned mode shows Auto with the model it resolves to");

  await pin(personalPin);
  await unsaved.waitFor();
  assert.match(await modeHeading.innerText(), /Tuned/i);
  await shot(page, "02-personal-pinning.desktop");
  await discard.click();
  await unsaved.waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), "auto");
  assert(await save.isDisabled(), "Save is enabled after Discard.");
  step("choosing a model and effort is an unsaved pin; Discard drops it");

  await pin(personalPin);
  await page.getByRole("link", { name: "Account" }).first().click();
  await page.getByText("Discard unsaved changes?").waitFor();
  await shot(page, "03-unsaved-guard.desktop");
  await page.getByRole("button", { name: "Stay on page" }).click();
  await page.getByRole("heading", { name: "Mode Dial" }).waitFor();
  step("leaving with an unsaved pin asks first");

  await saveChanges();
  let personal = await personalMode();
  assert.equal(personal.source, "override");
  assert.deepEqual(personal.config.agent, personalPin);
  await open("/settings/mode-dial");
  assert.equal(await select.inputValue(), personalPin.model);
  assert.equal(await effort.getAttribute("aria-valuetext"), "Extra high");
  assert(await reset.isVisible(), "Reset is missing on a pinned mode.");
  await shot(page, "04-personal-pinned.desktop");
  step("Save stores the personal pin and it survives a reload", {
    personal,
  });

  await open(`/workspaces/${workspaceSlug}/mode-dial`);
  assert.equal(await select.inputValue(), "auto");
  await page
    .getByText("Your own pins for High replace these in your Threads.")
    .waitFor();
  await pin(workspacePin);
  await saveChanges();
  await shot(page, "05-workspace-pinned.desktop");
  const workspaceSaved = await workspaceMode();
  assert.equal(workspaceSaved.source, "override");
  assert.deepEqual(workspaceSaved.config.agent, workspacePin);
  personal = await personalMode();
  assert.equal(personal.source, "override");
  assert.deepEqual(
    personal.config.agent,
    personalPin,
    "The workspace pin replaced the member's own pin.",
  );
  step("a workspace pin saves and leaves the member's own pin in charge", {
    workspace: workspaceSaved,
    personal,
  });

  await open("/settings/mode-dial");
  await reset.click();
  await page.getByText(`Workspace · ${shortName(workspacePin.model)}`).waitFor({
    state: "attached",
  });
  assert.equal(await select.inputValue(), "auto");
  assert.match(await modeHeading.innerText(), /Workspace/i);
  personal = await personalMode();
  assert.equal(personal.source, "workspace");
  assert.deepEqual(personal.config.agent, workspacePin);
  await shot(page, "06-personal-follows-workspace.desktop");
  step(
    "Reset to default clears the personal pin at once; the mode follows the workspace pin",
    { personal },
  );

  await pin(personalPin);
  await saveChanges();
  assert.equal((await personalMode()).source, "override");
  await select.selectOption("auto");
  await unsaved.waitFor();
  await saveChanges();
  personal = await personalMode();
  assert.equal(personal.source, "workspace");
  assert.deepEqual(personal.config.agent, workspacePin);
  step("Auto plus Save clears a personal pin", { personal });

  await open(`/workspaces/${workspaceSlug}/mode-dial`);
  await reset.click();
  await page.getByText(`Auto · ${shortName(shipped.model)}`).waitFor({
    state: "attached",
  });
  assert.equal((await workspaceMode()).source, "default");
  personal = await personalMode();
  assert.equal(personal.source, "default");
  assert.deepEqual(personal.config.agent, shipped);
  await shot(page, "07-workspace-reset.desktop");
  step("resetting the workspace pin returns members to dx's default", {
    personal,
  });

  // Leave a pin on each scope so the phone screenshots show both states.
  await api("PUT", modePath(workspaceRouting), {
    ...originalWorkspace.config,
    agent: workspacePin,
  });
  await api("PUT", modePath(personalRouting), {
    ...originalPersonal.config,
    agent: personalPin,
  });
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
  await phone.goto(`${base}/settings/mode-dial?mode=${MODE}`);
  await phone.locator("#mode-dial-model:enabled").waitFor();
  await shot(phone, "08-personal.mobile");
  await phone.goto(
    `${base}/workspaces/${workspaceSlug}/mode-dial?mode=${MODE}`,
  );
  await phone.locator("#mode-dial-model:enabled").waitFor();
  await phone
    .getByText("Your own pins for High replace these in your Threads.")
    .waitFor();
  await shot(phone, "09-workspace.mobile");
  await mobile.close();
  step("mobile pages rendered");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  const restore = async (routing, original) => {
    if (original.source === "override") {
      await api("PUT", modePath(routing), original.config);
    } else {
      await api("DELETE", modePath(routing));
    }
  };
  await restore(personalRouting, originalPersonal);
  await restore(workspaceRouting, originalWorkspace);
  for (const [routing, id] of created) {
    await api("DELETE", `${routing}/connections/${encodeURIComponent(id)}`);
  }
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
  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    if (
      entry.request.postData?.text?.includes(password) ||
      entry.request.postData?.text?.includes("mode-dial-proof-key")
    ) {
      entry.request.postData.text = "[redacted]";
    }
  }
  writeFileSync(harPath, JSON.stringify(har));
}
