// Boot flicker tracker: opens each route signed out and signed in, on a
// desktop and a throttled phone, and records what a person sees before the
// page settles.
//
//   node apps/web/test/boot-flicker.mjs <base-url> <out-dir> [options]
//
//   --routes hot|all      hot: landing, sign-in, sign-up, signed-in boot (default all)
//   --repeat <n>          runs per scenario; the report keeps the median (default 3)
//   --only <text>         only scenarios whose id contains <text>
//   --parallel <n>        runs at a time (default 1); n > 1 finishes in
//                         minutes, but its timings only compare to runs with
//                         the same n
//   --assert              exit 1 when a scenario breaks a budget below
//
// Signs in with DX_PERF_EMAIL / DX_PERF_PASSWORD; without them it measures
// only the signed-out routes.
//
// For every run it records:
// - screens: the sequence of distinct screens painted from navigation until
//   the page settles (blank, splash, landing, auth, app, unavailable, other),
//   read from the DOM on every animation frame. A page that shows anything
//   other than [splash →] final is a flash.
// - splashMounts: how many times a full-screen dx loading mark mounted. More
//   than one restarts its animation, which reads as a flicker.
// - themeFlips: how many times the colour painted at the viewport's corner
//   crossed between dark and light (a dark splash, then a light app, is one).
// - shortSplash: a splash on screen for less than 300 ms, a flash of the logo.
// - loaderMounts: loading marks, busy statuses, and skeletons mounted during
//   boot, the splash included; each is a "loads again" moment.
// - settledMs: when the final screen first painted.
// - FCP, LCP, CLS, long tasks (count and total), React commits and component
//   renders during boot (a DevTools-hook stub, so production builds count).
// - A filmstrip: one screenshot per screen change, from CDP screencast frames.
//
// Writes report.json, report.md, and filmstrips/<scenario>/<n>-<screen>.jpg.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const [baseArgument, outArgument] = args.filter(
  (value, index) =>
    !value.startsWith("--") && !args[index - 1]?.startsWith("--"),
);
if (baseArgument === undefined || outArgument === undefined)
  throw new Error(
    "Usage: boot-flicker.mjs <base-url> <out-dir> [--routes hot|all] [--repeat n] [--only text] [--assert]",
  );
const base = baseArgument.replace(/\/$/, "");
const out = resolve(outArgument);
const repeat = Number(option("repeat", "3"));
const routeSet = option("routes", "all");
const only = option("only", undefined);
const parallel = Number(option("parallel", "1"));
const assertBudgets = args.includes("--assert");
mkdirSync(out, { recursive: true });

const email = process.env.DX_PERF_EMAIL;
const password = process.env.DX_PERF_PASSWORD;

// Lighthouse's mobile profile: 4x CPU slowdown on a slow 4G link.
const devices = {
  desktop: {
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  },
  phone: {
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    cpu: 4,
    network: {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    },
  },
};

