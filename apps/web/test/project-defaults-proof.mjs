// Project Defaults journey against a running `pnpm dev` (local) or a branch
// preview. Creates a personal and a workspace project first, then saves new
// personal and workspace defaults through the settings pages and checks over
// the API that new projects take them while the earlier projects keep their
// own configuration. Checks that Save Defaults is enabled only while something
// changed and that leaving with unsaved edits asks first. Writes desktop
// (1440) and mobile (390) screenshots, a HAR without bodies, console.json,
// and summary.json to <output>, then restores the original defaults.
//
//   node apps/web/test/project-defaults-proof.mjs http://127.0.0.1:3000 out/
//
// dx has no project deletion, so the projects it creates stay, named
// `defaults-proof-*`. The workspace half runs only when the account owns or
// administers a workspace.
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
const personalPath = "/v1/settings/personal/projects";
const stamp = Date.now().toString(36);
const createProject = (name, workspaceSlug) =>
  api("POST", "/v1/projects", {
    name: `defaults-proof-${name}-${stamp}`,
    ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
  });
const projectConfiguration = async (id) =>
  (await api("GET", `/v1/projects/${id}`)).configuration;

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

const { workspace } = await api("GET", "/v1/settings/personal");
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const workspacePath =
  workspaceSlug === undefined
    ? undefined
    : `/v1/settings/workspaces/${workspaceSlug}/projects`;
const originalPersonal = await api("GET", personalPath);
const originalWorkspace =
  workspacePath === undefined ? undefined : await api("GET", workspacePath);

