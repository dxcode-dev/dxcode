// Main-thread budget check for the real thread page (local only; never
// contacts providers). Builds the harness in production mode, serves it, and
// drives named scenarios in Chromium: typing, resizing, scrolling, Flue
// streaming, realtime hints, sends, focus, thread switches, long threads,
// long code fences, and a large Changes pane.
//
//   pnpm --filter @dx/web test:thread-perf            # build, serve, measure
//   node test/thread-page-stress.mjs <url> [--out f]  # measure a running preview
//   DX_PERF_SCENARIOS=realtime-burst,send pnpm --filter @dx/web test:thread-perf
//
// Every scenario loads a fresh page, so a subset measures the same as a full
// run. Reports React commits, per-component render counts with their causes,
// long tasks, script time, and worst input latency per scenario. Exits 1 when
// any long task exceeds DX_PERF_BUDGET_MS (default 200), streamed text fails
// to reach the DOM, or the page logs an error.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const urlArgument = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : undefined;
const budgetMs = Number(process.env.DX_PERF_BUDGET_MS ?? 200);
// Showing the hidden phone transcript again, measured on its own.
const revealBudgetMs = Number(process.env.DX_PERF_REVEAL_BUDGET_MS ?? 200);
// Frames a Terminal may draw with nothing to show: idle with its cursor not
// blinking, or hidden.
const terminalFrameBudget = Number(
  process.env.DX_PERF_TERMINAL_FRAME_BUDGET ?? 2,
);
const turns = Number(process.env.DX_STRESS_TURNS ?? 40);
const tool = Number(process.env.DX_STRESS_TOOL_CHARS ?? 2000);
const LONG_THREAD_TURNS = 320;
const CHANGED_FILES = 50;
// Memoized components render under their inner function names.
const WATCH = [
  "AgentPanel",
  "TranscriptViewport",
  "TranscriptTurn",
  "TranscriptTurnContent",
  "TranscriptRowShell",
  "TranscriptRowShellContent",
  "RichMarkdown",
  "CodeBlock",
  "ToolEvent",
  "TranscriptActivityList",
  "AgentComposer",
  "ThreadHeader",
  "AppSidebar",
  "SidebarThreadRows",
  "SidebarThreadRow",
  "ThreadContextMenu",
  "ChangesPane",
  "OrbIcon",
  "SettingsPage",
  "ProjectPage",
  "ProductShell",
  "MobileThreadTabs",
  "MobileToolPanels",
  "ThreadTerminalSession",
  "TerminalKeys",
  "ThreadFilesPanel",
  "MobilePullActions",
];
/** Phone runs: an iPhone-sized touch screen on a CPU four times slower. */
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const PHONE_CPU_THROTTLING = 4;
/**
 * The phone at device scale 1, for Terminal resizes and reveals. Under CPU
 * throttling, headless Chromium's software canvas takes 0.3 to 8 s, not 7 ms,
 * to commit a newly sized 1032x2100 canvas; real browsers draw it on a GPU.
 * The emulator's per-cell work does not depend on the scale.
 */
const PHONE_1X = { ...PHONE, deviceScaleFactor: 1 };
/** DevTools' Fast 4G: 60 ms round trips, 9 Mbps down, 1.5 Mbps up. */
const FAST_4G = {
  latency: 60,
  downloadThroughput: 9_000_000 / 8,
  uploadThroughput: 1_500_000 / 8,
};
const isPhone = (device) => device === "phone" || device === "phone-1x";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const composer = 'textarea[aria-label="Message"]';
const threadReady = () =>
  document.querySelector('textarea[aria-label="Message"]:not([disabled])') &&
  document.querySelectorAll(".transcript-turn").length > 0 &&
  document.querySelectorAll(".product-sidebar .thread-row").length > 20;

/** One fenced block of `lines` TypeScript lines, as an agent writes a file. */
const codeFence = (lines) =>
  "Here is the new checkout module:\n\n```ts\n" +
  Array.from(
    { length: lines },
    (_, i) =>
      `export const step${i} = (cart: Cart) => applyDiscount(cart, ${i}) ?? cart;`,
  ).join("\n") +
  "\n```\n\nRun `pnpm test` to check it.\n";

// --- Interactions shared by scenarios.
const drag = async (page, selector, dx) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`No element for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // One pointer move per frame; the user releases at the new width.
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(x + (dx * i) / 30, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};
// Open the right pane so drags narrow the transcript enough to rewrap.
const openRightPane = async (page) => {
  await page.click('button[aria-label="Show Right Pane"]');
  await page.waitForTimeout(500);
};
// Watch the stream from the live edge, like a user following the answer.
const toLiveEdge = (page) =>
  page.evaluate(async () => {
    const viewport = document.querySelector(".transcript-viewport");
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
  });
const scrollTranscript = async (page, steps = 20) => {
  const box = await page.locator(".transcript-viewport").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(16);
  }
};
const phoneThreadReady = () =>
  document.querySelector('textarea[aria-label="Message"]:not([disabled])') &&
  document.querySelectorAll(".transcript-turn").length > 0 &&
  document.querySelector(".thread-mobile-tabs") !== null;
const phoneTab = (page, name) =>
  page.click(`.thread-mobile-tabs [role="tab"]#thread-mobile-tab-${name}`);
