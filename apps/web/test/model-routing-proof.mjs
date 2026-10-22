// Model Routing journey against a running `pnpm dev` (local) or a branch
// preview. In each scope it adds a Custom URL connection through the page,
// moves it to the top of the order, and checks that the routing graph sends
// the Low mode's Main Agent to it, as the server's graph says. It then
// deactivates, reactivates, and deletes the connection through the page and
// checks the graph follows each change. It also checks the other scope's
// routing row: the workspace row after personal connections, and the
// members' row before workspace connections. Writes desktop (1440) and mobile
// (390) screenshots, a HAR without bodies, console.json, and summary.json to
// <output>.
//
//   node apps/web/test/model-routing-proof.mjs http://127.0.0.1:3000 out/
//
// Connections point at `https://routing-proof.invalid`, so nothing is ever
// sent to a model provider; Check Access is never pressed. The run removes
// the connections it adds and restores the original order. The workspace
// half runs only when the account owns or administers a workspace.
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars. DX_PROOF_CDP connects to an existing
// Chromium instead of launching headless; DX_PROOF_CHROMIUM picks the binary.
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
    ? await chromium.launch(
        process.env.DX_PROOF_CHROMIUM === undefined
          ? {}
          : { executablePath: process.env.DX_PROOF_CHROMIUM },
      )
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
  // Delete asks with the browser's confirm dialog.
  page.on("dialog", (dialog) => void dialog.accept());
};
const shot = (page, name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const { workspace } = await api("GET", "/v1/settings/personal");
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const scopes = [
  {
    name: "personal",
    apiBase: "/v1/settings/personal/model-routing",
    page: "/settings/model-routing",
  },
  ...(workspaceSlug === undefined
    ? []
    : [
        {
          name: "workspace",
          apiBase: `/v1/settings/workspaces/${workspaceSlug}/model-routing`,
          page: `/workspaces/${workspaceSlug}/model-routing`,
        },
      ]),
];
const connectionsOf = async (scope) =>
  (await api("GET", `${scope.apiBase}/connections`)).connections;
const graphOf = (scope) => api("GET", `${scope.apiBase}/graph`);
/** Where the server routes the Low mode's Main Agent, as the page names it. */
const lowDestination = async (scope) =>
  (await graphOf(scope)).edges.find((edge) => edge.mode === "low")
    ?.connectionId ?? "not-served";

const originalOrder = new Map();
for (const scope of scopes)
  originalOrder.set(
    scope.name,
    (await connectionsOf(scope)).map(({ id }) => id),
  );
const added = [];
const stamp = Date.now().toString(36);

const openPage = async (page, scope) => {
  await page.goto(`${base}${scope.page}`);
  await page
    .getByRole("heading", { name: "Model Routing" })
    .waitFor({ timeout: 60_000 });
  await page.locator(".routing-graph").waitFor({ timeout: 60_000 });
};
const waitForLowDestination = async (page, destination) => {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-routing-source="low:agent"]')
        ?.getAttribute("data-destination") === expected,
    destination,
    { timeout: 30_000 },
  );
};
const row = (page, name) =>
  page.locator("[data-connection-row]").filter({
    has: page.locator(".model-routing-connection-name", { hasText: name }),
  });
const waitForMutation = (page, method, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname.includes(path) &&
      response.ok(),
  );

