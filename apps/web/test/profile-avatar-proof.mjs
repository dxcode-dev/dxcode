// Profile picture journey against a running `pnpm dev` (local) or a branch
// preview, recorded as video with a visible pointer. As the account owner it
// opens Settings → Account → Edit, uploads a picture through the file
// chooser, and checks the profile card, the sidebar, the API, and the served
// bytes; checks that a rejected file leaves the picture alone and that an
// unsaved name edit survives an upload; reloads; and removes the picture.
// Then, as workspace owner, it does the same for the workspace picture and
// checks the Members list and the settings switcher. A second account that
// is a plain member sees the workspace picture, gets no Edit button, and is
// refused by the API. Starts and ends with no pictures on
// either.
//
// Writes video/*.webm, desktop (1440) screenshots, a mobile (390) screenshot,
// HARs without bodies, console.json, and summary.json to <output>.
//
//   node apps/web/test/profile-avatar-proof.mjs http://127.0.0.1:3000 out/
//
// The owner comes from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars, and must own or administer its workspace. The
// member comes from DX_PROOF_MEMBER_EMAIL / DX_PROOF_MEMBER_PASSWORD, or the
// run signs up a throwaway `avatar-proof-*@example.com` account through an
// invite link, which works only where sign-up needs no email verification
// (local), and removes it from the workspace at the end; where sign-up is
// refused, the member half is skipped and summary.json says so. Without a
// workspace, the run creates one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "video"), { recursive: true });
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
    colorScheme: "light",
    deviceScaleFactor: 2,
    recordHar: { path, content: "omit" },
    recordVideo: {
      dir: join(output, "video"),
      size: { width: 1440, height: 900 },
    },
    ...options,
  });
};

// Playwright's recordings do not draw the pointer; this one follows real
// mouse events so the video shows where each click lands.
const pointer = () => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText =
      "position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #e53935;box-shadow:0 0 0 1px #fff;pointer-events:none;z-index:2147483647;transition:transform .08s";
    document.documentElement.append(dot);
    addEventListener(
      "mousemove",
      (event) => {
        dot.style.left = `${event.clientX}px`;
        dot.style.top = `${event.clientY}px`;
      },
      true,
    );
    addEventListener("mousedown", () => (dot.style.transform = "scale(.6)"));
    addEventListener("mouseup", () => (dot.style.transform = ""));
  });
};

const signIn = async (context, account) => {
  const response = await context.request.post(
    `${base}/api/auth/sign-in/email`,
    { headers: { origin: base }, data: account },
  );
  assert.equal(response.status(), 200, "Password sign-in failed.");
};
const apiFor =
  (context) =>
  async (method, path, init = {}) => {
    const response = await context.request.fetch(`${base}${path}`, {
      method,
      headers: { origin: base, ...init.headers },
      ...(init.data === undefined ? {} : { data: init.data }),
    });
    return { status: response.status(), body: await response.json() };
  };
const ok = async (result) => {
  const { status, body } = await result;
  assert(status < 300, `API answered ${status}: ${JSON.stringify(body)}`);
  return body.data;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  page.screenshot({ path: join(output, `${name}.png`) });
const pause = (page, ms = 700) => page.waitForTimeout(ms);
const moveTo = async (page, locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box, "The target is not visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 25,
  });
  await pause(page, 250);
};
const click = async (page, locator) => {
  await moveTo(page, locator);
  await locator.click();
  await pause(page);
};
const choose = async (page, button, file) => {
  await moveTo(page, button);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    button.click(),
  ]);
  await chooser.setFiles(file);
};
// The rendered image: loaded, not broken, and served from `url`.
const rendered = async (image, url) => {
  await image.waitFor();
  await image.evaluate((element) =>
    element.complete && element.naturalWidth > 0
      ? undefined
      : new Promise((done, fail) => {
          element.addEventListener("load", done, { once: true });
          element.addEventListener("error", fail, { once: true });
        }),
  );
  const facts = await image.evaluate((element) => ({
    src: element.getAttribute("src"),
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  }));
  assert.equal(facts.src, url, "The image shows another URL.");
  assert(facts.naturalWidth > 0, "The image did not decode.");
  return facts;
};

