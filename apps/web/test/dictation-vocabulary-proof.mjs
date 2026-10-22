// Dictation Vocabulary journey against a running `pnpm dev` (local) or a
// branch preview. On the personal Composer page it types terms one per line
// and comma-separated, saves, and checks the normalized list over the API and
// after a reload; it checks that a term over 64 characters blocks Save and
// that Reset brings the saved list back. On the workspace Composer page it
// saves a workspace list the same way. Writes desktop (1440) and mobile (390)
// screenshots, a HAR without credentials, console.json, and summary.json to
// <output>, then restores both lists.
//
//   node apps/web/test/dictation-vocabulary-proof.mjs http://127.0.0.1:3000 out/
//
// The workspace half runs only when the account owns or administers a
// workspace. Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from
// the local account in apps/core/.dev.vars. DX_PROOF_CDP connects to an
// existing Chromium instead of launching headless.
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
const shot = (page, name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const { workspace } = await api("GET", "/v1/settings/personal");
const workspaceSlug =
  workspace !== undefined && ["owner", "admin"].includes(workspace.role)
    ? workspace.shortName
    : undefined;
const personalApi = "/v1/settings/personal/dictation-vocabulary";
const workspaceApi =
  workspaceSlug === undefined
    ? undefined
    : `/v1/settings/workspaces/${workspaceSlug}/dictation-vocabulary`;
const original = {
  personal: (await api("GET", personalApi)).terms,
  workspace:
    workspaceApi === undefined
      ? undefined
      : (await api("GET", workspaceApi)).terms,
};

const field = (page) =>
  page.getByRole("textbox", { name: "Dictation vocabulary" });
const button = (page, name) => page.getByRole("button", { name, exact: true });

/** Types `typed`, saves, and checks `expected` on the server and on reload. */
const saveTerms = async (page, scope, url, apiPath, typed, expected) => {
  await page.goto(url);
  await page.getByRole("heading", { name: "Dictation Vocabulary" }).waitFor();
  await field(page).fill(typed);
  await page.getByText(`${expected.length} / 50 terms`).waitFor();
  await shot(page, `${scope}-typed.desktop`);
  await button(page, "Save").click();
  await page.getByText("Saved. Dictation uses these now.").waitFor();
  assert.equal(await field(page).inputValue(), expected.join("\n"));
  assert.deepEqual(
    (await api("GET", apiPath)).terms,
    expected,
    `The ${scope} vocabulary was not stored.`,
  );
  await page.goto(url);
  await field(page).waitFor();
  assert.equal(
    await field(page).inputValue(),
    expected.join("\n"),
    `The ${scope} vocabulary did not survive a reload.`,
  );
  assert(
    await button(page, "Save").isDisabled(),
    "Save is enabled when clean.",
  );
  await shot(page, `${scope}-saved.desktop`);
  step(`${scope} vocabulary saves, normalizes, and reloads`, {
    terms: expected,
  });
};

const summary = {
  base,
  workspace: workspace?.shortName ?? null,
  workspaceAdmin: workspaceSlug !== undefined,
  steps,
};
try {
  const page = await context.newPage();
  watch(page);
  const personalPage = `${base}/settings/composer`;
  await page.goto(personalPage);
  await page.getByRole("heading", { name: "Composer", exact: true }).waitFor();
  await page
    .getByText("Enter one term per line, or separate terms with commas.")
    .waitFor();
  await shot(page, "01-personal.desktop");
  step("personal Composer page shows the Dictation Vocabulary card");

  await saveTerms(
    page,
    "personal",
    personalPage,
    personalApi,
    "dxd, Flue\n  Alchemy  \n\nflue\nRavindra Barthwal",
    ["dxd", "Flue", "Alchemy", "Ravindra Barthwal"],
  );

  await field(page).fill(`dxd\n${"x".repeat(65)}`);
  await page
    .getByRole("alert")
    .filter({ hasText: "Keep each term to 64 characters." })
    .waitFor();
  assert(
    await button(page, "Save").isDisabled(),
    "Save is enabled for a 65-character term.",
  );
  await shot(page, "personal-too-long.desktop");
  await button(page, "Reset").click();
  assert.equal(
    await field(page).inputValue(),
    "dxd\nFlue\nAlchemy\nRavindra Barthwal",
  );
  step("a term over 64 characters blocks Save; Reset restores the saved list");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(personalPage);
  await field(page).waitFor();
  await shot(page, "personal.mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  step("personal page renders at mobile width");

  if (workspaceSlug !== undefined) {
    const workspacePage = `${base}/workspaces/${workspaceSlug}/composer`;
    await saveTerms(
      page,
      "workspace",
      workspacePage,
      workspaceApi,
      "Orb, Sarvam\nDXD",
      ["Orb", "Sarvam", "DXD"],
    );
  }
} finally {
  await api("PUT", personalApi, { terms: original.personal });
  if (workspaceApi !== undefined)
    await api("PUT", workspaceApi, { terms: original.workspace });
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
  // Vite dev serves every source module separately; they prove nothing here.
  har.log.entries = har.log.entries.filter(
    ({ request }) =>
      !/^\/(@|src\/|node_modules\/)/.test(new URL(request.url).pathname),
  );
  for (const entry of har.log.entries) {
    for (const message of [entry.request, entry.response]) {
      message.headers = message.headers.filter(
        ({ name }) => !privateHeaders.has(name.toLowerCase()),
      );
      message.cookies = [];
    }
    if (entry.request.postData?.text?.includes(password))
      entry.request.postData.text = "[redacted]";
  }
  writeFileSync(harPath, JSON.stringify(har));
}
