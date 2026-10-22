// Orb Providers journey against a running `pnpm dev` (local) or a branch
// preview. Through the page it saves, replaces, and removes a personal key
// and a workspace key for the first key-based provider (E2B), turns the
// workspace's "Members' Own Keys" policy off and on, and checks after each
// step what the server reports and what the personal row says. On a
// deployment (not the local runtime) it also checks that the provider set a
// workspace project's new Thread resolves to follows the policy: the
// personal key only when the workspace allows it. Writes desktop (1440) and
// mobile (390) screenshots, a HAR without bodies or credentials,
// console.json, and summary.json to <output>, then restores the policy and
// removes the keys it saved.
//
//   node apps/web/test/orb-providers-proof.mjs http://127.0.0.1:3000 out/
//
// The local runtime stores keys without reaching the provider, so a
// placeholder works there. A deployment checks the key with the provider:
// set DX_PROOF_ORB_KEY to a real key. Without one the run only checks that
// a placeholder is rejected inline. A deployment whose catalog has no
// key-based provider shows rows only: the run checks there is no key action
// and no policy card. The workspace half creates an
// `orb-proof` workspace when the account belongs to none.
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CHROMIUM picks the browser binary.
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
const stamp = Date.now().toString(36);
const realKey = process.env.DX_PROOF_ORB_KEY;
const placeholder = `orb-proof-placeholder-${stamp}`;

const browser = await chromium.launch(
  process.env.DX_PROOF_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.DX_PROOF_CHROMIUM },
);
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

let { workspace } = await api("GET", "/v1/settings/personal");
const createdWorkspace = workspace === undefined;
if (createdWorkspace)
  workspace = await api("POST", "/v1/settings/workspaces", {
    displayName: "Orb Proof",
    shortName: `orb-proof-${stamp}`,
  });
const workspaceSlug = ["owner", "admin"].includes(workspace.role ?? "owner")
  ? workspace.shortName
  : undefined;

const scopes = {
  personal: {
    name: "personal",
    apiBase: "/v1/settings/personal/orb-providers",
    page: "/settings/orb-providers",
    heading: "Orb Providers",
  },
  workspace: {
    name: "workspace",
    apiBase: `/v1/settings/workspaces/${workspaceSlug}/orb-providers`,
    page: `/workspaces/${workspaceSlug}/orb-providers`,
    heading: "Workspace Orb Providers",
  },
};
const listOf = (scope) => api("GET", scope.apiBase);
const personalStart = await listOf(scopes.personal);
// A deployment lists a key-based provider only when its catalog has sizes
// for it. Without one, the run checks the rows and the policy alone.
const keyed = personalStart.providers.find(
  ({ credentialLabel }) => credentialLabel !== null,
);
const provider = keyed ?? personalStart.providers[0];
const { localRuntime } = personalStart;
const keyOf = async (scope) =>
  (await listOf(scope)).providers.find(({ id }) => id === provider.id).key;
const workspaceStart =
  workspaceSlug === undefined ? undefined : await listOf(scopes.workspace);
const workspaceKeyAtStart = workspaceStart?.providers.find(
  ({ id }) => id === provider.id,
)?.key;
const policyAtStart = workspaceStart?.personalKeysOnWorkspaceProjects;
const key = (n) => (realKey === undefined ? `${placeholder}-${n}` : realKey);

const openPage = async (page, scope) => {
  await page.goto(`${base}${scope.page}`);
  await page
    .getByRole("heading", { name: scope.heading, exact: true })
    .waitFor({ timeout: 60_000 });
  await row(page).waitFor({ timeout: 60_000 });
};
const row = (page) => page.locator(`[data-provider="${provider.id}"]`);
const rowStatus = async (page) =>
  (await row(page).locator(".orb-provider-copy p").innerText()).trim();