// Realistic uploads: an illustrated portrait (PNG) and a workspace logo
// (JPEG), drawn in the browser so the run needs no image tools.
const artist = await browser.newPage({ viewport: { width: 256, height: 256 } });
await artist.setContent(`<body style="margin:0">
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffb74d"/><stop offset="1" stop-color="#7e57c2"/>
  </linearGradient></defs>
  <rect width="256" height="256" fill="url(#bg)"/>
  <ellipse cx="128" cy="250" rx="92" ry="70" fill="#263238"/>
  <rect x="110" y="150" width="36" height="40" fill="#f1c27d"/>
  <circle cx="128" cy="112" r="56" fill="#f1c27d"/>
  <path d="M72 108 Q74 48 128 50 Q186 48 186 108 Q170 76 128 78 Q90 78 72 108Z" fill="#3e2723"/>
  <circle cx="108" cy="114" r="6" fill="#263238"/><circle cx="150" cy="114" r="6" fill="#263238"/>
  <path d="M106 140 Q128 160 152 140" stroke="#8d4a2f" stroke-width="5" fill="none" stroke-linecap="round"/>
</svg></body>`);
const personFile = join(output, "upload-person.png");
await artist.screenshot({ path: personFile, type: "png" });
await artist.setContent(`<body style="margin:0">
<div style="width:256px;height:256px;display:grid;place-items:center;background:linear-gradient(160deg,#00897b,#1a237e);font:800 92px/1 system-ui,sans-serif;color:#fff;letter-spacing:-4px">
  <div style="text-align:center">▲<div style="font-size:40px;letter-spacing:0">ACME</div></div>
</div></body>`);
const workspaceFile = join(output, "upload-workspace.jpg");
await artist.screenshot({ path: workspaceFile, type: "jpeg", quality: 90 });
const svgFile = join(output, "upload-rejected.svg");
writeFileSync(
  svgFile,
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
);
await artist.close();

const owner = await newContext("owner");
await owner.addInitScript(pointer);
await signIn(owner, { email, password });
const ownerApi = apiFor(owner);
const summary = { base, steps };
const stamp = Date.now().toString(36);
let workspace = (await ok(ownerApi("GET", "/v1/settings/personal"))).workspace;
if (workspace === undefined) {
  workspace = await ok(
    ownerApi("POST", "/v1/settings/workspaces", {
      data: { displayName: "Acme Engineering", shortName: `acme-${stamp}` },
    }),
  );
  summary.createdWorkspace = workspace.shortName;
}
assert(
  workspace !== undefined && ["owner", "admin"].includes(workspace.role),
  "The proof account does not administer a workspace.",
);
const slug = workspace.shortName;
// Start from no pictures, and leave none behind.
const clearPictures = () =>
  Promise.all([
    ownerApi("DELETE", "/v1/settings/personal/account/avatar"),
    ownerApi("DELETE", `/v1/settings/workspaces/${slug}/avatar`),
  ]);
summary.startedWith = {
  accountAvatarUrl:
    (await ok(ownerApi("GET", "/v1/settings/personal/account"))).avatarUrl ??
    null,
  workspaceAvatarUrl: workspace.avatarUrl ?? null,
};
await clearPictures();
const before = await ok(ownerApi("GET", "/v1/settings/personal/account"));
let memberUserId;

