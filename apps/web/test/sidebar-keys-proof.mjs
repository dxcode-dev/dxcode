// Keyboard-only sidebar journey against a running `pnpm dev` (local) or a
// branch preview, at 1440x900 in Chromium. After the first page load it uses
// only the keyboard: Tab to a control and press Enter, Space, the arrows,
// letters, or Ctrl+B. It checks that Enter activates a focused button or link
// while the sidebar is shown (#1257), that an open menu keeps its arrows and
// letters, that Ctrl+B still collapses and reopens the sidebar, and, when the
// account has a Thread in the sidebar, that the arrows and Enter still open
// sidebar rows. With --seed-thread it starts a Thread from the keyboard first
// when the sidebar has none. Writes a video, a HAR without bodies, console and
// page errors, screenshots, and summary.json to <output>; exits 1 when any
// check fails.
//
//   node apps/web/test/sidebar-keys-proof.mjs https://<preview> out/ [--seed-thread]
//
// Credentials come from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, the deployment
// reviewer (DX_DEPLOYMENT_REVIEWER_EMAIL / _PASSWORD), or the local account
// in apps/core/.dev.vars.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, outputArgument, ...flags] = process.argv.slice(2);
assert(base && outputArgument, "Usage: <base url> <output dir>");
const seedThread = flags.includes("--seed-thread");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const devVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(devVars)
  ? parseEnv(readFileSync(devVars, "utf8"))
  : {};
const email =
  process.env.DX_PROOF_EMAIL ??
  process.env.DX_DEPLOYMENT_REVIEWER_EMAIL ??
  local.DX_LOCAL_AUTH_EMAIL;
const password =
  process.env.DX_PROOF_PASSWORD ??
  process.env.DX_DEPLOYMENT_REVIEWER_PASSWORD ??
  local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "No proof account credentials.");

const browser = await chromium.launch();
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({
  viewport,
  locale: "en-US",
  colorScheme: "light",
  recordHar: { path: join(output, "network.har"), content: "omit" },
  recordVideo: { dir: join(output, "video"), size: viewport },
});
const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email, password },
});
assert.equal(signIn.status(), 200, "Password sign-in failed.");