/** Adds a Custom URL connection serving `model` through the Add menu. */
const addConnection = async (page, scope, name, model) => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const items = await page.getByRole("menuitem").allInnerTexts();
  if (scope.name === "workspace")
    assert.deepEqual(
      items.map((item) => item.trim()),
      ["Custom URL"],
      "The workspace Add menu offers more than Custom URL.",
    );
  await page.getByRole("menuitem", { name: "Custom URL" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Base URL", { exact: true })
    .fill("https://routing-proof.invalid/v1");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("routing-proof-placeholder");
  await dialog.locator("#mr-models").fill(model);
  await dialog
    .getByText("https://routing-proof.invalid/v1/chat/completions")
    .waitFor();
  await shot(page, `${scope.name}-02-add-dialog.desktop`);
  const created = waitForMutation(page, "POST", "/connections");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await created;
  await dialog.waitFor({ state: "detached" });
  await row(page, name).waitFor();
  const connection = (await connectionsOf(scope)).find(
    (candidate) => candidate.name === name,
  );
  assert(connection, `${name} was not saved.`);
  added.push({ scope, id: connection.id });
  return connection.id;
};

/** Opens the row's details and actions, leaving an open row open. */
const expand = async (page, name) => {
  const disclosure = row(page, name).locator(
    ".model-routing-connection-disclosure",
  );
  if ((await disclosure.getAttribute("aria-expanded")) !== "true")
    await disclosure.click();
  await row(page, name).getByRole("button", { name: "Check Access" }).waitFor();
};

/** Moves the connection to the top with its overflow menu's Move Up. */
const moveToTop = async (page, scope, name, id) => {
  await expand(page, name);
  let moves = 0;
  for (;;) {
    const order = (await connectionsOf(scope)).map((c) => c.id);
    if (order.indexOf(id) === 0) break;
    await page
      .getByRole("button", { name: `More actions for ${name}` })
      .click();
    const reordered = waitForMutation(page, "POST", "/connections/reorder");
    await page.getByRole("menuitem", { name: "Move Up" }).click();
    await reordered;
    moves += 1;
    assert(moves < 50, "Move Up never reached the top.");
  }
  await page.waitForFunction(
    (expectedName) =>
      document
        .querySelector(
          ".model-routing-connection-list [data-connection-row] .model-routing-connection-name",
        )
        ?.textContent?.trim() === expectedName,
    name,
  );
  return moves;
};

const summary = {
  base,
  workspace: workspaceSlug ?? null,
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
    const lowModel = (await graphOf(scope)).modes.find(
      (mode) => mode.mode === "low",
    )?.config.model;
    assert(lowModel, "The graph has no Low mode.");
    await openPage(page, scope);

    // The other scope's routing sits in its place in the order.
    const list = page.locator(".model-routing-connection-list").first();
    if (scope.name === "personal" && workspace !== undefined) {
      const workspaceRow = list
        .locator(":scope > li")
        .last()
        .locator(".model-routing-connection-name");
      assert.equal(
        (await workspaceRow.innerText()).trim(),
        `${workspace.displayName} workspace model routing`,
        "The workspace's routing row is not last in the personal list.",
      );
      step("personal list ends with the workspace's routing row");
    }
    if (scope.name === "workspace") {
      assert.equal(
        (
          await list
            .locator(":scope > li")
            .first()
            .locator(".model-routing-connection-name")
            .innerText()
        ).trim(),
        "Members' personal model routing",
        "Members' personal routing is not first in the workspace list.",
      );
      step("workspace list starts with members' personal routing");
    }
    await shot(page, `${scope.name}-01.desktop`);

    const before = await lowDestination(scope);
    const name = `Routing proof ${scope.name} ${stamp}`;
    const id = await addConnection(page, scope, name, lowModel);
    step(`${scope.name}: added a Custom URL connection on the page`, {
      model: lowModel,
    });

    const moves = await moveToTop(page, scope, name, id);
    assert.equal(
      await lowDestination(scope),
      id,
      "The server does not route Low to the top connection.",
    );
    await waitForLowDestination(page, id);
    step(`${scope.name}: Move Up put it first and the graph routes Low to it`, {
      moves,
      lowBefore: before,
    });

    // Hovering the connection's node highlights every route it serves.
    await page.locator(`[data-routing-destination="${id}"]`).hover();
    await page
      .locator('.routing-card[data-mode="low"][data-active]')
      .waitFor({ timeout: 5_000 });
    step(`${scope.name}: hovering the connection highlights the Low route`);
    if (scope.name === "personal") {
      // Direct model choices list the model this connection now serves.
      await page
        .locator(
          `[data-routing-source="model:${lowModel}"][data-destination="${id}"]`,
        )
        .waitFor({ timeout: 30_000 });
      step("personal: the model choice row routes to the connection");
    }
    await page.mouse.move(0, 0);
    await expand(page, name);
    await shot(page, `${scope.name}-03-added.desktop`);

    await phone.goto(`${base}${scope.page}`);
    await phone
      .getByRole("heading", { name: "Model Routing" })
      .waitFor({ timeout: 60_000 });
    await phone.locator(`[data-routing-destination="${id}"]`).waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert(overflow <= 0, `The mobile page overflows by ${overflow}px.`);
    await shot(phone, `${scope.name}-04.mobile`);
    step(`${scope.name}: mobile page has no horizontal overflow`);

    const deactivated = waitForMutation(page, "POST", "/enabled");
    await row(page, name).getByRole("button", { name: "Deactivate" }).click();
    await deactivated;
    await row(page, name).getByText("Inactive").waitFor();
    const whileInactive = await lowDestination(scope);
    assert.notEqual(whileInactive, id, "An inactive connection still serves.");
    await waitForLowDestination(page, whileInactive);
    // Nothing routes to an inactive connection, model choices included.
    await page
      .locator(`[data-routing-destination="${id}"]`)
      .waitFor({ state: "detached", timeout: 30_000 });
    await shot(page, `${scope.name}-05-inactive.desktop`);
    step(`${scope.name}: Deactivate takes every route off the connection`, {
      lowWhileInactive: whileInactive,
    });

    const activated = waitForMutation(page, "POST", "/enabled");
    await row(page, name).getByRole("button", { name: "Activate" }).click();
    await activated;
    await waitForLowDestination(page, id);
    step(`${scope.name}: Activate routes Low back to it`);

    if (scope.name === "personal" && workspace !== undefined) {
      // A member sees the row; only admins can open the workspace page.
      const link = page.getByRole("link", {
        name: `${workspace.displayName} workspace model routing`,
      });
      assert.equal(
        await link.count(),
        workspaceSlug === undefined ? 0 : 1,
        "The workspace row's link does not match the member's role.",
      );
    }

    await page
      .getByRole("button", { name: `More actions for ${name}` })
      .click();
    const deleted = waitForMutation(page, "DELETE", `/connections/${id}`);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await deleted;
    await row(page, name).waitFor({ state: "detached" });
    const afterDelete = await lowDestination(scope);
    assert.notEqual(afterDelete, id, "A deleted connection still serves.");
    assert.equal(afterDelete, before, "Low did not return to its old route.");
    await waitForLowDestination(page, afterDelete);
    await page
      .locator(`[data-routing-destination="${id}"]`)
      .waitFor({ state: "detached", timeout: 30_000 });
    added.splice(
      added.findIndex((entry) => entry.id === id),
      1,
    );
    await shot(page, `${scope.name}-06-deleted.desktop`);
    step(`${scope.name}: Delete removes it from the list and the graph`, {
      lowAfterDelete: afterDelete,
    });
  }

  if (workspaceSlug !== undefined) {
    // Personal Threads use the workspace's connections after the user's own.
    const personal = scopes[0];
    const workspaceScope = scopes[1];
    await openPage(page, workspaceScope);
    const name = `Routing proof shared ${stamp}`;
    const lowModel = (await graphOf(personal)).modes.find(
      (mode) => mode.mode === "low",
    )?.config.model;
    const id = await addConnection(page, workspaceScope, name, lowModel);
    await moveToTop(page, workspaceScope, name, id);
    await openPage(page, personal);
    const personalLow = await lowDestination(personal);
    await waitForLowDestination(page, personalLow);
    if (personalLow === id) {
      await page
        .locator(`[data-routing-destination="${id}"] .settings-workspace-mark`)
        .waitFor();
      step("personal graph routes Low to the workspace connection, marked W");
    } else {
      step(
        "personal graph keeps Low on a personal connection ahead of the workspace's",
        { personalLow },
      );
    }
    await shot(page, "personal-07-workspace-route.desktop");
    await page
      .getByRole("link", {
        name: `${workspace.displayName} workspace model routing`,
      })
      .click();
    await page.waitForURL(`**/workspaces/${workspaceSlug}/model-routing`);
    await row(page, name).waitFor();
    step("the personal page's workspace row opens workspace Model Routing");
  }
  await mobile.close();
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  for (const { scope, id } of added)
    await api("DELETE", `${scope.apiBase}/connections/${id}`).catch(
      () => undefined,
    );
  for (const scope of scopes) {
    const order = originalOrder.get(scope.name) ?? [];
    const now = (await connectionsOf(scope)).map(({ id }) => id);
    if (order.length > 1 && now.join() !== order.join())
      await api("POST", `${scope.apiBase}/connections/reorder`, {
        orderedIds: order,
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
    if (
      entry.request.postData?.text?.includes(password) ||
      entry.request.postData?.text?.includes("routing-proof-placeholder")
    ) {
      entry.request.postData.text = "[redacted]";
    }
  }
  writeFileSync(harPath, JSON.stringify(har));
}
