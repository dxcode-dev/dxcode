// Members settings journey against a running `pnpm dev` (local) or a branch
// preview. As the workspace owner it invites through the Invite dialog, then a
// member joins with that link. The owner filters the list with search and the
// chips, promotes and demotes the member, creates a second link with an
// expiry from the Invite Links card, and revokes both links. The member sees
// the list read-only. Finally the owner removes the member. Writes desktop
// (1440) and mobile (390) screenshots, a HAR without bodies, console.json, and
// summary.json to <output>.
//
//   node apps/web/test/members-settings-proof.mjs http://127.0.0.1:3000 out/
//
// The owner comes from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars, and must own or administer its workspace;
// with none, the run creates one through the create card. The member comes
// from DX_PROOF_MEMBER_EMAIL / DX_PROOF_MEMBER_PASSWORD and must not be in a
// workspace, or the run signs up a throwaway `members-proof-*@example.com`
// account, which works only where sign-up needs no email verification (local).
// Without a member, the join, role, read-only, and removal steps are skipped
// and summary.json says so.
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
const stamp = Date.now().toString(36);
const memberAccount =
  process.env.DX_PROOF_MEMBER_EMAIL === undefined
    ? {
        email: `members-proof-${stamp}@example.com`,
        password: `Proof-${stamp}-${Math.random().toString(36).slice(2)}`,
        signUp: true,
      }
    : {
        email: process.env.DX_PROOF_MEMBER_EMAIL,
        password: process.env.DX_PROOF_MEMBER_PASSWORD,
        signUp: false,
      };
const secrets = [password, memberAccount.password];

const browser = await chromium.launch({
  ...(process.env.DX_PROOF_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.DX_PROOF_CHROMIUM }),
});
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
    {
      headers: { origin: base },
      data: { email: account.email, password: account.password },
    },
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
// Accounts from the environment are real people, so screenshots hide them.
const hiddenEmails =
  process.env.DX_PROOF_EMAIL === undefined
    ? []
    : [email, ...(memberAccount.signUp ? [] : [memberAccount.email])];
const shot = (page, name) =>
  page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    mask: hiddenEmails.map((address) => page.getByText(address)),
  });

const membersCard = (page) =>
  page.locator("section.settings-card.members-card").first();
const linksCard = (page) =>
  page.locator("section.settings-card", {
    has: page.getByRole("heading", { name: "Invite Links" }),
  });
const memberRow = (page, address) =>
  membersCard(page).locator(".members-row", { hasText: address });
const rowEmails = async (page) =>
  (
    await membersCard(page)
      .locator(".members-identity strong")
      .allTextContents()
  ).map((text) => text.trim());
