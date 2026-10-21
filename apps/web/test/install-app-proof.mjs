// Proves the signed-in app's install banner and new-version refresh on phone
// and desktop emulation (local only; never contacts providers). Builds the
// thread page harness in production mode (the real router and ProductShell)
// and serves it the way Cloudflare static assets do: a path without a file
// answers with the HTML entry. A "deploy" serves HTML whose entry script is a
// copy under a new name, which is all a new build changes in index.html.
//
//   pnpm --filter @dx/web test:install-app
//
// Failure modes it covers:
// - the banner shows on desktop, in the installed app, or after × in the same
//   session; or stays hidden in a new session
// - Android's install prompt fired before the app mounted and was lost
// - an in-app browser (Instagram, Android WebView) is told to install
// - a new version goes unnoticed when the person returns to the app
// - an automatic refresh discards a message the person is typing
// - a server still serving the old page causes a reload loop
// - the banner overlaps the page instead of pushing it down
//
// Writes report.json, screenshots, a HAR, and console/page errors to
// .dx/journeys/install-app/ and exits 1 unless every check passed.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium, devices } from "playwright-core";

const output = resolve(
  import.meta.dirname,
  "../../../.dx/journeys/install-app",
);
mkdirSync(output, { recursive: true });
const { build } = await import("vite");
await build({
  configFile: resolve(import.meta.dirname, "../vite.stress.config.ts"),
  logLevel: "warn",
});
const dist = resolve(import.meta.dirname, "../node_modules/.stress-dist");
const originalHtml = readFileSync(
  join(dist, "thread-page-stress.html"),
  "utf8",
);
const entryPattern = /<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"/;
const originalEntry = entryPattern.exec(originalHtml)?.[1];
if (originalEntry === undefined)
  throw new Error("The harness HTML has no module entry script.");
/** A build whose only index.html change is a new entry script name. */
const deployVersion = (label) => {
  const entry = originalEntry.replace(/\.js$/, `-${label}.js`);
  copyFileSync(join(dist, originalEntry), join(dist, entry));
  return { entry, html: originalHtml.replace(originalEntry, entry) };
};

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".wasm": "application/wasm",
};
let pageVersion = { entry: originalEntry, html: originalHtml };
const server = createServer((request, response) => {
  // The source index.html, for checks that run only its inline head.
  if (request.url === "/__index.html") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(readFileSync(resolve(import.meta.dirname, "../index.html")));
    return;
  }
  const path = join(
    dist,
    decodeURIComponent(new URL(request.url, "http://x").pathname),
  );
  if (path.startsWith(dist) && existsSync(path) && extname(path) !== "") {
    if (extname(path) === ".html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageVersion.html);
      return;
    }
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
    });
    response.end(readFileSync(path));
    return;
  }
  // notFoundHandling: "single-page-application"
  response.writeHead(200, {
    "content-type": "text/html",
    "cache-control": "public, max-age=0, must-revalidate",
  });
  response.end(pageVersion.html);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const threadUrl = `${origin}/thread-page-stress.html?turns=4&tool=20`;

const instagramUserAgent = `${devices["iPhone 15"].userAgent} Instagram 300.0.0.0`;
const androidWebViewUserAgent = devices["Pixel 7"].userAgent.replace(
  "Android 14; Pixel 7)",
  "Android 14; Pixel 7; wv)",
);

