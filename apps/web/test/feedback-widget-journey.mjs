// Feedback Widget journey against a running `pnpm dev` (local) or a branch
// preview. It plays both sides: the dx admin who sets the widget up, and a
// person on the website who comments on elements and starts a Thread.
//
// 1. Turns on the experimental flag in Personal Settings, creates a project,
//    enables the widget in Project Settings, and allows the site's origin.
// 2. Serves a small website on :4100 with the copied script tag, opens it
//    with `?dx`, comments on elements across two pages, sends, signs in
//    through the consent popup, and starts a Thread.
// 3. Opens the Thread and checks its title, project, and first message.
// 4. Controls: an unlisted origin is refused in the page and by the API; a
//    site that is not allowed cannot frame the panel; the grant stays in the
//    panel's storage, not the website's; consent needs the dx origin; a
//    wrong verifier claims nothing; flag off refuses sending; Turn Off makes
//    the script inert and ends every grant.
//
// Writes a video, screenshots, a HAR without bodies, console.json, and
// summary.json to <output dir>.
//
//   node apps/web/test/feedback-widget-journey.mjs http://127.0.0.1:3000 out/
//
// The website is http://localhost:4100 by default: another site than
// 127.0.0.1, so cookies and storage are partitioned as in production. On a
// preview, set DX_PROOF_SITE_ORIGIN to an https address that forwards to
// :4100 (such as an Orb Portal). Credentials come from DX_PROOF_EMAIL /
// DX_PROOF_PASSWORD, or the local account in apps/core/.dev.vars.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, outputArgument] = process.argv.slice(2);
assert(base && outputArgument, "Usage: <dx base url> <output dir>");
const dxOrigin = new URL(base).origin;
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const devVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(devVars)
  ? parseEnv(readFileSync(devVars, "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? local.DX_LOCAL_AUTH_EMAIL;
const password = process.env.DX_PROOF_PASSWORD ?? local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "No proof account credentials.");
const siteOrigin = process.env.DX_PROOF_SITE_ORIGIN ?? "http://localhost:4100";
// Same server, an origin nobody allowed.
const unlistedOrigin = "http://127.0.0.1:4100";

// The website. Its pages carry the script tag the settings page shows.
let scriptTag = "";
const pageHtml = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Acme</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; color: #111; background: #fafaf9; }
nav { display: flex; gap: 16px; padding: 16px 32px; border-bottom: 1px solid #e7e5e4; }
main { padding: 48px 32px; max-width: 720px; }
h1 { font-size: 40px; margin: 0 0 12px; }
.cta { background: #ea580c; color: #fff; border: 0; border-radius: 8px; padding: 12px 20px; font-size: 16px; }
.plan { border: 1px solid #e7e5e4; border-radius: 12px; padding: 20px; margin-top: 16px; background: #fff; }
</style>
${scriptTag}
</head><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<main>${body}</main>
</body></html>`;
const site = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://site").pathname;
  if (path === "/frame") {
    // A page on an unlisted origin that tries to frame the panel.
    const clientId = /\/w?\/?(fbw_[a-z0-9]{24})/.exec(scriptTag)?.[1] ?? "";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><iframe id="panel" src="${dxOrigin}/api/feedback-widget/${clientId}/panel" width="400" height="400"></iframe>`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    path === "/pricing"
      ? pageHtml(
          "Pricing",
          `<h1>Pricing</h1><div class="plan" id="team-plan"><h2>Team</h2><p>$20 per seat</p></div>`,
        )
      : pageHtml(
          "Home",
          `<h1 id="hero-title">Ship faster with Acme</h1><p class="lede">The platform for teams that move quickly.</p><button class="cta" type="button">Start free trial</button>`,
        ),
  );
});
await new Promise((done) => site.listen(4100, "0.0.0.0", done));

const browser = await chromium.launch({
  executablePath: process.env.DX_PROOF_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  recordHar: { path: join(output, "network.har"), content: "omit" },
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
});
const signIn = await context.request.post(
  `${dxOrigin}/api/auth/sign-in/email`,
  {
    headers: { origin: dxOrigin },
    data: { email, password },
  },
);
assert.equal(signIn.status(), 200, "Password sign-in failed.");

const api = async (method, path, data, expected = [200, 201]) => {
  const response = await context.request.fetch(`${dxOrigin}${path}`, {
    method,
    headers: { origin: dxOrigin },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json().catch(() => undefined);
  assert(
    expected.includes(response.status()),
    `${method} ${path} answered ${response.status()}: ${JSON.stringify(body)}`,
  );
  return { status: response.status(), body };
};
/** A call from outside any browser session, as the panel or a script makes. */
const bare = async (method, path, init = {}) => {
  const response = await fetch(`${dxOrigin}${path}`, { method, ...init });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
};

const consoleMessages = [];
const pageErrors = [];
const checks = [];
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
context.on("page", watch);
const check = async (name, run) => {
  try {
    const detail = await run();
    checks.push({ name, passed: true, ...detail });
    console.log(`✓ ${name}`);
  } catch (error) {
    checks.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(
      `✗ ${name}\n  ${error instanceof Error ? error.message : error}`,
    );
  }
};
let shots = 0;
const shot = (page, name) =>
  page.screenshot({
    path: join(output, `${String(++shots).padStart(2, "0")}-${name}.png`),
  });

const featureOn = async (enabled) => {
  const { body } = await api(
    "GET",
    "/v1/settings/personal/experimental-features",
  );
  const flag = body.data.flags.find(
    ({ registration }) => registration.id === "feedback-widget",
  );
  assert(flag, "The feedback-widget flag is not registered.");
  return flag.effectiveEnabled === enabled;
};

const admin = await context.newPage();
let project;
let clientId;
let threadId;
let panelToken;

await check(
  "Feedback Widget is off by default and hidden in Project Settings",
  async () => {
    if (await featureOn(true)) {
      await admin.goto(`${dxOrigin}/settings/experimental-features`);
      await admin
        .getByRole("button", { name: "Disable Feedback Widget" })
        .click();
      await admin.waitForFunction(() => true);
      for (let i = 0; i < 20 && !(await featureOn(false)); i++)
        await admin.waitForTimeout(250);
    }
    // Locally a Thread needs a served model; the key is never used because
    // the local model fixture answers. A deployment has its own model.
    const loopback = ["127.0.0.1", "localhost"].includes(
      new URL(dxOrigin).hostname,
    );
    if (loopback) {
      const { body } = await api(
        "GET",
        "/v1/settings/personal/model-routing/connections",
      );
      if (!JSON.stringify(body).includes("feedback-widget-fixture"))
        await api("POST", "/v1/settings/personal/model-routing/connections", {
          name: "feedback-widget-fixture",
          kind: "provider",
          providerId: "openai",
          apiKey: "sk-local-fixture-never-used",
          enabled: true,
        });
    }
    const name = `acme-site-${Date.now().toString(36)}`;
    project = (
      await api("POST", "/v1/projects", {
        name,
        source: process.env.DX_PROOF_REPOSITORY_URL
          ? { kind: "github-url", url: process.env.DX_PROOF_REPOSITORY_URL }
          : loopback
            ? {
                kind: "github-url",
                url: "https://github.com/dxcode-dev/local-fixture.git",
              }
            : { kind: "scratch" },
      })
    ).body.data;
    await admin.goto(`${dxOrigin}/projects/${project.id}/settings`);
    await admin
      .getByRole("navigation", { name: "Project settings sections" })
      .waitFor();
    assert.equal(
      await admin.getByRole("link", { name: "Feedback Widget" }).count(),
      0,
      "The tab shows without the flag.",
    );
    const refused = await api(
      "POST",
      `/v1/projects/${project.id}/feedback-widget/enable`,
      undefined,
      [403],
    );
    assert.equal(refused.body.data.code, "FEEDBACK_WIDGET_FEATURE_DISABLED");
    await shot(admin, "project-settings-flag-off");
    return { project: project.id };
  },
);

await check("Turn on the experimental flag in Personal Settings", async () => {
  await admin.goto(`${dxOrigin}/settings/experimental-features`);
  const toggle = admin.getByRole("button", { name: "Enable Feedback Widget" });
  await toggle.waitFor();
  await shot(admin, "experimental-features-off");
  await toggle.click();
  await admin
    .getByRole("button", { name: "Disable Feedback Widget" })
    .waitFor();
  assert(await featureOn(true));
  await shot(admin, "experimental-features-on");
});

await check("Enable the widget and allow the site's origin", async () => {
  await admin.goto(`${dxOrigin}/projects/${project.id}/settings`);
  await admin.getByRole("link", { name: "Feedback Widget" }).click();
  await admin
    .getByRole("heading", { name: /Feedback Widget/ })
    .first()
    .waitFor();
  await shot(admin, "widget-off");
  await admin.getByRole("button", { name: "Enable" }).click();
  const code = admin.locator(".project-feedback-widget-code code");
  await code.waitFor();
  scriptTag = (await code.textContent()) ?? "";
  assert.match(
    scriptTag,
    new RegExp(
      `^<script src="${dxOrigin.replaceAll(".", "\\.")}/api/feedback-widget/fbw_[a-z0-9]{24}\\.js" async></script>$`,
    ),
  );
  clientId = /fbw_[a-z0-9]{24}/.exec(scriptTag)?.[0];
  // A full address is cut to its origin.
  await admin
    .getByRole("textbox", { name: "Origin" })
    .fill(`${siteOrigin}/some/page?x=1`);
  await admin.getByRole("button", { name: "Add origin" }).click();
  await admin
    .getByRole("list", { name: "Allowed origins" })
    .getByText(siteOrigin, { exact: true })
    .waitFor();
  // Plain http on a public host is refused.
  await admin
    .getByRole("textbox", { name: "Origin" })
    .fill("http://example.com");
  await admin.getByRole("button", { name: "Add origin" }).click();
  await admin
    .getByText("Enter an https address, or http on localhost")
    .waitFor();
  await admin.getByRole("textbox", { name: "Origin" }).fill("");
  const { body } = await api(
    "GET",
    `/v1/projects/${project.id}/feedback-widget`,
  );
  assert.deepEqual(body.data.allowedOrigins, [siteOrigin]);
  assert.equal(body.data.enabled, true);
  await shot(admin, "widget-on");
  return { scriptTag, allowedOrigins: body.data.allowedOrigins };
});

const visitor = await context.newPage();
const widget = visitor.locator("dx-feedback-widget");
const launcher = widget.locator(".launcher");

const comment = async (target, text) => {
  await target.click();
  const editor = widget.getByRole("textbox", { name: "Comment" });
  await editor.waitFor();
  await editor.fill(text);
};

await check(
  "The widget stays hidden until ?dx, then remembers the site",
  async () => {
    await visitor.goto(`${siteOrigin}/`);
    await visitor.waitForFunction(
      () => window.__dxFeedbackWidget !== undefined,
    );
    assert.equal(await launcher.isVisible(), false, "Visible without ?dx.");
    await visitor.goto(`${siteOrigin}/?dx`);
    await launcher.waitFor();
    await shot(visitor, "site-with-dx");
    await visitor.goto(`${siteOrigin}/pricing`);
    await launcher.waitFor();
    // Ctrl+. hides and shows it.
    await visitor.keyboard.press("Control+Period");
    await launcher.waitFor({ state: "hidden" });
    await visitor.keyboard.press("Control+Period");
    await launcher.waitFor();
  },
);

await check("Comment on elements across two pages", async () => {
  await visitor.goto(`${siteOrigin}/`);
  await launcher.click();
  await widget
    .getByText("Click an element on the page to point at it")
    .waitFor();
  await visitor.locator("#hero-title").hover();
  await shot(visitor, "picking-highlight");
  await comment(
    visitor.locator("#hero-title"),
    "Make this headline say: Ship twice as fast with Acme",
  );
  await shot(visitor, "comment-editor");
  await widget.getByRole("button", { name: "Add" }).click();
  await widget.getByRole("button", { name: "New Comment" }).click();
  await comment(
    visitor.locator("button.cta"),
    "Rename this button to Start your free trial and make it green",
  );
  await visitor.keyboard.press("Enter");
  await widget.getByText("Start your free trial and make it green").waitFor();
  await visitor.goto(`${siteOrigin}/pricing`);
  await launcher.click();
  await widget.getByRole("button", { name: "New Comment" }).click();
  await comment(
    visitor.locator("#team-plan"),
    "Add a yearly price of $200 per seat under the monthly one",
  );
  await widget.getByRole("button", { name: "Add" }).click();
  await widget.getByText("$200 per seat").waitFor();
  // A comment can be edited, and one added by mistake deleted.
  await widget.getByRole("button", { name: "Edit comment 3" }).click();
  const editor = widget.getByRole("textbox", { name: "Comment" });
  await editor.fill(
    "Add a yearly price of $200 per seat under the monthly one, in grey",
  );
  await widget.getByRole("button", { name: "Save" }).click();
  await widget.getByText("in grey").waitFor();
  await widget.getByRole("button", { name: "New Comment" }).click();
  await comment(visitor.locator("h1"), "Throwaway comment");
  await widget.getByRole("button", { name: "Add" }).click();
  await widget.getByText("Throwaway comment").waitFor();
  await widget.getByRole("button", { name: "Delete comment 4" }).click();
  await widget.getByText("Throwaway comment").waitFor({ state: "detached" });
  assert.equal(await launcher.locator(".count").textContent(), "3");
  await shot(visitor, "three-comments");
});

const panel = visitor.frameLocator('iframe[title="Send to dx"]');

await check("Send, sign in with consent, and start a Thread", async () => {
  await widget.getByRole("button", { name: "Send" }).click();
  await panel.getByRole("button", { name: "Continue with dx" }).waitFor();
  await shot(visitor, "panel-signed-out");
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    panel.getByRole("button", { name: "Continue with dx" }).click(),
  ]);
  await popup
    .getByRole("heading", { name: /Allow the Feedback Widget/ })
    .waitFor();
  assert.equal(new URL(popup.url()).origin, dxOrigin);
  await shot(popup, "consent");
  await popup.getByRole("button", { name: "Allow" }).click();
  // The popup closes itself once the panel has the grant.
  await popup.waitForEvent("close", { timeout: 15_000 });
  await panel
    .getByRole("button", { name: "Start in Orb" })
    .waitFor({ timeout: 20_000 });
  await panel.getByText(`Signed in as ${email}`).waitFor();
  await shot(visitor, "panel-ready");
  const panelFrame = visitor
    .frames()
    .find((frame) => frame.url().includes("/panel"));
  panelToken = await panelFrame?.evaluate(
    (key) => localStorage.getItem(key),
    `dx-feedback-widget:${clientId}:token`,
  );
  assert.match(panelToken ?? "", /^dxw_/);
  await panel.getByRole("button", { name: "Start in Orb" }).click();
  await panel
    .getByRole("heading", { name: "Sent to dx" })
    .waitFor({ timeout: 30_000 });
  await shot(visitor, "thread-started");
  const href = await panel
    .getByRole("link", { name: "Open Thread" })
    .getAttribute("href");
  threadId = /thr_[0-9a-f-]+/.exec(href ?? "")?.[0];
  assert(threadId, `No Thread in ${href}`);
  assert.equal(href, `${dxOrigin}/threads/${threadId}`);
  return { threadId };
});

await check(
  "The website never holds the grant, and sent comments clear",
  async () => {
    const siteStorage = await visitor.evaluate(() =>
      JSON.stringify(localStorage),
    );
    assert(!siteStorage.includes("dxw_"), "The website can read the grant.");
    await panel.getByRole("button", { name: "Done" }).click();
    await visitor
      .locator('iframe[title="Send to dx"]')
      .waitFor({ state: "detached" });
    assert.equal(await launcher.locator(".count").count(), 0);
  },
);

await check(
  "Open Thread shows the Thread in the project with every comment",
  async () => {
    const [threadPage] = await Promise.all([
      context.waitForEvent("page"),
      (async () => {
        await widget.getByRole("button", { name: "Send" }).count();
        await visitor.evaluate(
          (url) => window.open(url, "_blank"),
          `${dxOrigin}/threads/${threadId}`,
        );
      })(),
    ]);
    await threadPage.waitForLoadState("domcontentloaded");
    await threadPage
      .getByText("Make this headline say: Ship twice as fast with Acme")
      .first()
      .waitFor({ timeout: 30_000 });
    await shot(threadPage, "thread");
    const { body } = await api("GET", `/v1/threads/${threadId}`);
    assert.equal(body.data.title, `Website: ${new URL(siteOrigin).host}`);
    assert.equal(body.data.projectId, project.id);
    const text = await threadPage.locator("body").innerText();
    for (const expected of [
      "Rename this button to Start your free trial and make it green",
      "Add a yearly price of $200 per seat under the monthly one",
    ])
      assert(text.includes(expected), `Thread lacks: ${expected}`);
    return { title: body.data.title, projectId: body.data.projectId };
  },
);

await check(
  "An unlisted origin is refused in the page and by the API",
  async () => {
    await visitor.goto(`${unlistedOrigin}/?dx`);
    await launcher.click();
    await comment(visitor.locator("#hero-title"), "Anything");
    await widget.getByRole("button", { name: "Add" }).click();
    await widget.getByRole("button", { name: "Send" }).click();
    await widget
      .getByText("isn't an allowed origin for this dx Project")
      .waitFor();
    assert.equal(
      await visitor.locator('iframe[title="Send to dx"]').count(),
      0,
    );
    await shot(visitor, "unlisted-origin");
    const refused = await bare(
      "POST",
      `/api/feedback-widget/${clientId}/threads`,
      {
        headers: {
          authorization: `Bearer ${panelToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          comments: [
            {
              pageUrl: `${unlistedOrigin}/`,
              selector: "h1",
              element: "<h1>",
              text: "",
              comment: "x",
            },
          ],
        }),
      },
    );
    assert.equal(refused.status, 403, refused.text);
    assert.match(refused.text, /FEEDBACK_WIDGET_ORIGIN_NOT_ALLOWED/);
  },
);

await check("Only allowed origins can frame the panel", async () => {
  const response = await bare("GET", `/api/feedback-widget/${clientId}/panel`);
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(
    policy,
    new RegExp(`frame-ancestors ${siteOrigin.replaceAll(".", "\\.")}(;|$)`),
  );
  const framer = await context.newPage();
  const blocked = framer.waitForEvent("console", {
    predicate: (message) =>
      /frame-ancestors|Refused to frame/i.test(message.text()),
    timeout: 10_000,
  });
  await framer.goto(`${unlistedOrigin}/frame`);
  await blocked;
  await shot(framer, "framing-refused");
  await framer.close();
  return { frameAncestors: policy.match(/frame-ancestors [^;]+/)?.[0] };
});

await check(
  "Consent needs the dx origin, and a wrong verifier claims nothing",
  async () => {
    const forged = await bare(
      "POST",
      `/api/feedback-widget/${clientId}/authorize`,
      {
        headers: {
          origin: unlistedOrigin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `challenge=${"a".repeat(64)}`,
      },
    );
    assert.equal(forged.status, 403);
    const wrong = await bare("POST", `/api/feedback-widget/${clientId}/token`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifier: "x".repeat(43) }),
    });
    assert.equal(wrong.status, 202, wrong.text);
    assert.match(wrong.text, /AUTHORIZATION_PENDING/);
    const noGrant = await bare("GET", `/api/feedback-widget/${clientId}/me`);
    assert.equal(noGrant.status, 401);
  },
);

await check("With the flag off, the panel refuses to send", async () => {
  await admin.goto(`${dxOrigin}/settings/experimental-features`);
  await admin.getByRole("button", { name: "Disable Feedback Widget" }).click();
  await admin.getByRole("button", { name: "Enable Feedback Widget" }).waitFor();
  const me = await bare("GET", `/api/feedback-widget/${clientId}/me`, {
    headers: { authorization: `Bearer ${panelToken}` },
  });
  assert.equal(me.status, 200);
  assert.equal(JSON.parse(me.text).data.readiness, "feature-disabled");
  await visitor.goto(`${siteOrigin}/`);
  await launcher.click();
  await comment(visitor.locator("#hero-title"), "Try while the flag is off");
  await widget.getByRole("button", { name: "Add" }).click();
  await widget.getByRole("button", { name: "Send" }).click();
  await panel.getByText("Turn on Feedback Widget in dx").waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Start in Orb" }).isDisabled(),
    true,
  );
  await shot(visitor, "flag-off-panel");
  const sent = await bare("POST", `/api/feedback-widget/${clientId}/threads`, {
    headers: {
      authorization: `Bearer ${panelToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      comments: [
        {
          pageUrl: `${siteOrigin}/`,
          selector: "h1",
          element: "<h1>",
          text: "",
          comment: "x",
        },
      ],
    }),
  });
  assert.equal(sent.status, 403);
  assert.match(sent.text, /FEEDBACK_WIDGET_FEATURE_DISABLED/);
  await admin.getByRole("button", { name: "Enable Feedback Widget" }).click();
  await admin
    .getByRole("button", { name: "Disable Feedback Widget" })
    .waitFor();
});

await check(
  "Show on dx: send feedback about dx itself to the project",
  async () => {
    // The dx app is a site too: allow its origin, choose the project under
    // the flag, and the widget loads in dx with ?dx.
    await api("POST", `/v1/projects/${project.id}/feedback-widget/origins`, {
      origin: dxOrigin,
    });
    await api("PUT", "/v1/settings/personal/feedback-widget", {
      scriptUrl: null,
    });
    await admin.goto(`${dxOrigin}/settings/experimental-features`);
    const choice = admin.getByRole("combobox", {
      name: "Project that receives feedback about dx",
    });
    await choice.waitFor();
    // Another dx host takes a pasted script tag; nonsense is refused.
    await choice.selectOption({ label: "Another dx host…" });
    const paste = admin.getByRole("textbox", {
      name: "Script tag from another dx host",
    });
    await paste.fill("not a script tag");
    await admin.getByText("Paste the Script Tag from a project's").waitFor();
    assert.equal(
      await admin
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled(),
      true,
    );
    await shot(admin, "show-on-dx-other-host");
    await admin.getByRole("button", { name: "Cancel" }).click();
    const options = await choice.locator("option").allTextContents();
    const label = options.find((text) => text.endsWith(`/${project.name}`));
    assert(label, `No option for ${project.name}: ${options.join(", ")}`);
    await choice.selectOption({ label });
    await admin.getByText("Reload dx to switch the Feedback Widget.").waitFor();
    await shot(admin, "show-on-dx-chosen");
    await admin.goto(`${dxOrigin}/settings/experimental-features?dx`);
    const inDx = admin.locator("dx-feedback-widget");
    await inDx.locator(".launcher").waitFor({ timeout: 20_000 });
    await inDx.locator(".launcher").click();
    await admin.getByRole("heading", { name: "Experimental Features" }).click();
    const box = inDx.getByRole("textbox", { name: "Comment" });
    await box.fill("Feedback about dx, sent from inside dx");
    await inDx.getByRole("button", { name: "Add" }).click();
    await shot(admin, "show-on-dx-comment");
    await inDx.getByRole("button", { name: "Send" }).click();
    const dxPanel = admin.frameLocator('iframe[title="Send to dx"]');
    const startInOrb = dxPanel.getByRole("button", { name: "Start in Orb" });
    const continueWithDx = dxPanel.getByRole("button", {
      name: "Continue with dx",
    });
    await startInOrb.or(continueWithDx).waitFor({ timeout: 20_000 });
    // A browser that does not partition the panel's storage between sites
    // already holds the grant from the website above.
    const signIn = await continueWithDx.isVisible();
    if (signIn) {
      const [popup] = await Promise.all([
        context.waitForEvent("page"),
        continueWithDx.click(),
      ]);
      await popup.getByRole("button", { name: "Allow" }).click();
      await popup.waitForEvent("close", { timeout: 15_000 });
    }
    await dxPanel
      .getByRole("button", { name: "Start in Orb" })
      .click({ timeout: 20_000 });
    await dxPanel
      .getByRole("heading", { name: "Sent to dx" })
      .waitFor({ timeout: 30_000 });
    await shot(admin, "show-on-dx-sent");
    const href = await dxPanel
      .getByRole("link", { name: "Open Thread" })
      .getAttribute("href");
    const id = /thr_[0-9a-f-]+/.exec(href ?? "")?.[0];
    const { body } = await api("GET", `/v1/threads/${id}`);
    assert.equal(body.data.title, `Website: ${new URL(dxOrigin).host}`);
    assert.equal(body.data.projectId, project.id);
    // Off again, so the next run starts clean.
    await api("PUT", "/v1/settings/personal/feedback-widget", {
      scriptUrl: null,
    });
    return { threadId: id, signedInAgain: signIn };
  },
);

await check(
  "Turn Off makes the script inert and ends every grant",
  async () => {
    await admin.goto(
      `${dxOrigin}/projects/${project.id}/settings/feedback-widget`,
    );
    await admin.getByRole("button", { name: "Turn Off" }).click();
    await shot(admin, "turn-off-confirm");
    await admin
      .getByRole("dialog")
      .getByRole("button", { name: "Turn Off" })
      .click();
    await admin.getByRole("button", { name: "Enable" }).waitFor();
    const script = await bare("GET", `/api/feedback-widget/${clientId}.js`);
    assert.match(script.text, /turned off/);
    assert(!script.text.includes("dxFeedbackWidget("));
    const me = await bare("GET", `/api/feedback-widget/${clientId}/me`, {
      headers: { authorization: `Bearer ${panelToken}` },
    });
    assert.equal(me.status, 404);
    const { body } = await api(
      "GET",
      `/v1/projects/${project.id}/feedback-widget`,
    );
    assert.equal(body.data.enabled, false);
    assert(
      body.data.allowedOrigins.includes(siteOrigin),
      "Origins should stay.",
    );
    // Turning it on again issues a new client ID.
    await admin.getByRole("button", { name: "Enable" }).click();
    const code = admin.locator(".project-feedback-widget-code code");
    await code.waitFor();
    assert(!((await code.textContent()) ?? "").includes(clientId));
    await shot(admin, "re-enabled-new-id");
  },
);

const failed = checks.filter((check) => !check.passed);
const appErrors = pageErrors.filter(({ url }) => !url.startsWith("about:"));
await context.close();
await browser.close();
site.close();
writeFileSync(
  join(output, "console.json"),
  JSON.stringify({ consoleMessages, pageErrors }, null, 2),
);
writeFileSync(
  join(output, "summary.json"),
  JSON.stringify(
    {
      base: dxOrigin,
      siteOrigin,
      projectId: project?.id,
      clientId,
      threadId,
      checks,
      pageErrors: appErrors.length,
    },
    null,
    2,
  ),
);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; ${appErrors.length} page errors.`,
);
if (failed.length > 0) process.exit(1);