try {
  const page = await owner.newPage();
  watch(page, "owner");
  await page.goto(`${base}/settings`);
  const profile = page.locator(".account-profile-card");
  await profile.getByRole("heading", { name: "Profile" }).waitFor();
  await pause(page, 1200);
  await shot(page, "01-account-before.desktop");
  assert.equal(await profile.locator("img").count(), 0);
  step("account profile starts with initials and no picture", {
    initials: (await profile.locator(".account-avatar").textContent())?.trim(),
  });

  await click(page, profile.getByRole("button", { name: "Edit" }));
  const displayName = page.getByLabel("Display name");
  const typedName = `${before.displayName} draft`;
  await moveTo(page, displayName);
  await displayName.fill(typedName);
  await pause(page);
  await shot(page, "02-account-edit.desktop");

  const upload = profile.getByRole("button", { name: "Upload" });
  const putAccount = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/settings/personal/account/avatar") &&
      response.request().method() === "PUT",
  );
  await choose(page, upload, personFile);
  const put = await putAccount;
  assert.equal(put.status(), 200);
  const accountUrl = (
    await ok(ownerApi("GET", "/v1/settings/personal/account"))
  ).avatarUrl;
  assert.match(accountUrl, /^\/v1\/avatars\/users\/[^/]+\/[0-9a-f-]+\.png$/);
  const profileImage = await rendered(
    profile.locator(".account-avatar img").first(),
    accountUrl,
  );
  await pause(page, 1200);
  await shot(page, "03-account-uploaded.desktop");
  assert.equal(
    await displayName.inputValue(),
    typedName,
    "The upload dropped the unsaved name edit.",
  );
  step("Upload stores the picture and shows it while the name draft stays", {
    avatarUrl: accountUrl,
    image: profileImage,
  });

  const served = await owner.request.get(`${base}${accountUrl}`);
  assert.equal(served.status(), 200);
  assert.equal(served.headers()["content-type"], "image/png");
  const uploadedHash = sha256(readFileSync(personFile));
  assert.equal(sha256(await served.body()), uploadedHash);
  const apiAccount = await ok(ownerApi("GET", "/v1/settings/personal/account"));
  assert.equal(apiAccount.avatarUrl, accountUrl);
  step("the API and the served bytes match the upload", {
    sha256: uploadedHash,
    contentType: served.headers()["content-type"],
  });

  await choose(page, upload, svgFile);
  await profile
    .getByText("Choose a PNG, JPEG, or WebP image up to 512 KB.")
    .waitFor();
  await pause(page, 1200);
  await shot(page, "04-account-rejected.desktop");
  assert.equal(
    (await ok(ownerApi("GET", "/v1/settings/personal/account"))).avatarUrl,
    accountUrl,
  );
  await rendered(profile.locator(".account-avatar img").first(), accountUrl);
  step("an SVG is refused with a message and the picture stays");

  await click(page, profile.getByRole("button", { name: "Cancel" }));
  await page.reload();
  await rendered(
    page.locator(".account-profile-card .account-avatar img"),
    accountUrl,
  );
  await pause(page, 1000);
  await shot(page, "05-account-reloaded.desktop");
  assert.equal(
    (await ok(ownerApi("GET", "/v1/settings/personal/account"))).displayName,
    before.displayName,
    "Cancel saved the name draft.",
  );
  step("after a reload the profile card still shows the picture");

  await click(page, page.getByRole("button", { name: "Close settings" }));
  const sidebarImage = await rendered(
    page.locator(".sidebar-account-avatar img"),
    accountUrl,
  );
  await moveTo(page, page.locator(".sidebar-account-avatar"));
  await pause(page, 1000);
  await page.mouse.move(720, 300, { steps: 15 });
  await pause(page, 500);
  await shot(page, "05b-sidebar.desktop");
  await page.locator(".sidebar-account-row").screenshot({
    path: join(output, "05c-sidebar-row.zoom.png"),
    scale: "device",
  });
  step("closing settings, the sidebar account row shows the picture", {
    sidebar: sidebarImage,
  });

  // Workspace picture, as its owner.
  await page.goto(`${base}/workspaces/${slug}`);
  const card = page.locator("section.settings-card", {
    has: page.getByRole("heading", { name: "Workspace profile" }),
  });
  await card.waitFor();
  await pause(page, 1000);
  await shot(page, "06-workspace-before.desktop");
  assert.equal(await card.locator("img").count(), 0);
  await click(page, card.getByRole("button", { name: "Edit" }));
  const putWorkspace = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/v1/settings/workspaces/${slug}/avatar`) &&
      response.request().method() === "PUT",
  );
  await choose(
    page,
    card.getByRole("button", { name: "Upload" }),
    workspaceFile,
  );
  const workspacePut = await putWorkspace;
  assert.equal(workspacePut.status(), 200);
  const workspaceData = await ok(
    ownerApi("GET", `/v1/settings/workspaces/${slug}`),
  );
  const workspaceUrl = workspaceData.avatarUrl;
  assert.match(
    workspaceUrl,
    /^\/v1\/avatars\/workspaces\/[^/]+\/[0-9a-f-]+\.jpg$/,
  );
  assert.equal(workspaceData.revision, workspace.revision);
  const markImage = await rendered(
    card.locator(".settings-workspace-mark img"),
    workspaceUrl,
  );
  await rendered(
    page.locator(".settings-scope-link .settings-workspace-mark img"),
    workspaceUrl,
  );
  await pause(page, 1200);
  await shot(page, "07-workspace-uploaded.desktop");
  const workspaceServed = await owner.request.get(`${base}${workspaceUrl}`);
  assert.equal(workspaceServed.headers()["content-type"], "image/jpeg");
  assert.equal(
    sha256(await workspaceServed.body()),
    sha256(readFileSync(workspaceFile)),
  );
  step(
    "an owner uploads the workspace picture; the card and switcher show it",
    {
      avatarUrl: workspaceUrl,
      image: markImage,
      revisionUnchanged: workspaceData.revision,
    },
  );

  await click(page, card.getByRole("button", { name: "Cancel" }));
  await click(page, page.getByRole("link", { name: "Members" }).first());
  const ownerRow = page.locator(".members-person", { hasText: email });
  await rendered(ownerRow.locator(".members-avatar img"), accountUrl);
  await pause(page, 1200);
  await shot(page, "08-members.desktop");
  step("the Members list shows the owner's own picture");

  // A plain member sees the workspace picture and cannot change it.
  const memberAccount =
    process.env.DX_PROOF_MEMBER_EMAIL === undefined
      ? {
          email: `avatar-proof-${stamp}@example.com`,
          password: `Proof-${stamp}-${Math.random().toString(36).slice(2)}`,
        }
      : {
          email: process.env.DX_PROOF_MEMBER_EMAIL,
          password: process.env.DX_PROOF_MEMBER_PASSWORD,
        };
  secrets.push(memberAccount.password);
  const member = await newContext("member");
  await member.addInitScript(pointer);
  if (process.env.DX_PROOF_MEMBER_EMAIL === undefined) {
    const link = await ok(
      ownerApi("POST", `/v1/settings/workspaces/${slug}/invite-links`, {
        data: { title: `avatar-proof-${stamp}` },
      }),
    );
    const token = new URL(link.url).pathname.split("/").at(-1);
    const signUp = await member.request.post(`${base}/api/auth/sign-up/email`, {
      headers: { origin: base },
      data: { ...memberAccount, name: "Avatar Proof Member" },
    });
    if (signUp.status() === 200) {
      await signIn(member, memberAccount);
      await ok(apiFor(member)("POST", `/v1/invites/${token}/accept`));
    } else {
      summary.memberSkipped = `Member sign-up answered ${signUp.status()}.`;
    }
    await ok(
      ownerApi(
        "DELETE",
        `/v1/settings/workspaces/${slug}/invite-links/${link.id}`,
      ),
    );
  } else {
    await signIn(member, memberAccount);
  }
  if (summary.memberSkipped === undefined) {
    const memberApi = apiFor(member);
    const memberView = await ok(memberApi("GET", "/v1/settings/personal"));
    memberUserId = (await ok(memberApi("GET", "/v1/settings/personal/account")))
      .username;
    assert.equal(memberView.workspace.role, "member");
    const memberPage = await member.newPage();
    watch(memberPage, "member");
    await memberPage.goto(`${base}/workspaces/${slug}`);
    const memberCard = memberPage.locator("section.settings-card", {
      has: memberPage.getByRole("heading", { name: "Workspace profile" }),
    });
    await rendered(
      memberCard.locator(".settings-workspace-mark img"),
      workspaceUrl,
    );
    assert.equal(
      await memberCard.getByRole("button", { name: "Edit" }).count(),
      0,
    );
    await moveTo(memberPage, memberCard.locator(".settings-workspace-mark"));
    await pause(memberPage, 1200);
    await shot(memberPage, "09-member-view.desktop");
    const refused = await memberApi(
      "PUT",
      `/v1/settings/workspaces/${slug}/avatar`,
      {
        headers: { "content-type": "image/png" },
        data: readFileSync(personFile),
      },
    );
    assert.equal(refused.status, 403);
    const refusedDelete = await memberApi(
      "DELETE",
      `/v1/settings/workspaces/${slug}/avatar`,
    );
    assert.equal(refusedDelete.status, 403);
    step(
      "a member sees the workspace picture, has no Edit, and the API refuses",
      {
        put: refused.status,
        delete: refusedDelete.status,
        code: refused.body.data.code,
      },
    );
  }

  const outsider = await browser.newContext();
  const anonymous = await outsider.request.get(`${base}${workspaceUrl}`);
  assert.equal(anonymous.status(), 401);
  await outsider.close();
  step("a signed-out request for the picture is refused", {
    status: anonymous.status(),
  });

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: await owner.storageState(),
  });
  const phone = await mobile.newPage();
  watch(phone, "owner");
  await phone.goto(`${base}/settings`);
  await rendered(
    phone.locator(".account-profile-card .account-avatar img"),
    accountUrl,
  );
  await phone.getByRole("button", { name: "Edit" }).click();
  await phone.getByRole("button", { name: "Remove" }).waitFor();
  await shot(phone, "10-account-edit.mobile");
  await mobile.close();
  step("the mobile profile editor shows the picture with Upload and Remove");

  // Remove both, through the UI.
  await page.goto(`${base}/workspaces/${slug}`);
  await card.waitFor();
  await click(page, card.getByRole("button", { name: "Edit" }));
  await click(page, card.getByRole("button", { name: "Remove" }));
  await card
    .locator(".settings-workspace-mark img")
    .waitFor({ state: "detached" });
  await pause(page, 1000);
  await shot(page, "11-workspace-removed.desktop");
  assert.equal(
    (await ok(ownerApi("GET", `/v1/settings/workspaces/${slug}`))).avatarUrl,
    undefined,
  );
  assert.equal(
    (await owner.request.get(`${base}${workspaceUrl}`)).status(),
    404,
  );
  await click(page, card.getByRole("button", { name: "Cancel" }));
  step("Remove returns the workspace to initials; the old URL answers 404");

  await page.goto(`${base}/settings`);
  await click(page, profile.getByRole("button", { name: "Edit" }));
  await click(page, profile.getByRole("button", { name: "Remove" }));
  await profile.locator(".account-avatar img").waitFor({ state: "detached" });
  await page
    .locator(".sidebar-account-avatar img")
    .waitFor({ state: "detached" });
  await click(page, profile.getByRole("button", { name: "Cancel" }));
  await pause(page, 1000);
  await shot(page, "12-account-removed.desktop");
  assert.equal(
    (await ok(ownerApi("GET", "/v1/settings/personal/account"))).avatarUrl,
    undefined,
  );
  assert.equal((await owner.request.get(`${base}${accountUrl}`)).status(), 404);
  step("Remove returns the account to initials; the old URL answers 404");

  const memberRow = (
    await ok(ownerApi("GET", `/v1/settings/workspaces/${slug}/members`))
  ).members.find((entry) => entry.email === memberAccount.email);
  if (process.env.DX_PROOF_MEMBER_EMAIL === undefined && memberRow) {
    await ok(
      ownerApi(
        "DELETE",
        `/v1/settings/workspaces/${slug}/members/${memberRow.userId}`,
      ),
    );
  }
  await member.close();
  summary.member = memberUserId;
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await clearPictures().catch(() => undefined);
  await owner.close();
  await browser.close();
  const unexpected = consoleMessages.filter(
    ({ type }) => type === "error" || type === "warning",
  );
  summary.consoleErrors = unexpected.length;
  summary.pageErrors = pageErrors;
  let text = JSON.stringify({ summary, console: consoleMessages }, null, 2);
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  writeFileSync(join(output, "console.json"), text);
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  for (const path of harPaths) {
    if (!existsSync(path)) continue;
    let har = readFileSync(path, "utf8");
    for (const secret of secrets) har = har.replaceAll(secret, "[redacted]");
    writeFileSync(path, har);
  }
}
