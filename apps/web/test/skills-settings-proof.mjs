// Skills journey against a running `pnpm dev` (local) or a branch preview.
// Through the settings pages it creates a skill with New Skill, edits it into
// version 2, imports a skill folder after reviewing it, uploads a new version
// of that folder, switches and pins versions, exports a skill and imports the
// export back, and checks a new Thread resolves the active version of every
// enabled skill. Writes desktop (1440) and mobile (390) screenshots, a HAR
// without bodies or credentials, console.json, and summary.json to <output>,
// then removes the skills it created.
//
//   node apps/web/test/skills-settings-proof.mjs http://127.0.0.1:3000 out/
//
// The workspace half runs only when the account owns or administers a
// workspace: it adds a workspace skill with the personal skill's name and
// checks a new Thread loads the personal one, then blocks personal skills and
// checks the workspace one loads instead. DX_PROOF_ASK=1 also sends the new Thread a message and waits
// for the reply to quote the skill's codeword; that needs a real model, so it
// is for the branch preview only. dx has no project deletion, so the project
// it creates for the Thread stays, named `skills-proof-*`.
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CDP connects to an existing
// Chromium instead of launching headless; DX_PROOF_CHROMIUM picks the binary.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    ? await chromium.launch({
        executablePath: process.env.DX_PROOF_CHROMIUM,
      })
    : await chromium.connectOverCDP(process.env.DX_PROOF_CDP);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  acceptDownloads: true,
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
// The sidebar's account row shows the signed-in email; keep it out of shots.
const shot = (page, name) =>
  page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    mask: [page.locator(".sidebar-account-shell")],
  });

const personalPath = "/v1/settings/personal/skills";
const { workspace } = await api("GET", "/v1/settings/personal");
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const workspacePath =
  workspaceSlug === undefined
    ? undefined
    : `/v1/settings/workspaces/${workspaceSlug}/skills`;
const originalWorkspace =
  workspacePath === undefined ? undefined : await api("GET", workspacePath);

const stamp = Date.now().toString(36);
const authored = `proof-notes-${stamp}`;
const imported = `proof-checklist-${stamp}`;
const codeword = `PELICAN-${stamp.toUpperCase()}`;
const created = [];
const createdInWorkspace = [];

/** A skill folder on disk, as a person would pick it. */
const skillFolder = (description, instructions) => {
  const root = join(mkdtempSync(join(tmpdir(), "skills-proof-")), imported);
  mkdirSync(join(root, "resources"), { recursive: true });
  writeFileSync(
    join(root, "skill.json"),
    JSON.stringify({ schemaVersion: 1, name: imported, description }),
  );
  writeFileSync(join(root, "instructions.md"), instructions);
  writeFileSync(
    join(root, "resources", "checklist.md"),
    "- Tests pass\n- Changelog updated\n",
  );
  return root;
};
const listed = async (path = personalPath) => (await api("GET", path)).items;
const find = async (name, path = personalPath) =>
  (await listed(path)).find((skill) => skill.name === name);
const row = (page, name) => page.locator(".skill-row", { hasText: name });
const status = (page, text) =>
  page.locator(".skills-heading-actions > span", { hasText: text }).waitFor();
