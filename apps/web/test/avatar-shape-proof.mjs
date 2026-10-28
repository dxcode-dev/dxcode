// Avatar shape journey against a running `pnpm dev`. People upload pictures
// that are not square, as phone photos and screenshots are: the owner a 3:4
// portrait, one member a 9:16 portrait, one a 16:9 landscape, and one a square
// picture as the control. The owner shares a Thread for chat, everyone tags
// someone, and then the owner and one member open every place dx shows a
// person: the Thread header stack and its people menu, the owner beside the
// title, message authors and their cards, the @ picker, the Mentions inbox,
// shared Thread rows, Thread search, the sidebar account row, the account
// profile, and the Members list.
//
// Each avatar must lay its picture out in the same square as its round frame,
// so the picture shows as a circle centered in it. The run also samples the
// screenshot just inside each lower corner of the frame, outside the circle,
// where none of the picture may show. It exits non-zero when any avatar fails.
//
// Writes screenshots of every surface, measurements.json (every avatar's frame
// and picture box, natural size, and corner pixels), summary.json, HARs without
// bodies, and console.json to <output>.
//
//   node apps/web/test/avatar-shape-proof.mjs http://127.0.0.1:3000 out/
//   pnpm --filter @dx/web test:avatar-shape http://127.0.0.1:3000 out/
//
// The owner comes from DX_PROOF_EMAIL / DX_PROOF_PASSWORD, or from the local
// account in apps/core/.dev.vars, and must own or administer its workspace.
// Members are throwaway `avatar-shape-*@example.com` accounts that sign up
// through an invite link, which works only where sign-up needs no email
// verification (local). Where sign-up is refused, as on a branch preview, the
// run checks only the owner's own avatars (header stack, people menu, shared
// Thread row, sidebar account row, account profile, Members list), and
// summary.json says so. The run removes every picture and member it added.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, outputArgument] = process.argv.slice(2);
assert(base && outputArgument, "Usage: <base url> <output dir>");
const output = resolve(outputArgument);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const devVars = resolve(import.meta.dirname, "../../core/.dev.vars");
const local = existsSync(devVars)
  ? parseEnv(readFileSync(devVars, "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? local.DX_LOCAL_AUTH_EMAIL;
const password = process.env.DX_PROOF_PASSWORD ?? local.DX_LOCAL_AUTH_PASSWORD;
assert(email && password, "No proof account credentials.");
const stamp = Date.now().toString(36);
const secrets = [password];

// Each person's picture: its size and its backdrop, which fills the left and
// right eighth of the picture so a corner sample can recognize it.
const people = [
  {
    key: "owner",
    name: "Olivia Owner",
    size: [480, 640],
    backdrop: [240, 138, 36],
  },
  {
    key: "ben",
    name: "Ben Portrait",
    size: [360, 640],
    backdrop: [31, 163, 163],
  },
  {
    key: "cara",
    name: "Cara Landscape",
    size: [640, 360],
    backdrop: [122, 79, 209],
  },
  { key: "dan", name: "Dan Square", size: [400, 400], backdrop: [214, 51, 92] },
];
const hex = ([r, g, b]) =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

const browser = await chromium.launch(
  process.env.DX_PROOF_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.DX_PROOF_CHROMIUM },
);
const harPaths = [];
const consoleMessages = [];
const pageErrors = [];
const newContext = (name) => {
  const path = join(output, `${name}.har`);
  harPaths.push(path);
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    colorScheme: "light",
    deviceScaleFactor: 2,
    recordHar: { path, content: "omit" },
  });
};
const watch = (page, account) => {
  page.on("console", (message) =>
    consoleMessages.push({
      account,
      type: message.type(),
      text: message.text(),
      url: page.url(),
    }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ account, message: error.message, url: page.url() }),
  );
};
// Better Auth limits sign-up and sign-in bursts; wait out a 429.
const authPost = async (context, path, data) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await context.request.post(`${base}/api/auth/${path}`, {
      headers: { origin: base },
      data,
    });
    if (response.status() !== 429 || attempt === 30) return response;
    const wait = Number(response.headers()["x-retry-after"] ?? 2);
    await new Promise((done) => setTimeout(done, (wait + 0.5) * 1000));
  }
};
const signIn = async (context, account) => {
  const response = await authPost(context, "sign-in/email", account);
  assert.equal(response.status(), 200, "Password sign-in failed.");
};
const apiFor =
  (context) =>
  async (method, path, data = undefined) => {
    const response = await context.request.fetch(`${base}${path}`, {
      method,
      headers: { origin: base },
      ...(data === undefined ? {} : { data }),
    });
    return {
      status: response.status(),
      body: await response.json().catch(() => undefined),
    };
  };
