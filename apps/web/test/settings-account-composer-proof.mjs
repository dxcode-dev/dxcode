// Account and Composer settings proof against a running dx (local `pnpm dev`
// or a branch preview). Signs in with email and password, captures both pages
// at 1440 px and 390 px, edits the profile name and every Composer row, and
// proves each change persists across a reload and reaches a New Thread.
// Restores the original values before it exits. Writes screenshots, a HAR,
// console output, page errors, and summary.json to <output>.
//
//   node apps/web/test/settings-account-composer-proof.mjs \
//     http://127.0.0.1:3000 . out/
//
// Credentials come from apps/core/.dev.vars, or DX_PROOF_EMAIL and
// DX_PROOF_PASSWORD for a preview. DX_PROOF_CDP attaches to a running
// Chromium; otherwise DX_PROOF_CHROMIUM (default /usr/bin/chromium) launches.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, checkout, outputArgument] = process.argv.slice(2);
assert(
  base !== undefined && outputArgument !== undefined,
  "usage: <base> <checkout> <output>",
);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const devVars = resolve(checkout, "apps/core/.dev.vars");
const localCredentials = existsSync(devVars)
  ? parseEnv(readFileSync(devVars, "utf8"))
  : {};
const email =
  process.env.DX_PROOF_EMAIL ?? localCredentials.DX_LOCAL_AUTH_EMAIL;
const password =
  process.env.DX_PROOF_PASSWORD ?? localCredentials.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "No sign-in credentials.");

const browser =
  process.env.DX_PROOF_CDP === undefined
    ? await chromium.launch({
        executablePath: process.env.DX_PROOF_CHROMIUM ?? "/usr/bin/chromium",
      })
    : await chromium.connectOverCDP(process.env.DX_PROOF_CDP);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordHar: { path: join(output, "network.har"), content: "omit" },
});
// The development-only render inspector draws over every frame.
await context.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent =
    "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
  document.addEventListener("DOMContentLoaded", () =>
    document.documentElement.append(style),
  );
});
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (message) =>
  consoleMessages.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400)
    failedRequests.push({ status: response.status(), url: response.url() });
});

const steps = [];
const step = async (name, run) => {
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    await page
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    console.error(`✗ ${name} at ${page.url()}`);
    throw error;
  }
  steps.push({ name, ms: Date.now() - started });
  console.log(`✓ ${name}`);
};
const shot = (name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });

const finish = async (status) => {
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify({ consoleMessages, pageErrors, failedRequests }, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify({ base, status, steps, pageErrors: pageErrors.length }, null, 2)}\n`,
  );
  await context.close();
  await browser.close();
};

try {
  await step("signs in with email and password", async () => {
    const response = await context.request.post(
      `${base}/api/auth/sign-in/email`,
      { headers: { origin: base }, data: { email, password } },
    );
    assert(response.ok(), `sign-in ${response.status()}`);
  });

  const composerApi = `${base}/v1/settings/personal/account/composer`;
  const accountApi = `${base}/v1/settings/personal/account`;
  const original = {
    account: (await (await context.request.get(accountApi)).json()).data,
    composer: (await (await context.request.get(composerApi)).json()).data,
  };
  writeFileSync(
    join(output, "original.json"),
    `${JSON.stringify(original, null, 2)}\n`,
  );

  // The API cannot clear a remembered value back to "never chosen" (null),
  // so restore writes back only the values the account had chosen.
  const restore = async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.request.patch(accountApi, {
      headers: { origin: base },
      data: {
        displayName: original.account.displayName,
        username: original.account.username,
      },
    });
    const { project, mode, model, runnerProfileId } = original.composer;
    const composer = {
      ...(project === null ? {} : { project }),
      ...(mode === null ? {} : { mode }),
      model,
      ...(runnerProfileId === null ? {} : { runnerProfileId }),
    };
    await context.request.patch(composerApi, {
      headers: { origin: base },
      data: composer,
    });
  };

  try {
    for (const [label, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      await step(`captures Account at ${viewport.width} px`, async () => {
        await page.setViewportSize(viewport);
        await page.goto(`${base}/settings`);
        await page.getByRole("heading", { name: "Profile" }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Delete Account" }).count(),
          0,
        );
        await shot(`account.${label}`);
      });
      await step(`captures Composer at ${viewport.width} px`, async () => {
        await page.goto(`${base}/settings/composer`);
        await page
          .getByRole("heading", { name: "Composer", level: 1 })
          .waitFor();
        await page.getByRole("combobox", { name: "Mode" }).waitFor();
        await page
          .getByRole("combobox", { name: "Project" })
          .and(page.locator(":enabled"))
          .waitFor();
        await shot(`composer.${label}`);
      });
    }

    await step(
      "lists Composer under Interface, between Appearance and Keyboard Shortcuts",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${base}/settings/composer`);
        await page.getByRole("link", { name: "Keyboard Shortcuts" }).waitFor();
        // The Interface heading labels the list that holds its group's links.
        const labels = await page
          .getByRole("navigation", { name: "personal settings" })
          .getByRole("list", { name: "Interface" })
          .getByRole("link")
          .evaluateAll((links) =>
            links.map((link) => link.getAttribute("aria-label")),
          );
        assert.deepEqual(labels.slice(0, 3), [
          "Appearance",
          "Composer",
          "Keyboard Shortcuts",
        ]);
        assert.equal(
          await page
            .getByRole("link", { name: "Composer" })
            .getAttribute("aria-current"),
          "page",
        );
      },
    );

    await step(
      "edits the profile name inline and keeps it after a reload",
      async () => {
        const name = `Proof ${Date.now().toString(36)}`;
        await page.goto(`${base}/settings`);
        await page.getByRole("button", { name: "Edit" }).click();
        await page.getByLabel("Display name").fill(name);
        await shot("account.editing.desktop");
        await page.getByRole("button", { name: "Save" }).click();
        await page.getByRole("button", { name: "Edit" }).waitFor();
        await page.reload();
        await page.getByText(name, { exact: true }).waitFor();
      },
    );

    await step(
      "a Mode change persists and opens the next New Thread",
      async () => {
        const startMode = await page
          .goto(`${base}/settings/composer`)
          .then(() =>
            page.getByRole("combobox", { name: "Mode" }).inputValue(),
          );
        const target = startMode === "high" ? "low" : "high";
        const saved = page.waitForResponse(
          (response) =>
            response.url() === composerApi &&
            response.request().method() === "PATCH",
        );
        await page.getByRole("combobox", { name: "Mode" }).selectOption(target);
        assert((await saved).ok(), "composer PATCH failed");
        await page.reload();
        assert.equal(
          await page.getByRole("combobox", { name: "Mode" }).inputValue(),
          target,
        );
        await page.goto(`${base}/new`);
        await page
          .getByRole("combobox", { name: `Reasoning mode: ${target}` })
          .waitFor();
        await shot("new-thread.mode");
      },
    );

    await step(
      "a Project change persists and opens the next New Thread",
      async () => {
        await page.goto(`${base}/settings/composer`);
        const project = page
          .getByRole("combobox", { name: "Project" })
          .and(page.locator(":enabled"));
        await project.waitFor();
        const options = await project.locator("option").evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: node.value,
            label: node.textContent,
          })),
        );
        const current = await project.inputValue();
        // A real Project, so the New Thread's Project pill proves the handoff.
        const next = options.find(
          ({ value }) => value !== "" && value !== current,
        );
        assert(next, "The account needs two Projects for this step.");
        const saved = page.waitForResponse(
          (response) =>
            response.url() === composerApi &&
            response.request().method() === "PATCH",
        );
        await project.selectOption(next.value);
        assert((await saved).ok(), "composer PATCH failed");
        await page.reload();
        assert.equal(
          await page
            .getByRole("combobox", { name: "Project" })
            .and(page.locator(":enabled"))
            .inputValue(),
          next.value,
        );
        await page.goto(`${base}/new`);
        await page.getByLabel(`Project: ${next.label}`).waitFor();
        await shot("new-thread.project");
      },
    );
  } finally {
    await restore();
  }
  await finish("passed");
} catch (error) {
  await finish("failed");
  throw error;
}