const terminalReady = async (page) => {
  await page.waitForFunction(
    () =>
      document.querySelector(".thread-terminal canvas, .thread-terminal *") !==
        null &&
      [
        ...document.querySelectorAll(".thread-terminal-shell [role=status]"),
      ].some((node) => node.textContent === "Terminal ready"),
    undefined,
    { timeout: 30_000 },
  );
  // The emulator's first frames and WebAssembly warm-up stay out of the
  // measured window.
  await page.waitForTimeout(2_000);
};
/** Opens the phone Terminal and waits for Core's ready. */
const openPhoneTerminal = async (page) => {
  await phoneTab(page, "terminal");
  await terminalReady(page);
};
/** Opens the Terminal in the desktop right pane and waits for Core's ready. */
const openDesktopTerminal = async (page) => {
  await openRightPane(page);
  await page.click("#thread-workspace-tab-terminal");
  await terminalReady(page);
};
/**
 * Counts what the Terminal draws: calls on its canvas, and the frames with
 * any. Calls in one frame share `document.timeline.currentTime`.
 */
const countTerminalDraws = (page) =>
  page.evaluate(() => {
    const counter = { calls: 0, frames: new Set(), first: undefined };
    const prototype = CanvasRenderingContext2D.prototype;
    for (const name of ["fillRect", "fillText", "clearRect", "drawImage"]) {
      const draw = prototype[name];
      prototype[name] = function (...args) {
        if (this.canvas.closest?.(".thread-terminal")) {
          counter.calls++;
          counter.frames.add(document.timeline.currentTime);
          counter.first ??= performance.now();
        }
        return draw.apply(this, args);
      };
    }
    window.__terminalDraws = counter;
  });
/** Starts a count; the returned function ends it. */
const terminalDraws = async (page) => {
  await page.evaluate(() => {
    window.__terminalDraws.calls = 0;
    window.__terminalDraws.frames.clear();
  });
  return () =>
    page.evaluate(() => ({
      frames: window.__terminalDraws.frames.size,
      calls: window.__terminalDraws.calls,
    }));
};
/** SHA-256 of the Terminal canvas pixels, to compare builds. */
const terminalPixels = (page) =>
  page.evaluate(async () => {
    const canvas = document.querySelector(".thread-terminal canvas");
    const { data } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  });
/**
 * Ten seconds of a shown, idle Terminal, then output, which it must draw.
 * The pixels are taken after the output.
 */
const idleTerminal = async (page) => {
  const idle = await terminalDraws(page);
  await page.waitForTimeout(10_000);
  const { frames, calls } = await idle();
  const output = await terminalDraws(page);
  await page.evaluate(() =>
    window.dxPerf.terminalOutput({ lines: 3, intervalMs: 16 }),
  );
  await page.waitForTimeout(100);
  return {
    terminalFrames: frames,
    terminalDrawCalls: calls,
    outputFrames: (await output()).frames,
    terminalPixels: await terminalPixels(page),
  };
};
const PHONE_TOOLS = ["changes", "files", "terminal", "preview", "desktop"];
/**
 * Back to the agent tab: the longest task while the hidden transcript is
 * shown again, and its scroll offset afterwards.
 */
const revealAgent = async (page) => {
  const from = await page.evaluate(() => performance.now());
  await phoneTab(page, "agent");
  await page.waitForTimeout(600);
  return page.evaluate(
    (start) => ({
      revealMs: Math.round(
        Math.max(
          0,
          ...window.__long
            .filter(({ startTime }) => startTime >= start)
            .map(({ duration }) => duration),
        ),
      ),
      scrollTop: Math.round(
        document.querySelector(".transcript-viewport").scrollTop,
      ),
    }),
    from,
  );
};
const liveTurnChars = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-turn-id^="turn:t-live-"]')].at(-1)
        ?.textContent?.length ?? 0,
  );
/** A one-finger drag down from `y`, one touchmove per frame. */
const pullDown = async (cdp, page, { x, y, distance, steps }) => {
  const point = (dy) => [{ x, y: y + dy, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(0),
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point((distance * i) / steps),
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};
const typeInComposer = async (page, text) => {
  await page.click(composer);
  await page.keyboard.type(text, { delay: 30 });
};
const waitForDiffs = (page, count, timeout = 30_000) =>
  page.waitForFunction(
    (n) => document.querySelectorAll(".changes-diff-view").length >= n,
    count,
    { timeout },
  );
const expandAllChangedFiles = async (page) => {
  const triggers = page.locator(".changes-file-trigger");
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    await triggers.nth(i).click();
    await page.waitForTimeout(16);
  }
  await waitForDiffs(page, count);
  return count;
};
const clickSidebarThread = async (page, title) => {
  await page
    .locator(".product-sidebar .thread-row", { hasText: title })
    .first()
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".thread-title-bar .thread-title")?.textContent ===
        expected && document.querySelectorAll(".transcript-turn").length > 0,
    title,
  );
};