const ok = async (result) => {
  const { status, body } = await result;
  assert(status < 300, `API answered ${status}: ${JSON.stringify(body)}`);
  return body.data;
};

// Illustrated head-and-shoulders pictures, drawn in the browser so the run
// needs no image tools.
const artist = await browser.newPage();
for (const person of people) {
  const [width, height] = person.size;
  const unit = Math.min(width, height);
  const cx = width / 2;
  const headY = height * 0.42;
  await artist.setViewportSize({ width, height });
  await artist.setContent(`<body style="margin:0">
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="${hex(person.backdrop)}"/>
  <ellipse cx="${cx}" cy="${height}" rx="${Math.min(unit * 0.36, width * 0.36)}" ry="${unit * 0.3}" fill="#263238"/>
  <rect x="${cx - unit * 0.07}" y="${headY + unit * 0.12}" width="${unit * 0.14}" height="${unit * 0.18}" fill="#f1c27d"/>
  <circle cx="${cx}" cy="${headY}" r="${unit * 0.2}" fill="#f1c27d"/>
  <path d="M${cx - unit * 0.2} ${headY} Q${cx - unit * 0.2} ${headY - unit * 0.24} ${cx} ${headY - unit * 0.23} Q${cx + unit * 0.2} ${headY - unit * 0.24} ${cx + unit * 0.2} ${headY} Q${cx + unit * 0.13} ${headY - unit * 0.12} ${cx} ${headY - unit * 0.11} Q${cx - unit * 0.13} ${headY - unit * 0.12} ${cx - unit * 0.2} ${headY}Z" fill="#3e2723"/>
  <circle cx="${cx - unit * 0.07}" cy="${headY + unit * 0.01}" r="${unit * 0.022}" fill="#263238"/>
  <circle cx="${cx + unit * 0.07}" cy="${headY + unit * 0.01}" r="${unit * 0.022}" fill="#263238"/>
  <path d="M${cx - unit * 0.08} ${headY + unit * 0.09} Q${cx} ${headY + unit * 0.15} ${cx + unit * 0.08} ${headY + unit * 0.09}" stroke="#8d4a2f" stroke-width="${unit * 0.02}" fill="none" stroke-linecap="round"/>
</svg></body>`);
  person.file = join(output, `picture-${person.key}.png`);
  await artist.screenshot({ path: person.file, type: "png" });
}
await artist.close();

// Reads screenshot pixels by drawing the PNG on a canvas.
const pixelPage = await browser.newPage();
const pixelsAt = (png, points) =>
  pixelPage.evaluate(
    async ({ source, points }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return points.map(([x, y]) => [
        ...context.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      ]);
    },
    { source: `data:image/png;base64,${png.toString("base64")}`, points },
  );

const summary = { base, stamp, steps: [], failures: [] };
const measurements = [];
const step = (name, detail = {}) => {
  summary.steps.push({ name, ...detail });
  console.log(`✓ ${name}`);
};

/**
 * Every visible avatar frame matching `selector`: its box, its picture's box,
 * natural size, and the CSS that sizes it.
 */
const frames = (page, selector) =>
  page.evaluate((selector) => {
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return [...document.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const style = getComputedStyle(element);
        const image = element.querySelector("img");
        const frame = rect(element);
        const border = (side) =>
          Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
        return {
          frame,
          // Inside the frame's border, where the picture belongs.
          inner: {
            x: frame.x + border("left"),
            y: frame.y + border("top"),
            width: frame.width - border("left") - border("right"),
            height: frame.height - border("top") - border("bottom"),
          },
          overflow: style.overflow,
          radius: style.borderTopLeftRadius,
          picture:
            image === null
              ? null
              : {
                  ...rect(image),
                  src: image.getAttribute("src"),
                  natural: [image.naturalWidth, image.naturalHeight],
                  minHeight: getComputedStyle(image).minHeight,
                  radius: getComputedStyle(image).borderTopLeftRadius,
                },
          text: image === null ? element.textContent?.trim() : undefined,
        };
      });
  }, selector);

const pictureLoaded = (page, selector) =>
  page.waitForFunction(
    (selector) =>
      [...document.querySelectorAll(`${selector} img`)].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    selector,
  );