const focusedLabel = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const openSettings = async (page, name) => {
  await page.getByRole("button", { name: `${name} settings` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return dialog;
};

const summary = { base, workspace: workspaceSlug ?? null, steps };
try {
  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/settings/skills`);
  await page.getByRole("heading", { name: "Personal Skills" }).waitFor();
  await page.locator(".skills-page .settings-card").waitFor();
  assert(
    (await page.getByRole("link", { name: "Skills" }).count()) > 0,
    "Skills is missing from the personal menu.",
  );
  const before = await listed();
  if (before.length === 0) {
    await page.getByText("No personal skills yet.").waitFor();
    await shot(page, "01-personal-empty.desktop");
  } else {
    await shot(page, "01-personal-existing.desktop");
  }
  step("personal page shows the menu item and its list", {
    existingSkills: before.length,
  });

  // New Skill: saving publishes it, switched on.
  await page.getByRole("button", { name: "New Skill" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("Not Kebab");
  await form.getByText("Use lowercase letters").waitFor();
  assert(await form.getByRole("button", { name: "Save" }).isDisabled());
  await form.getByLabel("Name").fill(authored);
  await form.getByLabel("Description").fill("Writes release notes.");
  await form
    .getByLabel("Instructions")
    .fill(`Start every set of release notes with ${codeword}-1.`);
  await shot(page, "02-new-skill.desktop");
  const skillWrites = [];
  const recordWrite = (request) => {
    if (
      request.url().includes("/skills") &&
      !request.url().endsWith("/preview") &&
      request.method() !== "GET"
    ) {
      skillWrites.push(
        `${request.method()} ${new URL(request.url()).pathname}`,
      );
    }
  };
  page.on("request", recordWrite);
  await form.getByRole("button", { name: "Save" }).click();
  await status(page, `${authored} published.`);
  page.off("request", recordWrite);
  const first = await find(authored);
  created.push(first.id);
  assert.equal(first.enabled, true, "A new skill was saved switched off.");
  assert.equal(first.activeVersion, 1);
  assert.deepEqual(
    skillWrites,
    ["POST /v1/settings/personal/skills"],
    "New Skill took more than one write.",
  );
  step("New Skill publishes version 1, switched on, in one write", {
    id: first.id,
  });

  // A second skill with that name is refused on the Name field.
  await page.getByRole("button", { name: "New Skill" }).click();
  const duplicate = page.getByRole("dialog");
  await duplicate.getByLabel("Name").fill(authored);
  await duplicate.getByLabel("Description").fill("Duplicate.");
  await duplicate.getByLabel("Instructions").fill("Duplicate.");
  await duplicate.getByRole("button", { name: "Save" }).click();
  await duplicate
    .locator(".skill-field-error", {
      hasText: `A skill named ${authored} already exists here.`,
    })
    .waitFor();
  assert.equal(
    await duplicate.getByText("skill.json:").count(),
    0,
    "The name clash names the manifest file.",
  );
  await shot(page, "02b-duplicate-name.desktop");
  await page.keyboard.press("Escape");
  await duplicate.waitFor({ state: "detached" });
  step("a second skill with the same name is refused on the Name field");

  // Edit publishes version 2 and makes it active.
  let dialog = await openSettings(page, authored);
  await dialog.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  assert(await edit.getByLabel("Name").isDisabled(), "Edit can rename.");
  await edit
    .getByLabel("Instructions")
    .fill(`Start every set of release notes with ${codeword}.`);
  await edit.getByRole("button", { name: "Save" }).click();
  await status(page, `${authored} version 2 published.`);
  assert.equal(
    await focusedLabel(page),
    `${authored} settings`,
    "Focus did not return to the skill's gear after Edit.",
  );
  const second = await find(authored);
  assert.equal(second.activeVersion, 2);
  assert.match(second.active.instructions, new RegExp(`${codeword}\\.$`));
  await row(page, authored).getByText("v2").waitFor();
  step("Edit publishes and activates version 2; focus returns to the gear");

  // Import a folder: preview, review, import (switched off), switch on.
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose folder" }).click();
  await (await chooser).setFiles(
    skillFolder("Checks a release.", "Walk the release checklist."),
  );
  dialog = page.getByRole("dialog");
  await dialog.getByText("Review skill import").waitFor();
  await dialog.getByText("resources/checklist.md").waitFor({
    state: "attached",
  });
  await shot(page, "03-import-review.desktop");
  await dialog.getByRole("button", { name: "Import reviewed skill" }).click();
  await status(page, `${imported} imported.`);
  let folder = await find(imported);
  created.push(folder.id);
  assert.equal(folder.enabled, false);
  assert.deepEqual(
    folder.active.resources.map(({ path }) => path),
    ["resources/checklist.md"],
  );
  await row(page, imported)
    .getByRole("button", { name: `${imported} off` })
    .click();
  await status(page, `${imported} turned on.`);
  assert.equal(
    await focusedLabel(page),
    `${imported} on`,
    "The switch lost keyboard focus while saving.",
  );
  step(
    "a reviewed folder imports switched off with its resource; it turns on and its switch keeps focus",
  );

  // Upload a new version of the folder from the skill's settings.
  dialog = await openSettings(page, imported);
  const versionChooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Upload version" }).click();
  await (await versionChooser).setFiles(
    skillFolder(
      "Checks a release, twice.",
      "Walk the release checklist twice.",
    ),
  );
  dialog = page.getByRole("dialog");
  await dialog.getByText(`Review ${imported} update`).waitFor();
  await dialog.getByRole("button", { name: "Publish and activate" }).click();
  await status(page, `${imported} version published.`);
  folder = await find(imported);
  assert.equal(folder.activeVersion, 2);
  step("an uploaded folder becomes version 2");

  // Switch back to version 1, pin it, and check an edit leaves it active.
  dialog = await openSettings(page, imported);
  await dialog
    .getByRole("combobox", { name: `Active version for ${imported}` })
    .selectOption("1");
  await status(page, `${imported} now uses version 1.`);
  await dialog
    .getByRole("button", { name: `Pin version 1 of ${imported}` })
    .click();
  await status(page, `${imported} pinned to version 1.`);
  assert(
    await dialog
      .getByRole("combobox", { name: `Active version for ${imported}` })
      .isDisabled(),
  );
  await shot(page, "04-skill-settings.desktop");
  await dialog.getByRole("button", { name: "Edit" }).click();
  const pinnedEdit = page.getByRole("dialog");
  await pinnedEdit.getByText("version 1 stays pinned").waitFor();
  await pinnedEdit
    .getByLabel("Description")
    .fill("Checks a release, three times.");
  await pinnedEdit.getByRole("button", { name: "Save" }).click();
  await status(page, `${imported} version 3 published.`);
  folder = await find(imported);
  assert.equal(folder.activeVersion, 1, "A pinned skill changed version.");
  assert.deepEqual([...folder.versions].sort(), [1, 2, 3]);
  dialog = await openSettings(page, imported);
  await dialog
    .getByRole("button", { name: `Pin version 1 of ${imported}` })
    .click();
  await status(page, `${imported} unpinned.`);
  await dialog
    .getByRole("combobox", { name: `Active version for ${imported}` })
    .selectOption("3");
  await status(page, `${imported} now uses version 3.`);
  folder = await find(imported);
  assert.equal(folder.activeVersion, 3);
  assert.deepEqual(
    folder.active.resources.map(({ path }) => path),
    ["resources/checklist.md"],
    "An edit dropped the skill's resource files.",
  );
  step(
    "versions switch; a pinned version stays active while an edit publishes version 3 with its files",
  );

  // Export, remove, and import the export back.
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export" }).click();
  const download = await downloading;
  const exportPath = join(output, "export.skill.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  assert.deepEqual(exported.files.map(({ path }) => path).sort(), [
    "instructions.md",
    "resources/checklist.md",
    "skill.json",
  ]);
  assert.equal(exported.integrity, folder.active.integrity);
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: `Remove ${imported}?` }).click();
  await status(page, `${imported} removed.`);
  assert.equal(await find(imported), undefined);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const exportChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose .skill.json" }).click();
  await (await exportChooser).setFiles(exportPath);
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Import reviewed skill" }).click();
  await status(page, `${imported} imported.`);
  folder = await find(imported);
  created.push(folder.id);
  assert.equal(folder.active.integrity, exported.integrity);
  await api("PATCH", `${personalPath}/${folder.id}`, { enabled: true });
  await page.reload();
  await row(page, imported).waitFor();
  await shot(page, "05-personal-list.desktop");
  step("an export downloads, and imports back with the same integrity", {
    integrity: exported.integrity,
  });

  // A new Thread resolves the active version of each enabled skill.
  const project = await api("POST", "/v1/projects", {
    name: `skills-proof-${stamp}`,
  });
  const thread = await api("POST", "/v1/threads", {
    projectId: project.id,
    title: `Skills proof ${stamp}`,
  });
  const resolved = (await api("GET", `/v1/threads/${thread.id}`))
    .agentInitialization.skills;
  const resolvedNames = resolved.map(
    ({ name, version }) => `${name}@${version}`,
  );
  assert(resolvedNames.includes(`${authored}@2`), resolvedNames.join(", "));
  assert(resolvedNames.includes(`${imported}@1`), resolvedNames.join(", "));
  assert.match(
    resolved.find(({ name }) => name === authored).instructions,
    new RegExp(codeword),
  );
  await page.goto(`${base}/threads/${thread.id}`);
  await page.getByLabel("Resolved skill versions").waitFor();
  await shot(page, "06-thread-resolved-skills.desktop");
  step("a new Thread loads the active version of each enabled skill", {
    threadId: thread.id,
    resolved: resolvedNames,
  });
  if (process.env.DX_PROOF_ASK === "1") {
    const textbox = page.getByRole("textbox", { name: "Message" });
    await textbox.fill(
      "Write a one-line release note for a fix to the sign-in page.",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await page
      .locator("main")
      .getByText(codeword)
      .first()
      .waitFor({ timeout: 180_000 });
    await shot(page, "07-thread-uses-skill.desktop");
    step("the Thread's reply follows the skill and quotes its codeword", {
      codeword,
    });
  }

  if (workspaceSlug !== undefined) {
    await page.goto(`${base}/settings/skills`);
    await page.getByRole("link", { name: "Workspace Skills" }).click();
    await page.getByRole("heading", { name: "Workspace Skills" }).waitFor();
    await page.locator(".skills-page .settings-card").first().waitFor();
    await shot(page, "08-workspace.desktop");

    // A workspace skill with the personal skill's name: the personal one wins.
    await page.getByRole("button", { name: "New Skill" }).click();
    const workspaceForm = page.getByRole("dialog");
    await workspaceForm.getByLabel("Name").fill(authored);
    await workspaceForm
      .getByLabel("Description")
      .fill("The workspace's release notes.");
    await workspaceForm
      .getByLabel("Instructions")
      .fill("Start every set of release notes with WORKSPACE-NOTES.");
    await workspaceForm.getByRole("button", { name: "Save" }).click();
    await status(page, `${authored} published.`);
    const workspaceTwin = await find(authored, workspacePath);
    createdInWorkspace.push(workspaceTwin.id);
    assert.equal(workspaceTwin.effectiveState, "replaced-by-personal");
    await row(page, authored)
      .getByText("Replaced by your personal skill")
      .waitFor();
    await shot(page, "08b-workspace-replaced.desktop");
    const resolvedFor = async (title) => {
      const created = await api("POST", "/v1/threads", {
        projectId: project.id,
        title: `${title} ${stamp}`,
      });
      return (
        await api("GET", `/v1/threads/${created.id}`)
      ).agentInitialization.skills
        .filter(({ name }) => name === authored)
        .map(({ scope, version }) => `${scope}@${version}`);
    };
    assert.deepEqual(await resolvedFor("Precedence"), ["personal@2"]);
    step(
      "a personal skill replaces the workspace skill with the same name in a new Thread",
    );

    const policy = page.getByRole("button", {
      name: "Members can use personal skills",
    });
    await policy.click();
    await status(page, "Members' personal skills are blocked.");
    assert.equal((await api("GET", workspacePath)).allowPersonalSkills, false);
    assert.equal(
      (await find(authored)).effectiveState,
      "blocked-by-policy",
      "The policy did not reach personal skills.",
    );
    await page.goto(`${base}/settings/skills`);
    await row(page, authored)
      .getByText("Blocked by workspace policy")
      .waitFor();
    await shot(page, "09-personal-blocked.desktop");
    assert.deepEqual(
      await resolvedFor("Policy"),
      ["workspace@1"],
      "With personal skills blocked, the workspace skill did not load.",
    );
    await api("PATCH", `${workspacePath}/policy`, {
      allowPersonalSkills: originalWorkspace.allowPersonalSkills,
    });
    step(
      "the workspace page opens from the switch; its policy blocks personal skills, and the workspace skill loads instead",
    );
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
  await phone.goto(`${base}/settings/skills`);
  await row(phone, authored).waitFor();
  await shot(phone, "10-personal.mobile");
  await phone.getByRole("button", { name: `${authored} settings` }).click();
  await phone.getByRole("dialog").waitFor();
  await shot(phone, "11-skill-settings.mobile");
  await phone.keyboard.press("Escape");
  await phone.getByRole("button", { name: "New Skill" }).click();
  await phone.getByRole("dialog").waitFor();
  await shot(phone, "12-new-skill.mobile");
  await phone.keyboard.press("Escape");
  if (workspaceSlug !== undefined) {
    await phone.goto(`${base}/workspaces/${workspaceSlug}/skills`);
    await phone.locator(".skills-page .settings-card").first().waitFor();
    await shot(phone, "13-workspace.mobile");
  }
  await mobile.close();
  step("mobile pages and dialogs rendered");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  for (const id of created) {
    await api("DELETE", `${personalPath}/${id}`).catch(() => undefined);
  }
  for (const id of createdInWorkspace) {
    await api("DELETE", `${workspacePath}/${id}`).catch(() => undefined);
  }
  if (workspacePath !== undefined) {
    await api("PATCH", `${workspacePath}/policy`, {
      allowPersonalSkills: originalWorkspace.allowPersonalSkills,
    });
  }
  summary.cleanedUp = true;
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