// Runs in the page before any of its scripts.
const instrument = () => {
  const start = performance.now();
  const state = {
    screens: [],
    backgrounds: [],
    splashMounts: 0,
    loaderMounts: 0,
    commits: 0,
    renders: 0,
    rendersByComponent: {},
    longTasks: [],
    shifts: [],
    lcp: undefined,
    fcp: undefined,
  };
  window.__bootFlicker = state;

  const visible = (element) => {
    if (element === null) return false;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    if (!element.checkVisibility({ visibilityProperty: true })) return false;
    // Its own and its ancestors' opacity: a splash fading in counts once it
    // is a quarter opaque, the least a person notices.
    let opacity = 1;
    for (let node = element; node !== null; node = node.parentElement)
      opacity *= Number(getComputedStyle(node).opacity);
    return opacity >= 0.25;
  };
  const classify = () => {
    const explicit = document.querySelector("[data-screen]");
    if (visible(explicit)) return explicit.getAttribute("data-screen");
    if (visible(document.querySelector(".product-shell, .dx-app-shell")))
      return "app";
    if (visible(document.querySelector(".lp"))) return "landing";
    if (visible(document.querySelector(".sign-in-page"))) return "auth";
    const splash = document.querySelector(".dx-loading-screen");
    // A full-screen loading screen covers everything; until it fades in,
    // only the page background shows.
    if (splash !== null) return visible(splash) ? "splash" : "blank";
    const root = document.getElementById("root");
    if (root === null || root.childElementCount === 0) return "blank";
    const text = (root.innerText ?? "").trim();
    if (text === "") return "blank";
    if (/couldn't reach dx|isn't available/i.test(text)) return "unavailable";
    return "other";
  };
  const pixel = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  const toRgb = (color) => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = color;
    pixel.fillRect(0, 0, 1, 1);
    return [...pixel.getImageData(0, 0, 1, 1).data];
  };
  const sample = () => {
    const screen = classify();
    // The colour painted at the viewport's bottom-right corner: the first
    // element there with a background, else the body's, else the root's.
    const transparent = "rgba(0, 0, 0, 0)";
    const painted = document
      .elementsFromPoint(innerWidth - 2, innerHeight - 2)
      .map((element) => getComputedStyle(element).backgroundColor)
      .find((colour) => colour !== transparent);
    const rgb = toRgb(
      painted ?? getComputedStyle(document.documentElement).backgroundColor,
    );
    const previous = state.backgrounds.at(-1);
    // Colour spaces round differently; a change under 6 per channel is the same colour.
    // Before the first style applies, nothing is painted behind the page.
    if (rgb[3] === 0) {
      // Nothing to compare.
    } else if (
      previous === undefined ||
      rgb
        .slice(0, 3)
        .some((channel, index) => Math.abs(channel - previous[index]) > 6)
    )
      state.backgrounds.push(rgb.slice(0, 3));
    const last = state.screens.at(-1);
    if (last?.screen !== screen)
      state.screens.push({
        screen,
        at: Math.round(performance.now() - start),
        epoch: performance.timeOrigin + performance.now(),
        path: location.pathname,
      });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const loaders = ".dx-loading, [role=status][aria-busy=true], .skeleton";
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (
          node.nodeType === 1 &&
          (node.matches(".dx-loading-screen") ||
            node.querySelector(".dx-loading-screen") !== null)
        )
          state.splashMounts += 1;
    for (const record of records)
      for (const node of record.addedNodes)
        if (node.nodeType === 1)
          state.loaderMounts +=
            (node.matches(loaders) ? 1 : 0) +
            node.querySelectorAll(loaders).length;
  }).observe(document, { childList: true, subtree: true });

  const observe = (type, onEntry) => {
    try {
      new PerformanceObserver((list) =>
        list.getEntries().forEach(onEntry),
      ).observe({
        type,
        buffered: true,
      });
    } catch {
      // This browser does not report the entry type.
    }
  };
  observe("longtask", (entry) =>
    state.longTasks.push({
      at: Math.round(entry.startTime),
      ms: Math.round(entry.duration),
    }),
  );
  observe("layout-shift", (entry) => {
    if (!entry.hadRecentInput)
      state.shifts.push({
        at: Math.round(entry.startTime),
        value: entry.value,
      });
  });
  observe("largest-contentful-paint", (entry) => {
    state.lcp = Math.round(entry.startTime);
  });
  observe("paint", (entry) => {
    if (entry.name === "first-contentful-paint")
      state.fcp = Math.round(entry.startTime);
  });

  // React calls these hooks on every commit when DevTools is present. A
  // component rendered in a commit when React set PerformedWork on its fiber;
  // a subtree whose child list React did not clone was skipped.
  const COMPOSITE = new Set([0, 1, 11, 14, 15]);
  const nameOf = (fiber) => {
    const type = fiber.type?.type ?? fiber.type?.render ?? fiber.type;
    return type?.displayName ?? type?.name ?? "Anonymous";
  };
  const walk = (fiber) => {
    const stack = [fiber];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || node === undefined) continue;
      if (COMPOSITE.has(node.tag) && (node.flags & 1) === 1) {
        state.renders += 1;
        const name = nameOf(node);
        state.rendersByComponent[name] =
          (state.rendersByComponent[name] ?? 0) + 1;
      }
      if (node.sibling !== null) stack.push(node.sibling);
      const skipped =
        node.alternate !== null && node.child === node.alternate.child;
      if (!skipped && node.child !== null) stack.push(node.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      state.commits += 1;
      window.__bootFlickerRoot = root;
      try {
        walk(root.current.child);
      } catch {
        // A React internals change must not break the page.
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
  };
};

