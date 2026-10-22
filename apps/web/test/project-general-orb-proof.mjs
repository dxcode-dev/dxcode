// Project General and Orb settings journey against a running `pnpm dev`
// (local) or a branch preview. Creates a personal project, then through the
// settings pages: renames it, describes it, adds an additional repository by
// URL, and saves once, checking each change over the API and after a reload;
// uploads an icon while an edit is unsaved and checks the edit survives;
// removes the repository; and checks a bad name is refused without saving.
// On the Orb page it saves a different size, then opens the new-Thread
// composer on the project and checks the composer shows that size and sends
// it when it creates the Thread. Writes desktop (1440) and mobile (390)
// screenshots, a HAR without bodies, console.json, and summary.json to
// <output>.
//
//   node apps/web/test/project-general-orb-proof.mjs http://127.0.0.1:3000 out/
//
// The catalog needs a second available Orb size. dx has no project deletion,
// so the project stays, named `general-orb-proof-*`. Where the deployment
// serves a model (a branch preview), the run creates one Thread in it.
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CDP connects to an existing
// Chromium instead of launching headless.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { deflateSync } from "node:zlib";
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
// The owner name beside the project name and the sidebar's account row show
// who signed in.
// General settles once the repository lookup answers and the icon loads.
const settled = (page) =>
  page.waitForFunction(() => {
    const card = document.querySelector(".project-general-card");
    const icon = card?.querySelector(".project-settings-icon img");
    return (
      card !== null &&
      card !== undefined &&
      !card.textContent?.includes("Loading authorized repositories") &&
      (icon === null ||
        icon === undefined ||
        (icon.complete && icon.naturalWidth > 0))
    );
  });
const shot = (page, name) =>
  page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    mask: [page.locator(".sidebar-account-shell, .project-owner-name")],
  });
const waitForSave = (page, method, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === path,
  );

