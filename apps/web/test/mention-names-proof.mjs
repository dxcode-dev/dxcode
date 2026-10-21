// Proves that people who still have the username dx assigned at sign-up
// (`user-<24 hex>`) are tagged by name, and people who chose a username are
// tagged by it: in the composer's `@` suggestions, in sent messages, and on
// the member card. Runs against a supervised local `pnpm dev`, with fresh
// accounts each run, and drives a real Chromium over CDP.
//
// Owen (owner, default username) shares a Thread with his workspace; Bea
// (default username) tags Owen and Carol (chosen username); Carol reads it.
// No model is called: tagging only members is chat. Thread creation needs a
// connection that serves the default mode, so Owen adds a placeholder
// OpenAI key that nothing uses.
//
//   DX_PROOF_CDP=http://127.0.0.1:9222 \
//     node apps/web/test/mention-names-proof.mjs http://127.0.0.1:3000 <output dir>
//
// Writes screenshots, a captioned video of Bea's and Carol's screens, a HAR
// per browser context, console output, page errors, and summary.json to
// <output dir>; exits 1 when any check fails.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const [base, outputArgument = ".dx/journeys/mention-names"] =
  process.argv.slice(2);
assert(new URL(base).hostname === "127.0.0.1", "The journey is local-only.");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });

const run = Date.now().toString(36);
const DEFAULT_USERNAME = /^user-[0-9a-f]{24}$/;
const browser = await chromium.connectOverCDP(
  process.env.DX_PROOF_CDP ?? "http://127.0.0.1:9222",
);

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const consoleMessages = [];
const pageErrors = [];
const contexts = [];

/** A fresh account with its own browser context (cookies shared with its API). */
const account = async (key, name) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    recordHar: { path: join(output, `${key}.har`), content: "omit" },
    recordVideo: {
      dir: join(output, "video", key),
      size: { width: 1280, height: 820 },
    },
  });
  contexts.push(context);
  // The development-only render inspector draws over every frame.
  await context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () =>
      document.documentElement.append(style),
    );
  });
  const call = async (method, path, data) => {
    const response = await context.request.fetch(`${base}${path}`, {
      method,
      headers: { origin: base, "content-type": "application/json" },
      ...(data === undefined ? {} : { data }),
    });
    const body = await response.json().catch(() => undefined);
    assert(
      response.ok(),
      `${method} ${path} ${response.status()} ${JSON.stringify(body)}`,
    );
    return body?.data ?? body;
  };
  const email = `${key}-${run}@dx.local`;
  await call("POST", "/api/auth/sign-up/email", {
    name,
    email,
    password: `proof-${run}-password`,
  });
  const profile = await call("GET", "/v1/settings/personal/account");
  return { key, name, email, context, call, username: profile.username };
};

/** A banner over the page saying what the video shows, held long enough to read. */
const caption = async (page, text, hold = 1_800) => {
  await page.evaluate((text) => {
    let banner = document.getElementById("proof-caption");
    if (banner === null) {
      banner = document.createElement("div");
      banner.id = "proof-caption";
      banner.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:1100px;padding:10px 18px;border-radius:10px;background:#ffd400;color:#111;font:600 17px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);pointer-events:none;text-align:center";
      document.body.append(banner);
    }
    banner.textContent = text;
  }, text);
  await page.waitForTimeout(hold);
};
const humanType = (page, text) => page.keyboard.type(text, { delay: 110 });

const watch = (page, key) => {
  page.on("console", (message) =>
    consoleMessages.push({ key, type: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ key, error: String(error) }),
  );
};

