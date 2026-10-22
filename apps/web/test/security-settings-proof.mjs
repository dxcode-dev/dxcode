// Personal Security settings journey against a running `pnpm dev` (local) or
// a branch preview. Signs one account in from four browsers it creates, then
// drives the page: create, copy, use, rotate, and revoke an access token, and
// sign out one session and the others. Each step checks the server outcome
// with a separate request, not only the UI. Writes desktop (1440) and mobile
// (390) screenshots, a HAR without private headers, console.json, and
// summary.json to <output>.
//
//   node apps/web/test/security-settings-proof.mjs http://127.0.0.1:3000 out/
//
// The account may be shared (the preview reviewer login), so the journey only
// touches sessions and tokens it created: it finds rows by its own session
// IDs, uses "Sign out other sessions" only when every other session is its
// own, and signs its browsers out and revokes its token even when a step
// fails.
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
const userAgents = {
  desktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0",
};
const securityPath = "/v1/settings/personal/security";
const tokensPath = `${securityPath}/tokens`;
const unsafe = { headers: { origin: base } };

// Every session this run signs in, by session ID.
const own = new Map();
const listSessions = async (context) => {
  const items = [];
  let offset = 0;
  for (;;) {
    const response = await context.request.get(
      `${base}${securityPath}/sessions?limit=100&offset=${offset}`,
    );
    assert.equal(response.status(), 200, "Session list failed.");
    const page = (await response.json()).data;
    items.push(...page.items);
    if (page.nextOffset === undefined) return items;
    offset = page.nextOffset;
  }
};

// Better Auth admits three password sign-ins per IP until ten quiet seconds
// pass since the last one.
let lastSignIn = 0;
const signedInContext = async (userAgent, options = {}) => {
  const wait = lastSignIn + 11_000 - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  lastSignIn = Date.now();
  const context = await browser.newContext({
    userAgent,
    locale: "en-US",
    ...options,
  });
  const response = await context.request.post(
    `${base}/api/auth/sign-in/email`,
    { headers: { origin: base }, data: { email, password } },
  );
  assert.equal(response.status(), 200, "Password sign-in failed.");
  const first = await context.request.get(
    `${base}${securityPath}/sessions?limit=1`,
  );
  const current = (await first.json()).data.items[0];
  assert.equal(current?.isCurrent, true, "The current session is not first.");
  own.set(current.id, context);
  context.sessionId = current.id;
  return context;
};
// The security routes read the session from D1, so they see a revocation at
// once. Other routes accept Better Auth's signed session cookie cache until it
// expires; summary.json records what they answered after each sign-out.
const sessionLive = async (context) =>
  (await context.request.get(`${base}${tokensPath}`)).status() === 200;
const cachedAccess = async (context) =>
  (await context.request.get(`${base}/v1/projects`)).status();
const afterSignOut = {};
const anonymous = await browser.newContext();
const bearerStatus = async (plaintext) =>
  (
    await anonymous.request.get(`${base}/v1/projects`, {
      headers: { authorization: `Bearer ${plaintext}` },
    })
  ).status();

