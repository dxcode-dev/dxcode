// Proves the personal Instructions settings page end to end against a running
// dx (local `pnpm dev` or a branch preview): the old /settings/advanced link
// redirects, the counter tracks the draft against the server maximum, Reset
// restores the saved value, the unsaved-changes guard holds navigation, Save
// persists across a reload, and an over-limit draft cannot be saved. Leaves
// the account's instructions as it found them.
//
//   node apps/web/test/instructions-settings-proof.mjs <base url> <output dir>
//
// Signs in with DX_PROOF_EMAIL and DX_PROOF_PASSWORD, or with the local
// account in apps/core/.dev.vars. Writes desktop (1440px) and mobile (390px)
// screenshots, a HAR, console output, page errors, and summary.json, and
// exits 1 when a check fails.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [baseArgument, outputArgument] = process.argv.slice(2);
assert(baseArgument && outputArgument, "Usage: <base url> <output dir>");
const base = baseArgument.replace(/\/$/, "");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const localVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(localVars)
  ? parseEnv(readFileSync(localVars, "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? local.DX_LOCAL_AUTH_EMAIL;
const password = process.env.DX_PROOF_PASSWORD ?? local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "Set DX_PROOF_EMAIL and DX_PROOF_PASSWORD.");
const MAX = 10_000;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  // A POSIX host locale ("en-US@posix") breaks Intl.Locale in dev tooling.
  locale: "en-US",
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
const failedApiResponses = [];
page.on("console", (message) =>
  consoleMessages.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("response", (response) => {
  if (
    new URL(response.url()).pathname.startsWith("/v1/") &&
    response.status() >= 400
  )
    failedApiResponses.push({ url: response.url(), status: response.status() });
});

const steps = [];
const step = async (name, run) => {
  try {
    await run();
    steps.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    steps.push({ name, ok: false, error: String(error) });
    console.error(`✗ ${name} at ${page.url()}\n${error}`);
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
    throw error;
  }
};
const shot = (name) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const textarea = () => page.getByRole("textbox", { name: "Global AGENTS.md" });
const save = () => page.getByRole("button", { name: "Save", exact: true });
const reset = () => page.getByRole("button", { name: "Reset", exact: true });
const counter = (count) =>
  page.getByText(
    `${count.toLocaleString("en-US")} / ${MAX.toLocaleString("en-US")} characters`,
  );
const instructionsResponse = () =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/v1/settings/personal/agent-instructions" &&
      response.request().method() === "PATCH",
  );
// Set once the saved instructions are read; until then there is nothing to
// restore, and restoring would overwrite the account's real instructions.
let original;

try {
  await step("signs in with a password", async () => {
    await page.goto(`${base}/signin?next=%2Fsettings`);
    // With other providers enabled, the password form sits behind a button.
    const passwordForm = page.getByLabel("Password");
    const passwordButton = page.getByRole("button", {
      name: "Sign in with a password",
    });
    await passwordForm.or(passwordButton).first().waitFor();
    if (await passwordButton.isVisible()) await passwordButton.click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/settings"));
  });

  await step(
    "/settings/advanced redirects to /settings/instructions",
    async () => {
      await page.goto(`${base}/settings/advanced`);
      await page.waitForURL((url) => url.pathname === "/settings/instructions");
      await page
        .getByRole("heading", { name: "Instructions", level: 1 })
        .waitFor();
      await page.getByRole("heading", { name: "Global AGENTS.md" }).waitFor();
      await page.getByRole("link", { name: "Instructions" }).waitFor();
      original = await textarea().inputValue();
      await counter(original.length).waitFor();
      assert(await save().isDisabled(), "Save is disabled while unchanged");
      assert(await reset().isDisabled(), "Reset is disabled while unchanged");
      await shot("desktop-01-saved");
    },
  );

  const draft = `${original}${original ? "\n" : ""}Prefer small, reviewed commits.`;
  await step(
    "editing counts characters and enables Save and Reset",
    async () => {
      await textarea().fill(draft);
      await counter(draft.length).waitFor();
      assert(await save().isEnabled());
      assert(await reset().isEnabled());
      await shot("desktop-02-dirty");
    },
  );

  await step("Reset restores the saved value without saving", async () => {
    let patched = false;
    const listener = (request) => {
      if (request.method() === "PATCH") patched = true;
    };
    page.on("request", listener);
    await reset().click();
    assert.equal(await textarea().inputValue(), original);
    await counter(original.length).waitFor();
    assert(await reset().isDisabled());
    page.off("request", listener);
    assert(!patched, "Reset must not call the server");
  });

  await step("the unsaved-changes guard holds navigation", async () => {
    await textarea().fill(draft);
    await page.getByRole("link", { name: "Account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: "Discard unsaved changes?" })
      .waitFor();
    await shot("desktop-03-guard");
    await dialog.getByRole("button", { name: "Stay on page" }).click();
    assert.equal(new URL(page.url()).pathname, "/settings/instructions");
    assert.equal(await textarea().inputValue(), draft);
  });

  await step("Save persists across a reload", async () => {
    const response = instructionsResponse();
    await save().click();
    assert.equal((await response).status(), 200);
    await page
      .getByText("Saved. New Threads use these instructions.")
      .waitFor();
    assert(await save().isDisabled());
    await shot("desktop-04-saved-message");
    await page.reload();
    await page.getByRole("heading", { name: "Global AGENTS.md" }).waitFor();
    assert.equal(await textarea().inputValue(), draft);
    await counter(draft.length).waitFor();
  });

  await step("an over-limit draft cannot be saved", async () => {
    await textarea().fill("x".repeat(MAX + 1));
    await counter(MAX + 1).waitFor();
    await page
      .getByText(
        `Enter no more than ${MAX.toLocaleString("en-US")} characters.`,
      )
      .waitFor();
    assert(await save().isDisabled());
    await shot("desktop-05-over-limit");
    await reset().click();
    assert.equal(await textarea().inputValue(), draft);
  });

  await step("renders at 390px", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("heading", { name: "Global AGENTS.md" }).waitFor();
    await shot("mobile-01-saved");
    await textarea().fill(`${draft} Edited on a phone.`);
    await shot("mobile-02-dirty");
    await reset().click();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    assert(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
} finally {
  // Put the account's instructions back the way the proof found them.
  if (original !== undefined)
    await step("restores the original instructions", async () => {
      await page.goto(`${base}/settings/instructions`);
      await page.getByRole("heading", { name: "Global AGENTS.md" }).waitFor();
      if ((await textarea().inputValue()) === original) return;
      await textarea().fill(original);
      const response = instructionsResponse();
      await save().click();
      assert.equal((await response).status(), 200);
    }).catch(() => {});
  await context.close();
  await browser.close();
  const failed =
    steps.some(({ ok }) => !ok) ||
    pageErrors.length > 0 ||
    failedApiResponses.length > 0;
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify({ base, ok: !failed, steps, pageErrors, failedApiResponses }, null, 2)}\n`,
  );
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify(consoleMessages, null, 2)}\n`,
  );
  if (failed) process.exitCode = 1;
}
