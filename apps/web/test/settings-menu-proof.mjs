// Proves the grouped settings menu end to end against a running dx (local
// `pnpm dev` or a branch preview): top-level sections lead, group headings
// follow in order and are not collapsible, each heading labels its group's
// list for screen readers, there is no Advanced item, the active item is
// marked, the workspace menu matches the viewer's role, and below 1024px the
// menu is one horizontally scrolling tab row with dividers for headings.
//
//   node apps/web/test/settings-menu-proof.mjs <base url> <output dir>
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

// The menus as shown today; headings are "# Heading".
const personalMenu = [
  "Account",
  "Integrations & MCP",
  "# Agent",
  "Instructions",
  "Mode Dial",
  "Model Routing",
  "# Library",
  "Secrets & Env Vars",
  "Skills",
  "Plugins",
  "# Projects & Orbs",
  "Project Defaults",
  "Orb Providers",
  "# Interface",
  "Appearance",
  "Composer",
  "Keyboard Shortcuts",
  "Notifications",
  "# Privacy & Security",
  "Security",
];
const workspaceAdminMenu = [
  "Workspace",
  "Members",
  "Integrations & MCP",
  "# Agent",
  "Mode Dial",
  "Model Routing",
  "# Library",
  "Secrets & Env Vars",
  "Skills",
  "Plugins",
  "External API Apps",
  "# Projects & Orbs",
  "Project Defaults",
  "Orb Providers",
];
const workspaceMemberMenu = [
  "Workspace",
  "Members",
  "Integrations & MCP",
  "# Library",
  "Plugins",
];

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
    const detail = await run();
    steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
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
// Admin-only sections join the menu once the settings context (with the
// viewer's workspace role) has loaded.
const settled = () =>
  page.locator(".settings-content[aria-busy='false']").waitFor();
const navigation = () =>
  page.getByRole("navigation", { name: /^(personal|workspace) settings$/ });

/** The menu as rendered: labels, headings, geometry, and the active item. */
const readMenu = () =>
  navigation().evaluate((nav) => {
    const items = [
      ...nav.querySelectorAll(
        ".settings-navigation-heading, .settings-navigation-link",
      ),
    ].map((element) => {
      const box = element.getBoundingClientRect();
      const heading = element.classList.contains("settings-navigation-heading");
      const style = getComputedStyle(element);
      return {
        text: heading
          ? `# ${element.textContent.trim()}`
          : element.getAttribute("aria-label"),
        heading,
        top: Math.round(box.top),
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
        visibleText: heading
          ? element.firstElementChild.getBoundingClientRect().width > 1
          : true,
        divider: heading && style.borderLeftStyle !== "none",
        current: element.getAttribute("aria-current") === "page",
        expandable: element.hasAttribute("aria-expanded"),
      };
    });
    return {
      items,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      background: (() => {
        const active = nav.querySelector("[aria-current='page']");
        return active === null ? null : getComputedStyle(active).boxShadow;
      })(),
    };
  });

const assertRail = (menu, expected) => {
  assert.deepEqual(
    menu.items.map(({ text }) => text),
    expected,
  );
  assert(
    menu.items.every(({ expandable }) => !expandable),
    "no menu item expands",
  );
  const links = menu.items.filter(({ heading }) => !heading);
  assert(
    links.every(({ left }) => left === links[0].left),
    "rail items share one column",
  );
  assert(
    menu.items.every(
      ({ top }, index) => index === 0 || top > menu.items[index - 1].top,
    ),
    "rail items stack vertically",
  );
  assert(
    menu.items.filter(({ heading }) => heading).every((h) => h.visibleText),
    "group headings show their text",
  );
};

const assertTabRow = (menu, expected) => {
  assert.deepEqual(
    menu.items.map(({ text }) => text),
    expected,
  );
  const links = menu.items.filter(({ heading }) => !heading);
  assert(
    links.every(
      ({ top, height }) => top === links[0].top && height === links[0].height,
    ),
    "tabs share one row and one height",
  );
  assert(
    menu.items.every(
      ({ left }, index) => index === 0 || left > menu.items[index - 1].left,
    ),
    "tabs run left to right",
  );
  // Tabs are 32px; hidden heading text must not stretch the row.
  assert(
    Math.abs(links[0].height - 32) <= 2,
    `tabs are ${links[0].height}px tall, not about 32px`,
  );
  assert(menu.scrollWidth > menu.clientWidth, "the tab row scrolls sideways");
  const headings = menu.items.filter(({ heading }) => heading);
  assert(
    headings.every((h) => h.divider && h.width <= 1 && !h.visibleText),
    "headings collapse to dividers with their text hidden",
  );
};

/** Each heading labels a list holding exactly its group's links. */
const assertGroupLists = async (expected) => {
  const groups = [];
  for (const item of expected) {
    if (item.startsWith("# ")) groups.push({ name: item.slice(2), links: [] });
    else groups.at(-1)?.links.push(item);
  }
  assert.equal(
    await navigation().getByRole("list").count(),
    groups.length,
    "one list per heading",
  );
  for (const group of groups) {
    const links = await navigation()
      .getByRole("list", { name: group.name, exact: true })
      .getByRole("link")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    assert.deepEqual(links, group.links, `the ${group.name} list`);
  }
};