const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
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

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name} ${JSON.stringify(detail)}`);
};
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) });
const settle = () => page.waitForTimeout(700);
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(250);
};

const focused = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? null,
      label:
        element?.getAttribute("aria-label") ??
        element?.textContent?.trim().slice(0, 40) ??
        null,
      href: element?.getAttribute("href") ?? null,
      role: element?.getAttribute("role") ?? null,
      sidebarRow: element?.hasAttribute("data-command-sidebar-item") ?? false,
    };
  });
const sidebarWidth = () =>
  page.evaluate(
    () =>
      document
        .querySelector("[data-command-surface='sidebar']")
        ?.getBoundingClientRect().width ?? 0,
  );
const path = () => new URL(page.url()).pathname;

/** Presses Tab until the focused element matches, at most 40 times. */
const tabTo = async (description, matches) => {
  for (let presses = 1; presses <= 40; presses += 1) {
    await page.keyboard.press("Tab");
    const element = await focused();
    if (matches(element)) return presses;
  }
  throw new Error(`Tab never reached ${description}`);
};
const load = async (route) => {
  await page.goto(`${base}${route}`);
  await page.locator("[data-command-surface='sidebar']").waitFor();
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await settle();
};

try {
  // 1. The reported case: Enter on the focused "Collapse sidebar" button.
  await load("/projects");
  const widthBefore = await sidebarWidth();
  await tabTo(
    "Collapse sidebar",
    (element) => element.label === "Collapse sidebar",
  );
  await press("Enter");
  await settle();
  const widthAfterEnter = await sidebarWidth();
  await shot("01-enter-collapse");
  check(
    "Enter on the focused Collapse sidebar button collapses it",
    widthAfterEnter === 0,
    {
      widthBefore,
      widthAfterEnter,
    },
  );

  // 2. Ctrl+B collapses the sidebar from a fresh page and reopens it.
  await load("/projects");
  const shown = await sidebarWidth();
  await press("Control+b");
  await settle();
  const hidden = await sidebarWidth();
  await press("Control+b");
  await settle();
  const shownAgain = await sidebarWidth();
  const reopenFocus = await focused();
  check(
    "Ctrl+B collapses and reopens the sidebar",
    shown > 0 && hidden === 0 && shownAgain > 0,
    { shown, hidden, shownAgain, reopenFocus },
  );

  // 3. Enter on a focused button inside the sidebar: New thread opens the
  // composer dialog.
  await load("/projects");
  await tabTo("New thread", (element) => element.label === "New thread");
  await press("Enter");
  await settle();
  const composer = await page.locator("textarea[aria-label='Prompt']").count();
  await shot("03-enter-new-thread");
  check(
    "Enter on the focused New thread button opens the composer",
    composer > 0,
    { composer, path: path() },
  );

  // 4. Enter on a focused link: the sidebar's DX home link.
  await load("/projects");
  await tabTo("DX home link", (element) => element.href === "/");
  await press("Enter");
  await settle();
  check("Enter on the focused DX home link navigates to /", path() === "/", {
    from: "/projects",
    path: path(),
  });

  // 5. Enter on a focused button in the page: New Project.
  await load("/projects");
  await tabTo("New Project", (element) => element.label === "New Project");
  await press("Enter");
  await settle();
  const dialogOpen = await page.locator("[role='dialog']").count();
  await shot("05-enter-new-project");
  check(
    "Enter on the focused New Project button opens its dialog",
    dialogOpen > 0,
    {
      dialogs: dialogOpen,
    },
  );
  await press("Escape");
  await settle();

  // 6. An open menu keeps its arrows and letters. Space opens it on every
  // build, so this isolates the arrow keys.
  await load("/projects");
  await tabTo(
    "account menu",
    (element) => element.label === "Open account menu",
  );
  await press(" ");
  await settle();
  const menuOpened = await page.locator("[role='menu']").count();
  const firstItem = await focused();
  await press("ArrowDown");
  const afterArrow = await focused();
  const menuAfterArrow = await page.locator("[role='menu']").count();
  await shot("06-menu-arrow");
  check(
    "ArrowDown in the open account menu moves within the menu",
    menuOpened > 0 &&
      menuAfterArrow > 0 &&
      afterArrow.role?.startsWith("menuitem") === true,
    {
      menuOpened,
      firstItem,
      afterArrow,
      menuAfterArrow,
    },
  );
  await press("Escape");
  await settle();

  // 7. Sidebar rows: the arrows and Enter open the focused Thread.
  let rows = await page.locator("[data-command-sidebar-item]").count();
  if (rows === 0 && seedThread) {
    await press("Alt+Enter");
    await page.getByRole("textbox").first().waitFor();
    await settle();
    await page.keyboard.type("Reply with the single word ready.");
    await press("Enter");
    await page.waitForURL(/\/threads\//, { timeout: 60_000 });
    await page.locator("[data-command-sidebar-item]").first().waitFor();
    rows = await page.locator("[data-command-sidebar-item]").count();
  }
  if (rows === 0) {
    check("Sidebar row cases need a Thread (rerun with --seed-thread)", true, {
      skipped: true,
    });
  } else {
    await load("/projects");
    await press("Escape");
    await press("ArrowDown");
    const row = await focused();
    await press("Enter");
    await settle();
    await shot("07-enter-row");
    check(
      "ArrowDown then Enter opens the focused sidebar Thread",
      row.sidebarRow && path() === row.href,
      {
        row,
        path: path(),
      },
    );

    // 8. After focus leaves a row, Enter acts on the newly focused control,
    // not on the row that was focused before.
    await load("/projects");
    await press("ArrowDown");
    const marked = await focused();
    await tabTo(
      "Collapse sidebar",
      (element) => element.label === "Collapse sidebar",
    );
    await press("Enter");
    await settle();
    const collapsed = await sidebarWidth();
    check(
      "Enter on Collapse sidebar after visiting a row collapses, and opens no Thread",
      collapsed === 0 && path() === "/projects",
      {
        marked,
        width: collapsed,
        path: path(),
      },
    );
    await press("Control+b");
    await settle();

    // 9. M opens the focused row's menu, and the menu keeps ArrowDown.
    await load("/projects");
    await press("ArrowDown");
    await press("m");
    await settle();
    const rowMenu = await page.locator("[role='menu']").count();
    await press("ArrowDown");
    const inRowMenu = await focused();
    const rowMenuAfter = await page.locator("[role='menu']").count();
    await shot("09-row-menu");
    check(
      "M opens the focused Thread's menu and ArrowDown stays in it",
      rowMenu > 0 &&
        rowMenuAfter > 0 &&
        inRowMenu.role?.startsWith("menuitem") === true,
      {
        rowMenu,
        inRowMenu,
      },
    );
    await press("Escape");
  }
} catch (error) {
  check("journey completed", false, { error: String(error) });
  await shot("error").catch(() => undefined);
}

const video = page.video();
await context.close();
await browser.close();
const summary = {
  base,
  checks,
  passed: checks.every((entry) => entry.pass),
  pageErrors,
  consoleErrors: consoleMessages.filter((message) => message.type === "error"),
  video: video === null ? null : await video.path(),
};
writeFileSync(
  join(output, "console.json"),
  JSON.stringify(consoleMessages, null, 2),
);
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `${summary.passed ? "PASS" : "FAIL"}: ${checks.filter((entry) => entry.pass).length}/${checks.length} checks, ${pageErrors.length} page errors`,
);
process.exit(summary.passed ? 0 : 1);
