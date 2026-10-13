// Proves the sidebar's shared-Thread rows, its single selection, the Thread
// header title, and the New Thread composer's retained files in the real
// production build (local only; never contacts providers). Builds the thread
// page harness with code splitting as shipped, serves it, and drives Chromium
// and WebKit (`npx playwright@1.55.0 install chromium webkit` once).
//
//   pnpm --filter @dx/web test:sidebar-composer
//
// Writes report.json, screenshots, a HAR, and console/page errors to
// .dx/journeys/sidebar-composer/ and exits 1 when any check fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/sidebar-composer",
);
mkdirSync(output, { recursive: true });
const { build, preview } = await import("vite");
const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
await build({ configFile, logLevel: "warn" });
const server = await preview({ configFile, preview: { port: 0 } });
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const threadId = "thr_00000000-0000-4000-8000-000000000147";
const harness = (query) =>
  `${base}/thread-page-stress.html?turns=2&tool=50&sidebar=8&shared=1&${query}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordHar: { path: join(output, "sidebar-composer.har") },
});
// Attachment parts go to storage by XHR PUT; answer them like R2 does.
await context.route("**/__upload/**", (route) =>
  route.fulfill({ status: 200, headers: { etag: '"proof-etag"' }, body: "" }),
);
const errors = [];
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const open = async (query) => {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(harness(query));
  await page.waitForSelector(".thread-row-shell");
  await page.waitForSelector(".thread-row-avatars");
  // Park the pointer away from the sidebar so no row is hovered.
  await page.mouse.move(1400, 880);
  return page;
};

/** Each avatar cell sits inside its row's box, and holds one avatar. */
const avatarLayout = (page) =>
  page.$$eval(".thread-row-shell", (shells) =>
    shells.flatMap((shell) => {
      const cell = shell.querySelector(".thread-row-avatars");
      if (cell === null) return [];
      const row = shell.querySelector(".thread-row").getBoundingClientRect();
      const box = cell.getBoundingClientRect();
      return [
        {
          title: shell.querySelector(".thread-row strong")?.textContent,
          inRow: box.top >= row.top - 1 && box.bottom <= row.bottom + 1,
          shellHeight: Math.round(shell.getBoundingClientRect().height),
          avatars: cell.querySelectorAll(".dx-avatar").length,
          label: cell.getAttribute("title"),
        },
      ];
    }),
  );

for (const [route, label] of [
  [`/threads/${threadId}`, "thread page"],
  ["/projects", "projects page"],
]) {
  const page = await open(`route=${encodeURIComponent(route)}`);
  const rows = await avatarLayout(page);
  await page.screenshot({
    path: join(output, `sidebar-${label.replace(" ", "-")}.png`),
    clip: { x: 0, y: 0, width: 320, height: 520 },
  });
  check(
    `avatars sit on their row's line on the ${label}`,
    rows.length === 3 && rows.every((row) => row.inRow),
    rows,
  );
  check(
    `rows show only the owner's avatar on the ${label}`,
    rows.every(
      (row) => row.avatars === 1 && row.label?.startsWith("Thread owner:"),
    ),
    rows,
  );
  await page.close();
}

// One selected row, whatever opened the Thread.
const filledRows = (page) =>
  page.$$eval(".product-sidebar .thread-row", (rows) => {
    const selected = document.querySelector(
      ".product-sidebar .thread-row.selected",
    );
    const fill = selected && getComputedStyle(selected).backgroundColor;
    return rows
      .filter((row) => fill && getComputedStyle(row).backgroundColor === fill)
      .map((row) => row.querySelector("strong")?.textContent);
  });
{
  const page = await open("");
  await page.getByRole("link", { name: /Sidebar thread 3/ }).click();
  await page.waitForSelector(
    '.thread-row[aria-current="page"] >> text=Sidebar thread 3',
  );
  await page.mouse.move(1400, 880);
  await page.keyboard.press("Control+Alt+ArrowDown");
  await page.waitForSelector(
    '.thread-row[aria-current="page"] >> text=Sidebar thread 4',
  );
  await page.mouse.move(1400, 880);
  const afterSwitch = await filledRows(page);
  check(
    "switching Threads by keyboard leaves one selected row",
    afterSwitch.length === 1 && afterSwitch[0] === "Sidebar thread 4",
    afterSwitch,
  );

  await page.getByRole("link", { name: /Sidebar thread 6/ }).click();
  await page.waitForSelector(
    '.thread-row[aria-current="page"] >> text=Sidebar thread 6',
  );
  await page.mouse.move(1400, 880);
  await page.keyboard.press("j");
  const focused = await page.$eval("[data-command-focused='true']", (row) => ({
    title: row.querySelector("strong")?.textContent,
    indicator:
      getComputedStyle(row).boxShadow !== "none" ||
      getComputedStyle(row).outlineStyle !== "none",
  }));
  const afterMove = await filledRows(page);
  await page.screenshot({
    path: join(output, "sidebar-keyboard-focus.png"),
    clip: { x: 0, y: 0, width: 320, height: 520 },
  });
  check(
    "keyboard focus is shown without a second selected row",
    afterMove.length === 1 &&
      afterMove[0] === "Sidebar thread 6" &&
      focused.title === "Sidebar thread 7" &&
      focused.indicator,
    { afterMove, focused },
  );
  await page.close();
}

