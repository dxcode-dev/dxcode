// Workspace profile journey against a running `pnpm dev` (local) or a branch
// preview. As the workspace owner it checks the read-only profile row, opens
// Edit, saves a new display name and short name, follows the URL to the new
// short name, and restores both. Then a member account joins through an invite
// link, sees no Edit button, and leaves through the Leave workspace dialog,
// which returns it to the home page without a workspace. Writes desktop
// (1440) and mobile (390) screenshots, a HAR without bodies, console.json, and
// summary.json to <output>.
//
//   node apps/web/test/workspace-profile-proof.mjs http://127.0.0.1:3000 out/
//
// The owner comes from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars, and must own or administer its workspace;
// with none, the run creates one through the create card. The member comes
// from DX_PROOF_MEMBER_EMAIL / DX_PROOF_MEMBER_PASSWORD, or the run signs up a
// throwaway `leave-proof-*@example.com` account through the invite link, which
// works only where sign-up needs no email verification (local). Without a
// member, the leave half is skipped and summary.json says so.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const secrets = [password];

const browser = await chromium.launch();
const harPaths = [];
const newContext = (name, options = {}) => {
  const path = join(output, `${name}.har`);
  harPaths.push(path);
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    recordHar: { path, content: "omit" },
    ...options,
  });
};
const mobileOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const signIn = async (context, account) => {
  const response = await context.request.post(
    `${base}/api/auth/sign-in/email`,
    { headers: { origin: base }, data: account },
  );
  assert.equal(response.status(), 200, "Password sign-in failed.");
};
const apiFor = (context) => async (method, path, data) => {
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
const watch = (page, account) => {
  page.on("console", (message) =>
    consoleMessages.push({
      account,
      type: message.type(),
      text: message.text(),
      url: page.url(),
    }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ account, message: error.message, url: page.url() }),
  );
};
const shot = (page, name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const profileCard = (page) =>
  page.locator("section.settings-card", {
    has: page.getByRole("heading", { name: "Workspace profile" }),
  });
const expectProfileRow = async (page, displayName, shortName) => {
  const card = profileCard(page);
  await card.locator("dd", { hasText: displayName }).first().waitFor();
  assert.equal(
    (await card.locator("dd").nth(1).textContent())?.trim(),
    shortName,
    "The profile row shows the wrong short name.",
  );
  assert.equal(
    await card.locator("input").count(),
    0,
    "The profile row shows inputs.",
  );
};
const fillProfile = async (page, displayName, shortName) => {
  await page.getByRole("button", { name: "Edit" }).click();
  const save = page.getByRole("button", { name: "Save" });
  assert(await save.isDisabled(), "Save is enabled before a change.");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Short name").fill(shortName);
  assert(await save.isEnabled(), "Save stays disabled after a change.");
  return save;
};

const owner = await newContext("owner");
await signIn(owner, { email, password });
const ownerApi = apiFor(owner);
const stamp = Date.now().toString(36);
const summary = { base, steps };
let workspace = (await ownerApi("GET", "/v1/settings/personal")).workspace;
if (workspace === undefined) {
  // Create it through the create card, which this page shows without one.
  const page = await owner.newPage();
  watch(page, "owner");
  await page.goto(`${base}/workspaces`);
  await page.getByLabel("Workspace display name").fill("Proof Workspace");
  await page.getByLabel("Short name").fill(`proof-${stamp}`);
  await shot(page, "00-create.desktop");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(`${base}/workspaces/proof-${stamp}`);
  workspace = (await ownerApi("GET", "/v1/settings/personal")).workspace;
  assert.equal(workspace?.shortName, `proof-${stamp}`);
  await page.close();
  summary.createdWorkspace = true;
  step("the create card creates a workspace and opens its page");
}
assert(
  ["owner", "admin"].includes(workspace.role),
  "The proof account does not administer its workspace.",
);
const original = {
  displayName: workspace.displayName,
  shortName: workspace.shortName,
};
summary.workspace = original;
const edited = {
  displayName: `${original.displayName} (edited)`,
  shortName: `${original.shortName}-${stamp}`.slice(0, 32).replace(/-$/, ""),
};
let restored = false;
let inviteLinkId;

try {
  const page = await owner.newPage();
  watch(page, "owner");
  await page.goto(`${base}/workspaces/${original.shortName}`);
  await page.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
  await expectProfileRow(page, original.displayName, original.shortName);
  await shot(page, "01-profile.desktop");
  step("the profile is a read-only row with an Edit button");

  const save = await fillProfile(page, edited.displayName, edited.shortName);
  await shot(page, "02-edit.desktop");
  await page.getByRole("link", { name: "Members" }).first().click();
  await page.getByText("Discard unsaved changes?").waitFor();
  await page.getByRole("button", { name: "Stay on page" }).click();
  step("Edit opens the fields; leaving with unsaved edits asks first");

  await save.click();
  await page.waitForURL(`${base}/workspaces/${edited.shortName}`);
  await expectProfileRow(page, edited.displayName, edited.shortName);
  await shot(page, "03-saved.desktop");
  const saved = (await ownerApi("GET", "/v1/settings/personal")).workspace;
  assert.equal(saved.displayName, edited.displayName);
  assert.equal(saved.shortName, edited.shortName);
  step("Save stores both names and moves the URL to the new short name", {
    saved: { displayName: saved.displayName, shortName: saved.shortName },
  });

  await fillProfile(page, "x", "x");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectProfileRow(page, edited.displayName, edited.shortName);
  step("Cancel discards the draft");

  await (
    await fillProfile(page, original.displayName, original.shortName)
  ).click();
  await page.waitForURL(`${base}/workspaces/${original.shortName}`);
  await expectProfileRow(page, original.displayName, original.shortName);
  restored = true;
  step("a second save on the new revision restores the original names");

  const ownerMobile = await newContext("owner-mobile", {
    ...mobileOptions,
    storageState: await owner.storageState(),
  });
  const phone = await ownerMobile.newPage();
  watch(phone, "owner");
  await phone.goto(`${base}/workspaces/${original.shortName}`);
  await expectProfileRow(phone, original.displayName, original.shortName);
  await shot(phone, "04-profile.mobile");
  await phone.getByRole("button", { name: "Edit" }).click();
  await phone.getByLabel("Display name").waitFor();
  await shot(phone, "05-edit.mobile");
  await ownerMobile.close();
  step("mobile profile row and edit form rendered");

  const memberAccount =
    process.env.DX_PROOF_MEMBER_EMAIL === undefined
      ? {
          email: `leave-proof-${stamp}@example.com`,
          password: `Proof-${stamp}-${Math.random().toString(36).slice(2)}`,
        }
      : {
          email: process.env.DX_PROOF_MEMBER_EMAIL,
          password: process.env.DX_PROOF_MEMBER_PASSWORD,
        };
  secrets.push(memberAccount.password);
  const link = await ownerApi(
    "POST",
    `/v1/settings/workspaces/${original.shortName}/invite-links`,
    { title: `leave-proof-${stamp}` },
  );
  inviteLinkId = link.id;
  const token = new URL(link.url).pathname.split("/").at(-1);
  const member = await newContext("member");
  if (process.env.DX_PROOF_MEMBER_EMAIL === undefined) {
    const signUp = await member.request.post(`${base}/api/auth/sign-up/email`, {
      headers: { origin: base },
      data: {
        ...memberAccount,
        name: "Leave Proof",
        callbackURL: `/join/${token}`,
      },
    });
    if (signUp.status() !== 200) {
      summary.leaveSkipped = `Member sign-up answered ${signUp.status()}.`;
    }
  }
  if (summary.leaveSkipped === undefined) {
    await signIn(member, memberAccount);
    const memberApi = apiFor(member);
    await memberApi("POST", `/v1/invites/${token}/accept`);
    step("a member joined through an invite link");

    const memberMobile = await newContext("member-mobile", {
      ...mobileOptions,
      storageState: await member.storageState(),
    });
    const memberPhone = await memberMobile.newPage();
    watch(memberPhone, "member");
    await memberPhone.goto(`${base}/workspaces/${original.shortName}`);
    await expectProfileRow(
      memberPhone,
      original.displayName,
      original.shortName,
    );
    await memberPhone
      .getByRole("button", { name: "Leave workspace" })
      .waitFor();
    await shot(memberPhone, "06-member.mobile");
    await memberMobile.close();

    const memberPage = await member.newPage();
    watch(memberPage, "member");
    await memberPage.goto(`${base}/workspaces/${original.shortName}`);
    await expectProfileRow(
      memberPage,
      original.displayName,
      original.shortName,
    );
    assert.equal(
      await memberPage.getByRole("button", { name: "Edit" }).count(),
      0,
      "A member sees the Edit button.",
    );
    await shot(memberPage, "07-member.desktop");
    step("a member sees the profile without Edit, and a Leave workspace row");

    await memberPage.getByRole("button", { name: "Leave workspace" }).click();
    const dialog = memberPage.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: `Leave ${original.displayName}?` })
      .waitFor();
    await shot(memberPage, "08-leave-dialog.desktop");
    await dialog.getByRole("button", { name: "Leave", exact: true }).click();
    await memberPage.waitForURL(`${base}/`);
    const after = await memberApi("GET", "/v1/settings/personal");
    assert.equal(
      after.workspace,
      undefined,
      "The member still has a workspace.",
    );
    const members = await ownerApi(
      "GET",
      `/v1/settings/workspaces/${original.shortName}/members`,
    );
    assert(
      !JSON.stringify(members).includes(memberAccount.email),
      "The workspace still lists the member.",
    );
    await shot(memberPage, "09-after-leave.desktop");
    step("Leave removes the membership and returns home");
  }
  await member.close();
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (!restored) {
    const current = (await ownerApi("GET", "/v1/settings/personal")).workspace;
    await ownerApi("PATCH", `/v1/settings/workspaces/${current.shortName}`, {
      ...original,
      expectedRevision: current.revision,
    }).catch((error) => {
      summary.restoreError = String(error);
    });
  }
  if (inviteLinkId !== undefined) {
    await ownerApi(
      "DELETE",
      `/v1/settings/workspaces/${original.shortName}/invite-links/${inviteLinkId}`,
    ).catch(() => undefined);
  }
  summary.pageErrors = pageErrors;
  summary.consoleErrors = consoleMessages.filter(
    ({ type }) => type === "error",
  ).length;
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify({ console: consoleMessages, pageErrors }, null, 2)}\n`,
  );
  await owner.close();
  await browser.close();

  // One shareable HAR without credentials, client addresses, or invite links.
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
  const entries = [];
  let pages = [];
  for (const path of harPaths.filter(existsSync)) {
    const har = JSON.parse(readFileSync(path, "utf8"));
    pages = pages.concat(har.log.pages ?? []);
    entries.push(...har.log.entries);
  }
  const redact = (text) =>
    text
      .replace(/\/(join|invites)\/[A-Za-z0-9_-]{43}/g, "/$1/[redacted]")
      .replaceAll(email, "[redacted]");
  for (const entry of entries) {
    entry.request.url = redact(entry.request.url);
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    if (entry.request.postData?.text !== undefined) {
      const text = entry.request.postData.text;
      entry.request.postData.text = secrets.some((secret) =>
        text.includes(secret),
      )
        ? "[redacted]"
        : redact(text);
    }
  }
  entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  const merged = JSON.parse(readFileSync(harPaths[0], "utf8"));
  merged.log.pages = pages;
  merged.log.entries = entries;
  writeFileSync(join(output, "network.har"), JSON.stringify(merged));
  for (const path of harPaths) rmSync(path, { force: true });
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify(summary, (key, value) => (key === "email" ? "[redacted]" : value), 2)}\n`,
  );
}
