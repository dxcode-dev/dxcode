// Orb provider connections, end to end, against a deployment (a branch
// preview; the local runtime never reaches a provider). Through the Settings
// page it connects the signed-in person's own provider account, watches dx
// prepare it until ready, starts a Thread on that account, waits for its Orb
// to be ready and lists its files, then disconnects and checks that it
// stops new Threads and the picker asks to connect a provider again (on a
// deployment that offers none of its own). Writes desktop and mobile
// screenshots, a HAR without bodies or credentials, console.json, and
// summary.json to <output>, and with DX_PROOF_VIDEO=1 a WebM of the
// desktop pages under <output>/video.
//
//   DX_PROOF_PROVIDER=e2b DX_PROOF_CREDENTIALS='{"apiKey":"e2b_…"}' \
//     node apps/web/test/orb-providers-proof.mjs https://<preview> out/
//
// DX_PROOF_PROVIDER picks the provider (e2b by default). DX_PROOF_CREDENTIALS
// is a JSON object of its connection fields. Sign-in comes from
// DX_PROOF_EMAIL / DX_PROOF_PASSWORD. DX_PROOF_CHROMIUM picks the browser.
// The run refuses an account that already has a connection for the
// provider, and removes the connection it made.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const [base, outputArgument] = process.argv.slice(2);
assert(base && outputArgument, "Usage: <base url> <output dir>");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const email = process.env.DX_PROOF_EMAIL;
const password = process.env.DX_PROOF_PASSWORD;
assert(email && password, "Set DX_PROOF_EMAIL and DX_PROOF_PASSWORD.");
const providerId = process.env.DX_PROOF_PROVIDER ?? "e2b";
const credentials = JSON.parse(process.env.DX_PROOF_CREDENTIALS ?? "{}");
assert(
  Object.keys(credentials).length > 0,
  "Set DX_PROOF_CREDENTIALS to the provider's connection fields.",
);
const PREPARE_TIMEOUT_MS = 30 * 60_000;
const ORB_TIMEOUT_MS = 10 * 60_000;

const browser = await chromium.launch(
  process.env.DX_PROOF_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.DX_PROOF_CHROMIUM },
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  recordHar: { path: join(output, "network.har"), content: "omit" },
  // DX_PROOF_VIDEO=1 also records the desktop pages as WebM.
  ...(process.env.DX_PROOF_VIDEO === "1"
    ? {
        recordVideo: {
          dir: join(output, "video"),
          size: { width: 1440, height: 900 },
        },
      }
    : {}),
});
const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email, password },
});
assert.equal(signIn.status(), 200, "Password sign-in failed.");

const request = async (method, path, data) => {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    headers: { origin: base },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), body: await response.json() };
};
const api = async (method, path, data) => {
  const { status, body } = await request(method, path, data);
  assert(
    status >= 200 && status < 300,
    `${method} ${path} answered ${status}: ${JSON.stringify(body)}`,
  );
  return body.data;
};