// The header shows up to 60 characters and elides only when out of room.
{
  const title = "Pitch Deck Roadmap Planning for the next quarter review";
  const page = await open(`title=${encodeURIComponent(title)}`);
  const header = await page.$eval(
    ".thread-title-bar .thread-title",
    (element) => ({
      text: element.textContent,
      clipped: element.scrollWidth > element.clientWidth,
      width: Math.round(element.getBoundingClientRect().width),
      bar: Math.round(
        element.closest(".thread-title-bar").getBoundingClientRect().width,
      ),
    }),
  );
  await page.screenshot({
    path: join(output, "thread-header.png"),
    clip: { x: 0, y: 0, width: 1440, height: 60 },
  });
  check(
    "a 55-character title shows whole in a wide header",
    header.text === title && !header.clipped,
    header,
  );
  await page.close();
}
{
  // A narrow chat pane: the chips give up their width before the title.
  const title = "Pitch Deck Roadmap Planning";
  const page = await open(`title=${encodeURIComponent(title)}`);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(200);
  const header = await page.$eval(".thread-title-bar", (bar) => {
    const element = bar.querySelector(".thread-title");
    return {
      text: element.textContent,
      clipped: element.scrollWidth > element.clientWidth,
      bar: Math.round(bar.getBoundingClientRect().width),
      overflowing: bar.scrollWidth > bar.clientWidth,
      chips: [...bar.querySelectorAll(".thread-header-chip-label")].map(
        (label) => ({
          text: label.textContent,
          width: Math.round(label.getBoundingClientRect().width),
          clipped: label.scrollWidth > label.clientWidth,
        }),
      ),
    };
  });
  await page.screenshot({
    path: join(output, "thread-header-narrow.png"),
    clip: { x: 0, y: 0, width: 800, height: 60 },
  });
  check(
    "a narrow header shrinks its chips before the title",
    header.text === title &&
      !header.clipped &&
      !header.overflowing &&
      header.chips.some((chip) => chip.clipped),
    header,
  );
  await page.close();
}

// Files added to the New Thread composer stay after it closes and reopens.
{
  const page = await open("");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByRole("button", { name: "New thread" }).click();
  const dialog = page.getByRole("dialog", { name: "New thread" });
  await dialog
    .getByRole("textbox", { name: "Prompt" })
    .fill("Keep these files");
  await dialog
    .locator('input[aria-label="Choose files"]')
    .setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: png });
  await dialog.locator(".composer-attachments").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('.new-thread-dialog [aria-label="Uploading"]') ===
      null,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "New thread" }).click();
  await dialog.waitFor();
  await dialog
    .locator(".composer-attachments")
    .waitFor({ timeout: 3_000 })
    .catch(() => undefined);
  const reopened = {
    prompt: await dialog.getByRole("textbox", { name: "Prompt" }).inputValue(),
    attachments: await dialog.locator(".composer-attachment").count(),
  };
  await page.screenshot({ path: join(output, "new-thread-reopened.png") });
  check(
    "the New Thread composer keeps its prompt and files after closing",
    reopened.prompt === "Keep these files" && reopened.attachments === 1,
    reopened,
  );
  await page.close();
}

/** Each sidebar title: elided or faded, and whether its text is cut. */
const sidebarTitles = (page) =>
  page.$$eval(".product-sidebar .thread-row strong", (titles) =>
    titles.map((element) => ({
      text: element.textContent,
      selected: element.closest(".thread-row").classList.contains("selected"),
      textOverflow: getComputedStyle(element).textOverflow,
      faded: getComputedStyle(element).maskImage.includes("gradient"),
      truncated: element.scrollWidth > element.clientWidth,
    })),
  );
const checkSidebarTitles = (engine, titles) => {
  const long = titles.find(({ text }) => text.startsWith("Research t3code"));
  check(
    `no sidebar title ends in an ellipsis (${engine})`,
    titles.every(({ textOverflow }) => textOverflow !== "ellipsis"),
    titles,
  );
  check(
    `a long selected title fades out at rest (${engine})`,
    long?.selected === true && long.truncated && long.faded,
    long,
  );
  check(
    `titles that fit are not faded (${engine})`,
    titles.some(({ truncated }) => !truncated) &&
      titles.every(({ truncated, faded }) => truncated || !faded),
    titles.filter(({ truncated }) => !truncated),
  );
};
{
  const title = "Research t3code improvements to adopt in the dx web app";
  const page = await open(`title=${encodeURIComponent(title)}`);
  checkSidebarTitles("Chromium", await sidebarTitles(page));
  await page.screenshot({
    path: join(output, "sidebar-rest.png"),
    clip: { x: 0, y: 0, width: 320, height: 200 },
  });
  await page.close();
}