// --- Scenarios. `query` adds harness URL parameters, `ready` waits for the
// page, `setup` reaches the starting state unmeasured, `run` is measured.
const SCENARIOS = [
  {
    name: "type",
    label: "type 40 chars",
    run: (page) =>
      typeInComposer(page, "Please refactor the checkout flow quickly"),
  },
  {
    name: "drag-left-sidebar",
    setup: openRightPane,
    run: (page) => drag(page, '[aria-label="Resize navigation"]', 180),
  },
  {
    name: "drag-right-pane",
    setup: openRightPane,
    run: (page) => drag(page, ".right-pane-resize-handle", -300),
  },
  {
    name: "drag-right-pane-back",
    setup: async (page) => {
      await openRightPane(page);
      await drag(page, ".right-pane-resize-handle", -300);
    },
    run: (page) => drag(page, ".right-pane-resize-handle", 300),
  },
  {
    name: "toggle-right-pane",
    setup: openRightPane,
    run: async (page) => {
      await page.click('button[aria-label="Hide Right Pane"]');
      await page.waitForTimeout(200);
      await page.click('button[aria-label="Show Right Pane"]');
    },
  },
  {
    name: "scroll",
    label: "scroll transcript",
    setup: openRightPane,
    run: scrollTranscript,
  },
  {
    name: "sidebar-refetch",
    label: "sidebar refetch x5 (no change)",
    run: (page) => page.evaluate(() => window.dxPerf.refetchSidebar(5)),
  },
  {
    name: "sidebar-status",
    label: "sidebar one thread -> working -> idle",
    run: async (page) => {
      await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "working"));
      await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "idle"));
    },
  },
  {
    name: "sidebar-hover",
    label: "hover 15 sidebar rows (preview open)",
    run: async (page) => {
      const rows = page.locator(".product-sidebar .thread-row");
      // Pausing past the intent delay opens the preview; later rows update it.
      await rows.nth(1).hover();
      await page.waitForTimeout(700);
      for (let i = 2; i <= 15; i++) {
        await rows.nth(i).hover();
        await page.waitForTimeout(120);
      }
      await page.mouse.move(700, 450);
      await page.waitForTimeout(300);
    },
  },
  {
    name: "idle",
    label: "idle 2s (no working orbs)",
    run: (page) => page.waitForTimeout(2000),
  },
  {
    name: "working-orbs",
    label: "10 working orbs, idle 2s",
    setup: async (page) => {
      await page.evaluate(async () => {
        for (let i = 1; i <= 10; i++)
          await window.dxPerf.setSidebarStatus(i, "working");
      });
      await page.waitForTimeout(500);
    },
    run: (page) => page.waitForTimeout(2000),
  },
  {
    name: "stream-steady",
    label: "stream steady (1/16ms)",
    stream: true,
    setup: async (page) => {
      await openRightPane(page);
      await toLiveEdge(page);
    },
    run: (page) =>
      page.evaluate(() =>
        window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
      ),
  },
  {
    name: "stream-bursts",
    label: "stream bursts (50/batch)",
    stream: true,
    setup: async (page) => {
      await openRightPane(page);
      await toLiveEdge(page);
    },
    run: (page) =>
      page.evaluate(() =>
        window.dxPerf.stream({ chars: 6_000, batchSize: 50 }),
      ),
  },
  {
    name: "type-while-streaming",
    stream: true,
    setup: async (page) => {
      await openRightPane(page);
      await toLiveEdge(page);
    },
    run: async (page) => {
      const streaming = page.evaluate(() =>
        window.dxPerf.stream({ chars: 3_000, batchSize: 1, intervalMs: 16 }),
      );
      await typeInComposer(page, "steer: also add tests");
      return streaming;
    },
  },
  {
    name: "realtime-burst",
    label: "another thread works: 32 realtime hints",
    run: (page) => page.evaluate(() => window.dxPerf.realtimeBurst({})),
  },
  {
    name: "realtime-reconnect",
    label: "realtime reconnect with revision gap",
    run: (page) => page.evaluate(() => window.dxPerf.realtimeReconnect()),
  },
  {
    name: "open-thread-lifecycle",
    label: "open thread idle -> working -> idle, title settles",
    query: "titlePending=1&title=New%20thread",
    run: (page) => page.evaluate(() => window.dxPerf.openThreadLifecycle()),
  },
  {
    name: "send",
    label: "send a message, 800-char reply",
    stream: true,
    setup: async (page) => {
      await toLiveEdge(page);
      await page.fill(composer, "Run the checkout tests");
    },
    run: async (page) => {
      await page.press(composer, "Enter");
      return page.evaluate(() =>
        window.dxPerf.reply({ chars: 800, intervalMs: 16, settle: true }),
      );
    },
  },
  {
    name: "send-image",
    label: "attach an image, send, 800-char reply",
    stream: true,
    setup: toLiveEdge,
    run: async (page) => {
      await page
        .locator('.thread-main-panel input[aria-label="Choose files"]')
        .setInputFiles({
          name: "proof.png",
          mimeType: "image/png",
          buffer: png,
        });
      await page.waitForSelector(".thread-main-panel .composer-attachment");
      await page.waitForFunction(
        () =>
          document.querySelector(
            '.thread-main-panel [aria-label="Uploading"]',
          ) === null,
      );
      await typeInComposer(page, "Why is this red?");
      await page.press(composer, "Enter");
      return page.evaluate(() =>
        window.dxPerf.reply({ chars: 800, intervalMs: 16, settle: true }),
      );
    },
  },
  {
    name: "auth-focus",
    label: "window focus x5, session refetched (equal, new objects)",
    run: (page) => page.evaluate(() => window.dxPerf.focusWindow(5)),
  },
  {
    name: "thread-switch",
    label: "switch thread A -> B -> A",
    run: async (page) => {
      const started = Date.now();
      await clickSidebarThread(page, "Sidebar thread 1");
      const toB = Date.now() - started;
      await clickSidebarThread(page, "Perf: long thread");
      return { toBMs: toB, roundTripMs: Date.now() - started };
    },
  },
  {
    name: "long-thread-stream",
    label: `${LONG_THREAD_TURNS} turns: stream steady (1/16ms)`,
    query: `turns=${LONG_THREAD_TURNS}`,
    stream: true,
    setup: toLiveEdge,
    run: (page) =>
      page.evaluate(() =>
        window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
      ),
  },
  {
    name: "long-thread-scroll",
    label: `${LONG_THREAD_TURNS} turns: scroll transcript`,
    query: `turns=${LONG_THREAD_TURNS}`,
    run: scrollTranscript,
  },
  {
    name: "code-fence-stream",
    label: "stream a 1,000-line code fence",
    stream: true,
    setup: toLiveEdge,
    run: (page) =>
      page.evaluate(
        (text) =>
          window.dxPerf.stream({
            text,
            deltaChars: 40,
            batchSize: 5,
            intervalMs: 16,
            settle: true,
          }),
        codeFence(1_000),
      ),
  },
  {
    name: "changes-expand",
    label: `Changes: expand ${CHANGED_FILES} files`,
    query: `changes=${CHANGED_FILES}`,
    setup: async (page) => {
      await openRightPane(page);
      await page.waitForFunction(
        (n) => document.querySelectorAll(".changes-file").length >= n,
        CHANGED_FILES,
      );
    },
    run: async (page) => ({ diffs: await expandAllChangedFiles(page) }),
  },
  {
    name: "changes-captures",
    label: `Changes: ${CHANGED_FILES} expanded, 3 same + 1 new capture`,
    query: `changes=${CHANGED_FILES}`,
    setup: async (page) => {
      await openRightPane(page);
      await page.waitForFunction(
        (n) => document.querySelectorAll(".changes-file").length >= n,
        CHANGED_FILES,
      );
      await expandAllChangedFiles(page);
      await page.waitForTimeout(500);
    },
    run: async (page) => {
      const detail = await page.evaluate(() =>
        window.dxPerf.changesCaptures({ unchanged: 3 }),
      );
      await waitForDiffs(page, CHANGED_FILES);
      return detail;
    },
  },
  {
    name: "project-page",
    label: "project page: refetch x5 + status",
    query: `route=${encodeURIComponent("/projects/prj_00000000-0000-4000-8000-000000000147")}`,
    ready: () => document.body.innerText.includes("Recent Threads"),
    run: async (page) => {
      await page.evaluate(() => window.dxPerf.refetchSidebar(5));
      await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "working"));
      await page.evaluate(() => window.dxPerf.setSidebarStatus(3, "idle"));
    },
  },
  {
    name: "account-settings",
    label: "account settings: type 40 chars",
    query: "route=%2Fsettings",
    ready: () => document.body.innerText.includes("Perf User"),
    setup: async (page) => {
      await page.getByRole("button", { name: "Edit" }).first().click();
      await page.waitForTimeout(200);
    },
    run: async (page) => {
      await page.locator("main input, [role=dialog] input").first().click();
      await page.keyboard.type("Please refactor the checkout flow quickly", {
        delay: 30,
      });
    },
  },
  {
    name: "phone-stream",
    label: "phone: stream with Terminal and Changes opened, hidden",
    device: "phone",
    query: `changes=${CHANGED_FILES}&portal=1`,
    stream: true,
    setup: async (page) => {
      await openPhoneTerminal(page);
      await phoneTab(page, "changes");
      await page.waitForFunction(
        (n) => document.querySelectorAll(".changes-file").length >= n,
        CHANGED_FILES,
      );
      await phoneTab(page, "agent");
      await toLiveEdge(page);
    },
    run: (page) =>
      page.evaluate(() =>
        window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
      ),
  },
  {
    name: "phone-stream-hidden",
    label: "phone: stream while the Terminal is shown",
    device: "phone",
    stream: true,
    query: `changes=${CHANGED_FILES}&portal=1`,
    setup: async (page) => {
      await toLiveEdge(page);
      await openPhoneTerminal(page);
    },
    run: async (page) => {
      const streamed = await page.evaluate(() =>
        window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
      );
      // Back to the conversation: the streamed answer is there.
      const { revealMs } = await revealAgent(page);
      return {
        ...streamed,
        revealMs,
        renderedChars: await liveTurnChars(page),
      };
    },
  },
  {
    name: "phone-reveal-scrolled",
    label: "phone: read older turns, stream behind the Terminal, come back",
    device: "phone",
    stream: true,
    query: `changes=${CHANGED_FILES}&portal=1`,
    setup: async (page) => {
      await toLiveEdge(page);
      await scrollTranscript(page, 8);
      await page.waitForTimeout(400);
      // Read while shown: a hidden scroller reports zero.
      await page.evaluate(() => {
        window.__readingTop = Math.round(
          document.querySelector(".transcript-viewport").scrollTop,
        );
      });
      await openPhoneTerminal(page);
    },
    run: async (page) => {
      const before = await page.evaluate(() => window.__readingTop);
      const streamed = await page.evaluate(() =>
        window.dxPerf.stream({ chars: 4_000, batchSize: 1, intervalMs: 16 }),
      );
      const { revealMs, scrollTop } = await revealAgent(page);
      // The reader stays where they were; the answer is below them.
      await toLiveEdge(page);
      return {
        ...streamed,
        revealMs,
        positionKept: scrollTop === before,
        renderedChars: await liveTurnChars(page),
      };
    },
  },
  {
    name: "phone-tab-switch",
    label: "phone: cycle every tool and back, twice",
    device: "phone",
    query: `changes=${CHANGED_FILES}&portal=1`,
    // Every tool has been opened once, so the run measures switching, not
    // first mounts.
    setup: async (page) => {
      for (const tool of PHONE_TOOLS) {
        if (tool === "terminal") await openPhoneTerminal(page);
        else await phoneTab(page, tool);
        await page.waitForTimeout(500);
      }
      await phoneTab(page, "agent");
      await page.waitForTimeout(1_000);
    },
    run: async (page) => {
      for (let round = 0; round < 2; round++)
        for (const tool of [...PHONE_TOOLS, "agent"]) {
          await phoneTab(page, tool);
          await page.waitForTimeout(250);
        }
      // Mounted once and kept: the Terminal is the one first opened, and
      // Changes fetched once.
      return page.evaluate(() => ({
        terminals: document.querySelectorAll(".thread-terminal").length,
        changesFetches: window.__requests.filter(({ url }) =>
          /\/changes(\?|$)/.test(url),
        ).length,
      }));
    },
  },
  {
    name: "phone-type",
    label: "phone: type 40 chars, the last 20 while streaming",
    device: "phone",
    query: `changes=${CHANGED_FILES}&portal=1`,
    stream: true,
    setup: toLiveEdge,
    run: async (page) => {
      await typeInComposer(page, "Please refactor the ");
      const streaming = page.evaluate(() =>
        window.dxPerf.stream({ chars: 2_000, batchSize: 1, intervalMs: 16 }),
      );
      await page.keyboard.type("checkout flow quickly", { delay: 30 });
      return streaming;
    },
  },
  {
    name: "phone-pull",
    label: "phone: pull home to the palette, then to New Thread",
    device: "phone",
    query: "route=%2F",
    ready: () => document.querySelector(".mobile-home") !== null,
    run: async (page, cdp) => {
      const box = await page.locator(".mobile-home").boundingBox();
      const start = { x: box.x + box.width / 2, y: box.y + 120 };
      // 130 px of travel arms the palette; 300 px arms New Thread.
      await pullDown(cdp, page, { ...start, distance: 130, steps: 20 });
      await page.waitForSelector("[role=dialog]");
      const palette = await page.evaluate(
        () =>
          document.querySelector("[role=dialog]")?.getAttribute("aria-label") ??
          document
            .querySelector("[role=dialog] input")
            ?.getAttribute("placeholder"),
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector("[role=dialog]"),
      );
      await pullDown(cdp, page, { ...start, distance: 300, steps: 40 });
      await page.waitForSelector("[role=dialog]");
      const newThread = await page.evaluate(
        () =>
          document.querySelector("[role=dialog]")?.getAttribute("aria-label") ??
          document.querySelector("[role=dialog] h2")?.textContent,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector("[role=dialog]"),
      );
      return {
        palette,
        newThread,
        vibrations: await page.evaluate(() => window.__vibrations.length),
      };
    },
  },
  {
    name: "phone-terminal-keys",
    label: "phone: latch Ctrl and press keys while output streams",
    device: "phone",
    query: "portal=1",
    setup: openPhoneTerminal,
    run: async (page) => {
      const output = page.evaluate(() =>
        window.dxPerf.terminalOutput({ lines: 150, intervalMs: 16 }),
      );
      const key = (name) =>
        page
          .locator(".terminal-keys")
          .getByRole("button", { name, exact: true })
          .click();
      // Ctrl then an on-screen key, Ctrl then a typed key, and plain keys.
      for (const name of ["Control", "Esc", "Tab", "Control", "Control C"])
        await key(name);
      await key("Control");
      await page.focus(".thread-terminal textarea");
      await page.keyboard.type("c");
      for (const name of ["Up", "Down", "Left", "Right", "Pipe", "Slash"])
        await key(name);
      await output;
      return {
        terminalInput: await page.evaluate(() =>
          JSON.stringify(window.__terminalInput.join("")),
        ),
        terminalPixels: await terminalPixels(page),
      };
    },
  },
  {
    name: "phone-terminal-session",
    label:
      "phone 1x: Terminal bulk and line output, keyboard resize, tabs, typing",
    device: "phone-1x",
    query: "portal=1",
    setup: openPhoneTerminal,
    run: async (page) => {
      // `cat` of a 1 MiB log, then a build printing a line per frame.
      const bulk = await page.evaluate(() =>
        window.dxPerf.terminalBulk({ bytes: 1_024 * 1_024, perTask: 4 }),
      );
      await page.evaluate(() =>
        window.dxPerf.terminalOutput({ lines: 120, intervalMs: 16 }),
      );
      // The soft keyboard opens and closes; the emulator refits each time.
      const size = () =>
        page.evaluate(
          () => document.querySelector(".thread-terminal canvas")?.style.height,
        );
      const before = await size();
      await page.setViewportSize({ width: 390, height: 520 });
      await page.waitForTimeout(400);
      const keyboard = await size();
      await page.setViewportSize(PHONE.viewport);
      await page.waitForTimeout(400);
      for (let round = 0; round < 2; round++) {
        await phoneTab(page, "agent");
        await page.waitForTimeout(250);
        await phoneTab(page, "terminal");
        await page.waitForTimeout(250);
      }
      await page.focus(".thread-terminal textarea");
      await page.keyboard.type("ls -la", { delay: 30 });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.__terminalInput.join("").endsWith("\r"),
      );
      return {
        ...(await page.evaluate(
          ({ bulk, before, keyboard }) => ({
            ...bulk,
            canvasHeights: [before, keyboard].join(" -> "),
            terminalInput: JSON.stringify(window.__terminalInput.join("")),
          }),
          { bulk, before, keyboard },
        )),
        terminalPixels: await terminalPixels(page),
      };
    },
  },
  {
    name: "terminal-idle",
    label: "Terminal shown and idle for 10 s",
    setup: async (page) => {
      await countTerminalDraws(page);
      await openDesktopTerminal(page);
    },
    run: idleTerminal,
  },
  {
    name: "phone-terminal-idle",
    label: "phone 1x: Terminal shown and idle for 10 s",
    device: "phone-1x",
    query: "portal=1",
    setup: async (page) => {
      await countTerminalDraws(page);
      await openPhoneTerminal(page);
    },
    run: idleTerminal,
  },
  {
    name: "phone-terminal-hidden",
    label: "phone 1x: 120 lines into the hidden Terminal, then show it",
    device: "phone-1x",
    query: "portal=1",
    setup: async (page) => {
      await countTerminalDraws(page);
      await openPhoneTerminal(page);
      await phoneTab(page, "agent");
      await page.waitForTimeout(500);
    },
    run: async (page) => {
      const hidden = await terminalDraws(page);
      await page.evaluate(() =>
        window.dxPerf.terminalOutput({ lines: 120, intervalMs: 16 }),
      );
      await page.waitForTimeout(500);
      const { frames } = await hidden();
      const shown = await terminalDraws(page);
      await phoneTab(page, "terminal");
      await page.waitForTimeout(500);
      return {
        terminalFrames: frames,
        outputFrames: (await shown()).frames,
        terminalPixels: await terminalPixels(page),
      };
    },
  },
  {
    name: "phone-terminal-open",
    label: "phone 1x: first Terminal open, cold cache, Fast 4G",
    device: "phone-1x",
    query: "portal=1",
    coldCache: true,
    network: FAST_4G,
    setup: (page) =>
      page.evaluate(() => {
        new MutationObserver((_, observer) => {
          const ready = [
            ...document.querySelectorAll(
              ".thread-terminal-shell [role=status]",
            ),
          ].some((node) => node.textContent === "Terminal ready");
          if (!ready) return;
          window.__terminalReadyAt = performance.now();
          observer.disconnect();
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      }),
    run: async (page) => {
      await countTerminalDraws(page);
      const start = await page.evaluate(() => performance.now());
      await openPhoneTerminal(page);
      return page.evaluate(
        (start) => ({
          // From the tap to the emulator's first canvas draw, and to Core's ready.
          terminalDrawnMs: Math.round(window.__terminalDraws.first - start),
          terminalReadyMs: Math.round(window.__terminalReadyAt - start),
          emulatorAssets: performance
            .getEntriesByType("resource")
            .filter(({ name }) =>
              /\/assets\/(ghostty|__vite-browser)/.test(name),
            )
            .map(({ name }) => name.split("/").at(-1)),
        }),
        start,
      );
    },
  },
  {
    name: "phone-drawer",
    label: "phone: open, scroll, close the drawer twice while a thread works",
    device: "phone",
    run: async (page) => {
      const status = page.evaluate(async () => {
        await window.dxPerf.publishStatus(3, "working");
        await new Promise((r) => setTimeout(r, 1_500));
        await window.dxPerf.publishStatus(3, "idle");
      });
      for (let round = 0; round < 2; round++) {
        await page.click('button[aria-label="Open sidebar"]');
        await page.waitForSelector(".mobile-sidebar-drawer .thread-row", {
          state: "visible",
        });
        await page.waitForTimeout(400);
        const box = await page.locator(".mobile-sidebar-drawer").boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 20; i++) {
          await page.mouse.wheel(0, i < 10 ? 300 : -300);
          await page.waitForTimeout(16);
        }
        await page.keyboard.press("Escape");
        await page.waitForSelector(".mobile-sidebar-drawer", {
          state: "hidden",
        });
      }
      await status;
    },
  },
];