const assertNoSidewaysPage = async () => {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  assert(overflow <= 0, `page scrolls sideways by ${overflow}px`);
};

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

  await step("personal menu is grouped at 1440px", async () => {
    await page.goto(`${base}/settings`);
    await navigation().getByRole("link", { name: "Account" }).waitFor();
    const menu = await readMenu();
    assertRail(menu, personalMenu);
    await assertGroupLists(personalMenu);
    assert.equal(menu.items.find(({ current }) => current)?.text, "Account");
    assert.equal(
      await page.getByRole("link", { name: "Advanced" }).count(),
      0,
      "no Advanced item",
    );
    await shot("desktop-01-personal-account");
    return { activeShadow: menu.background };
  });

  await step("a grouped item opens and becomes the active item", async () => {
    await navigation()
      .getByRole("link", { name: "Keyboard Shortcuts" })
      .click();
    await page.waitForURL(
      (url) => url.pathname === "/settings/keyboard-shortcuts",
    );
    await page
      .getByRole("heading", { name: "Keyboard Shortcuts", level: 1 })
      .waitFor();
    const menu = await readMenu();
    assertRail(menu, personalMenu);
    assert.deepEqual(
      menu.items.filter(({ current }) => current).map(({ text }) => text),
      ["Keyboard Shortcuts"],
    );
    await shot("desktop-02-personal-keyboard-shortcuts");
  });

  await step("Instructions sits under Agent", async () => {
    await navigation().getByRole("link", { name: "Instructions" }).click();
    await page.waitForURL((url) => url.pathname === "/settings/instructions");
    await page
      .getByRole("heading", { name: "Instructions", level: 1 })
      .waitFor();
    assertRail(await readMenu(), personalMenu);
    await shot("desktop-03-personal-instructions");
  });

  let workspacePath;
  let workspaceMenu;
  await step("workspace menu is grouped at 1440px", async () => {
    // The expected menu follows the viewer's role in the settings context.
    const context = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /^\/v1\/settings\/workspaces\/[^/]+$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await page.getByRole("link", { name: "Workspace Settings" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/workspaces"));
    assert.notEqual(
      new URL(page.url()).pathname,
      "/workspaces",
      "the proof account must belong to a workspace",
    );
    const response = await context;
    assert.equal(response.status(), 200);
    const { role } = (await response.json()).data;
    assert(
      ["owner", "admin", "member"].includes(role),
      `unexpected role ${role}`,
    );
    workspaceMenu =
      role === "owner" || role === "admin"
        ? workspaceAdminMenu
        : workspaceMemberMenu;
    await navigation().getByRole("link", { name: "Members" }).waitFor();
    await settled();
    workspacePath = new URL(page.url()).pathname;
    assertRail(await readMenu(), workspaceMenu);
    await assertGroupLists(workspaceMenu);
    await shot("desktop-04-workspace");
    return { role };
  });

  await step(
    "the rail holds at 1024px and turns into tabs at 1023px",
    async () => {
      await page.setViewportSize({ width: 1024, height: 800 });
      await page.goto(`${base}/settings`);
      await navigation().getByRole("link", { name: "Account" }).waitFor();
      assertRail(await readMenu(), personalMenu);
      await page.setViewportSize({ width: 1023, height: 800 });
      assertTabRow(await readMenu(), personalMenu);
      await shot("tablet-01-personal-1023");
    },
  );

  await step("personal menu is a tab row at 390px", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/settings/environment-variables`);
    await navigation().getByRole("link", { name: "Account" }).waitFor();
    const menu = await readMenu();
    assertTabRow(menu, personalMenu);
    await assertGroupLists(personalMenu);
    assert.equal(
      menu.items.find(({ current }) => current)?.text,
      "Secrets & Env Vars",
    );
    const scopeLabels = await page
      .getByRole("navigation", { name: "Settings scope" })
      .innerText();
    assert.deepEqual(scopeLabels.split(/\s+/).filter(Boolean), [
      "Personal",
      "W",
      "Workspace",
    ]);
    await assertNoSidewaysPage();
    await shot("mobile-01-personal-environment-variables");
    await navigation().evaluate((nav) => {
      nav.scrollLeft = nav.scrollWidth;
    });
    await shot("mobile-02-personal-tabs-scrolled");
  });

  await step("workspace menu is a tab row at 390px", async () => {
    const section =
      workspaceMenu === workspaceAdminMenu ? "/environment-variables" : "";
    await page.goto(`${base}${workspacePath}${section}`);
    await navigation().getByRole("link", { name: "Members" }).waitFor();
    await settled();
    assertTabRow(await readMenu(), workspaceMenu);
    await assertGroupLists(workspaceMenu);
    await assertNoSidewaysPage();
    await shot("mobile-03-workspace");
  });
} finally {
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