// A cut title uses its row's full width at rest, up to the avatar or child
// count, and fades over its last letters; on hover the fade grows to where
// the actions start. It never elides.
{
  const title = "Research t3code improvements to adopt in the dx web app";
  const page = await open(`long=1&title=${encodeURIComponent(title)}`);
  // Mask stops as distances from the title's right edge, in px.
  const fade = (mask) => {
    const stops = [...mask.matchAll(/calc\(100% (?:- |\+ -)([\d.]+)px\)/g)];
    return {
      start: Number(stops[0]?.[1] ?? Number.NaN),
      end: Number(stops[1]?.[1] ?? 0),
    };
  };
  const measure = (name) =>
    page
      .locator(".thread-row-shell", { hasText: name })
      .first()
      .evaluate((shell) => {
        const row = shell.getBoundingClientRect();
        const title = shell.querySelector(".thread-row strong");
        const end = shell.querySelector(
          ".thread-row-avatars .dx-avatar, .thread-children-toggle",
        );
        const actions = shell.querySelector(".thread-hover-actions");
        const fromRight = (x) => Math.round(row.right - x);
        return {
          textOverflow: getComputedStyle(title).textOverflow,
          mask: getComputedStyle(title).maskImage,
          truncated: title.scrollWidth > title.clientWidth,
          titleEnd: fromRight(title.getBoundingClientRect().right),
          control:
            end === null ? 0 : fromRight(end.getBoundingClientRect().left),
          actions:
            getComputedStyle(actions).display === "none"
              ? undefined
              : fromRight(actions.getBoundingClientRect().left),
        };
      });
  for (const [name, label] of [
    ["Research t3code", "a plain row"],
    ["Sidebar thread 1", "a row with its owner's avatar"],
    ["Sidebar thread 3", "a row with a child count"],
  ]) {
    await page.mouse.move(1400, 880);
    const atRest = await measure(name);
    await page.locator(".thread-row-shell", { hasText: name }).first().hover();
    const hovered = await measure(name);
    const rest = fade(atRest.mask);
    const hover = fade(hovered.mask);
    // Where the actions start, measured from the title's right edge.
    const actionsStart = hovered.actions - hovered.titleEnd;
    check(
      `${label}: a cut title runs to the row's end at rest and fades without an ellipsis`,
      atRest.truncated &&
        atRest.textOverflow === "clip" &&
        atRest.titleEnd <= atRest.control + 8 &&
        rest.end === 0 &&
        rest.start <= 20,
      { atRest, rest },
    );
    check(
      `${label}: on hover the fade grows to where the actions start`,
      hovered.titleEnd === atRest.titleEnd &&
        hover.start > rest.start &&
        Math.abs(hover.end - actionsStart) <= 6,
      { hovered, hover, actionsStart },
    );
  }
  await page.mouse.move(1400, 880);
  await page.screenshot({
    path: join(output, "sidebar-rest-long.png"),
    clip: { x: 0, y: 0, width: 320, height: 220 },
  });
  await page
    .locator(".thread-row-shell", { hasText: "Sidebar thread 1" })
    .hover();
  await page.screenshot({
    path: join(output, "sidebar-hover.png"),
    clip: { x: 0, y: 0, width: 320, height: 220 },
  });
  await page.close();
}

await context.close();
await browser.close();

// WebKit (Safari) measures the header differently from Chromium.
{
  const { webkit } = await import("playwright-core");
  const safari = await webkit.launch();
  const page = await safari.newPage({ viewport: { width: 1500, height: 800 } });
  page.on("pageerror", (error) => errors.push(`webkit: ${error}`));
  const title = "Sidebar shared-thread icon layout";
  await page.goto(harness(`title=${encodeURIComponent(title)}`));
  await page.waitForSelector(".thread-title-bar .thread-title");
  const header = await page.$eval(
    ".thread-title-bar .thread-title",
    (element) => ({
      text: element.textContent,
      clipped: element.scrollWidth > element.clientWidth,
      width: element.getBoundingClientRect().width,
    }),
  );
  await page.screenshot({
    path: join(output, "thread-header-webkit.png"),
    clip: { x: 0, y: 0, width: 1500, height: 50 },
  });
  check(
    "a short title shows whole in a wide WebKit header",
    header.text === title && !header.clipped,
    header,
  );
  const long = "Research t3code improvements to adopt in the dx web app";
  await page.goto(harness(`title=${encodeURIComponent(long)}`));
  await page.waitForSelector(".thread-row-shell");
  await page.waitForTimeout(300);
  checkSidebarTitles("WebKit", await sidebarTitles(page));
  await safari.close();
}
await new Promise((done) => server.httpServer.close(done));
check("no console or page errors", errors.length === 0, errors);
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify({ checks, errors }, null, 2)}\n`,
);
const failed = checks.filter(({ pass }) => !pass);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; artifacts in ${output}`,
);
process.exit(failed.length === 0 ? 0 : 1);