const requested = (process.env.DX_PERF_SCENARIOS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const unknown = requested.filter(
  (name) => !SCENARIOS.some((scenario) => scenario.name === name),
);
if (unknown.length > 0) {
  console.error(
    `Unknown scenario ${unknown.join(", ")}. Scenarios: ${SCENARIOS.map(({ name }) => name).join(", ")}`,
  );
  process.exit(2);
}
const selected =
  requested.length === 0
    ? SCENARIOS
    : SCENARIOS.filter(({ name }) => requested.includes(name));

let server;
if (urlArgument === undefined) {
  const { build, preview } = await import("vite");
  const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
  await build({ configFile, logLevel: "warn" });
  server = await preview({ configFile, preview: { port: 0 } });
}
const base = urlArgument ?? server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch();
const errors = [];
/** One page per device, created on first use. */
const devices = new Map();
const deviceFor = async (device = "desktop") => {
  const existing = devices.get(device);
  if (existing !== undefined) return existing;
  const context = await browser.newContext(
    device === "phone"
      ? PHONE
      : device === "phone-1x"
        ? PHONE_1X
        : { viewport: { width: 1440, height: 900 } },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Attachment parts go to storage by XHR PUT; answer them like R2 does.
  await page.route("**/__upload/**", (route) =>
    route.fulfill({ status: 200, headers: { etag: '"perf-etag"' }, body: "" }),
  );
  // Uploaded attachments preview from their URL; answer with the same image.
  await page.route("**/v1/attachments/**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "image/png", body: png })
      : route.fallback(),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (isPhone(device))
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: PHONE_CPU_THROTTLING,
    });
  const created = { page, cdp };
  devices.set(device, created);
  return created;
};
const metric = async (cdp) => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { script: get("ScriptDuration"), task: get("TaskDuration") };
};