const consoleMessages = [];
const pageErrors = [];
const steps = [];
const started = Date.now();
const step = (name, detail = {}) => {
  steps.push({ name, atMs: Date.now() - started, ...detail });
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const providersBase = "/v1/settings/personal/orb-providers";
const list = () => api("GET", providersBase);
const providerOf = (data) => data.providers.find(({ id }) => id === providerId);

const summary = {
  base,
  provider: providerId,
  steps,
};
let connected = false;
// Until the provider lists its fields, treat every value as secret.
let secretFieldIds = Object.keys(credentials);
try {
  const before = await list();
  const provider = providerOf(before);
  assert(provider !== undefined, `${providerId} is not listed.`);
  assert(provider.fields.length > 0, `${providerId} takes no connection.`);
  secretFieldIds = provider.fields
    .filter(({ secret }) => secret)
    .map(({ id }) => id);
  assert.equal(
    provider.connection,
    null,
    "The account already has a connection; the run would replace it.",
  );
  assert.deepEqual(
    provider.fields.map(({ id }) => id).sort(),
    Object.keys(credentials).sort(),
    "DX_PROOF_CREDENTIALS does not match the provider's fields.",
  );
  summary.deploymentProviders = before.providers
    .filter(({ deployment }) => deployment)
    .map(({ id }) => id);
  summary.resolvedBefore = before.resolved;
  step("the provider lists its connection form and sizes", {
    fields: provider.fields.map(({ id, secret }) => ({ id, secret })),
    sizes: provider.sizes.map(({ id }) => id),
  });

  const page = await context.newPage();
  watch(page);
  const row = page.locator(`[data-provider="${providerId}"]`);
  const rowStatus = async () =>
    (await row.locator(".orb-provider-copy p").innerText()).trim();
  const openSettings = async () => {
    await page.goto(`${base}/settings/orb-providers`);
    await page
      .getByRole("heading", { name: "Orb Providers", exact: true })
      .waitFor({ timeout: 60_000 });
    await row.waitFor({ timeout: 60_000 });
  };

  // With no usable provider the composer asks to connect one.
  if (before.resolved.length === 0) {
    await page.goto(`${base}/new`);
    const connect = page.getByRole("button", {
      name: "Connect an Orb provider",
    });
    await connect.waitFor({ timeout: 60_000 });
    await shot(page, "01-new-thread-no-provider.desktop");
    await connect.click();
    await page
      .getByRole("heading", { name: "Orb Providers", exact: true })
      .waitFor({ timeout: 60_000 });
    step("with no provider, New Thread offers Connect an Orb provider");
  }

  await openSettings();
  await shot(page, "02-settings-before.desktop");
  await page
    .getByRole("button", { name: `Connect ${provider.displayName}` })
    .click();
  const dialog = page.getByRole("dialog");
  for (const field of provider.fields)
    await dialog
      .getByLabel(field.label, { exact: true })
      .fill(credentials[field.id]);
  await shot(page, "03-connect-dialog.desktop");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.endsWith(`/${providerId}/connection`),
  );
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  const savedResponse = await saved;
  assert(
    savedResponse.ok(),
    `Connecting answered ${savedResponse.status()}: ${await savedResponse.text()}`,
  );
  connected = true;
  await dialog.waitFor({ state: "detached" });
  step("the connection form verifies and saves the credentials", {
    status: await rowStatus(),
  });

  // Preparation runs on its own; the page polls while it does.
  const progress = [];
  const preparingSince = Date.now();
  for (;;) {
    const connection = providerOf(await list()).connection;
    const last = progress.at(-1);
    if (
      connection.progress !== null &&
      (last === undefined || last.step !== connection.progress.step)
    ) {
      progress.push({
        ...connection.progress,
        atMs: Date.now() - preparingSince,
      });
      await openSettings();
      await shot(page, `04-preparing-${progress.length}.desktop`);
    }
    if (connection.status === "ready") break;
    assert.notEqual(
      connection.status,
      "failed",
      `Preparation failed: ${connection.error}`,
    );
    assert(
      Date.now() - preparingSince < PREPARE_TIMEOUT_MS,
      "Preparation took longer than 30 minutes.",
    );
    await sleep(5_000);
  }
  const ready = await list();
  summary.preparation = {
    ms: Date.now() - preparingSince,
    progress,
    account: providerOf(ready).connection.account,
  };
  await openSettings();
  await shot(page, "05-ready.desktop");
  const readyStatus = await rowStatus();
  assert(
    readyStatus.startsWith("Your account"),
    `The ready row reads "${readyStatus}".`,
  );
  const member = ready.resolved.find(
    (candidate) => candidate.providerId === providerId,
  );
  assert.equal(member?.scope, "personal", "New Threads do not use it.");
  assert.equal(member?.status, "ready");
  step("preparation reaches ready and new Threads resolve to the account", {
    status: readyStatus,
    preparationMs: summary.preparation.ms,
  });

  // The picker offers the connected provider's sizes.
  await page.goto(`${base}/new`);
  const picker = page.locator(".new-thread-orb-size");
  await picker.waitFor({ timeout: 60_000 });
  await picker.click();
  await page
    .locator(".orb-picker-provider")
    .filter({ hasText: provider.displayName.split(" ")[0] })
    .first()
    .waitFor();
  await shot(page, "06-picker.desktop");
  await page.keyboard.press("Escape");
  step("the Orb picker offers the connected provider");

  // A Thread on the connection gets a ready Orb whose files list.
  const size = provider.sizes[0].id;
  const thread = await api("POST", "/v1/threads", {
    runnerProfileId: size,
    title: "Orb connection proof",
    generateTitle: false,
    threadId: `thr_${crypto.randomUUID()}`,
    initialMessage: {
      body: "Run `uname -a` in the terminal and reply with its output.",
      attachments: [],
    },
  });
  summary.threadId = thread.id;
  const orbSince = Date.now();
  let readiness;
  for (;;) {
    readiness = await api("GET", `/v1/threads/${thread.id}/readiness`);
    if (readiness.ready) break;
    assert(Date.now() - orbSince < ORB_TIMEOUT_MS, "The Orb never got ready.");
    await sleep(3_000);
  }
  const files = await api("GET", `/v1/threads/${thread.id}/files`);
  summary.orb = {
    readyMs: Date.now() - orbSince,
    files: files.entries?.length,
  };
  await page.goto(`${base}/threads/${thread.id}`);
  await page.waitForTimeout(5_000);
  await shot(page, "07-thread.desktop");
  step("a Thread on the connection gets a ready Orb and lists its files", {
    size,
    orbReadyMs: summary.orb.readyMs,
  });

  // Disconnecting fails pinned Threads closed and stops new ones.
  await openSettings();
  await page
    .getByRole("button", { name: `Manage ${provider.displayName}` })
    .click();
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname.endsWith(`/${providerId}/connection`),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  assert((await removed).ok(), "Disconnecting failed.");
  connected = false;
  const after = await list();
  assert.equal(providerOf(after).connection, null);
  // A running Orb keeps serving through its resident daemon until it
  // pauses; the pinned account fails closed at the next provider operation.
  const filesAfter = await request("GET", `/v1/threads/${thread.id}/files`);
  // New Threads cannot start on the removed account.
  const refused = await request("POST", "/v1/threads", {
    runnerProfileId: size,
    title: "Orb connection proof (after disconnect)",
    generateTitle: false,
  });
  summary.afterDisconnect = {
    resolved: after.resolved,
    runningOrbFilesStatus: filesAfter.status,
    newThread: { status: refused.status, body: refused.body.data },
  };
  if (summary.deploymentProviders.length === 0) {
    assert.equal(
      refused.status,
      409,
      "A new Thread started without a provider.",
    );
    assert.equal(refused.body.data.code, "ORB_UNAVAILABLE");
    assert.equal(refused.body.data.reason, "no-provider");
    await page.goto(`${base}/new`);
    await page
      .getByRole("button", { name: "Connect an Orb provider" })
      .waitFor({ timeout: 60_000 });
  }
  await shot(page, "08-disconnected.desktop");
  step("disconnecting stops new Threads on the account", {
    newThreadStatus: refused.status,
    runningOrbFilesStatus: filesAfter.status,
  });

  // The settings page on a phone has no horizontal overflow.
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
  await phone.goto(`${base}/settings/orb-providers`);
  await phone
    .getByRole("heading", { name: "Orb Providers", exact: true })
    .waitFor({ timeout: 60_000 });
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(overflow <= 0, `The mobile page overflows by ${overflow}px.`);
  await shot(phone, "09-settings.mobile");
  await mobile.close();
  step("the settings page fits a phone");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (connected)
    await request("DELETE", `${providersBase}/${providerId}/connection`).catch(
      () => undefined,
    );
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
  // The provider's secret fields; others (an account ID) are not secret.
  const secrets = [
    password,
    email,
    ...secretFieldIds.map((id) => credentials[id]),
  ].filter((value) => typeof value === "string" && value.length > 0);
  const harPath = join(output, "network.har");
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    if (entry.request.postData !== undefined)
      entry.request.postData.text = "[redacted]";
  }
  const text = JSON.stringify(har);
  for (const artifact of [
    text,
    readFileSync(join(output, "console.json"), "utf8"),
    readFileSync(join(output, "summary.json"), "utf8"),
  ])
    for (const secret of secrets)
      assert(!artifact.includes(secret), "An artifact holds a credential.");
  writeFileSync(harPath, text);
}