let failed = false;
try {
  // Accounts. Owen and Bea keep the username the sign-up trigger assigns.
  const owen = await account("owen", "Owen Owner");
  const bea = await account("bea", "Bea Default");
  const carol = await account("carol", "Carol Chosen");
  const carolHandle = `carol-${run}`;
  await carol.call("PATCH", "/v1/settings/personal/account", {
    displayName: carol.name,
    username: carolHandle,
  });
  carol.username = (
    await carol.call("GET", "/v1/settings/personal/account")
  ).username;
  check("Owen and Bea have dx's default username; Carol chose one", true, {
    owen: owen.username,
    bea: bea.username,
    carol: carol.username,
  });
  assert.match(owen.username, DEFAULT_USERNAME);
  assert.match(bea.username, DEFAULT_USERNAME);
  assert.equal(carol.username, carolHandle);

  // Owen's workspace, its members, and a Thread shared with it.
  const workspace = await owen.call("POST", "/v1/settings/workspaces", {
    displayName: `Mention proof ${run}`,
    shortName: `mention-${run}`,
  });
  const invite = await owen.call(
    "POST",
    `/v1/settings/workspaces/${workspace.shortName}/invite-links`,
    { title: "mention proof" },
  );
  const token = new URL(invite.url).pathname.split("/").pop();
  await bea.call("POST", `/v1/invites/${token}/accept`, {});
  await carol.call("POST", `/v1/invites/${token}/accept`, {});
  await owen.call("POST", "/v1/settings/personal/model-routing/connections", {
    name: "Mention proof placeholder (never called)",
    kind: "provider",
    providerId: "openai",
    apiKey: "sk-mention-proof-never-called",
  });
  const thread = await owen.call("POST", "/v1/threads", {
    title: `Mention proof ${run}`,
    generateTitle: false,
  });
  await owen.call("PUT", `/v1/threads/${thread.id}/sharing`, {
    workspaceAccess: "contribute",
  });
  const members = (await bea.call("GET", `/v1/threads/${thread.id}/members`))
    .members;
  check(
    "the members API still carries usernames (the wire is unchanged)",
    members.some((member) => member.handle === owen.username) &&
      members.some((member) => member.handle === carolHandle),
    members.map(({ name, handle }) => ({ name, handle })),
  );

  // Bea opens the Thread and types `@`.
  const page = await bea.context.newPage();
  watch(page, "bea");
  // Members load once; listen before navigating so the response is not missed.
  const membersLoaded = page.waitForResponse((response) =>
    response.url().includes(`/v1/threads/${thread.id}/members`),
  );
  await page.goto(`${base}/threads/${thread.id}`);
  const textarea = page.locator('textarea[aria-label="Message"]');
  await textarea.waitFor();
  await membersLoaded;
  const options = () =>
    page.$$eval(
      '[role="listbox"][aria-label="Mention"] [role="option"]',
      (rows) =>
        rows.map((row) => ({
          tag:
            row.querySelector(".composer-mention-handle")?.textContent ?? null,
          name:
            row.querySelector(".composer-mention-name")?.textContent ?? null,
        })),
    );
  await caption(
    page,
    `Bea (default username) is in Owen's shared Thread. Owen: ${owen.username} (default). Carol: @${carolHandle} (chosen).`,
    3_500,
  );
  await textarea.click();
  await caption(page, "Bea types @ to tag someone…", 1_200);
  await humanType(page, "@");
  await page.locator('[role="listbox"][aria-label="Mention"]').waitFor();
  const offered = await options();
  const owenRow = offered.find(
    (row) => row.tag === "@Owen Owner" || row.name === "Owen Owner",
  );
  await caption(
    page,
    `Suggestions: Owen (default username) shows as ${owenRow?.tag ?? "nothing"}; Carol (chosen username) shows as @${carolHandle}`,
    4_500,
  );
  await page.screenshot({ path: join(output, "01-suggestions.png") });
  check(
    "suggestions show Owen (default username) as @Owen Owner, without a repeated name",
    offered.some((row) => row.tag === "@Owen Owner" && row.name === null),
    offered,
  );
  check(
    "suggestions show Carol (chosen username) as @username beside her name",
    offered.some(
      (row) => row.tag === `@${carolHandle}` && row.name === "Carol Chosen",
    ),
    offered,
  );
  check(
    "no suggestion shows a default user-<hex> username",
    offered.every((row) => !/user-[0-9a-f]{24}/.test(JSON.stringify(row))),
    offered,
  );

  await caption(page, "Typing the placeholder prefix @user…", 900);
  await humanType(page, "user");
  await page.waitForTimeout(400);
  const byDefaultHandle = (await options()).filter((row) => row.tag !== "@dx");
  check(
    "typing the placeholder prefix (@user) offers nobody",
    byDefaultHandle.length === 0,
    byDefaultHandle,
  );
  await caption(
    page,
    byDefaultHandle.length === 0
      ? "…offers nobody: a default username is not how people find Owen."
      : "…still offers members by their default username.",
    2_500,
  );
  await textarea.fill("");

  // Pick Owen by name and Carol by handle, then send.
  await caption(page, "Bea finds Owen by his name…", 900);
  await humanType(page, "@owen");
  await page.locator('[role="option"]', { hasText: "Owen Owner" }).waitFor();
  // Choosing inserts the tag and moves the caret on the next frame.
  const inserted = async (text) => {
    await page.waitForFunction(
      ([text]) => {
        const field = document.querySelector('textarea[aria-label="Message"]');
        return (
          field?.value.endsWith(text) &&
          field.selectionStart === field.value.length
        );
      },
      [text],
    );
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  };
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Enter");
  await inserted(`@${owen.username} `);
  await caption(
    page,
    "The draft keeps Owen's unique username: it is what the server resolves.",
    2_500,
  );
  await humanType(page, "and @car");
  await page
    .locator('[role="option"]', { hasText: `@${carolHandle}` })
    .waitFor();
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Enter");
  await inserted(`@${carolHandle} `);
  await humanType(page, "please review the plan");
  const draft = await textarea.inputValue();
  await page.screenshot({ path: join(output, "02-draft.png") });
  check(
    "the draft keeps the unique username, which the server resolves",
    draft === `@${owen.username} and @${carolHandle} please review the plan`,
    { draft },
  );
  await caption(page, "Bea sends it.", 1_000);
  await page.keyboard.press("Enter");

  const pills = page.locator(".user-message-text .message-mention");
  await pills.nth(1).waitFor();
  const shown = await pills.allTextContents();
  const messageText = await page
    .locator(".user-message-text")
    .last()
    .textContent();
  await caption(page, `Sent message tags: ${shown.join(" and ")}`, 4_000);
  await page.screenshot({ path: join(output, "03-sent-message.png") });
  check(
    "the sent message shows @Owen Owner and @<Carol's username>",
    JSON.stringify(shown) ===
      JSON.stringify(["@Owen Owner", `@${carolHandle}`]),
    { shown, messageText },
  );
  check(
    "the rendered message never shows a default user-<hex> username",
    !/user-[0-9a-f]{24}/.test(messageText ?? ""),
    { messageText },
  );

  await caption(page, "Bea opens Owen's card…", 900);
  await pills.nth(0).click();
  const owenCard = page.locator(".member-card");
  await owenCard.waitFor();
  const owenCardText = await owenCard.innerText();
  await caption(
    page,
    owenCardText.includes(owen.username)
      ? "Owen's card shows his placeholder username."
      : "Owen's card: name and email, no placeholder username.",
    3_500,
  );
  await page.screenshot({ path: join(output, "04-card-default-username.png") });
  check(
    "Owen's card shows his name and email, not the placeholder username",
    owenCardText.includes("Owen Owner") &&
      owenCardText.includes(owen.email) &&
      !owenCardText.includes(owen.username),
    { owenCardText },
  );
  await page.keyboard.press("Escape");
  await owenCard.waitFor({ state: "hidden" });
  await caption(page, "…and Carol's card.", 900);
  await pills.nth(1).click();
  const carolCard = page.locator(".member-card");
  await carolCard.waitFor();
  const carolCardText = await carolCard.innerText();
  await caption(page, "Carol's card keeps her chosen @username.", 3_500);
  await page.screenshot({ path: join(output, "05-card-chosen-username.png") });
  check(
    "Carol's card shows her chosen @username",
    carolCardText.includes("Carol Chosen") &&
      carolCardText.includes(`@${carolHandle}`),
    { carolCardText },
  );
  await page.keyboard.press("Escape");

  // Another member reads the same message.
  const carolPage = await carol.context.newPage();
  watch(carolPage, "carol");
  await carolPage.goto(`${base}/threads/${thread.id}`);
  const carolPills = carolPage.locator(".user-message-text .message-mention");
  await carolPills.nth(1).waitFor();
  const carolSees = await carolPills.allTextContents();
  await caption(
    carolPage,
    `Carol's screen: the same message reads ${carolSees.join(" and ")}`,
    4_000,
  );
  await carolPage.screenshot({ path: join(output, "06-carol-view.png") });
  check(
    "Carol sees the same tags",
    JSON.stringify(carolSees) ===
      JSON.stringify(["@Owen Owner", `@${carolHandle}`]),
    { carolSees },
  );

  // The tags still reach the right people.
  const owenInbox = await owen.call("GET", "/v1/notifications");
  const carolInbox = await carol.call("GET", "/v1/notifications");
  const fromBea = (inbox) =>
    inbox.items.filter((item) => item.threadId === thread.id);
  check(
    "Owen and Carol were each notified of Bea's tag",
    fromBea(owenInbox).length === 1 && fromBea(carolInbox).length === 1,
    { owen: fromBea(owenInbox), carol: fromBea(carolInbox) },
  );

  writeFileSync(
    join(output, "accounts.json"),
    `${JSON.stringify(
      {
        threadId: thread.id,
        owen: { name: owen.name, username: owen.username },
        bea: { name: bea.name, username: bea.username },
        carol: { name: carol.name, username: carol.username },
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  // Closing a context also finishes its video.
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const errors = consoleMessages.filter((message) => message.type === "error");
const passed = !failed && checks.every((entry) => entry.pass);
writeFileSync(
  join(output, "summary.json"),
  `${JSON.stringify({ base, run, passed, checks, pageErrors, consoleErrors: errors }, null, 2)}\n`,
);
writeFileSync(
  join(output, "console.json"),
  `${JSON.stringify(consoleMessages, null, 2)}\n`,
);
console.log(
  `${passed ? "PASSED" : "FAILED"}: ${checks.filter((entry) => entry.pass).length}/${checks.length} checks; ${pageErrors.length} page errors; ${errors.length} console errors. Evidence in ${output}`,
);
process.exit(passed ? 0 : 1);