const open = async (page, scenario) => {
  const query = new URLSearchParams(`turns=${turns}&tool=${tool}`);
  for (const [key, value] of new URLSearchParams(scenario.query ?? ""))
    query.set(key, value);
  await page.goto(`${base}/thread-page-stress.html?${query}`);
  const ready =
    scenario.ready ??
    (isPhone(scenario.device) ? phoneThreadReady : threadReady);
  await page.waitForFunction(ready, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(scenario.ready ? 800 : 500);
  await page.evaluate(() => {
    window.__long = [];
    window.__events = [];
    // Entries arrive after their task, so a setup task can be reported once
    // the measured window has started; each keeps its start to be excluded.
    const keep = (target) => (list) =>
      target.push(
        ...list
          .getEntries()
          .map(({ startTime, duration }) => ({ startTime, duration })),
      );
    new PerformanceObserver(keep(window.__long)).observe({ type: "longtask" });
    new PerformanceObserver(keep(window.__events)).observe({
      type: "event",
      durationThreshold: 16,
    });
  });
};

/** `name:count` for the top components, each with its top three causes. */
const describeTop = (counts, causes, limit) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => {
      const why = Object.entries(causes[name] ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cause, n]) => `${cause} ${n}`)
        .join(", ");
      return { name, count, why };
    });

