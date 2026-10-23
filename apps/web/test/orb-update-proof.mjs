// An Orb provider connection updated under a running Orb, end to end,
// against a deployment. It connects the signed-in person's own provider
// account and starts a Thread whose Orb writes a marker file and leaves a
// background process running. Then it runs the deploy command, which ships a
// new preparation recipe (an Orb image or account Orb Worker change), and
// keeps the Thread active meanwhile. While the connection prepares the new
// version it checks that new Threads still start, on the last ready version.
// Afterwards it asks the same Thread for the marker, the process, and the
// container's uptime: the Orb kept its files and processes, and its uptime
// kept growing, so the update never restarted it. Writes screenshots, a WebM,
// a HAR without bodies or credentials, console.json, and summary.json.
//
//   DX_PROOF_PROVIDER=cloudflare \
//   DX_PROOF_CREDENTIALS='{"accountId":"…","apiToken":"…"}' \
//     node apps/web/test/orb-update-proof.mjs https://<preview> out/ -- \
//       node scripts/run-alchemy-deployment.mjs deploy
//
// Sign-in comes from DX_PROOF_EMAIL / DX_PROOF_PASSWORD; DX_PROOF_CHROMIUM
// picks the browser. The run refuses an account that already has a
// connection for the provider, and removes the connection it made.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const separator = process.argv.indexOf("--");
const [base, outputArgument] = process.argv.slice(2, separator);
const deployCommand = process.argv.slice(separator + 1);
assert(
  base && outputArgument && separator > 0 && deployCommand.length > 0,
  "Usage: <base url> <output dir> -- <deploy command>",
);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const email = process.env.DX_PROOF_EMAIL;
const password = process.env.DX_PROOF_PASSWORD;
assert(email && password, "Set DX_PROOF_EMAIL and DX_PROOF_PASSWORD.");
const providerId = process.env.DX_PROOF_PROVIDER ?? "cloudflare";
const credentials = JSON.parse(process.env.DX_PROOF_CREDENTIALS ?? "{}");
const PREPARE_TIMEOUT_MS = 30 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const KEEPALIVE_MS = 90_000;

const browser = await chromium.launch(
  process.env.DX_PROOF_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.DX_PROOF_CHROMIUM },
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  recordHar: { path: join(output, "network.har"), content: "omit" },
  recordVideo: {
    dir: join(output, "video"),
    size: { width: 1440, height: 900 },
  },
});
const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email, password },
});
assert.equal(signIn.status(), 200, "Password sign-in failed.");

