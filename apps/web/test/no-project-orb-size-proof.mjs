// No Project Orb size journey against a running `pnpm dev` (local) or a
// branch preview. In a workspace, a No Project Thread starts on the person's
// own Orb size, then the workspace's, then the deployment default. Sets a
// workspace size W and a personal size P, then checks that the new-Thread
// composer with No Project shows P and that a No Project Thread created over
// the API (no size requested) records P. Clears P and checks the composer
// falls back to W. Writes desktop (1440) and mobile (390) screenshots, a HAR
// without bodies, console.json, and summary.json to <output>, then restores
// the original defaults.
//
//   node apps/web/test/no-project-orb-size-proof.mjs http://127.0.0.1:3000 out/
//
// The account must own or administer a workspace (the run creates one when
// the account has none) and must have no remembered composer Orb size, which
// would take precedence over every default. The catalog needs three available
// sizes. The run leaves one Thread, `no-project-orb-proof-*`, and the
// composer's project choice set to No Project. The Thread's backing No
// Project project is created once per person, so the API check runs only
// when this run creates it.
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
// The sidebar's account row shows the signed-in email.
const shot = (page, name) =>
  page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    mask: [page.locator(".sidebar-account-shell")],
  });

const stamp = Date.now().toString(36);
let { workspace } = await api("GET", "/v1/settings/personal");
if (workspace === undefined) {
  workspace = await api("POST", "/v1/settings/workspaces", {
    displayName: "Orb Proof",
    shortName: `orb-proof-${stamp}`,
  });
  step("created a workspace for the run", { workspace: workspace.shortName });
}
assert(
  ["owner", "admin"].includes(workspace.role),
  "The account must own or administer its workspace.",
);
const personalPath = "/v1/settings/personal/projects";
const workspacePath = `/v1/settings/workspaces/${workspace.shortName}/projects`;
const composerPath = "/v1/settings/personal/account/composer";
const originalPersonal = await api("GET", personalPath);
const originalWorkspace = await api("GET", workspacePath);
const composer = await api("GET", composerPath);
assert.equal(
  composer.runnerProfileId,
  null,
  "The account has a remembered composer Orb size, which beats every default.",
);

const catalog = originalWorkspace.catalog;
const allowed = originalWorkspace.restrictions.allowedRunnerProfileIds;
const sizes = catalog.profiles.filter(
  ({ id, availability }) =>
    availability === "available" && (allowed === null || allowed.includes(id)),
);
const workspaceSize = sizes.find(({ id }) => id !== catalog.defaultProfileId);
const personalSize = sizes.find(
  ({ id }) => id !== catalog.defaultProfileId && id !== workspaceSize?.id,
);
assert(workspaceSize && personalSize, "The catalog needs three sizes.");

// The pill reads "<provider> · <size>" or just "<size>".
const composerSize = async (page) => {
  await page.goto(`${base}/new`);
  const pill = page.locator(".new-thread-orb-size").first();
  await pill.waitFor();
  // "Orb" alone is the loading state.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = (await pill.innerText()).trim();
    if (text !== "Orb") return text;
    await page.waitForTimeout(500);
  }
  return `${(await pill.innerText()).trim()} (${await pill.getAttribute("title")})`;
};

const summary = {
  base,
  workspace: workspace.shortName,
  sizes: {
    deployment: catalog.defaultProfileId,
    workspace: workspaceSize.id,
    personal: personalSize.id,
  },
  steps,
};
try {
  await api("PATCH", composerPath, { project: "none" });
  const savedWorkspace = await api("PUT", workspacePath, {
    expectedRevision: originalWorkspace.revision,
    overrides: {
      ...originalWorkspace.overrides,
      runnerProfileId: workspaceSize.id,
    },
    policy: originalWorkspace.policy,
  });
  const savedPersonal = await api("PUT", personalPath, {
    expectedRevision: originalPersonal.revision,
    overrides: {
      ...originalPersonal.overrides,
      runnerProfileId: personalSize.id,
    },
  });
  step("saved a workspace size and a different personal size", {
    workspace: savedWorkspace.overrides.runnerProfileId,
    personal: savedPersonal.overrides.runnerProfileId,
  });

  const page = await context.newPage();
  watch(page);
  const shown = await composerSize(page);
  assert(
    shown.endsWith(personalSize.label),
    `The No Project composer shows "${shown}", not ${personalSize.label}.`,
  );
  await shot(page, "01-no-project-personal.desktop");
  step("the No Project composer starts on the personal size", { shown });

  const threadResponse = await context.request.post(`${base}/v1/threads`, {
    headers: { origin: base },
    data: { title: `no-project-orb-proof-${stamp}` },
  });
  const threadBody = await threadResponse.json();
  if (threadBody.data?.code === "MODEL_NOT_SERVED") {
    // `pnpm dev -- --ui-only` serves no model, so it cannot create a Thread.
    step("skipped the API check: the deployment serves no model");
    summary.apiCheck = "skipped";
  } else {
    assert.equal(threadResponse.status(), 201, JSON.stringify(threadBody));
    const thread = threadBody.data;
    const backing = await api("GET", `/v1/projects/${thread.projectId}`);
    // Created with this Thread, or by an earlier one (then frozen).
    if (Date.parse(thread.createdAt) - Date.parse(backing.createdAt) > 5_000) {
      step("skipped the API check: the No Project project predates this run", {
        recorded: backing.configuration.runnerProfileId,
      });
      summary.apiCheck = "skipped";
    } else {
      assert.equal(
        backing.configuration.runnerProfileId,
        personalSize.id,
        "A No Project Thread created over the API did not take the personal size.",
      );
      step(
        "a No Project Thread created with no size requested takes the personal size",
        {
          threadId: thread.id,
          recorded: backing.configuration.runnerProfileId,
        },
      );
      summary.apiCheck = "passed";
    }
  }

  const cleared = await api("GET", personalPath);
  await api("PUT", personalPath, {
    expectedRevision: cleared.revision,
    overrides: { ...cleared.overrides, runnerProfileId: null },
  });
  const fallback = await composerSize(page);
  assert(
    fallback.endsWith(workspaceSize.label),
    `Without a personal size the composer shows "${fallback}", not ${workspaceSize.label}.`,
  );
  await shot(page, "02-no-project-workspace-fallback.desktop");
  step("without a personal size the composer falls back to the workspace's", {
    shown: fallback,
  });

  const restored = await api("GET", personalPath);
  await api("PUT", personalPath, {
    expectedRevision: restored.revision,
    overrides: { ...restored.overrides, runnerProfileId: personalSize.id },
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
  const phoneShown = await composerSize(phone);
  assert(phoneShown.endsWith(personalSize.label));
  await shot(phone, "03-no-project-personal.mobile");
  await mobile.close();
  step("mobile composer shows the personal size", { shown: phoneShown });
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
  const restoreWorkspace = await api("GET", workspacePath);
  await api("PUT", workspacePath, {
    expectedRevision: restoreWorkspace.revision,
    overrides: originalWorkspace.overrides,
    policy: originalWorkspace.policy,
  });
  if (composer.project !== null && composer.project !== "none") {
    await api("PATCH", composerPath, { project: composer.project });
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