/**
 * Where re-renders start: renders caused by a component's own state, external
 * store, or context. Everything else in the scenario cascades from these.
 */
const describeOrigins = (causes, limit) =>
  Object.entries(causes)
    .flatMap(([name, byCause]) =>
      Object.entries(byCause)
        .filter(([cause]) => /^(state|store|context)/.test(cause))
        .map(([cause, count]) => ({ name, cause, count })),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

const measure = async (page, cdp, scenario) => {
  const startedAt = await page.evaluate(() => {
    window.__long.length = 0;
    window.__events.length = 0;
    window.dxRenders.start();
    return performance.now();
  });
  const before = await metric(cdp);
  const detail = await scenario.run(page, cdp);
  await page.waitForTimeout(300);
  const after = await metric(cdp);
  const result = await page.evaluate((from) => {
    const since = (entries) =>
      entries
        .filter(({ startTime }) => startTime >= from)
        .map(({ duration }) => duration);
    return {
      renders: window.dxRenders.stop(),
      long: since(window.__long),
      events: since(window.__events),
    };
  }, startedAt);
  const { counts, causes, commits } = result.renders;
  return {
    scenario: scenario.name,
    label: scenario.label ?? scenario.name,
    commits,
    ...Object.fromEntries(WATCH.map((k) => [k, counts[k] ?? 0])),
    totalRenders: Object.values(counts).reduce((a, b) => a + b, 0),
    top: describeTop(counts, causes, 8),
    origins: describeOrigins(causes, 5),
    longTasks: result.long.length,
    longestMs: Math.round(Math.max(0, ...result.long)),
    blockedMs: Math.round(result.long.reduce((a, b) => a + b, 0)),
    scriptMs: Math.round((after.script - before.script) * 1000),
    worstInputMs: Math.round(Math.max(0, ...result.events)),
    stream: scenario.stream === true,
    ...(detail ?? {}),
    counts,
    causes,
  };
};

const results = [];
for (const scenario of selected) {
  const errorsBefore = errors.length;
  try {
    const { page, cdp } = await deviceFor(scenario.device);
    // A cold cache covers the whole scenario; network conditions only its
    // measured window.
    const emulatesNetwork = scenario.coldCache || scenario.network;
    if (emulatesNetwork) await cdp.send("Network.enable");
    if (scenario.coldCache)
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await open(page, scenario);
    await scenario.setup?.(page);
    if (scenario.network)
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        ...scenario.network,
      });
    results.push(await measure(page, cdp, scenario));
    if (emulatesNetwork) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      await cdp.send("Network.disable");
    }
  } catch (error) {
    errors.push(`${scenario.name}: ${error.message.split("\n")[0]}`);
    results.push({ scenario: scenario.name, failed: true, top: [] });
  }
  if (errors.length > errorsBefore)
    results.at(-1).errors = errors.slice(errorsBefore);
  const row = results.at(-1);
  console.log(
    row.failed
      ? `${scenario.name}: failed`
      : `${scenario.name}: ${row.commits} commits, ${row.totalRenders} renders, longest ${row.longestMs}ms, script ${row.scriptMs}ms`,
  );
}
await browser.close();