const request = async (method, path, data) => {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    headers: { origin: base },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), body: await response.json() };
};
const api = async (method, path, data) => {
  const { status, body } = await request(method, path, data);
  assert(
    status >= 200 && status < 300,
    `${method} ${path} answered ${status}: ${JSON.stringify(body)}`,
  );
  return body.data;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const consoleMessages = [];
const pageErrors = [];
const steps = [];
const started = Date.now();
const step = (name, detail = {}) => {
  steps.push({ name, atMs: Date.now() - started, ...detail });
  console.log(`✓ ${name}`);
};
const page = await context.newPage();
page.on("console", (message) =>
  consoleMessages.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push({ message: error.message }));
const shot = (name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const providersBase = "/v1/settings/personal/orb-providers";
const list = () => api("GET", providersBase);
const providerOf = (data) => data.providers.find(({ id }) => id === providerId);
const waitReady = async (label) => {
  const since = Date.now();
  for (;;) {
    const connection = providerOf(await list()).connection;
    if (connection?.status === "ready") return Date.now() - since;
    assert.notEqual(
      connection?.status,
      "failed",
      `${label} failed: ${connection?.error}`,
    );
    assert(Date.now() - since < PREPARE_TIMEOUT_MS, `${label} timed out.`);
    await sleep(5_000);
  }
};
const startThread = async (title, body) => {
  const thread = await api("POST", "/v1/threads", {
    runnerProfileId: provider.sizes[0].id,
    title,
    generateTitle: false,
    threadId: `thr_${crypto.randomUUID()}`,
    initialMessage: { body, attachments: [] },
  });
  const since = Date.now();
  for (;;) {
    if ((await api("GET", `/v1/threads/${thread.id}/readiness`)).ready)
      return { id: thread.id, orbReadyMs: Date.now() - since };
    assert(Date.now() - since < REPLY_TIMEOUT_MS, "The Orb never got ready.");
    await sleep(3_000);
  }
};
/** The Thread's transcript text, once it contains `pattern`. */
const waitForText = async (threadId, pattern, label) => {
  if (!page.url().endsWith(threadId))
    await page.goto(`${base}/threads/${threadId}`);
  const since = Date.now();
  for (;;) {
    const text = await page.locator("body").innerText();
    if (pattern.test(text)) return text;
    assert(Date.now() - since < REPLY_TIMEOUT_MS, `${label}: no reply.`);
    await sleep(3_000);
  }
};
const send = async (threadId, message) => {
  await page.goto(`${base}/threads/${threadId}`);
  const composer = page.getByPlaceholder("Message");
  await composer.waitFor({ timeout: 60_000 });
  await composer.fill(message);
  await composer.press("Enter");
};
const uptimes = (text, token) =>
  [...text.matchAll(new RegExp(`${token}=(\\d+(?:\\.\\d+)?)`, "g"))].map(
    (match) => Number(match[1]),
  );

const before = await list();
const provider = providerOf(before);
assert(provider !== undefined, `${providerId} is not listed.`);
assert.equal(
  provider.connection,
  null,
  "The account already has a connection; the run would replace it.",
);
const secretFieldIds = provider.fields
  .filter(({ secret }) => secret)
  .map(({ id }) => id);
const summary = { base, provider: providerId, steps };
let connected = false;
try {
  await api("PUT", `${providersBase}/${providerId}/connection`, {
    credentials,
  });
  connected = true;
  const firstMs = await waitReady("Preparing the account");
  const recipeBefore = providerOf(await list()).connection;
  step("the account is connected and ready", { preparationMs: firstMs });

  const running = await startThread(
    "Orb update proof: running",
    "Run exactly this command in the terminal and reply with its output: `nohup sleep 7200 >/dev/null 2>&1 & echo dx-update-marker > marker.txt; echo before=$(cut -d' ' -f1 /proc/uptime)`",
  );
  const first = await waitForText(running.id, /before=\d/, "First command");
  const [uptimeBefore] = uptimes(first, "before");
  await shot("01-running-thread");
  step("a Thread's Orb runs a background process and writes a marker", {
    threadId: running.id,
    uptimeBefore,
  });

  // The deploy ships a new recipe; the Thread stays active meanwhile.
  const deploy = spawn(deployCommand[0], deployCommand.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let deployLog = "";
  deploy.stdout.on("data", (chunk) => {
    deployLog += chunk;
  });
  deploy.stderr.on("data", (chunk) => {
    deployLog += chunk;
  });
  const deployed = new Promise((done) => deploy.on("exit", done));
  let keepalives = 0;
  for (;;) {
    const exit = await Promise.race([deployed, sleep(KEEPALIVE_MS)]);
    if (exit !== undefined) {
      assert.equal(exit, 0, `The deploy failed:\n${deployLog.slice(-2000)}`);
      break;
    }
    keepalives += 1;
    await send(
      running.id,
      `Run \`echo keep${keepalives}=$(cut -d' ' -f1 /proc/uptime)\` and reply with its output.`,
    );
    await waitForText(
      running.id,
      new RegExp(`keep${keepalives}=\\d`),
      "Keepalive",
    );
  }
  writeFileSync(join(output, "deploy.log"), deployLog.slice(-20_000));
  step("the deploy shipped a new recipe while the Orb ran", { keepalives });

  // The connection prepares the new version; new Threads keep starting.
  const updating = await list();
  const connection = providerOf(updating).connection;
  assert.equal(connection.updating, true, "The connection is not updating.");
  assert.notEqual(connection.status, "ready");
  assert.equal(
    updating.resolved.find((member) => member.providerId === providerId)
      ?.status,
    "ready",
    "New Threads stopped during the update.",
  );
  await page.goto(`${base}/settings/orb-providers`);
  await page
    .locator(`[data-provider="${providerId}"]`)
    .getByText("Updating…", { exact: false })
    .waitFor({ timeout: 60_000 });
  await shot("02-updating");
  const duringUpdate = await startThread(
    "Orb update proof: during the update",
    "Run `echo during=ok` and reply with its output.",
  );
  step("during the update, new Threads start on the ready version", {
    orbReadyMs: duringUpdate.orbReadyMs,
    step: connection.progress?.step ?? null,
  });

  const updateMs = await waitReady("Preparing the update");
  const after = providerOf(await list()).connection;
  assert.equal(after.updating, false);
  step("the update becomes ready", { updateMs });

  // The running Orb kept its files, its process, and its uptime.
  await send(
    running.id,
    "Run exactly this command and reply with its output: `cat marker.txt; pgrep -f 'sleep 7200' >/dev/null && echo process=alive; echo after=$(cut -d' ' -f1 /proc/uptime)`",
  );
  const last = await waitForText(running.id, /after=\d/, "Last command");
  const [uptimeAfter] = uptimes(last, "after");
  await shot("03-after-update");
  assert(last.includes("dx-update-marker"), "The marker file is gone.");
  assert(last.includes("process=alive"), "The background process is gone.");
  assert(
    uptimeAfter > uptimeBefore,
    `The container restarted: uptime ${uptimeBefore} → ${uptimeAfter}.`,
  );
  step("the running Orb kept its files, process, and uptime", {
    uptimeBefore,
    uptimeAfter,
  });

  const afterUpdate = await startThread(
    "Orb update proof: after the update",
    "Run `echo after-update=ok` and reply with its output.",
  );
  step("after the update, new Threads start on the new version", {
    orbReadyMs: afterUpdate.orbReadyMs,
  });
  summary.connection = { before: recipeBefore, after };
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (connected)
    await request("DELETE", `${providersBase}/${providerId}/connection`).catch(
      () => undefined,
    );
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
  const harPath = join(output, "network.har");
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  const privateHeaders = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
  ]);
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
  const secrets = [
    password,
    email,
    ...secretFieldIds.map((id) => credentials[id]),
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const artifact of [
    text,
    readFileSync(join(output, "summary.json"), "utf8"),
    readFileSync(join(output, "console.json"), "utf8"),
  ])
    for (const secret of secrets)
      assert(!artifact.includes(secret), "An artifact holds a credential.");
  writeFileSync(harPath, text);
}
