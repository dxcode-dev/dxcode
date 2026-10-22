// Integrations & MCP journey against a running `pnpm dev` (local) or a branch
// preview. In each scope it first submits an endpoint dx rejects and checks
// the server's error shows under URL in the add and settings dialogs. It adds
// an MCP server with a bearer token through the page, turns it off and on,
// renames it, and removes it, checking the server's list after each step. It checks each scope's precedence line, the
// workspace's personal-server policy toggle, and the workspace's link to
// personal integrations. GitHub and Bitbucket connect and disconnect run
// against route-mocked API responses, because the proof account has no real
// grant: the run checks that each button sends the right request and that
// the row follows the answer. Connect starts the real authorization when the
// deployment configures the provider, and the browser is stopped before it
// reaches the provider. Writes desktop (1440) and mobile (390) screenshots, a
// HAR without bodies, console.json, and summary.json to <output>.
//
//   node apps/web/test/integrations-mcp-proof.mjs http://127.0.0.1:3000 out/
//
// Servers point at `https://example.com/mcp`. Saving one resolves the
// host's DNS to check it is public, but Discover tools is never pressed, so
// no MCP request is sent. The run removes the servers it adds and
// restores the workspace policy. The workspace half runs only when the
// account owns or administers a workspace; DX_PROOF_CREATE_WORKSPACE=1
// creates one when it has none.
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CHROMIUM picks the Chromium binary.
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
const placeholderToken = "mcp-proof-placeholder-token";
// `.invalid` never resolves, so dx's public-address check rejects it.
const rejectedEndpoint = "https://mcp-proof.invalid/mcp";
const endpointErrorText =
  "Use a public HTTPS Streamable HTTP endpoint without redirects.";

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
let createdWorkspace = false;
if (workspace === undefined && process.env.DX_PROOF_CREATE_WORKSPACE === "1") {
  workspace = await api("POST", "/v1/settings/workspaces", {
    displayName: "MCP proof",
    shortName: `mcp-proof-${Date.now().toString(36)}`,
  });
  createdWorkspace = true;
}
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const scopes = [
  {
    name: "personal",
    apiBase: "/v1/settings/personal/mcp-servers",
    page: "/settings/integrations",
    precedence:
      "Threads you start use these alongside your workspace's MCP servers. Neither overrides the other.",
  },
  ...(workspaceSlug === undefined
    ? []
    : [
        {
          name: "workspace",
          apiBase: `/v1/settings/workspaces/${workspaceSlug}/mcp-servers`,
          page: `/workspaces/${workspaceSlug}/integrations`,
          precedence:
            "Members' Threads use these alongside their personal MCP servers. Neither overrides the other.",
        },
      ]),
];
const listOf = (scope) => api("GET", scope.apiBase);
const serverNamed = async (scope, name) =>
  (await listOf(scope)).items.find((server) => server.name === name);

const openPage = async (page, scope) => {
  await page.goto(`${base}${scope.page}`);
  await page
    .getByRole("heading", { name: "Integrations & MCP" })
    .waitFor({ timeout: 60_000 });
  await page
    .locator(".mcp-section .settings-card")
    .first()
    .getByText(/No MCP servers yet\.|settings$/)
    .first()
    .or(page.locator(".mcp-server-row").first())
    .waitFor({ timeout: 60_000 });
};
const waitForMutation = (page, method, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname.includes(path) &&
      response.ok(),
  );
const row = (page, name) =>
  page.locator(".mcp-server-row").filter({
    has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }),
  });
const noOverflow = async (page) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(overflow <= 0, `The mobile page overflows by ${overflow}px.`);
};