const near = (left, right) => Math.abs(left - right) <= 0.5;
const close = (left, right) =>
  left.slice(0, 3).every((value, index) => Math.abs(value - right[index]) < 40);

/**
 * Measures every avatar of one surface, screenshots it, and records whether
 * each renders as a circle.
 */
const survey = async (page, viewer, surface, selector, clip) => {
  await page.locator(selector).first().waitFor();
  await pictureLoaded(page, selector);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const found = await frames(page, selector);
  assert(found.length > 0, `${surface}: no avatar is visible.`);
  const name = `${viewer}-${surface}`;
  const png = await page.screenshot({ path: join(output, `${name}.png`) });
  if (clip !== undefined)
    await page
      .locator(clip)
      .first()
      .screenshot({ path: join(output, `${name}.zoom.png`) });
  for (const avatar of found) {
    const { frame, inner, picture } = avatar;
    const person = people.find(
      (entry) => picture !== null && entry.avatarUrl === picture.src,
    );
    const square =
      near(frame.width, frame.height) && near(inner.width, inner.height);
    const fills =
      picture === null ||
      (near(picture.x, inner.x) &&
        near(picture.y, inner.y) &&
        near(picture.width, inner.width) &&
        near(picture.height, inner.height));
    const clips = avatar.overflow !== "visible";
    // Just inside each lower corner of the frame, outside its circle.
    const corners = [
      [frame.x + 1, frame.y + frame.height - 1],
      [frame.x + frame.width - 1, frame.y + frame.height - 1],
    ];
    const colors =
      person === undefined
        ? []
        : await pixelsAt(
            png,
            corners.map(([x, y]) => [x * 2, y * 2]),
          );
    const pictureInCorner = colors.some((color) =>
      close(color, person.backdrop),
    );
    const shape =
      square && fills && !pictureInCorner
        ? "circle"
        : clips && square && !pictureInCorner
          ? "circle frame, picture off center"
          : "oval";
    const entry = {
      viewer,
      surface,
      selector,
      person: person?.key ?? (picture === null ? "initials" : "other"),
      shape,
      ...avatar,
      cornerColors: colors,
      pictureInCorner,
    };
    measurements.push(entry);
    if (shape !== "circle")
      summary.failures.push(
        `${viewer} ${surface}: ${entry.person} renders as ${shape} (frame ${frame.width}×${frame.height}, picture ${picture?.width}×${picture?.height})`,
      );
  }
  step(`${viewer} sees ${found.length} avatar(s) on ${surface}`, {
    shapes: found.length,
  });
};

const uploadPicture = async (page, person) => {
  await page.goto(`${base}/settings`);
  const profile = page.locator(".account-profile-card");
  await profile.getByRole("button", { name: "Edit" }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/settings/personal/account/avatar") &&
      response.request().method() === "PUT",
  );
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    profile.getByRole("button", { name: "Upload" }).click(),
  ]);
  await chooser.setFiles(person.file);
  assert.equal((await saved).status(), 200);
  await profile.getByRole("button", { name: "Cancel" }).click();
};

const send = async (page, text) => {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(text);
  await composer.press("Escape");
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/v1/agents/") &&
      response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await accepted;
};

const owner = await newContext("owner");
await signIn(owner, { email, password });
const ownerApi = apiFor(owner);
let workspace = (await ok(ownerApi("GET", "/v1/settings/personal"))).workspace;
if (workspace === undefined) {
  workspace = await ok(
    ownerApi("POST", "/v1/settings/workspaces", {
      displayName: "Acme Engineering",
      shortName: `acme-${stamp}`,
    }),
  );
  summary.createdWorkspace = workspace.shortName;
}
assert(
  workspace !== undefined && ["owner", "admin"].includes(workspace.role),
  "The proof account does not administer a workspace.",
);
const slug = workspace.shortName;
const contexts = { owner };
const pages = {};
const memberIds = [];