const chip = (page, label) =>
  page.getByRole("button", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
const chipCount = async (page, label) =>
  Number((await chip(page, label).textContent()).match(/\((\d+)\)/)[1]);
const openMembers = async (page, slug) => {
  await page.goto(`${base}/workspaces/${slug}/members`);
  await page.getByRole("heading", { name: /^Members/ }).waitFor();
  await membersCard(page).locator(".members-row").first().waitFor();
};
const manage = async (page, label, item) => {
  await page.getByRole("button", { name: `Manage ${label}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const confirm = async (page, title, action) => {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: title }).waitFor();
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
};

const owner = await newContext("owner");
await owner.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: new URL(base).origin,
});
await signIn(owner, { email, password });
const ownerApi = apiFor(owner);
const summary = { base, steps };
let workspace = (await ownerApi("GET", "/v1/settings/personal")).workspace;
if (workspace === undefined) {
  const page = await owner.newPage();
  watch(page, "owner");
  await page.goto(`${base}/workspaces`);
  await page.getByLabel("Workspace display name").fill("Proof Workspace");
  await page.getByLabel("Short name").fill(`proof-${stamp}`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(`${base}/workspaces/proof-${stamp}`);
  workspace = (await ownerApi("GET", "/v1/settings/personal")).workspace;
  await page.close();
  summary.createdWorkspace = true;
  step("the create card created the owner's workspace");
}
assert(
  ["owner", "admin"].includes(workspace.role),
  "The proof account does not administer its workspace.",
);
const slug = workspace.shortName;
const membersPath = `/v1/settings/workspaces/${slug}/members`;
const linksPath = `/v1/settings/workspaces/${slug}/invite-links`;
summary.workspace = { displayName: workspace.displayName, shortName: slug };
const linkTitle = `members-proof-${stamp}`;
const expiringTitle = `members-proof-expiring-${stamp}`;
let memberUserId;
let member;

try {
  const page = await owner.newPage();
  watch(page, "owner");
  await openMembers(page, slug);
  const before = (await ownerApi("GET", membersPath)).members.length;
  await page
    .getByRole("heading", { name: `Members — ${before} total` })
    .waitFor();
  await shot(page, "01-members.desktop");
  step("the page shows the total, search, chips, Invite, and Invite Links", {
    members: before,
  });

  // Invite opens the link dialog; the new link is shown with Copy.
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Create invite link" }).waitFor();
  await dialog.getByLabel("Title").fill(linkTitle);
  await shot(page, "02-invite-dialog.desktop");
  await dialog.getByRole("button", { name: "Create Link" }).click();
  await dialog.getByRole("heading", { name: "Invite link ready" }).waitFor();
  const url = await dialog
    .getByRole("textbox", { name: "Invite link" })
    .inputValue();
  assert.match(url, /\/join\/[A-Za-z0-9_-]{43}$/, "No invite URL shown.");
  await dialog.getByRole("button", { name: "Copy invite link" }).click();
  await dialog.getByRole("button", { name: "Invite link copied" }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    url,
    "Copy put something else on the clipboard.",
  );
  await page.locator(".members-link-ready input").evaluate((input) => {
    input.value = input.value.replace(/[A-Za-z0-9_-]{43}$/, "[redacted]");
  });
  await shot(page, "03-invite-ready.desktop");
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "detached" });
  await linksCard(page)
    .locator(".members-row", { hasText: linkTitle })
    .getByText("Never expires · 0 joined")
    .waitFor();
  step("Invite creates a link, shows it, copies it, and lists it in the card");

  // The member joins through the link, when there is a member account.
  member = await newContext("member");
  let memberReady = true;
  if (memberAccount.signUp) {
    const signUp = await member.request.post(`${base}/api/auth/sign-up/email`, {
      headers: { origin: base },
      data: {
        email: memberAccount.email,
        password: memberAccount.password,
        name: "Members Proof",
      },
    });
    if (signUp.status() !== 200) {
      memberReady = false;
      summary.memberSkipped = `Member sign-up answered ${signUp.status()}.`;
    }
  }
  const memberApi = apiFor(member);
  const memberPage = await member.newPage();
  watch(memberPage, "member");
  let memberLabel;
  if (memberReady) {
    await signIn(member, memberAccount);
    assert.equal(
      (await memberApi("GET", "/v1/settings/personal")).workspace,
      undefined,
      "The member account is already in a workspace.",
    );
    await memberPage.goto(url);
    await memberPage.getByRole("button", { name: "Join workspace" }).click();
    await memberPage.waitForURL(`${base}/workspaces/${slug}`);
    const joined = (await ownerApi("GET", membersPath)).members.find(
      (entry) => entry.email === memberAccount.email,
    );
    assert(joined, "The member is not in the workspace after joining.");
    memberUserId = joined.userId;
    memberLabel = joined.name || joined.email;
    step("a member joined through the invite link");

    await openMembers(page, slug);
    await page
      .getByRole("heading", { name: `Members — ${before + 1} total` })
      .waitFor();
    await memberRow(page, memberAccount.email)
      .getByText(/^Active /)
      .waitFor();
    await linksCard(page)
      .locator(".members-row", { hasText: linkTitle })
      .getByText("Never expires · 1 joined")
      .waitFor();
    await shot(page, "04-joined.desktop");
    step("the list counts the member, shows last active, and the link's join");
  }
  const total = before + (memberReady ? 1 : 0);
  // Search for the member, or for the owner when there is none.
  const searchFor = memberReady ? memberAccount.email : email;

  // Search and chips filter the list.
  const search = page.getByRole("searchbox", { name: "Search members" });
  await search.fill(searchFor);
  assert.deepEqual(await rowEmails(page), [searchFor]);
  await search.fill("no-such-member");
  await membersCard(page).getByText("No members match.").waitFor();
  await search.fill("");
  const admins = await chipCount(page, "Admins & Roles");
  await chip(page, "Admins & Roles").click();
  assert.equal(
    await chip(page, "Admins & Roles").getAttribute("aria-pressed"),
    "true",
  );
  const adminRows = await rowEmails(page);
  assert.equal(adminRows.length, admins, "Admins chip count is wrong.");
  if (memberReady) {
    assert(!adminRows.includes(memberAccount.email), "Admins shows a member.");
  }
  await shot(page, "05-admins-filter.desktop");
  await chip(page, "Active 72h").click();
  assert.equal(
    await chip(page, "Admins & Roles").getAttribute("aria-pressed"),
    "false",
  );
  const activeRows = await rowEmails(page);
  assert.equal(activeRows.length, await chipCount(page, "Active 72h"));
  assert(activeRows.includes(searchFor), "Active 72h hides an active member.");
  await chip(page, "Active 72h").click();
  assert.equal((await rowEmails(page)).length, total);
  step("search, Admins & Roles, and Active 72h filter the list", {
    admins,
  });

  if (memberReady) {
    // Role changes.
    await manage(page, memberLabel, "Promote to Workspace Admin");
    await confirm(page, "Promote to workspace admin?", "Promote");
    await memberRow(page, memberAccount.email)
      .getByText("Workspace Admin")
      .waitFor();
    assert.equal(await chipCount(page, "Admins & Roles"), admins + 1);
    assert.equal(
      (await ownerApi("GET", membersPath)).members.find(
        (entry) => entry.userId === memberUserId,
      ).role,
      "admin",
    );
    await shot(page, "06-promoted.desktop");
    await manage(page, memberLabel, "Revoke Workspace Admin");
    await confirm(page, "Revoke workspace admin?", "Revoke");
    await memberRow(page, memberAccount.email)
      .getByText("Workspace Admin")
      .waitFor({ state: "detached" });
    assert.equal(
      (await ownerApi("GET", membersPath)).members.find(
        (entry) => entry.userId === memberUserId,
      ).role,
      "member",
    );
    step("promote and revoke workspace admin change the member's role");

    // The member's read-only view.
    await openMembers(memberPage, slug);
    await memberPage
      .getByRole("heading", { name: `Members — ${before + 1} total` })
      .waitFor();
    await chip(memberPage, "Admins & Roles").waitFor();
    const readOnly = {
      invite: await memberPage
        .getByRole("button", { name: "Invite", exact: true })
        .count(),
      manage: await memberPage
        .getByRole("button", { name: /^Manage / })
        .count(),
      inviteLinks: await linksCard(memberPage).count(),
    };
    assert.deepEqual(readOnly, { invite: 0, manage: 0, inviteLinks: 0 });
    await shot(memberPage, "07-member.desktop");
    const memberMobile = await newContext("member-mobile", {
      ...mobileOptions,
      storageState: await member.storageState(),
    });
    const memberPhone = await memberMobile.newPage();
    watch(memberPhone, "member");
    await openMembers(memberPhone, slug);
    await shot(memberPhone, "08-member.mobile");
    await memberMobile.close();
    step("a member sees the list without Invite, row menus, or Invite Links");
  }

  // The owner on mobile.
  const ownerMobile = await newContext("owner-mobile", {
    ...mobileOptions,
    storageState: await owner.storageState(),
  });
  const phone = await ownerMobile.newPage();
  watch(phone, "owner");
  await openMembers(phone, slug);
  await linksCard(phone).getByText(linkTitle).waitFor();
  await shot(phone, "09-owner.mobile");
  await ownerMobile.close();
  step("the owner's page rendered at 390 px");

  // Create Link with an expiry from the card, then revoke both links.
  await linksCard(page).getByRole("button", { name: "Create Link" }).click();
  await dialog.getByLabel("Title").fill(expiringTitle);
  await dialog.getByLabel("Expires").fill("2030-01-02T10:00");
  await dialog.getByRole("button", { name: "Create Link" }).click();
  await dialog.getByRole("heading", { name: "Invite link ready" }).waitFor();
  await dialog.getByRole("button", { name: "Done" }).click();
  const expiring = linksCard(page).locator(".members-row", {
    hasText: expiringTitle,
  });
  await expiring.getByText("Expires Jan 2, 2030 · 0 joined").waitFor();
  await shot(page, "10-links.desktop");
  step("Create Link in the card creates a link with an expiry");

  for (const title of [expiringTitle, linkTitle]) {
    await linksCard(page)
      .locator(".members-row", { hasText: title })
      .getByRole("button", { name: "Revoke" })
      .click();
    await confirm(page, `Revoke ${title}?`, "Revoke");
    await linksCard(page)
      .locator(".members-row", { hasText: title })
      .waitFor({ state: "detached" });
  }
  const remaining = (await ownerApi("GET", linksPath)).links.map(
    (link) => link.title,
  );
  assert(!remaining.includes(linkTitle) && !remaining.includes(expiringTitle));
  const preview = await ownerApi(
    "GET",
    `/api/invites/${new URL(url).pathname.split("/").at(-1)}`,
  );
  assert.equal(preview.status, "revoked", "The revoked link still works.");
  step("Revoke removes both links and the first link stops working");

  if (memberReady) {
    // Removal.
    await manage(page, memberLabel, "Remove from Workspace");
    await confirm(page, `Remove ${memberLabel}?`, "Remove");
    await memberRow(page, memberAccount.email).waitFor({ state: "detached" });
    await page
      .getByRole("heading", { name: `Members — ${before} total` })
      .waitFor();
    assert.equal(
      (await memberApi("GET", "/v1/settings/personal")).workspace,
      undefined,
      "The removed member still has a workspace.",
    );
    memberUserId = undefined;
    await shot(page, "11-removed.desktop");
    step("Remove from Workspace removes the member");
  }
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  // Leave the workspace as the run found it.
  if (memberUserId !== undefined) {
    await ownerApi("DELETE", `${membersPath}/${memberUserId}`).catch(
      (error) => {
        summary.cleanupError = String(error);
      },
    );
  }
  const links = await ownerApi("GET", linksPath).catch(() => ({ links: [] }));
  for (const link of links.links) {
    if (link.title === linkTitle || link.title === expiringTitle) {
      await ownerApi("DELETE", `${linksPath}/${link.id}`).catch(() => {});
    }
  }
  summary.pageErrors = pageErrors;
  summary.consoleErrors = consoleMessages.filter(
    ({ type }) => type === "error",
  ).length;
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify({ console: consoleMessages, pageErrors }, null, 2)}\n`,
  );
  await member?.close();
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
      .replaceAll(email, "[redacted]")
      .replaceAll(memberAccount.email, "[redacted]");
  for (const entry of entries) {
    entry.request.url = redact(entry.request.url);
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers
        .filter(({ name }) => !privateHeaders.has(name.toLowerCase()))
        .map((header) => ({ ...header, value: redact(header.value) }));
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
    `${JSON.stringify(summary, null, 2).replaceAll(memberAccount.email, "[redacted]").replaceAll(email, "[redacted]")}\n`,
  );
}