const measured = results.filter((r) => !r.failed);
console.table(
  measured.map(
    ({
      scenario,
      commits,
      totalRenders,
      longTasks,
      longestMs,
      blockedMs,
      scriptMs,
      worstInputMs,
      worstBatchMs,
      renderedChars,
      revealMs,
      terminalFrames,
    }) => ({
      scenario,
      commits,
      renders: totalRenders,
      longTasks,
      longestMs,
      blockedMs,
      scriptMs,
      worstInputMs,
      worstBatchMs,
      renderedChars,
      revealMs,
      terminalFrames,
    }),
  ),
);
console.table(
  measured.map((r) => ({
    scenario: r.scenario,
    AgentPanel: r.AgentPanel,
    Viewport: r.TranscriptViewport,
    Turn: r.TranscriptTurn + r.TranscriptTurnContent,
    Markdown: r.RichMarkdown,
    Composer: r.AgentComposer,
    Header: r.ThreadHeader,
    SidebarRows: r.SidebarThreadRows,
    Row: r.SidebarThreadRow,
    Changes: r.ChangesPane,
    Orb: r.OrbIcon,
    SettingsPage: r.SettingsPage,
  })),
);
// Top components per scenario with why they rendered; see the cause notation
// in wiki/web-rendering-performance.md.
for (const r of measured) {
  console.log(`\n${r.scenario} (${r.label})`);
  for (const { name, count, why } of r.top)
    console.log(`  ${String(count).padStart(6)}  ${name}  [${why}]`);
  if (r.origins.length > 0)
    console.log(
      `  origins: ${r.origins.map(({ name, cause, count }) => `${name} ${cause} ${count}`).join(", ")}`,
    );
}
if (errors.length)
  console.error("page errors:", [...new Set(errors)].slice(0, 8));