const browser = await chromium.launch();
const errors = [];
const checks = [];
const check = (name, passed, detail) => {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? "ok  " : "FAIL"} ${name}`);
};
const contexts = [];
const newContext = async (name, options, initScript) => {
  const context = await browser.newContext({
    ...options,
    recordHar: { path: join(output, `${name}.har`) },
  });
  if (initScript !== undefined) await context.addInitScript(initScript);
  contexts.push(context);
  return context;
};
const openThread = async (context) => {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(threadUrl);
  await page.waitForSelector('textarea[aria-label="Message"]:not([disabled])');
  await page.waitForLoadState("networkidle");
  return page;
};
const banner = (page) => page.getByRole("region", { name: "Install dx" });
const visible = (locator) =>
  locator.waitFor({ state: "visible", timeout: 5_000 }).then(
    () => true,
    () => false,
  );
const absent = async (page, locator) => {
  // Give a late render the chance to show the banner before asserting.
  await page.waitForTimeout(500);
  return (await locator.count()) === 0;
};
/** The person leaves the app and comes back to it. */
const leaveAndReturn = (page) =>
  page.evaluate(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
const markDocument = (page) =>
  page.evaluate(() => {
    window.__sameDocument = true;
  });
const reloadedWithin = (page, timeout) =>
  page
    .waitForFunction(() => window.__sameDocument === undefined, null, {
      timeout,
    })
    .then(
      () => true,
      () => false,
    );
const runningEntry = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('script[type="module"][src]')
        ?.getAttribute("src") ?? undefined,
  );

try {
  // Desktop: never offered.
  const desktop = await newContext("desktop", {
    viewport: { width: 1440, height: 900 },
  });
  const desktopPage = await openThread(desktop);
  check(
    "desktop shows no install banner",
    await absent(desktopPage, banner(desktopPage)),
  );

  // iPhone Safari: the banner opens Apple's Add to Home Screen steps.
  const iphone = await newContext("iphone", devices["iPhone 15"]);
  const iphonePage = await openThread(iphone);
  check("iPhone shows the install banner", await visible(banner(iphonePage)));
  const layout = await iphonePage.evaluate(() => {
    const bannerBox = document
      .querySelector(".install-app-banner")
      ?.getBoundingClientRect();
    const content = document
      .querySelector(".product-shell-content")
      ?.getBoundingClientRect();
    return {
      bannerBottom: bannerBox?.bottom,
      contentTop: content?.top,
      contentBottom: content?.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  check(
    "the banner pushes the page down without overflowing it",
    layout.bannerBottom !== undefined &&
      layout.contentTop !== undefined &&
      layout.contentTop >= layout.bannerBottom - 0.5 &&
      layout.contentBottom <= layout.viewportHeight + 0.5,
    layout,
  );
  await iphonePage.screenshot({ path: join(output, "iphone-banner.png") });
  await banner(iphonePage)
    .getByRole("button", { name: "Install", exact: true })
    .click();
  const iosGuide = iphonePage.getByRole("dialog", { name: "Install dx" });
  check(
    "iPhone guide names Add to Home Screen and Open as Web App",
    (await visible(iosGuide.getByText("Add to Home Screen"))) &&
      (await visible(iosGuide.getByText("Open as Web App"))),
  );
  await iphonePage.screenshot({ path: join(output, "iphone-guide.png") });
  await iphonePage.keyboard.press("Escape");
  await banner(iphonePage)
    .getByRole("button", { name: "Dismiss install banner" })
    .click();
  check("× hides the banner", await absent(iphonePage, banner(iphonePage)));
  await iphonePage.reload();
  await iphonePage.waitForSelector('textarea[aria-label="Message"]');
  check(
    "the banner stays hidden after a reload in the same session",
    await absent(iphonePage, banner(iphonePage)),
  );
  const nextSession = await openThread(iphone);
  check(
    "a new session shows the banner again",
    await visible(banner(nextSession)),
  );
  await nextSession.close();

  // Installed on iPhone: opened from the Home Screen.
  const installed = await newContext(
    "iphone-installed",
    devices["iPhone 15"],
    () => Object.defineProperty(navigator, "standalone", { get: () => true }),
  );
  const installedPage = await openThread(installed);
  check(
    "the installed app shows no install banner",
    await absent(installedPage, banner(installedPage)),
  );
  // iOS colours the status bar from theme-color and, on iOS 26, from the
  // page behind the app; both must be the app's own top surface.
  const statusBar = await installedPage.evaluate(() => {
    const themeColor =
      document.querySelector('meta[name="theme-color"]')?.content ?? "";
    const probe = document.createElement("div");
    probe.style.color = themeColor;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return {
      themeColor,
      valid: CSS.supports("color", themeColor),
      resolved,
      frame: getComputedStyle(document.querySelector(".dx-app-frame"))
        .backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  check(
    "the status bar colour is the app's top surface",
    statusBar.valid &&
      statusBar.resolved === statusBar.frame &&
      statusBar.body === statusBar.frame,
    statusBar,
  );
  // An iPhone's home indicator and rounded corners: the drawer clears them.
  const insets = { top: 0, bottom: 34, left: 0, right: 0 };
  await (await installed.newCDPSession(installedPage)).send(
    "Emulation.setSafeAreaInsetsOverride",
    { insets },
  );
  await installedPage.getByRole("button", { name: "Open sidebar" }).click();
  await installedPage.waitForSelector(".mobile-sidebar-drawer");
  await installedPage.waitForTimeout(500);
  const drawer = await installedPage.evaluate(() => {
    const box = document
      .querySelector(".mobile-sidebar-drawer")
      .getBoundingClientRect();
    return { left: box.left, bottom: box.bottom, viewportHeight: innerHeight };
  });
  check(
    "the sidebar drawer stays inside the safe area",
    drawer.bottom <= drawer.viewportHeight - insets.bottom && drawer.left >= 8,
    drawer,
  );
  await installedPage.screenshot({
    path: join(output, "iphone-installed-sidebar.png"),
  });
  await installedPage.keyboard.press("Escape");
  // The thread composer clears the home indicator once, not twice, and the
  // prompt outline and jump controls sit above it, not on it.
  await installedPage.waitForTimeout(500);
  const bottomLayout = await installedPage.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect === undefined || rect.height === 0
        ? undefined
        : { top: rect.top, bottom: rect.bottom };
    };
    return {
      composer: box(".agent-composer"),
      controls: box(".transcript-controls"),
      viewportHeight: window.innerHeight,
    };
  });
  const composerGap =
    bottomLayout.viewportHeight - (bottomLayout.composer?.bottom ?? 0);
  check(
    "the thread composer sits just above the home indicator",
    composerGap >= insets.bottom && composerGap <= insets.bottom + 12,
    { composerGap, ...bottomLayout },
  );
  check(
    "the prompt outline does not overlap the composer",
    bottomLayout.controls !== undefined &&
      bottomLayout.composer !== undefined &&
      bottomLayout.controls.bottom <= bottomLayout.composer.top - 4,
    bottomLayout,
  );
  await installedPage.screenshot({
    path: join(output, "iphone-installed-composer.png"),
  });
  // The sidebar drawer drags like a native one: it follows the finger and
  // settles on release; a touch that does not travel sideways does nothing.
  const touch = await installed.newCDPSession(installedPage);
  const send = (type, points) =>
    touch.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const frame = () =>
    installedPage.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => {
            const onScreen = [
              ...document.querySelectorAll(".product-sidebar"),
            ].filter((sidebar) => {
              const box = sidebar.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.right > 0.5 &&
                box.left < window.innerWidth &&
                getComputedStyle(sidebar).visibility !== "hidden"
              );
            }).length;
            const drawer = document
              .querySelector(".mobile-sidebar-drawer")
              ?.getBoundingClientRect();
            done({ right: drawer?.right, onScreen });
          }),
        ),
    );
  /** Moves the finger through `xs` at `y`, sampling the drawer each step. */
  const drag = async (
    xs,
    y,
    { pause = 30, release = true, sample = true } = {},
  ) => {
    const samples = [];
    await send("touchStart", [{ x: xs[0], y }]);
    for (const x of xs.slice(1)) {
      await send("touchMove", [{ x, y }]);
      if (pause > 0) await installedPage.waitForTimeout(pause);
      if (sample) samples.push({ finger: x, ...(await frame()) });
    }
    if (release) {
      await send("touchEnd", []);
      await installedPage.waitForTimeout(700);
    }
    return samples;
  };
  const letGo = async () => {
    await send("touchEnd", []);
    await installedPage.waitForTimeout(700);
  };
  const drawerOpen = () =>
    installedPage.evaluate(
      () =>
        document.querySelector(".mobile-sidebar-drawer[data-open]") !== null,
    );
  const steps = (from, to, count) =>
    Array.from(
      { length: count + 1 },
      (_, index) => from + ((to - from) * index) / count,
    );
  const fingerGap = (samples) => {
    const gaps = samples
      .filter((sample) => sample.right !== undefined && sample.right > 0)
      .map((sample) => sample.finger - sample.right)
      .slice(2);
    return gaps.length >= 5 ? Math.max(...gaps) - Math.min(...gaps) : NaN;
  };
  const middle = 330;

  await send("touchStart", [{ x: 14, y: middle }]);
  await send("touchMove", [{ x: 19, y: middle + 2 }]);
  await installedPage.waitForTimeout(400);
  const held = await frame();
  await letGo();
  check(
    "a light touch or hold on the left does nothing",
    !(await drawerOpen()) && !(held.right > 0),
    held,
  );
  const edgeTouchClaimed = await installedPage.evaluate(() => {
    const target = document.querySelector(".product-shell-content");
    const box = target.getBoundingClientRect();
    const start = new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [
        new Touch({
          identifier: 1,
          target,
          clientX: 6,
          clientY: box.top + box.height / 2,
        }),
      ],
    });
    target.dispatchEvent(start);
    target.dispatchEvent(
      new TouchEvent("touchcancel", { bubbles: true, cancelable: true }),
    );
    return start.defaultPrevented;
  });
  check(
    "an edge touch is kept from the browser's back-swipe gesture",
    edgeTouchClaimed,
  );
  await drag(steps(14, 34, 4), middle);
  check("a short drag springs back closed", !(await drawerOpen()));

  const following = await drag(steps(16, 200, 12), middle, {
    release: false,
  });
  check(
    "the drawer follows the finger as it drags",
    fingerGap(following) < 6,
    following,
  );
  check(
    "only one sidebar is ever on screen",
    following.every((sample) => sample.onScreen <= 1),
    following.map((sample) => sample.onScreen),
  );
  const back = await drag(steps(200, 40, 8), middle, { release: false });
  await letGo();
  check(
    "dragging back before letting go puts it away",
    !(await drawerOpen()) && back.at(-1).right < following.at(-1).right,
    back.map((sample) => sample.right),
  );

  await drag(steps(16, 260, 12), middle);
  check("a slow drag past halfway opens the sidebar", await drawerOpen());
  await installedPage.screenshot({
    path: join(output, "iphone-drag-open.png"),
  });
  const closing = await drag(steps(280, 60, 10), middle, { release: false });
  await letGo();
  check(
    "dragging the open sidebar left follows the finger and closes it",
    !(await drawerOpen()) && fingerGap(closing) < 6,
    closing,
  );

  // A flick: moves as fast as a finger reports them, about every 10ms.
  await drag(steps(14, 110, 3), middle, { pause: 10, sample: false });
  check("a quick flick opens the sidebar", await drawerOpen());
  await drag(steps(260, 180, 3), middle, { pause: 10, sample: false });
  check("a quick flick left closes it", !(await drawerOpen()));

  await send("touchStart", [{ x: 40, y: middle }]);
  for (const step of [1, 2, 3, 4, 5, 6])
    await send("touchMove", [{ x: 40 + step * 3, y: middle + step * 30 }]);
  await letGo();
  check("a vertical scroll does not open the sidebar", !(await drawerOpen()));
  await drag(steps(330, 390, 6), middle);
  check(
    "a drag from the right half does not open the sidebar",
    !(await drawerOpen()),
  );
  const composer = await installedPage
    .locator('textarea[aria-label="Message"]')
    .boundingBox();
  await drag(
    steps(composer.x + 8, composer.x + 200, 8),
    composer.y + composer.height / 2,
  );
  check(
    "a drag in the composer does not open the sidebar",
    !(await drawerOpen()),
  );

  // Recorded drag: every animation frame of a slow pull, a let-go past
  // halfway, and a push back short of halfway is logged and inspected.
  const filmed = await browser.newContext({
    ...devices["iPhone 15"],
    recordVideo: {
      dir: join(output, "drawer-video"),
      size: { width: 393, height: 659 },
    },
  });
  contexts.push(filmed);
  await filmed.addInitScript(() =>
    Object.defineProperty(navigator, "standalone", { get: () => true }),
  );
  const filmPage = await openThread(filmed);
  const filmTouch = await filmed.newCDPSession(filmPage);
  const filmSend = (type, points) =>
    filmTouch.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await filmPage.evaluate(() => {
    window.__frames = [];
    const log = () => {
      const drawer = document
        .querySelector(".mobile-sidebar-drawer")
        ?.getBoundingClientRect();
      const onScreen = [
        ...document.querySelectorAll(".product-sidebar"),
      ].filter((sidebar) => {
        const box = sidebar.getBoundingClientRect();
        return box.width > 0 && box.right > 0.5 && box.left < innerWidth;
      }).length;
      window.__frames.push({
        time: performance.now(),
        right: drawer === undefined ? -1 : Math.round(drawer.right),
        onScreen,
        phase: window.__phase ?? "idle",
      });
      if (window.__filming !== false) requestAnimationFrame(log);
    };
    requestAnimationFrame(log);
  });
  const phase = (name) =>
    filmPage.evaluate((value) => {
      window.__phase = value;
    }, name);
  const filmDrag = async (xs, y, name) => {
    await phase(`${name}:drag`);
    await filmSend("touchStart", [{ x: xs[0], y }]);
    for (const x of xs.slice(1)) {
      await filmSend("touchMove", [{ x, y }]);
      await filmPage.waitForTimeout(24);
    }
    await phase(`${name}:settle`);
    await filmSend("touchEnd", []);
    await filmPage.waitForTimeout(800);
  };
  await filmDrag(steps(16, 250, 20), 330, "open");
  await filmDrag(steps(280, 200, 8), 330, "stay-open");
  await filmDrag(steps(280, 40, 20), 330, "close");
  const frames = await filmPage.evaluate(() => {
    window.__filming = false;
    return window.__frames;
  });
  await filmed.close();
  const settle = (name) =>
    frames.filter((entry) => entry.phase === `${name}:settle`);
  const steady = (entries, direction) =>
    entries.every(
      (entry, index) =>
        index === 0 ||
        (entry.right - entries[index - 1].right) * direction >= -1,
    );
  check(
    "recorded: one sidebar on screen in every frame",
    frames.every((entry) => entry.onScreen <= 1),
    { frames: frames.length },
  );
  check(
    "recorded: letting go past halfway glides open without reversing",
    steady(settle("open"), 1) && settle("open").at(-1)?.right > 250,
    settle("open").map((entry) => entry.right),
  );
  check(
    "recorded: a short push lets it spring back open",
    steady(settle("stay-open"), 1) && settle("stay-open").at(-1)?.right > 250,
    settle("stay-open").map((entry) => entry.right),
  );
  check(
    "recorded: pushing past halfway glides shut without reversing",
    steady(settle("close"), -1) && settle("close").at(-1)?.right <= 0,
    settle("close").map((entry) => entry.right),
  );
  const video = await filmPage.video()?.path();
  if (video !== undefined) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      video,
      "-vf",
      "fps=8,scale=131:-1,tile=8x4",
      "-frames:v",
      "1",
      join(output, "drawer-frames.png"),
    ]);
  }
  // Samsung Internet and Chrome's auto dark theme recolour pages unless
  // the page forbids it with `only`.
  const colourScheme = await installedPage.evaluate(() => ({
    root: getComputedStyle(document.documentElement).colorScheme,
    meta: document.querySelector('meta[name="color-scheme"]')?.content ?? "",
  }));
  check(
    "the colour scheme forbids browser-forced dark mode",
    colourScheme.root.includes("only") && colourScheme.meta.includes("only"),
    colourScheme,
  );
  // Launch: the saved theme paints before any script or stylesheet loads,
  // so the installed app never flashes white.
  const savedTheme = await installedPage.evaluate(() =>
    localStorage.getItem("dx:boot-theme:v1"),
  );
  check("the app saves its theme for the next launch", savedTheme !== null, {
    savedTheme,
  });
  const launchColours = [];
  for (const [label, appearance, scheme] of [
    ["dark", "dark", "light"],
    ["light", "light", "dark"],
    ["system light", "system", "light"],
  ]) {
    const launch = await browser.newContext({
      ...devices["iPhone 15"],
      colorScheme: scheme,
    });
    contexts.push(launch);
    await launch.addInitScript(
      ([saved, chosen]) => {
        const theme = JSON.parse(saved);
        localStorage.setItem(
          "dx:boot-theme:v1",
          JSON.stringify({ ...theme, appearance: chosen }),
        );
      },
      [savedTheme, appearance],
    );
    const launchPage = await launch.newPage();
    // Only index.html itself: every script and stylesheet is withheld.
    await launchPage.route(/\.(?:js|ts|tsx|css)(?:\?|$)/, (route) =>
      route.abort(),
    );
    await launchPage.goto(`${origin}/__index.html`);
    const painted = await launchPage.evaluate(() => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      appearance: document.documentElement.dataset.resolvedAppearance,
    }));
    const expected = label === "dark" ? "dark" : "light";
    const saved = JSON.parse(savedTheme).surface[expected];
    launchColours.push({ label, painted, saved });
    check(
      `a ${label} launch paints its own colour first`,
      painted.background === saved && painted.appearance === expected,
      { painted, saved },
    );
  }
  // Every signed-in layout, not only the main shell: Settings has its own.
  for (const route of ["/settings", "/projects"]) {
    await installedPage.goto(`${threadUrl}&route=${route}`);
    await installedPage.waitForSelector(".dx-app-frame");
    await installedPage.waitForTimeout(500);
    const colours = await installedPage.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      frame: getComputedStyle(document.querySelector(".dx-app-frame"))
        .backgroundColor,
    }));
    check(
      `the page behind ${route} matches its top surface`,
      colours.body === colours.frame,
      colours,
    );
    // iOS 26 paints the status bar from a fixed element with a solid
    // background at the top edge and then draws no blur over the page.
    const topLayer = await installedPage.evaluate(() => {
      const frame = getComputedStyle(
        document.querySelector(".dx-app-frame"),
      ).backgroundColor;
      const fixedAtTop = document
        .elementsFromPoint(window.innerWidth / 2, 0)
        .map((element) => getComputedStyle(element))
        .find((style) => style.position === "fixed");
      return { frame, fixed: fixedAtTop?.backgroundColor };
    });
    check(
      `${route} has a solid fixed layer under the status bar`,
      topLayer.fixed === topLayer.frame,
      topLayer,
    );
  }

  // In-app browsers cannot install: send the person to a real browser.
  for (const [name, userAgent] of [
    ["instagram", instagramUserAgent],
    ["android-webview", androidWebViewUserAgent],
  ]) {
    const inApp = await newContext(name, {
      ...devices[name === "instagram" ? "iPhone 15" : "Pixel 7"],
      userAgent,
    });
    const inAppPage = await openThread(inApp);
    await banner(inAppPage)
      .getByRole("button", { name: "Install", exact: true })
      .click();
    check(
      `${name} is told to open dx in a browser`,
      await visible(
        inAppPage
          .getByRole("dialog", { name: "Install dx" })
          .getByText("Open in browser"),
      ),
    );
    await inAppPage.screenshot({ path: join(output, `${name}-guide.png`) });
  }

  // Android Chrome: the browser's own install prompt, even when it fired
  // before the signed-in app finished loading.
  const android = await newContext("android", devices["Pixel 7"], () => {
    const fire = () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = () => {
        window.__installPrompted = true;
        return Promise.resolve();
      };
      event.userChoice = new Promise((resolve) => {
        window.__acceptInstall = () => {
          resolve({ outcome: "accepted", platform: "web" });
          window.dispatchEvent(new Event("appinstalled"));
        };
      });
      window.dispatchEvent(event);
      window.__installPromptDefaultPrevented = event.defaultPrevented;
    };
    // Chrome fires it early, typically before lazy app chunks load.
    if (document.readyState === "complete") fire();
    else window.addEventListener("load", fire, { once: true });
  });
  const androidPage = await openThread(android);
  check("Android shows the install banner", await visible(banner(androidPage)));
  check(
    "dx replaces Chrome's mini-infobar with its banner",
    await androidPage.evaluate(() => window.__installPromptDefaultPrevented),
  );
  await androidPage.screenshot({ path: join(output, "android-banner.png") });
  await banner(androidPage)
    .getByRole("button", { name: "Install", exact: true })
    .click();
  check(
    "Install opens Chrome's install prompt",
    await androidPage
      .waitForFunction(() => window.__installPrompted === true, null, {
        timeout: 5_000,
      })
      .then(
        () => true,
        () => false,
      ),
  );
  await androidPage.evaluate(() => window.__acceptInstall());
  check(
    "accepting the install hides the banner",
    await absent(androidPage, banner(androidPage)),
  );

  // Android without a prompt (Firefox, or Chrome before it offers one).
  const androidManual = await newContext("android-manual", devices["Pixel 7"]);
  const androidManualPage = await openThread(androidManual);
  await banner(androidManualPage)
    .getByRole("button", { name: "Install", exact: true })
    .click();
  check(
    "Android without a prompt shows menu steps",
    await visible(
      androidManualPage
        .getByRole("dialog", { name: "Install dx" })
        .getByText("Add to Home screen"),
    ),
  );

  // A new version: dx never reloads by itself; the sidebar offers it.
  const updates = await newContext("updates", devices["iPhone 15"]);
  const updatePage = await openThread(updates);
  const updateDot = updatePage.locator(
    ".product-sidebar-trigger .app-update-dot",
  );
  await markDocument(updatePage);
  await leaveAndReturn(updatePage);
  check(
    "nothing is offered when nothing changed",
    !(await reloadedWithin(updatePage, 1_500)) &&
      (await updateDot.count()) === 0,
  );
  pageVersion = deployVersion("next");
  await leaveAndReturn(updatePage);
  check(
    "a new version never reloads the app by itself",
    !(await reloadedWithin(updatePage, 3_000)),
  );
  check("the sidebar button shows an update dot", await visible(updateDot));
  await updatePage.screenshot({ path: join(output, "update-dot.png") });
  await updatePage.getByRole("button", { name: "Open sidebar" }).click();
  const updateRow = updatePage.getByRole("button", {
    name: "Update available",
  });
  const rowShown = await visible(updateRow);
  const rowPlace = await updatePage.evaluate(() => {
    const row = document
      .querySelector(".mobile-sidebar-drawer .app-update-row")
      ?.getBoundingClientRect();
    const drawer = document
      .querySelector(".mobile-sidebar-drawer")
      ?.getBoundingClientRect();
    return { rowBottom: row?.bottom, drawerBottom: drawer?.bottom };
  });
  check(
    "the update sits at the bottom of the sidebar",
    rowShown && rowPlace.drawerBottom - rowPlace.rowBottom < 120,
    rowPlace,
  );
  await updatePage.screenshot({ path: join(output, "update-sidebar.png") });
  await updateRow.click();
  const updated = await reloadedWithin(updatePage, 5_000);
  await updatePage.waitForSelector('textarea[aria-label="Message"]');
  check(
    "tapping Update loads the new version",
    updated && (await runningEntry(updatePage)) === pageVersion.entry,
  );

  // Desktop: the same row at the bottom of the sidebar.
  pageVersion = deployVersion("desktop");
  await markDocument(desktopPage);
  await leaveAndReturn(desktopPage);
  check(
    "desktop offers the update in the sidebar without reloading",
    (await visible(
      desktopPage.getByRole("button", { name: "Update available" }),
    )) && !(await reloadedWithin(desktopPage, 500)),
  );
  await desktopPage.screenshot({
    path: join(output, "desktop-update.png"),
  });
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  server.close();
}

const passed = checks.length > 0 && checks.every((entry) => entry.passed);
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify({ passed, checks }, null, 2)}\n`,
);
writeFileSync(join(output, "errors.txt"), `${errors.join("\n")}\n`);
console.log(`Evidence: ${output}`);
if (!passed) process.exitCode = 1;