/** A 2×2 opaque PNG. */
const png = () => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = [0, 46, 204, 113, 46, 204, 113];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([...row, ...row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const stamp = Date.now().toString(36);
const created = await api("POST", "/v1/projects", {
  name: `general-orb-proof-${stamp}`,
});
const projectPath = `/v1/projects/${created.id}`;
const settingsUrl = (section) =>
  `${base}/projects/${created.id}/settings/${section}`;
const extraRepository = "https://github.com/octocat/Hello-World";
const summary = { base, project: created.id, steps };

try {
  const page = await context.newPage();
  watch(page);
  const name = page.getByLabel("Project name", { exact: true });
  const description = page.getByLabel("Project description", { exact: true });
  const save = page.locator(".project-general-card").getByRole("button", {
    name: "Save",
    exact: true,
  });
  const extras = page.getByRole("list", { name: "Additional repositories" });

  await page.goto(settingsUrl("general"));
  await name.waitFor();
  assert.equal(await name.inputValue(), created.name);
  assert(await save.isDisabled(), "Save is enabled before any edit.");
  await settled(page);
  await shot(page, "01-general.desktop");
  step("General shows the project in one card; Save starts disabled");

  const renamed = `general-orb-proof-${stamp}-renamed`;
  await name.fill(renamed);
  await description.fill("Proof description");
  await page.locator("#project-additional-repositories").click();
  await page
    .getByPlaceholder("Search repositories or paste a URL")
    .fill(extraRepository);
  await page
    .getByRole("option", { name: extraRepository, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await extras.getByText(extraRepository).waitFor();
  assert(await save.isEnabled(), "Save stayed disabled after edits.");
  await settled(page);
  await shot(page, "02-general-edited.desktop");
  step("name, description, and an additional repository edit the form");

  const saved = waitForSave(page, "PATCH", projectPath);
  await save.click();
  assert.equal((await saved).status(), 200, "Save was refused.");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".project-general-card .settings-form-actions button")
        ?.hasAttribute("disabled") === true,
  );
  const afterSave = await api("GET", projectPath);
  assert.equal(afterSave.name, renamed);
  assert.equal(afterSave.description, "Proof description");
  assert.deepEqual(
    afterSave.additionalRepositories.map(({ webUrl }) => webUrl),
    [extraRepository],
  );
  step("one Save stores all three over the API", {
    name: afterSave.name,
    description: afterSave.description,
    additionalRepositories: afterSave.additionalRepositories,
    revision: afterSave.revision,
  });

  await page.reload();
  await name.waitFor();
  assert.equal(await name.inputValue(), renamed);
  assert.equal(await description.inputValue(), "Proof description");
  await extras.getByText(extraRepository).waitFor();
  await settled(page);
  await shot(page, "03-general-saved.desktop");
  step("a reload shows the saved values");

  await description.fill("Draft kept across the icon upload");
  const uploaded = waitForSave(page, "PUT", `${projectPath}/icon`);
  await page.locator("#project-icon-input").setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: png(),
  });
  assert.equal((await uploaded).status(), 200, "The icon upload failed.");
  await page.locator(".project-settings-icon img").waitFor();
  assert.equal(
    await description.inputValue(),
    "Draft kept across the icon upload",
  );
  assert(await save.isEnabled(), "The upload dropped the unsaved edit.");
  const afterIcon = await api("GET", projectPath);
  assert(afterIcon.iconUrl, "The project has no icon after the upload.");
  assert.equal(afterIcon.description, "Proof description");
  await settled(page);
  await shot(page, "04-icon-uploaded.desktop");
  step("an icon uploads at once and keeps the unsaved description", {
    revision: afterIcon.revision,
  });

  await extras
    .getByRole("button", { name: /^Remove / })
    .first()
    .click();
  const savedAgain = waitForSave(page, "PATCH", projectPath);
  await save.click();
  assert.equal((await savedAgain).status(), 200);
  await extras.waitFor({ state: "detached" });
  const afterRemove = await api("GET", projectPath);
  assert.equal(afterRemove.description, "Draft kept across the icon upload");
  assert.deepEqual(afterRemove.additionalRepositories, []);
  step("removing the repository and saving stores both edits", {
    description: afterRemove.description,
    additionalRepositories: afterRemove.additionalRepositories,
  });

  await name.fill("x");
  await save.click();
  await page.locator(".settings-form-error").waitFor();
  const refusal = await page.locator(".settings-form-error").innerText();
  assert.equal((await api("GET", projectPath)).name, renamed);
  await settled(page);
  await shot(page, "05-bad-name.desktop");
  await name.fill(renamed);
  step("a bad name shows why and saves nothing", { refusal });

  await page.goto(settingsUrl("orb"));
  const radios = page.locator('.project-orb-size-card input[type="radio"]');
  await radios.first().waitFor();
  const body = await page.locator(".project-settings-content").innerText();
  assert(!body.includes("Detection deferred"), "The Setup stub is back.");
  assert(!body.includes(".agents/setup"), "The Setup stub is back.");
  const sizes = await radios.evaluateAll((inputs) =>
    inputs.map((input) => ({
      checked: input.checked,
      disabled: input.disabled,
      label:
        input
          .closest("label")
          ?.querySelector(".orb-size-card-summary strong")
          ?.textContent?.trim() ?? "",
    })),
  );
  const target = sizes.findIndex(
    ({ checked, disabled }) => !checked && !disabled,
  );
  assert(target >= 0, "The catalog has no second available Orb size.");
  const catalog = (await api("GET", "/v1/settings/personal/projects")).catalog;
  const chosen = catalog.profiles.find(
    ({ label }) => label === sizes[target].label,
  );
  assert(chosen, `No catalog size is labelled ${sizes[target].label}.`);
  const orbSave = page.locator(".project-orb-size-card").getByRole("button", {
    name: "Save",
    exact: true,
  });
  assert(await orbSave.isDisabled());
  await shot(page, "06-orb.desktop");
  step("Orb shows the size grid without the Setup stub", {
    sizes: sizes.map(({ label }) => label),
  });

  await radios.nth(target).locator("xpath=ancestor::label").click();
  const orbSaved = waitForSave(page, "PATCH", projectPath);
  await orbSave.click();
  assert.equal((await orbSaved).status(), 200);
  const afterOrb = await api("GET", projectPath);
  assert.equal(afterOrb.configuration.runnerProfileId, chosen.id);
  await shot(page, "07-orb-saved.desktop");
  step("a different size saves to the project", {
    runnerProfileId: afterOrb.configuration.runnerProfileId,
  });

  await page.goto(`${base}/new?project=${created.id}`);
  const pill = page.locator(".new-thread-orb-size").first();
  await pill.waitFor();
  let shown = "";
  // "Orb" alone is the loading state.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    shown = (await pill.innerText()).trim();
    if (shown !== "Orb") break;
    await page.waitForTimeout(500);
  }
  assert(
    shown.endsWith(chosen.label),
    `The composer shows "${shown}", not ${chosen.label}.`,
  );
  await shot(page, "08-new-thread.desktop");
  const requested = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/v1/threads",
  );
  await page.getByRole("textbox", { name: "Prompt" }).fill("Reply with OK.");
  await page.getByRole("button", { name: "Create thread and send" }).click();
  const request = await requested;
  const sent = request.postDataJSON();
  assert.equal(sent.projectId, created.id);
  assert.equal(
    sent.runnerProfileId,
    chosen.id,
    "The composer did not send the project's size.",
  );
  const response = await request.response();
  const answer = await response?.json();
  summary.thread =
    response?.status() === 201
      ? { created: true, id: answer.data.thread?.id ?? answer.data.id }
      : {
          created: false,
          status: response?.status(),
          code: answer?.data?.code,
        };
  step("the new-Thread composer starts on the project's size and sends it", {
    shown,
    runnerProfileId: sent.runnerProfileId,
    thread: summary.thread,
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
  await phone.goto(settingsUrl("general"));
  await phone.getByLabel("Project name", { exact: true }).waitFor();
  await settled(phone);
  await shot(phone, "09-general.mobile");
  await phone.goto(settingsUrl("orb"));
  await phone
    .locator('.project-orb-size-card input[type="radio"]')
    .first()
    .waitFor();
  await shot(phone, "10-orb.mobile");
  await mobile.close();
  step("mobile shows both pages");
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