/** Polls the row's status until `predicate` holds. */
const waitForStatus = async (page, predicate, label) => {
  for (let attempt = 0; ; attempt += 1) {
    const text = await rowStatus(page);
    if (predicate(text)) return text;
    if (attempt >= 60) throw new Error(`${label}: the row reads "${text}".`);
    await page.waitForTimeout(500);
  }
};
const waitForMutation = (page, method, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname.endsWith(path),
  );

/** Opens the row's key dialog. */
const openKey = async (page, action) => {
  await page
    .getByRole("button", { name: `${action} ${provider.displayName} key` })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(provider.credentialLabel, { exact: true }).waitFor();
  return dialog;
};
/** Types a key into the open dialog and saves it; returns the response. */
const saveKey = async (page, dialog, credential) => {
  await dialog
    .getByLabel(provider.credentialLabel, { exact: true })
    .fill(credential);
  const saved = waitForMutation(page, "PUT", `/${provider.id}/key`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  return saved;
};
const placeholderOf = (dialog) =>
  dialog
    .getByLabel(provider.credentialLabel, { exact: true })
    .getAttribute("placeholder");

const saved = { personal: false, workspace: false };
const summary = {
  base,
  localRuntime,
  provider: provider.id,
  keyBased: keyed !== undefined,
  providers: personalStart.providers.map(({ id }) => id),
  workspace: workspaceSlug ?? null,
  createdWorkspace,
  realKey: realKey !== undefined,
  steps,
};
try {
  const page = await context.newPage();
  watch(page);
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
  const phoneShot = async (scope, name) => {
    await openPage(phone, scope);
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert(overflow <= 0, `The mobile page overflows by ${overflow}px.`);
    await shot(phone, name);
  };

  const personal = scopes.personal;
  await openPage(page, personal);
  const startStatus = await rowStatus(page);
  await shot(page, "personal-01.desktop");
  await phoneShot(personal, "personal-02.mobile");
  assert.equal(
    await page.locator(".orb-provider-row").count(),
    personalStart.providers.length,
    "The page does not show one row per provider.",
  );
  if (keyed === undefined) {
    assert.equal(
      await row(page).getByRole("button").count(),
      0,
      "A provider without keys offers a key action.",
    );
  } else {
    const phoneDialog = await openKey(phone, "Add");
    await shot(phone, "personal-02-add-dialog.mobile");
    await phone.keyboard.press("Escape");
    await phoneDialog.waitFor({ state: "detached" });
    assert.equal(
      personalStart.providers.find(({ id }) => id === provider.id).key,
      null,
      "The account already has a personal key; the run would replace it.",
    );
  }
  step("personal: one row per provider; mobile has no horizontal overflow", {
    status: startStatus,
  });

  if (keyed === undefined) {
    step("personal: no key-based provider here, so no key to save");
  } else if (!localRuntime && realKey === undefined) {
    // Without a real key a deployment can only show the rejection.
    const dialog = await openKey(page, "Add");
    const response = await saveKey(page, dialog, placeholder);
    assert.equal(response.status(), 400, "The placeholder key was accepted.");
    await dialog
      .getByRole("alert")
      .filter({ hasText: "The provider rejected this key." })
      .waitFor();
    await shot(page, "personal-03-rejected.desktop");
    assert.equal(await keyOf(personal), null, "A rejected key was saved.");
    step("personal: a rejected key shows inline and is not saved");
    await page.keyboard.press("Escape");
  } else {
    // Save.
    let dialog = await openKey(page, "Add");
    await shot(page, "personal-03-add-dialog.desktop");
    const response = await saveKey(page, dialog, key(1));
    assert(response.ok(), `Saving answered ${response.status()}.`);
    saved.personal = true;
    await dialog.waitFor({ state: "detached" });
    const first = await keyOf(personal);
    assert(first !== null, "The saved key is not on the server.");
    await waitForStatus(
      page,
      (text) => /^(Your key|Building template…|Ignored locally)/.test(text),
      "After saving",
    );
    await page
      .getByRole("button", { name: `Manage ${provider.displayName} key` })
      .waitFor();
    await shot(page, "personal-04-saved.desktop");
    step("personal: Add Key saves a key and the row names it", {
      status: await rowStatus(page),
    });

    // Replace.
    dialog = await openKey(page, "Manage");
    assert.equal(
      await placeholderOf(dialog),
      "Key saved. Enter a new key to replace it.",
    );
    await shot(page, "personal-05-manage-dialog.desktop");
    const replaced = await saveKey(page, dialog, key(2));
    assert(replaced.ok(), `Replacing answered ${replaced.status()}.`);
    await dialog.waitFor({ state: "detached" });
    const second = await keyOf(personal);
    assert(
      second !== null && second.configuredAt !== first.configuredAt,
      "Replacing did not store a new key.",
    );
    step("personal: Manage Key replaces the key", {
      configuredAt: [first.configuredAt, second.configuredAt],
    });
  }

  if (workspaceSlug !== undefined) {
    const workspaceScope = scopes.workspace;
    assert.equal(workspaceKeyAtStart, null, "The workspace already has a key.");
    await openPage(page, workspaceScope);
    await shot(page, "workspace-01.desktop");
    await phoneShot(workspaceScope, "workspace-02.mobile");
    step("workspace: one row per provider; mobile has no horizontal overflow", {
      status: await rowStatus(page),
    });

    if (keyed !== undefined && (localRuntime || realKey !== undefined)) {
      let dialog = await openKey(page, "Add");
      const response = await saveKey(page, dialog, key(3));
      assert(response.ok(), `Saving answered ${response.status()}.`);
      saved.workspace = true;
      await dialog.waitFor({ state: "detached" });
      const first = await keyOf(workspaceScope);
      assert(first !== null, "The workspace key is not on the server.");
      await waitForStatus(
        page,
        (text) =>
          /^(Workspace key|Building template…|Ignored locally)/.test(text),
        "After saving the workspace key",
      );
      step("workspace: Add Key saves a workspace key", {
        status: await rowStatus(page),
      });
      dialog = await openKey(page, "Manage");
      const replaced = await saveKey(page, dialog, key(4));
      assert(replaced.ok(), `Replacing answered ${replaced.status()}.`);
      await dialog.waitFor({ state: "detached" });
      const second = await keyOf(workspaceScope);
      assert.notEqual(second.configuredAt, first.configuredAt);
      await shot(page, "workspace-03-saved.desktop");
      step("workspace: Manage Key replaces the workspace key");
    }

    // The workspace policy on members' own keys.
    const toggle = page.getByRole("button", {
      name: "Members' own keys on workspace projects",
    });
    const policy = (await listOf(workspaceScope))
      .personalKeysOnWorkspaceProjects;
    if (keyed === undefined) {
      // No provider takes a key, so the policy on keys has nothing to do.
      assert.equal(await toggle.count(), 0, "The policy card is shown.");
      step("workspace: without a key-based provider there is no policy card");
    } else if (!policy.pluginOverridesAllowed) {
      assert(await toggle.isDisabled(), "A locked policy switch is enabled.");
      step("workspace: the switch is locked by the plugin policy");
    } else {
      /** Sets the switch through the page and checks the server agrees. */
      const setPolicy = async (allowed) => {
        await openPage(page, workspaceScope);
        if ((await toggle.getAttribute("aria-pressed")) !== String(allowed)) {
          const written = waitForMutation(page, "PUT", "/orb-providers/policy");
          await toggle.click();
          assert((await written).ok(), "The policy write failed.");
        }
        await page.waitForFunction(
          (expected) =>
            [...document.querySelectorAll("button[aria-pressed]")].some(
              (button) =>
                button.getAttribute("aria-label") ===
                  "Members' own keys on workspace projects" &&
                button.getAttribute("aria-pressed") === expected,
            ),
          String(allowed),
        );
        assert.equal(
          (await listOf(workspaceScope)).personalKeysOnWorkspaceProjects
            .allowed,
          allowed,
        );
      };
      /** The provider a new Thread in a workspace project would run on. */
      const resolvedScope = async () =>
        (await listOf(personal)).resolved.find(
          ({ providerId }) => providerId === provider.id,
        )?.scope ?? null;

      for (const allowed of [false, true]) {
        await setPolicy(allowed);
        await shot(
          page,
          `workspace-0${allowed ? 5 : 4}-policy-${allowed ? "on" : "off"}.desktop`,
        );
        await openPage(page, personal);
        const detail = { status: await rowStatus(page) };
        if (saved.personal && !localRuntime) {
          await waitForStatus(
            page,
            allowed
              ? (text) => !text.includes("Personal projects only")
              : (text) => text.endsWith("· Personal projects only"),
            `Policy ${allowed ? "on" : "off"}`,
          );
          detail.status = await rowStatus(page);
          // Without a projectId the set resolves for the member's workspace.
          detail.resolved = await resolvedScope();
          assert.equal(
            detail.resolved === "personal",
            allowed,
            `With the policy ${allowed ? "on" : "off"} a workspace project resolves to the ${detail.resolved} key.`,
          );
        }
        if (saved.personal) {
          const dialog = await openKey(page, "Manage");
          const note = dialog.getByText(
            "Your workspace keeps members' own keys off its projects",
          );
          assert.equal(
            await note.count(),
            !allowed && !localRuntime ? 1 : 0,
            "The dialog's policy note does not match the policy.",
          );
          await shot(
            page,
            `personal-0${allowed ? 7 : 6}-policy-${allowed ? "on" : "off"}.desktop`,
          );
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
        }
        step(
          `policy ${allowed ? "on" : "off"}: the server, the personal row, and the resolved provider agree`,
          detail,
        );
      }
    }
  }

  if (saved.personal) {
    await openPage(page, personal);
    const dialog = await openKey(page, "Manage");
    const removed = waitForMutation(page, "DELETE", `/${provider.id}/key`);
    await dialog
      .getByRole("button", { name: "Remove Key", exact: true })
      .click();
    assert((await removed).ok(), "Removing the personal key failed.");
    await dialog.waitFor({ state: "detached" });
    saved.personal = false;
    assert.equal(await keyOf(personal), null, "The key is still saved.");
    await page
      .getByRole("button", { name: `Add ${provider.displayName} key` })
      .waitFor();
    if (saved.workspace)
      await waitForStatus(
        page,
        (text) =>
          /^(Workspace key|Building template…|Ignored locally)/.test(text),
        "After removing with a workspace key",
      );
    await shot(page, "personal-08-removed.desktop");
    step("personal: Remove Key deletes it and the row falls back", {
      status: await rowStatus(page),
    });
  }
  if (saved.workspace) {
    await openPage(page, scopes.workspace);
    const dialog = await openKey(page, "Manage");
    const removed = waitForMutation(page, "DELETE", `/${provider.id}/key`);
    await dialog
      .getByRole("button", { name: "Remove Key", exact: true })
      .click();
    assert((await removed).ok(), "Removing the workspace key failed.");
    await dialog.waitFor({ state: "detached" });
    saved.workspace = false;
    assert.equal(await keyOf(scopes.workspace), null);
    await openPage(page, personal);
    assert.equal(
      await rowStatus(page),
      startStatus,
      "The personal row did not return to its first state.",
    );
    step("workspace: Remove Key deletes it; the personal row is as it began");
  }
  await mobile.close();
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (saved.personal)
    await api("DELETE", `${scopes.personal.apiBase}/${provider.id}/key`).catch(
      () => undefined,
    );
  if (saved.workspace)
    await api("DELETE", `${scopes.workspace.apiBase}/${provider.id}/key`).catch(
      () => undefined,
    );
  if (policyAtStart?.pluginOverridesAllowed)
    await api("PUT", `${scopes.workspace.apiBase}/policy`, {
      allowPersonalKeysOnWorkspaceProjects:
        policyAtStart.executionOverridesAllowed,
    }).catch(() => undefined);
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
  const secrets = [password, email, placeholder, realKey].filter(
    (value) => value !== undefined,
  );
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