const added = [];
let originalPolicy;
const stamp = Date.now().toString(36);
const summary = {
  base,
  workspace: workspaceSlug ?? null,
  createdWorkspace,
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

  for (const scope of scopes) {
    await openPage(page, scope);
    const precedence = await page
      .locator(".mcp-section .integrations-section-heading p")
      .innerText();
    assert.equal(precedence.trim(), scope.precedence);
    step(`${scope.name}: the MCP heading states dx's precedence`, {
      precedence,
    });
    await shot(page, `${scope.name}-01.desktop`);

    // Add, with a bearer token typed in the dialog.
    const name = `MCP proof ${scope.name} ${stamp}`;
    await page.getByRole("button", { name: "Add MCP server" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    const url = dialog.getByLabel("URL", { exact: true });
    await dialog.getByLabel("Auth", { exact: true }).selectOption("token");
    await dialog.getByLabel("Token", { exact: true }).fill(placeholderToken);

    // A host that fails dx's public-address check: the server's endpoint
    // error shows under URL, not as the page's generic status.
    await url.fill(rejectedEndpoint);
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/mcp-servers"),
    );
    await dialog.getByRole("button", { name: "Add server" }).click();
    assert.equal((await rejected).status(), 400);
    const endpointError = dialog.getByText(endpointErrorText, { exact: true });
    await endpointError.waitFor();
    assert.equal(await url.getAttribute("aria-invalid"), "true");
    assert.equal(
      await url.getAttribute("aria-describedby"),
      await endpointError.getAttribute("id"),
      "The URL field does not point at its error.",
    );
    assert(
      await dialog.getByRole("button", { name: "Add server" }).isDisabled(),
      "Add server stays enabled while the URL error shows.",
    );
    assert.equal(
      await page.getByText("MCP server validation failed.").count(),
      0,
      "The generic validation status still shows.",
    );
    assert.equal(await serverNamed(scope, name), undefined);
    await shot(page, `${scope.name}-02-endpoint-error.desktop`);
    if (scope.name === "personal") {
      await phone.goto(`${base}${scope.page}`);
      await phone
        .getByRole("button", { name: "Add MCP server" })
        .waitFor({ timeout: 60_000 });
      await phone.getByRole("button", { name: "Add MCP server" }).click();
      const phoneDialog = phone.getByRole("dialog");
      await phoneDialog.getByLabel("Name", { exact: true }).fill(name);
      await phoneDialog
        .getByLabel("URL", { exact: true })
        .fill(rejectedEndpoint);
      await phoneDialog.getByRole("button", { name: "Add server" }).click();
      await phoneDialog.getByText(endpointErrorText, { exact: true }).waitFor();
      await noOverflow(phone);
      await shot(phone, "personal-02-endpoint-error.mobile");
    }
    step(`${scope.name}: a rejected URL shows the server's error under URL`);

    // Editing the URL clears its error and re-enables Add server.
    await url.fill("https://example.com/mcp");
    await endpointError.waitFor({ state: "detached" });
    assert.equal(await url.getAttribute("aria-invalid"), "false");
    await shot(page, `${scope.name}-02-add-dialog.desktop`);
    const created = waitForMutation(page, "POST", "/mcp-servers");
    await dialog.getByRole("button", { name: "Add server" }).click();
    await created;
    await dialog.waitFor({ state: "detached" });
    await row(page, name).waitFor();
    const server = await serverNamed(scope, name);
    assert(server, `${name} was not saved.`);
    assert.equal(server.hasStoredToken, true, "The token was not stored.");
    assert.equal(server.enabled, true);
    added.push({ scope, id: server.id });
    await row(page, name).getByText("example.com", { exact: true }).waitFor();
    await row(page, name).getByText("Tools not discovered").waitFor();
    step(`${scope.name}: Add MCP server saved it with a stored token`);
    await shot(page, `${scope.name}-03-added.desktop`);

    await phone.goto(`${base}${scope.page}`);
    await row(phone, name).waitFor({ timeout: 60_000 });
    await noOverflow(phone);
    await shot(phone, `${scope.name}-04.mobile`);
    step(`${scope.name}: mobile page has no horizontal overflow`);

    // Off and on through the row's switch.
    for (const enabled of [false, true]) {
      const saved = waitForMutation(page, "PATCH", `/${server.id}`);
      await row(page, name)
        .getByRole("button", { name: `${name} ${enabled ? "off" : "on"}` })
        .click();
      await saved;
      assert.equal((await serverNamed(scope, name))?.enabled, enabled);
      await row(page, name)
        .getByRole("button", { name: `${name} ${enabled ? "on" : "off"}` })
        .waitFor();
      if (!enabled) await shot(page, `${scope.name}-05-off.desktop`);
    }
    step(`${scope.name}: the row switch turns the server off and on`);

    // Edit: rename through the settings dialog; the token stays stored.
    const renamed = `${name} edited`;
    await row(page, name)
      .getByRole("button", { name: `${name} settings` })
      .click();
    const edit = page.getByRole("dialog");
    await edit
      .getByLabel("Token", { exact: true })
      .and(
        page.locator('[placeholder="Saved. Enter a new token to replace it."]'),
      )
      .waitFor();
    await edit.getByLabel("Name", { exact: true }).fill(renamed);
    await shot(page, `${scope.name}-06-edit-dialog.desktop`);
    const updated = waitForMutation(page, "PATCH", `/${server.id}`);
    await edit.getByRole("button", { name: "Save" }).click();
    await updated;
    await edit.waitFor({ state: "detached" });
    await row(page, renamed).waitFor();
    const afterEdit = await serverNamed(scope, renamed);
    assert.equal(afterEdit?.id, server.id, "The rename did not save.");
    assert.equal(afterEdit.hasStoredToken, true, "The rename lost the token.");
    step(`${scope.name}: editing renames the server and keeps its token`);

    // The settings dialog shows the same endpoint error and saves nothing.
    await row(page, renamed)
      .getByRole("button", { name: `${renamed} settings` })
      .click();
    const editUrl = page.getByRole("dialog").getByLabel("URL", { exact: true });
    await editUrl.fill(rejectedEndpoint);
    const editRejected = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname.endsWith(`/${server.id}`),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save" })
      .click();
    assert.equal((await editRejected).status(), 400);
    await page
      .getByRole("dialog")
      .getByText(endpointErrorText, { exact: true })
      .waitFor();
    assert.equal(
      (await serverNamed(scope, renamed))?.endpoint,
      "https://example.com/mcp",
    );
    await shot(page, `${scope.name}-06-edit-endpoint-error.desktop`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close dialog" })
      .click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    step(`${scope.name}: the settings dialog shows the endpoint error too`);

    // Remove, through the settings dialog's confirmation.
    await row(page, renamed)
      .getByRole("button", { name: `${renamed} settings` })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove server" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Remove ${renamed}?` });
    await confirm.waitFor();
    await shot(page, `${scope.name}-07-remove-confirm.desktop`);
    const removed = waitForMutation(page, "DELETE", `/${server.id}`);
    await confirm.getByRole("button", { name: "Remove server" }).click();
    await removed;
    await row(page, renamed).waitFor({ state: "detached" });
    assert.equal(await serverNamed(scope, renamed), undefined);
    added.splice(
      added.findIndex((entry) => entry.id === server.id),
      1,
    );
    step(`${scope.name}: Remove server deletes it`);
  }

  if (workspaceSlug !== undefined) {
    const scope = scopes[1];
    originalPolicy = (await listOf(scope)).allowPersonalServers;
    await openPage(page, scope);
    for (const allow of [!originalPolicy, originalPolicy]) {
      await page
        .getByRole("button", { name: "Allow personal MCP servers" })
        .click();
      const confirm = page.getByRole("dialog", {
        name: `${allow ? "Allow" : "Block"} personal MCP servers?`,
      });
      await confirm.waitFor();
      const saved = waitForMutation(page, "PATCH", "/mcp-servers/policy");
      await confirm.getByRole("button", { name: "Confirm" }).click();
      await saved;
      await confirm.waitFor({ state: "detached" });
      assert.equal((await listOf(scope)).allowPersonalServers, allow);
      if (!allow) await shot(page, "workspace-08-personal-blocked.desktop");
    }
    step("workspace: the personal-server policy blocks and allows again");

    await phone.goto(`${base}${scope.page}`);
    await phone
      .getByRole("heading", { name: "Integrations & MCP" })
      .waitFor({ timeout: 60_000 });
    await phone.getByText("Allow personal MCP servers").waitFor();
    await noOverflow(phone);
    await shot(phone, "workspace-09.mobile");

    await page.getByRole("link", { name: "Personal integrations" }).click();
    await page.waitForURL("**/settings/integrations");
    await page.getByRole("region", { name: "GitHub integration" }).waitFor();
    step("workspace: Personal integrations opens personal Integrations & MCP");
  }

  // GitHub and Bitbucket, from mocked server state.
  const github = (await api("GET", "/v1/integrations/github/personal/grants"))
    .configured;
  const bitbucket = (
    await api("GET", "/v1/integrations/bitbucket/personal/connection")
  ).configured;
  const sent = [];
  const grant = {
    id: "grant-proof",
    ownerScope: "personal",
    ownerId: "proof",
    installationId: "1",
    status: "active",
    installationStatus: "active",
    account: { id: "1", login: "proof-org", type: "organization" },
    repositorySelection: "all",
    repositories: [],
  };
  const state = { grants: [grant], bitbucket: true };
  const json = (route, data) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "success", data }),
    });
  await page.route("**/v1/integrations/github/personal/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    sent.push(`${request.method()} ${path}`);
    if (request.method() === "GET" && path.endsWith("/grants"))
      return json(route, { configured: true, grants: state.grants });
    if (request.method() === "DELETE" && path.endsWith(`/grants/${grant.id}`)) {
      state.grants = [];
      return json(route, {
        grantId: grant.id,
        localAccessStopped: true,
        installationUninstalled: true,
      });
    }
    if (request.method() === "POST" && path.endsWith("/authorize") && !github)
      return json(route, {
        authorizationUrl: "https://github.com/login/oauth/authorize?proof=1",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    return route.continue();
  });
  await page.route(
    "**/v1/integrations/bitbucket/personal/**",
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      sent.push(`${request.method()} ${path}`);
      if (request.method() === "GET" && path.endsWith("/connection"))
        return json(route, {
          configured: true,
          connection: state.bitbucket
            ? { id: "bb-proof", accountName: "proof-team", status: "active" }
            : null,
        });
      if (request.method() === "DELETE" && path.endsWith("/connection")) {
        state.bitbucket = false;
        return json(route, { localAccessStopped: true });
      }
      if (
        request.method() === "POST" &&
        path.endsWith("/authorize") &&
        !bitbucket
      )
        return json(route, {
          authorizationUrl:
            "https://bitbucket.org/site/oauth2/authorize?proof=1",
        });
      return route.continue();
    },
  );
  // Never reach the provider; Connect's request records where it went.
  for (const pattern of ["https://github.com/**", "https://bitbucket.org/**"])
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Stopped before the provider</title>",
      }),
    );

  await openPage(page, scopes[0]);
  const githubCard = page.getByRole("region", { name: "GitHub integration" });
  const bitbucketCard = page.getByRole("region", {
    name: "Bitbucket integration",
  });
  await githubCard.getByText("@proof-org on GitHub").waitFor();
  await bitbucketCard.getByText("proof-team on Bitbucket").waitFor();
  await shot(page, "personal-10-connected.desktop");
  await phone.route("**/v1/integrations/github/personal/grants", (route) =>
    json(route, { configured: true, grants: [grant] }),
  );
  await phone.route(
    "**/v1/integrations/bitbucket/personal/connection",
    (route) =>
      json(route, {
        configured: true,
        connection: {
          id: "bb-proof",
          accountName: "proof-team",
          status: "active",
        },
      }),
  );
  await phone.goto(`${base}${scopes[0].page}`);
  await phone.getByText("@proof-org on GitHub").waitFor({ timeout: 60_000 });
  await noOverflow(phone);
  await shot(phone, "personal-11-connected.mobile");
  step("personal: connected GitHub and Bitbucket accounts render as rows");

  await githubCard
    .getByRole("button", { name: "Disconnect @proof-org" })
    .click();
  const githubConfirm = page.getByRole("dialog", {
    name: "Disconnect @proof-org?",
  });
  await shot(page, "personal-12-github-disconnect.desktop");
  await githubConfirm.getByRole("button", { name: "Disconnect" }).click();
  await githubConfirm.waitFor({ state: "detached" });
  await githubCard.getByRole("button", { name: "Connect GitHub" }).waitFor();
  assert(
    sent.includes(`DELETE /v1/integrations/github/personal/grants/${grant.id}`),
    "Disconnect did not delete the GitHub grant.",
  );
  step("personal: GitHub Disconnect deletes the grant and offers Connect");

  await bitbucketCard.getByRole("button", { name: "Disconnect" }).click();
  const bitbucketConfirm = page.getByRole("dialog", {
    name: "Disconnect proof-team?",
  });
  await bitbucketConfirm.getByRole("button", { name: "Disconnect" }).click();
  await bitbucketConfirm.waitFor({ state: "detached" });
  const bitbucketConnectButton = bitbucketCard.getByRole("button", {
    name: "Connect",
    exact: true,
  });
  await bitbucketConnectButton.and(page.locator(":enabled")).waitFor();
  await page.mouse.move(0, 0);
  assert(
    sent.includes("DELETE /v1/integrations/bitbucket/personal/connection"),
    "Disconnect did not delete the Bitbucket connection.",
  );
  await shot(page, "personal-13-disconnected.desktop");
  step(
    "personal: Bitbucket Disconnect deletes the connection and offers Connect",
  );

  const githubConnect = page.waitForRequest((request) =>
    request.url().startsWith("https://github.com/"),
  );
  await githubCard.getByRole("button", { name: "Connect GitHub" }).click();
  const githubDestination = new URL((await githubConnect).url());
  assert(
    sent.includes("POST /v1/integrations/github/personal/authorize"),
    "Connect GitHub did not start authorization.",
  );
  step("personal: Connect GitHub starts authorization and leaves for GitHub", {
    realAuthorization: github,
    destination: `${githubDestination.origin}${githubDestination.pathname}`,
  });

  await openPage(page, scopes[0]);
  const bitbucketConnect = page.waitForRequest((request) =>
    request.url().startsWith("https://bitbucket.org/"),
  );
  await bitbucketCard
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const bitbucketDestination = new URL((await bitbucketConnect).url());
  assert(
    sent.includes("POST /v1/integrations/bitbucket/personal/authorize"),
    "Connect did not start Bitbucket authorization.",
  );
  step(
    "personal: Bitbucket Connect starts authorization and leaves for Bitbucket",
    {
      realAuthorization: bitbucket,
      destination: `${bitbucketDestination.origin}${bitbucketDestination.pathname}`,
    },
  );
  await mobile.close();
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  for (const { scope, id } of added)
    await api("DELETE", `${scope.apiBase}/${id}`).catch(() => undefined);
  if (originalPolicy !== undefined && workspaceSlug !== undefined) {
    const scope = scopes[1];
    if ((await listOf(scope)).allowPersonalServers !== originalPolicy)
      await api("PATCH", `${scope.apiBase}/policy`, {
        allowPersonalServers: originalPolicy,
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
      entry.request.postData?.text?.includes(placeholderToken)
    ) {
      entry.request.postData.text = "[redacted]";
    }
  }
  writeFileSync(harPath, JSON.stringify(har));
}