const median = (values) => {
  const defined = values.filter((value) => typeof value === "number");
  if (defined.length === 0) return undefined;
  const sorted = [...defined].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// In a dx Orb, the Desktop's Chromium; it needs the Desktop's fonts, or it
// crashes on the first page that asks for one.
const orbChromium = "/opt/dx/desktop/env/bin/chromium";
const useOrbChromium =
  process.env.DX_PERF_CHROMIUM === undefined && existsSync(orbChromium);
const browser = await chromium.launch({
  executablePath: useOrbChromium ? orbChromium : process.env.DX_PERF_CHROMIUM,
  ...(useOrbChromium
    ? { env: { ...process.env, FONTCONFIG_FILE: "/opt/dx/desktop/fonts.conf" } }
    : {}),
});

// Signs in once per device and keeps the cookies for every signed-in run.
// One sign-in per device, shared by runs that start at the same time.
const signedInState = {};
const signIn = (device) => {
  signedInState[device] ??= signInOnce(device);
  return signedInState[device];
};
const signInOnce = async (device) => {
  if (email === undefined || password === undefined)
    throw new Error(
      "Set DX_PERF_EMAIL and DX_PERF_PASSWORD to measure signed-in routes.",
    );
  const context = await browser.newContext(devices[device].context);
  const response = await context.request.post(
    `${base}/api/auth/sign-in/email`,
    {
      headers: { origin: base },
      data: { email, password },
    },
  );
  if (!response.ok()) throw new Error(`Sign-in failed: ${response.status()}`);
  const state = await context.storageState();
  await context.close();
  return state;
};

// A real Thread of the signed-in account for the thread route: DX_PERF_THREAD,
// else its newest active Thread, else its newest archived one.
const findThread = async () => {
  if (process.env.DX_PERF_THREAD !== undefined)
    return `/threads/${process.env.DX_PERF_THREAD}`;
  const context = await browser.newContext({
    storageState: await signIn("desktop"),
  });
  for (const state of ["active", "archived"]) {
    const response = await context.request.get(
      `${base}/v1/threads?limit=1&lifecycleState=${state}`,
    );
    const body = response.ok() ? await response.json() : undefined;
    const thread = body?.data?.items?.[0];
    if (thread?.id !== undefined) {
      await context.close();
      return `/threads/${thread.id}`;
    }
  }
  await context.close();
  console.warn(
    "The signed-in account has no Thread; skipping Thread routes. Set DX_PERF_THREAD to measure them.",
  );
  return undefined;
};

const settle = async (page) => {
  const deadline = Date.now() + 25_000;
  let lastChange = Date.now();
  let lastLength = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const length = await page.evaluate(
      () => window.__bootFlicker.screens.length,
    );
    if (length !== lastLength) {
      lastLength = length;
      lastChange = Date.now();
    }
    const current = await page.evaluate(
      () => window.__bootFlicker.screens.at(-1)?.screen,
    );
    const quiet = Date.now() - lastChange;
    if (quiet > 2_500 && current !== "blank" && current !== "splash")
      return true;
  }
  return false;
};