try {
  people[0].email = email;
  for (const person of people.slice(1)) {
    const account = {
      email: `avatar-shape-${person.key}-${stamp}@example.com`,
      password: `Proof-${stamp}-${Math.random().toString(36).slice(2)}`,
    };
    secrets.push(account.password);
    person.email = account.email;
    const link = await ok(
      ownerApi("POST", `/v1/settings/workspaces/${slug}/invite-links`, {
        title: `avatar-shape-${person.key}-${stamp}`,
      }),
    );
    const token = new URL(link.url).pathname.split("/").at(-1);
    const context = await newContext(person.key);
    const signUp = await authPost(context, "sign-up/email", {
      ...account,
      name: person.name,
    });
    if (signUp.status() === 200) {
      await signIn(context, account);
      await ok(apiFor(context)("POST", `/v1/invites/${token}/accept`));
      contexts[person.key] = context;
    } else {
      summary.membersSkipped = `Member sign-up answered ${signUp.status()}.`;
      await context.close();
    }
    await ok(
      ownerApi(
        "DELETE",
        `/v1/settings/workspaces/${slug}/invite-links/${link.id}`,
      ),
    );
    if (summary.membersSkipped !== undefined) break;
  }
  // Where sign-up needs a verified email, only the owner's own avatars run.
  const present = people.filter(({ key }) => contexts[key] !== undefined);
  const together = present.length > 1;
  step(
    together
      ? "three members joined the workspace through invite links"
      : "members skipped; checking the owner's own avatars",
    { membersSkipped: summary.membersSkipped },
  );

  for (const person of present) {
    const context = contexts[person.key];
    const page = await context.newPage();
    watch(page, person.key);
    pages[person.key] = page;
    await uploadPicture(page, person);
    const account = await ok(
      apiFor(context)("GET", "/v1/settings/personal/account"),
    );
    person.avatarUrl = account.avatarUrl;
    person.handle = account.username;
    assert(person.avatarUrl, `${person.key} has no picture.`);
  }
  step("everyone uploaded a picture through Settings → Account", {
    pictures: people.map(({ key, size, avatarUrl }) => ({
      key,
      size,
      avatarUrl,
    })),
  });

  // Locally a Thread needs a served model and a Project; the model fixture
  // answers, so the key is never used. A deployment has its own model.
  const loopback = ["127.0.0.1", "localhost"].includes(new URL(base).hostname);
  let projectId;
  if (loopback) {
    const connections = await ok(
      ownerApi("GET", "/v1/settings/personal/model-routing/connections"),
    );
    if (!JSON.stringify(connections).includes("avatar-shape-fixture"))
      await ok(
        ownerApi("POST", "/v1/settings/personal/model-routing/connections", {
          name: "avatar-shape-fixture",
          kind: "provider",
          providerId: "openai",
          apiKey: "sk-local-fixture-never-used",
          enabled: true,
        }),
      );
    projectId = (
      await ok(
        ownerApi("POST", "/v1/projects", {
          name: `avatar-shape-${stamp}`,
          source: {
            kind: "github-url",
            url: "https://github.com/dxcode-dev/local-fixture.git",
          },
        }),
      )
    ).id;
  }
  const thread = await ok(
    ownerApi("POST", "/v1/threads", {
      title: "Team photo check",
      generateTitle: false,
      ...(projectId === undefined ? {} : { projectId }),
    }),
  );
  summary.threadId = thread.id;
  await ok(
    ownerApi("PUT", `/v1/threads/${thread.id}/sharing`, {
      workspaceAccess: "contribute",
      contributeFor: "1h",
      skipMultiplayerConfirmation: true,
    }),
  );
  const openThread = async (page) => {
    await page.goto(`${base}/threads/${thread.id}`);
    await page
      .getByRole("region", { name: "Thread transcript" })
      .waitFor({ timeout: 60_000 });
  };
  if (together) {
    for (const person of present.slice(1)) {
      await openThread(pages[person.key]);
      await send(
        pages[person.key],
        `@${people[0].handle} here is my new picture, ${person.name.split(" ")[0]}`,
      );
    }
    await openThread(pages.owner);
    await send(pages.owner, `@${people[1].handle} thanks, looks good`);
    step("everyone tagged someone in the shared Thread's chat");
  }

  for (const viewer of together ? ["owner", "ben"] : ["owner"]) {
    const page = pages[viewer];
    await openThread(page);
    await page
      .locator(".participant-stack .dx-avatar")
      .nth(Math.min(present.length, 3) - 1)
      .waitFor();
    await survey(
      page,
      viewer,
      "thread-header-stack",
      ".participant-stack > .dx-avatar",
      ".thread-title-bar",
    );
    if (viewer !== "owner")
      await survey(
        page,
        viewer,
        "thread-title-owner",
        ".thread-title-owner .dx-avatar",
        ".thread-title-bar",
      );
    if (together)
      await survey(
        page,
        viewer,
        "message-authors",
        ".message-author .dx-avatar",
        '[aria-label="Thread transcript"]',
      );
    await survey(
      page,
      viewer,
      "sidebar-thread-row",
      ".thread-row-avatars .dx-avatar",
      ".thread-row-shell[data-avatars]",
    );
    await survey(
      page,
      viewer,
      "sidebar-account",
      ".sidebar-account-avatar",
      ".sidebar-account-row",
    );

    await page.locator(".thread-participants-trigger").click();
    await survey(
      page,
      viewer,
      "people-menu",
      ".thread-participant-row .dx-avatar",
      ".thread-participants-menu",
    );
    await page.keyboard.press("Escape");

    // These need other people: their messages, tags, and Threads.
    if (together) {
      const other = page
        .locator(".message-author-trigger")
        .filter({ hasNotText: "You" })
        .first();
      await other.click();
      await survey(
        page,
        viewer,
        "member-card",
        ".member-card .dx-avatar",
        ".member-card",
      );
      await page.keyboard.press("Escape");

      const composer = page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await composer.click();
      await composer.pressSequentially("@");
      await survey(
        page,
        viewer,
        "mention-picker",
        ".composer-mention-option .dx-avatar",
        ".composer-mention-list",
      );
      await composer.press("Escape");
      await composer.fill("");

      await page
        .getByRole("button", { name: /^Mentions(, \d+ unread)?$/ })
        .click();
      await survey(
        page,
        viewer,
        "mentions-inbox",
        ".notification-row .dx-avatar",
        ".notification-popup",
      );
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Search threads" }).click();
      await survey(
        page,
        viewer,
        "thread-search",
        ".thread-search-result .dx-avatar",
        ".thread-search-result",
      );
      await page.keyboard.press("Escape");
    }

    await page.goto(`${base}/settings`);
    await survey(
      page,
      viewer,
      "account-profile",
      ".account-avatar",
      ".account-profile-card",
    );
    await page
      .locator(".account-profile-card")
      .getByRole("button", { name: "Edit" })
      .click();
    await survey(
      page,
      viewer,
      "account-profile-edit",
      ".account-avatar",
      ".account-profile-card",
    );
    await page
      .locator(".account-profile-card")
      .getByRole("button", { name: "Cancel" })
      .click();

    await page.goto(`${base}/workspaces/${slug}/members`);
    await page
      .locator(".members-person .members-avatar img")
      .nth(present.length - 1)
      .waitFor();
    await survey(
      page,
      viewer,
      "members-list",
      ".members-person .members-avatar",
      ".members-person",
    );
  }
  summary.passed = summary.failures.length === 0;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  // Leave no pictures or members behind.
  for (const person of people) {
    const context = contexts[person.key];
    if (context === undefined) continue;
    await apiFor(context)("DELETE", "/v1/settings/personal/account/avatar");
  }
  const members = await ok(
    ownerApi("GET", `/v1/settings/workspaces/${slug}/members`),
  ).catch(() => ({ members: [] }));
  for (const member of members.members) {
    if (!member.email?.startsWith(`avatar-shape-`)) continue;
    if (!member.email.endsWith(`-${stamp}@example.com`)) continue;
    memberIds.push(member.userId);
    await ownerApi(
      "DELETE",
      `/v1/settings/workspaces/${slug}/members/${member.userId}`,
    );
  }
  summary.removedMembers = memberIds.length;
  for (const context of Object.values(contexts)) await context.close();
  await browser.close();
  summary.counts = measurements.reduce((counts, { shape }) => {
    counts[shape] = (counts[shape] ?? 0) + 1;
    return counts;
  }, {});
  summary.consoleErrors = consoleMessages.filter(
    ({ type }) => type === "error",
  ).length;
  summary.pageErrors = pageErrors;
  const redact = (text) =>
    secrets.reduce(
      (value, secret) => value.replaceAll(secret, "[redacted]"),
      text,
    );
  writeFileSync(
    join(output, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(output, "console.json"),
    redact(JSON.stringify(consoleMessages, null, 2)),
  );
  for (const path of harPaths)
    if (existsSync(path))
      writeFileSync(path, redact(readFileSync(path, "utf8")));
}
for (const failure of summary.failures) console.log(`✗ ${failure}`);
console.log(
  `${measurements.length} avatars measured: ${JSON.stringify(summary.counts)}`,
);
process.exitCode = summary.passed ? 0 : 1;