const consoleMessages = [];
const pageErrors = [];
const steps = [];
const signOutOthers = {};
const cleanup = [];
let tokenId;
let main;
let iphone;
let iphoneTwo;
let firefox;
let page;
try {
  main = await signedInContext(userAgents.desktop, {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"],
    recordHar: { path: join(output, "network.har"), content: "omit" },
  });
  iphone = await signedInContext(userAgents.iphone);
  iphoneTwo = await signedInContext(userAgents.iphone);
  firefox = await signedInContext(userAgents.firefox);

  // Hide the development-only render inspector.
  await main.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () =>
      document.documentElement.append(style),
    );
  });
  page = await main.newPage();
  page.on("console", (message) =>
    consoleMessages.push({ type: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const step = async (name, run) => {
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      await page
        .screenshot({ path: join(output, "failure.png") })
        .catch(() => {});
      console.error(`✗ ${name} at ${page.url()}`);
      throw error;
    }
    steps.push({ name, ms: Date.now() - started });
    console.log(`✓ ${name}`);
  };
  const shot = async (name, viewport = "desktop") => {
    await page.setViewportSize(
      viewport === "desktop"
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 },
    );
    // Never write a token plaintext into the evidence.
    await page.screenshot({
      path: join(output, `${name}.${viewport}.png`),
      mask: [page.getByRole("textbox", { name: "Personal API token" })],
    });
  };
  const tokenName = `Proof ${new Date().toISOString().slice(11, 19)}`;
  const tokenRow = () =>
    page.locator(".security-row", { has: page.getByText(tokenName) });
  const sessionsCard = () =>
    page.locator(".security-card", {
      has: page.getByRole("heading", { name: "Active sessions" }),
    });
  const sessionRow = (context) =>
    page.locator(`.security-row[data-session-id="${context.sessionId}"]`);
  const signOutRow = async (context) => {
    await sessionRow(context)
      .getByRole("button", { name: /^Sign out / })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sign out" })
      .click();
    await sessionRow(context).waitFor({ state: "detached" });
  };
  const plaintext = () =>
    page.getByRole("textbox", { name: "Personal API token" }).inputValue();
  let created = "";
  let rotated = "";

  await step("Security is in the personal settings menu", async () => {
    await page.goto(`${base}/settings`);
    await page.getByRole("link", { name: "Security" }).click();
    await page.waitForURL(/\/settings\/security$/);
    await page.getByRole("heading", { name: "Security", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Access tokens" }).waitFor();
    await page.getByRole("heading", { name: "Active sessions" }).waitFor();
    assert.equal(await page.getByText(/passkey/i).count(), 0);
  });

  await step("a new token is shown once and copies exactly", async () => {
    await page.getByRole("button", { name: "New token" }).click();
    await page.getByRole("checkbox", { name: /Read projects/ }).check();
    await page.getByLabel("Name").fill(tokenName);
    await shot("02-new-token-dialog", "mobile");
    await shot("02-new-token-dialog");
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(tokensPath) &&
        candidate.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create token" }).click();
    tokenId = (await (await response).json()).data.token.id;
    created = await plaintext();
    assert.match(created, /^dxu_/);
    await page.getByRole("button", { name: "Copy" }).click();
    await page.getByText("Token copied.").waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      created,
    );
    await shot("03-token-shown-once");
    await page.getByRole("button", { name: "Done" }).click();
    await tokenRow().getByText("Read projects · Never used").waitFor();
  });

  await step(
    "the token authenticates an API call within its scope",
    async () => {
      assert.equal(await bearerStatus(created), 200);
      const write = await anonymous.request.post(`${base}/v1/projects`, {
        headers: { authorization: `Bearer ${created}` },
        data: { name: "outside-token-scope", source: { kind: "scratch" } },
      });
      assert.equal(write.status(), 403);
      await page.reload();
      await tokenRow()
        .getByText(/Last used just now/)
        .waitFor();
    },
  );

  await step(
    "this device is listed first, with every own browser",
    async () => {
      const first = sessionsCard().locator(".security-row").first();
      await first.getByText("This device").waitFor();
      assert.equal(await first.getAttribute("data-session-id"), main.sessionId);
      assert.equal(await first.getByRole("button").count(), 0);
      for (const context of [iphone, iphoneTwo, firefox]) {
        await sessionRow(context).waitFor();
      }
      await page
        .getByRole("button", { name: "Sign out other sessions" })
        .waitFor();
      await shot("01-security", "mobile");
      await shot("01-security");
    },
  );

  await step(
    "two rows for the same browser have distinct button names",
    async () => {
      const names = [];
      for (const context of [iphone, iphoneTwo]) {
        const button = sessionRow(context).getByRole("button");
        const snapshot = await button.ariaSnapshot();
        assert.match(
          snapshot,
          /Sign out Safari on iOS, .+, active .+, signed in /,
        );
        names.push(snapshot);
      }
      assert.notEqual(names[0], names[1]);
    },
  );

  await step("a failed refresh keeps the list and says so", async () => {
    await page.route(`**${tokensPath}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 503, body: "" })
        : route.fallback(),
    );
    // Refetch on focus, as returning to the tab would.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    const banner = page.getByRole("alert").filter({
      hasText: "Tokens could not be refreshed",
    });
    await banner.waitFor();
    await tokenRow().waitFor();
    await shot("06-refresh-failed");
    await page.unroute(`**${tokensPath}`);
    await banner.getByRole("button", { name: "Retry" }).click();
    await banner.waitFor({ state: "detached" });
    await tokenRow().waitFor();
  });

  await step("rotating replaces the token", async () => {
    const response = page.waitForResponse((candidate) =>
      candidate.url().endsWith("/rotate"),
    );
    await page
      .getByRole("button", { name: new RegExp(`^Rotate ${tokenName} `) })
      .click();
    await page.getByRole("button", { name: "Rotate token" }).click();
    tokenId = (await (await response).json()).data.token.id;
    rotated = await plaintext();
    assert.notEqual(rotated, created);
    await page.getByRole("button", { name: "Done" }).click();
    assert.equal(await bearerStatus(created), 401);
    assert.equal(await bearerStatus(rotated), 200);
    assert.equal(await tokenRow().count(), 1);
  });

  await step("revoking removes the token", async () => {
    await page
      .getByRole("button", { name: new RegExp(`^Revoke ${tokenName} `) })
      .click();
    await shot("04-revoke-confirm", "mobile");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Revoke token" }).click();
    await tokenRow().waitFor({ state: "detached" });
    assert.equal(await bearerStatus(rotated), 401);
    tokenId = undefined;
  });

  await step("signing out one session ends only that session", async () => {
    await signOutRow(iphone);
    own.delete(iphone.sessionId);
    assert.equal(await sessionLive(iphone), false);
    for (const context of [iphoneTwo, firefox, main]) {
      assert.equal(await sessionLive(context), true);
    }
    afterSignOut.iphoneProjectsStatus = await cachedAccess(iphone);
  });

  await step("signing out other sessions keeps this device", async () => {
    const others = (await listSessions(main)).filter(
      (session) => !session.isCurrent,
    );
    const foreign = others.filter((session) => !own.has(session.id));
    if (foreign.length === 0) {
      await page
        .getByRole("button", { name: "Sign out other sessions" })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Sign out" })
        .click();
      await page
        .getByRole("button", { name: "Sign out other sessions" })
        .waitFor({ state: "detached" });
      assert.equal(await sessionsCard().locator(".security-row").count(), 1);
      signOutOthers.method = "Sign out other sessions";
    } else {
      // Other people's browsers share this account: end only our own.
      await signOutRow(iphoneTwo);
      await signOutRow(firefox);
      signOutOthers.method = "each own row";
      signOutOthers.skippedBulkBecauseForeignSessions = foreign.length;
    }
    own.delete(iphoneTwo.sessionId);
    own.delete(firefox.sessionId);
    assert.equal(await sessionLive(iphoneTwo), false);
    assert.equal(await sessionLive(firefox), false);
    assert.equal(await sessionLive(main), true);
    afterSignOut.firefoxProjectsStatus = await cachedAccess(firefox);
    await shot("05-signed-out-others", "mobile");
    await shot("05-signed-out-others");
  });
} finally {
  // Leave the account as it was: our token revoked, our browsers signed out.
  if (tokenId !== undefined) {
    const response = await main.request.delete(
      `${base}${tokensPath}/${tokenId}`,
      unsafe,
    );
    cleanup.push({ revokeToken: response.status() });
  }
  for (const context of own.values()) {
    const response = await context.request.post(`${base}/api/auth/sign-out`, {
      ...unsafe,
      data: {},
    });
    cleanup.push({
      signOut: response.status(),
      live: await sessionLive(context),
    });
  }
  await main?.close();
  await browser.close();
}

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
const errors = consoleMessages.filter(({ type }) => type === "error");
writeFileSync(
  join(output, "console.json"),
  `${JSON.stringify({ console: consoleMessages, pageErrors }, null, 2)}\n`,
);
writeFileSync(
  join(output, "summary.json"),
  `${JSON.stringify(
    {
      base,
      steps,
      signOutOthers,
      cleanup,
      afterSignOut,
      consoleErrors: errors.length,
      pageErrors: pageErrors.length,
    },
    null,
    2,
  )}\n`,
);
assert.deepEqual(pageErrors, [], "Page errors were raised.");
assert(
  cleanup.every(({ live }) => live !== true),
  "A session this run created is still signed in.",
);
console.log(`Wrote ${output}`);