if (out)
  writeFileSync(
    out,
    JSON.stringify({ turns, tool, budgetMs, results }, null, 2),
  );
await server?.close();
const overBudget = measured.filter((r) => r.longestMs > budgetMs);
const revealOverBudget = measured.filter((r) => r.revealMs > revealBudgetMs);
const positionLost = measured.filter((r) => r.positionKept === false);
for (const r of revealOverBudget)
  console.error(
    `reveal over budget: ${r.scenario} ${r.revealMs}ms > ${revealBudgetMs}ms`,
  );
for (const r of positionLost)
  console.error(`reading position lost on reveal: ${r.scenario}`);
const missingText = measured.filter((r) => r.stream && !r.renderedChars);
const terminalBusy = measured.filter(
  (r) => r.terminalFrames > terminalFrameBudget,
);
const terminalStuck = measured.filter((r) => r.outputFrames === 0);
for (const r of terminalBusy)
  console.error(
    `Terminal drew with nothing to show: ${r.scenario} ${r.terminalFrames} frames > ${terminalFrameBudget}`,
  );
for (const r of terminalStuck)
  console.error(`Terminal did not draw its output: ${r.scenario}`);
for (const r of overBudget)
  console.error(
    `over budget: ${r.scenario} longest task ${r.longestMs}ms > ${budgetMs}ms`,
  );
for (const r of missingText)
  console.error(`streamed text did not render: ${r.scenario}`);
process.exit(
  overBudget.length +
    revealOverBudget.length +
    positionLost.length +
    missingText.length +
    terminalBusy.length +
    terminalStuck.length +
    errors.length >
    0
    ? 1
    : 0,
);