const run = async (scenario, index, filmstrip) => {
  const device = devices[scenario.device];
  const context = await browser.newContext({
    ...device.context,
    ...(scenario.signedIn
      ? { storageState: await signIn(scenario.device) }
      : {}),
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const consoleLines = [];
  page.on("console", (message) =>
    consoleLines.push(`${message.type()}: ${message.text()}`),
  );
  const pending = new Map();
  page.on("request", (request) => pending.set(request, request.url()));
  page.on("requestfinished", (request) => pending.delete(request));
  page.on("requestfailed", (request) => {
    pending.delete(request);
    consoleLines.push(
      `failed: ${request.url()} ${request.failure()?.errorText}`,
    );
  });
  const cdp = await context.newCDPSession(page);
  if (device.cpu !== undefined)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: device.cpu });
  if (device.network !== undefined) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", device.network);
  }
  // A warm run loads the page once so the HTTP cache holds the app's code, as
  // it does for a returning visitor.
  if (scenario.cache === "warm") {
    await page.goto(`${base}${scenario.path}`, { waitUntil: "load" });
    await settle(page);
    await page.goto("about:blank");
  }
  const frames = [];
  if (filmstrip) {
    cdp.on("Page.screencastFrame", (frame) => {
      frames.push({ epoch: frame.metadata.timestamp * 1000, data: frame.data });
      void cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: device.context.viewport.width,
      maxHeight: device.context.viewport.height,
    });
  }
  await page.goto(`${base}${scenario.path}`, { waitUntil: "commit" });
  const settled = await settle(page);
  const state = await page.evaluate(() => window.__bootFlicker);
  // What a run that never settled was left showing.
  if (!settled) {
    mkdirSync(join(out, "unsettled"), { recursive: true });
    await page.screenshot({
      path: join(out, "unsettled", `${scenario.id}-${index}.png`),
    });
    writeFileSync(
      join(out, "unsettled", `${scenario.id}-${index}.json`),
      `${JSON.stringify(
        {
          screens: state.screens,
          pending: [...pending.values()],
          marks: await page.evaluate(() =>
            performance
              .getEntriesByType("mark")
              .filter((mark) => mark.name.startsWith("dx-boot:"))
              .map((mark) => `${Math.round(mark.startTime)} ${mark.name}`),
          ),
          resources: await page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .map(
                (entry) =>
                  `${Math.round(entry.startTime)}+${Math.round(entry.duration)} ${entry.name.replace(location.origin, "")}`,
              ),
          ),
          root: await page.evaluate(() =>
            document.getElementById("root")?.innerHTML.slice(0, 300),
          ),
          lanes: await page.evaluate(() => {
            const root = window.__bootFlickerRoot;
            return root === undefined
              ? undefined
              : {
                  pending: root.pendingLanes,
                  suspended: root.suspendedLanes,
                  pinged: root.pingedLanes,
                  expired: root.expiredLanes,
                  warm: root.warmLanes,
                  callback: root.callbackNode !== null,
                  visibility: document.visibilityState,
                };
          }),
          console: consoleLines,
          errors,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (filmstrip) await cdp.send("Page.stopScreencast").catch(() => undefined);
  await context.close();

  const screens = state.screens.map((entry) => entry.screen);
  // The final screen and the first time it painted in its last stretch.
  const final = state.screens.at(-1);
  const meaningful = screens.filter(
    (screen) => screen !== "blank" && screen !== "splash",
  );
  const wrong = [
    ...new Set(
      meaningful.slice(0, -1).filter((screen) => screen !== final?.screen),
    ),
  ];
  const result = {
    run: index,
    settled,
    screens,
    final: final?.screen,
    finalPath: final?.path,
    settledMs: final?.at,
    flashes: screens.length - 1,
    wrongScreens: wrong,
    backgrounds: state.backgrounds,
    // A flip is the painted colour crossing between dark and light; a
    // change of tint within one appearance is not counted.
    themeFlips: state.backgrounds
      .map(
        ([red, green, blue]) =>
          0.2126 * red + 0.7152 * green + 0.0722 * blue > 128,
      )
      .filter((light, index, all) => index > 0 && light !== all[index - 1])
      .length,
    // A splash on screen for less than 300 ms reads as a flash of the logo.
    shortSplash: state.screens.some(
      (entry, position) =>
        entry.screen === "splash" &&
        state.screens[position + 1] !== undefined &&
        state.screens[position + 1].at - entry.at < 300,
    ),
    blankAfterContent: screens
      .slice(screens.findIndex((screen) => screen !== "blank"))
      .includes("blank"),
    splashMounts: state.splashMounts,
    loaderMounts: state.loaderMounts,
    fcp: state.fcp,
    lcp: state.lcp,
    cls: Number(
      state.shifts.reduce((sum, shift) => sum + shift.value, 0).toFixed(4),
    ),
    longTasks: state.longTasks.length,
    longTaskMs: state.longTasks.reduce((sum, task) => sum + task.ms, 0),
    commits: state.commits,
    renders: state.renders,
    topRenders: Object.entries(state.rendersByComponent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    errors,
  };
  if (filmstrip && frames.length > 0) {
    const directory = join(out, "filmstrips", scenario.id);
    mkdirSync(directory, { recursive: true });
    state.screens.forEach((entry, position) => {
      // The first frame painted at least one frame after the change.
      const frame =
        frames.find((candidate) => candidate.epoch >= entry.epoch + 16) ??
        frames.at(-1);
      writeFileSync(
        join(
          directory,
          `${String(position).padStart(2, "0")}-${entry.at}ms-${entry.screen}.jpg`,
        ),
        Buffer.from(frame.data, "base64"),
      );
    });
  }
  return result;
};

const hot = [
  { name: "landing", path: "/", signedIn: false },
  { name: "signin", path: "/signin", signedIn: false },
  { name: "signup", path: "/signup", signedIn: false },
  { name: "home", path: "/", signedIn: true },
  { name: "thread", path: "THREAD", signedIn: true },
  { name: "signin-while-signed-in", path: "/signin", signedIn: true },
];
const rest = [
  { name: "deep-link-signed-out", path: "THREAD", signedIn: false },
  { name: "new", path: "/new", signedIn: true },
  { name: "settings", path: "/settings", signedIn: true },
  { name: "projects", path: "/projects", signedIn: true },
  { name: "artifacts", path: "/artifacts", signedIn: true },
  { name: "mailbox", path: "/mailbox", signedIn: true },
  { name: "workspaces", path: "/workspaces", signedIn: true },
  { name: "not-found", path: "/no-such-page", signedIn: true },
];
const routes = routeSet === "hot" ? hot : [...hot, ...rest];
const needsThread = routes.some((route) => route.path === "THREAD");
const placeholderThread = "/threads/thr_00000000-0000-4000-8000-000000000000";
const threadPath =
  needsThread && email !== undefined ? await findThread() : placeholderThread;

const scenarios = routes
  .flatMap((route) =>
    ["desktop", "phone"].flatMap((device) =>
      ["cold", "warm"].map((cache) => ({
        ...route,
        path:
          route.path !== "THREAD"
            ? route.path
            : route.signedIn
              ? threadPath
              : (threadPath ?? placeholderThread),
        device,
        cache,
        id: `${route.signedIn ? "in" : "out"}-${route.name}-${device}-${cache}`,
      })),
    ),
  )
  .filter((scenario) => scenario.path !== undefined)
  .filter((scenario) => !scenario.signedIn || email !== undefined)
  .filter((scenario) => only === undefined || scenario.id.includes(only));

// Budgets a polished boot meets.
const budgets = {
  wrongScreens: 0,
  splashMounts: 1,
  cls: 0.01,
};

// Every run of every scenario, `parallel` at a time. Runs side by side share
// the machine's CPU, so their times are only comparable to runs made with the
// same --parallel; screen sequences, flips, and splash counts are not.
const jobs = scenarios.flatMap((scenario) =>
  Array.from({ length: repeat }, (_, index) => ({ scenario, index })),
);
const results = new Map(scenarios.map((scenario) => [scenario.id, []]));
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { scenario, index } = jobs[next++];
      results.get(scenario.id)[index] = await run(scenario, index, index === 0);
    }
  }),
);

const report = [];
for (const scenario of scenarios) {
  const runs = results.get(scenario.id);
  const sequences = [
    ...new Set(runs.map((entry) => entry.screens.join(" → "))),
  ];
  const summary = {
    id: scenario.id,
    path: scenario.path.startsWith("/threads/")
      ? "/threads/<id>"
      : scenario.path,
    signedIn: scenario.signedIn,
    device: scenario.device,
    cache: scenario.cache,
    sequences,
    final: runs[0].final,
    settledMs: median(runs.map((entry) => entry.settledMs)),
    flashes: Math.max(...runs.map((entry) => entry.flashes)),
    wrongScreens: [...new Set(runs.flatMap((entry) => entry.wrongScreens))],
    blankAfterContent: runs.some((entry) => entry.blankAfterContent),
    themeFlips: Math.max(...runs.map((entry) => entry.themeFlips)),
    shortSplash: runs.some((entry) => entry.shortSplash),
    splashMounts: Math.max(...runs.map((entry) => entry.splashMounts)),
    loaderMounts: median(runs.map((entry) => entry.loaderMounts)),
    fcp: median(runs.map((entry) => entry.fcp)),
    lcp: median(runs.map((entry) => entry.lcp)),
    cls: median(runs.map((entry) => entry.cls)),
    longTasks: median(runs.map((entry) => entry.longTasks)),
    longTaskMs: median(runs.map((entry) => entry.longTaskMs)),
    commits: median(runs.map((entry) => entry.commits)),
    renders: median(runs.map((entry) => entry.renders)),
    topRenders: runs[0].topRenders,
    unsettledRuns: runs.filter((entry) => !entry.settled).length,
    errors: [...new Set(runs.flatMap((entry) => entry.errors))],
    runs: runs.map(({ screens, backgrounds, settledMs }) => ({
      screens,
      backgrounds,
      settledMs,
    })),
  };
  summary.failures = [
    summary.wrongScreens.length > budgets.wrongScreens
      ? `wrong screens: ${summary.wrongScreens.join(", ")}`
      : undefined,
    summary.blankAfterContent ? "blank after content" : undefined,
    summary.themeFlips > 0
      ? `dark/light flipped ${summary.themeFlips}×`
      : undefined,
    summary.shortSplash ? "splash flashed (<300 ms)" : undefined,
    summary.splashMounts > budgets.splashMounts
      ? `splash mounted ${summary.splashMounts}×`
      : undefined,
    summary.cls > budgets.cls ? `CLS ${summary.cls}` : undefined,
    summary.unsettledRuns > 0
      ? `${summary.unsettledRuns} run(s) never settled`
      : undefined,
  ].filter(Boolean);
  report.push(summary);
  console.log(
    `${summary.id.padEnd(44)} ${String(summary.settledMs).padStart(6)}ms  ${summary.sequences.join(" | ")}${summary.failures.length > 0 ? `  ✗ ${summary.failures.join("; ")}` : ""}`,
  );
}
await browser.close();

const table = [
  "| Scenario | Screens seen | Settled (ms) | FCP | LCP | CLS | Splash mounts | Loaders | Long tasks (ms) | Commits | Renders | Budget |",
  "| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- |",
  ...report.map(
    (row) =>
      `| ${row.id} | ${row.sequences.join("<br>")} | ${row.settledMs ?? "–"} | ${row.fcp ?? "–"} | ${row.lcp ?? "–"} | ${row.cls} | ${row.splashMounts} | ${row.loaderMounts} | ${row.longTasks} (${row.longTaskMs}) | ${row.commits} | ${row.renders} | ${row.failures.length === 0 ? "pass" : row.failures.join("; ")} |`,
  ),
];
writeFileSync(
  join(out, "report.json"),
  `${JSON.stringify({ base, repeat, at: new Date().toISOString(), budgets, report }, null, 2)}\n`,
);
writeFileSync(
  join(out, "report.md"),
  `# Boot flicker: ${base}\n\n${repeat} run(s) per scenario, medians.\n\n${table.join("\n")}\n`,
);
const failing = report.filter((row) => row.failures.length > 0);
console.log(
  `\n${report.length - failing.length}/${report.length} scenarios within budget. Report: ${join(out, "report.md")}`,
);
if (assertBudgets && failing.length > 0) process.exit(1);