/** An available size that differs from what new projects get today. */
const otherSize = (defaults, avoid = []) => {
  const allowed = defaults.restrictions.allowedRunnerProfileIds;
  const profile = defaults.catalog.profiles.find(
    ({ id, availability }) =>
      availability === "available" &&
      id !== defaults.resolved.runnerProfileId.value &&
      !avoid.includes(id) &&
      (allowed === null || allowed.includes(id)),
  );
  assert(profile, "The catalog has no second available Orb size.");
  return profile;
};
const saveDefaults = async (page) => {
  const save = page.getByRole("button", { name: "Save Defaults" });
  assert(await save.isEnabled(), "Save Defaults is disabled after a change.");
  await save.click();
  await page.getByText("Project defaults saved for new projects.").waitFor();
  assert(await save.isDisabled(), "Save Defaults stays enabled after saving.");
};
const shot = (page, name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const summary = { base, workspace: workspaceSlug ?? null, steps };
try {
  const existingPersonal = await createProject("existing-personal");
  const existingWorkspace =
    workspaceSlug === undefined
      ? undefined
      : await createProject("existing-workspace", workspaceSlug);
  step("created projects before changing defaults", {
    personal: existingPersonal.configuration,
    workspace: existingWorkspace?.configuration ?? null,
  });

  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/settings/projects`);
  await page.getByRole("heading", { name: "Project Defaults" }).waitFor();
  await page.getByRole("radiogroup").first().waitFor();
  assert(
    (await page.getByRole("link", { name: "Project Defaults" }).count()) > 0,
    "Project Defaults is missing from the personal menu.",
  );
  const save = page.getByRole("button", { name: "Save Defaults" });
  assert(await save.isDisabled(), "Save Defaults is enabled before a change.");
  await shot(page, "01-personal.desktop");
  step("personal page shows the menu item; Save Defaults starts disabled");

  const personalSize = otherSize(originalPersonal);
  const personalAuthor =
    originalPersonal.resolved.commitAuthor.value === "dx" ? "user" : "dx";
  await page
    .getByRole("radiogroup", { name: "Default Orb size" })
    .locator("label", { hasText: personalSize.label })
    .click();
  await page
    .getByRole("combobox", { name: "Default commit author" })
    .selectOption(personalAuthor);
  assert(
    await save.isEnabled(),
    "Save Defaults stays disabled after a change.",
  );
  await shot(page, "02-personal-changed.desktop");
  step("a change enables Save Defaults", {
    runnerProfileId: personalSize.id,
    commitAuthor: personalAuthor,
  });

  await page.getByRole("link", { name: "Account" }).first().click();
  await page.getByText("Discard unsaved changes?").waitFor();
  await shot(page, "03-unsaved-guard.desktop");
  await page.getByRole("button", { name: "Stay on page" }).click();
  await page.getByRole("heading", { name: "Project Defaults" }).waitFor();
  step("leaving with unsaved edits asks first");

  await saveDefaults(page);
  await shot(page, "04-personal-saved.desktop");
  const savedPersonal = await api("GET", personalPath);
  assert.equal(savedPersonal.overrides.runnerProfileId, personalSize.id);
  assert.equal(savedPersonal.overrides.commitAuthor, personalAuthor);
  step("personal defaults saved on the server", {
    overrides: savedPersonal.overrides,
  });

  const newPersonal = await createProject("new-personal");
  assert.equal(newPersonal.configuration.runnerProfileId, personalSize.id);
  assert.equal(
    newPersonal.configuration.commitAuthor.preference,
    personalAuthor,
  );
  assert.deepEqual(
    await projectConfiguration(existingPersonal.id),
    existingPersonal.configuration,
    "The earlier personal project changed.",
  );
  step(
    "a new personal project takes the defaults; the earlier one keeps its own",
    {
      newProject: newPersonal.configuration,
    },
  );

  if (workspaceSlug !== undefined) {
    await page.goto(`${base}/workspaces/${workspaceSlug}/projects`);
    await page.getByRole("heading", { name: "Project Defaults" }).waitFor();
    await page.getByRole("radiogroup").first().waitFor();
    assert.equal(
      await page
        .getByRole("combobox", { name: "Default commit author" })
        .count(),
      0,
      "The workspace page shows a commit author default.",
    );
    await shot(page, "05-workspace.desktop");
    const workspaceDefaults = await api("GET", workspacePath);
    if (originalWorkspace.overrides.runnerProfileId === null) {
      // With no workspace size saved, the creator's personal size does not
      // apply: the page and new workspace projects use the deployment default.
      const deploymentDefault = workspaceDefaults.catalog.profiles.find(
        ({ id }) => id === workspaceDefaults.catalog.defaultProfileId,
      );
      assert(deploymentDefault, "The catalog default is not in the catalog.");
      assert.notEqual(deploymentDefault.id, personalSize.id);
      assert(
        await page
          .getByRole("radiogroup", { name: "Default Orb size" })
          .locator("label", { hasText: deploymentDefault.label })
          .locator("input")
          .isChecked(),
        "The workspace page does not show the deployment default.",
      );
      const unsetWorkspace = await createProject(
        "unset-workspace",
        workspaceSlug,
      );
      assert.equal(
        unsetWorkspace.configuration.runnerProfileId,
        deploymentDefault.id,
        "A workspace project took the creator's personal Orb size.",
      );
      step(
        "with no workspace size saved, the workspace page and a new workspace project use the deployment default",
        { unsetWorkspaceProject: unsetWorkspace.configuration },
      );
    }
    // Differ from the personal default and from what the earlier project got,
    // so each comparison below can fail.
    const workspaceSize = otherSize(workspaceDefaults, [
      personalSize.id,
      existingWorkspace.configuration.runnerProfileId,
    ]);
    await page
      .getByRole("radiogroup", { name: "Default Orb size" })
      .locator("label", { hasText: workspaceSize.label })
      .click();
    await saveDefaults(page);
    await shot(page, "06-workspace-saved.desktop");
    const savedWorkspace = await api("GET", workspacePath);
    assert.equal(savedWorkspace.overrides.runnerProfileId, workspaceSize.id);
    assert.deepEqual(
      savedWorkspace.policy,
      originalWorkspace.policy,
      "Saving defaults changed workspace policy.",
    );
    step("workspace defaults saved; policy untouched", {
      overrides: savedWorkspace.overrides,
    });

    const newWorkspace = await createProject("new-workspace", workspaceSlug);
    assert.equal(newWorkspace.configuration.runnerProfileId, workspaceSize.id);
    assert.deepEqual(
      await projectConfiguration(existingWorkspace.id),
      existingWorkspace.configuration,
      "The earlier workspace project changed.",
    );
    const laterPersonal = await createProject("later-personal");
    assert.equal(
      laterPersonal.configuration.runnerProfileId,
      personalSize.id,
      "Workspace defaults reached a personal project.",
    );
    step(
      "a new workspace project takes the workspace default; the earlier one and new personal projects do not",
      {
        newWorkspaceProject: newWorkspace.configuration,
        laterPersonalProject: laterPersonal.configuration,
      },
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
  await phone.goto(`${base}/settings/projects`);
  await phone.getByRole("radiogroup").first().waitFor();
  await shot(phone, "07-personal.mobile");
  if (workspaceSlug !== undefined) {
    await phone.goto(`${base}/workspaces/${workspaceSlug}/projects`);
    await phone.getByRole("radiogroup").first().waitFor();
    await shot(phone, "08-workspace.mobile");
  }
  await mobile.close();
  step("mobile pages rendered");
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  const restorePersonal = await api("GET", personalPath);
  await api("PUT", personalPath, {
    expectedRevision: restorePersonal.revision,
    overrides: originalPersonal.overrides,
  });
  if (workspacePath !== undefined) {
    const restoreWorkspace = await api("GET", workspacePath);
    await api("PUT", workspacePath, {
      expectedRevision: restoreWorkspace.revision,
      overrides: originalWorkspace.overrides,
      policy: originalWorkspace.policy,
    });
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
