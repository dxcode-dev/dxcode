// The quick-reply row above the composer, through the real Thread page
// (`ThreadWorkspace`, its transcript and composer), with Flue a stand-in whose
// conversation ends on an unsettled agent reply and dx's server answering the
// quick-actions request at `fetch`.
//
// Ways it could go wrong (#1945): the transcript's outline and scroll-to-bottom
// controls stay at the composer's height while the chip row sits there too, so
// the last chip runs under them and can't be read or tapped; the controls
// clear the row but keep that height once the chips go away, leaving them
// floating; on a phone the composer dock's bottom space is counted twice or
// not at all. Screenshots go to apps/web/.cache/quick-actions-layout/.

import type { ThreadDetailData } from "@dx/api";
import {
  defaultThreadModelSelection,
  type ProjectId,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import type { FlueConversationMessage } from "@flue/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

/** Flue's conversation as the page reads it; `set` publishes a change. */
const flue = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const actions = {
    abort: () => Promise.resolve(),
    refresh: () => undefined,
    resendPrompt: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    retrySend: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    loadOlder: () => Promise.resolve(),
  };
  let snapshot: Record<string, unknown> = {
    error: undefined,
    failedSends: [],
    historyReady: true,
    hasMore: false,
    messages: [],
    settlements: [],
    finalOutputs: [],
    status: "idle",
    ...actions,
  };
  return {
    get: () => snapshot,
    set: (next: Record<string, unknown>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@flue/react", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@flue/react")>()),
    useFlueAgent: () => useSyncExternalStore(flue.subscribe, flue.get),
  };
});
vi.mock("@flue/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flue/sdk")>()),
  createFlueClient: () => ({ send: vi.fn() }),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { projectKeys } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { defaultPaneLayout } from "./panes/pane-layout.js";
import { paneLayoutKeys } from "./panes/pane-layout-queries.js";
import { threadKeys } from "./thread-queries.js";
import { ThreadWorkspace } from "./thread-workspace.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = "../../../.cache/quick-actions-layout";
const viewer = "usr_quick_viewer" as UserId;
const THREAD = "thr_00000000-0000-4000-8000-0000000000f1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000f2" as ProjectId;
const LAST_REPLY = "entry_a4";
const REPLIES = [
  "Yes, open the pull request now",
  "Ship it to review after the proof video is attached",
];

const thread = {
  id: THREAD,
  title: "Quick replies",
  projectId: PROJECT,
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  access: "owner",
  agentUrl: `/v1/agents/dx/${THREAD}`,
  agentInitialization: {
    selection: defaultThreadModelSelection(),
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;

let clock = 0;
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turn: string,
): FlueConversationMessage =>
  ({
    id,
    role,
    purpose: role,
    display: "visible",
    turnId: turn,
    submissionId: `sub_${turn}`,
    createdAt: new Date(Date.UTC(2026, 10, 10, 9, clock++)).toISOString(),
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as FlueConversationMessage;
const tag = `<dx_message_author role="owner" user_id="${viewer}" identifier="Rhea Banerjee" />\n`;

const conversation = () =>
  [1, 2, 3, 4].flatMap((n) => [
    message(
      `entry_m${n}`,
      "user",
      `${tag}Step ${n}: do the thing`,
      `entry_m${n}`,
    ),
    message(
      n === 4 ? LAST_REPLY : `entry_a${n}`,
      "assistant",
      n === 4 ? "Done. Should I open the pull request?" : `done ${n}`,
      `entry_m${n}`,
    ),
  ]);
// The last turn is unsettled, so its reply is the one the row follows.
const settlements = () =>
  ["entry_m1", "entry_m2", "entry_m3"].map((turn) => ({
    submissionId: `sub_${turn}`,
    outcome: "completed",
    provenance: { kind: "agent" },
  }));

const serve = () => {
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (path.endsWith("/quick-actions"))
      return Response.json({
        status: "success",
        data: {
          messageId: LAST_REPLY,
          actions: [
            { kind: "snooze" },
            ...REPLIES.map((text) => ({ kind: "reply", text })),
          ],
        },
      });
    return new Promise<Response>(() => {});
  });
};

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.resolvedAppearance;
  delete document.documentElement.dataset.palette;
  vi.unstubAllGlobals();
});

const settle = (ms = 50) =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const until = async (check: () => boolean, timeout = 6_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await settle();
  }
};

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);

const mount = async (viewport: readonly [number, number]) => {
  serve();
  clock = 0;
  flue.set({ messages: conversation(), settlements: settlements() });
  await page.viewport(viewport[0], viewport[1]);
  document.documentElement.dataset.resolvedAppearance = "dark";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
    composerQuickActions: true,
  } as never);
  queryClient.setQueryData(threadKeys.detail(viewer, THREAD), thread);
  queryClient.setQueryData(projectKeys.detail(viewer, PROJECT), {
    id: PROJECT,
    name: "dx",
    revision: 1,
  } as never);
  queryClient.setQueryData(
    paneLayoutKeys.layout(viewer, THREAD),
    defaultPaneLayout(),
  );
  const rootRoute = createRootRoute();
  const product = createRoute({
    getParentRoute: () => rootRoute,
    id: "_product",
  });
  const threadRoute = createRoute({
    getParentRoute: () => product,
    path: "/threads/$threadId",
    component: () => (
      <main
        className="product-shell-content"
        style={{ position: "fixed", inset: 0, display: "flex" }}
      >
        <ThreadWorkspace />
      </main>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([product.addChildren([threadRoute])]),
    history: createMemoryHistory({ initialEntries: [`/threads/${THREAD}`] }),
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await React.act(async () => {
    await router.load();
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Rhea Banerjee", email: "r@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await until(() => q("[aria-label='Message']") !== null);
};

const visible = (rect: DOMRect) => rect.width > 0 && rect.height > 0;
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Every chip, scrolled into view in turn, against the visible controls. */
const assertChipsClear = async () => {
  const controls = (
    q(".transcript-controls") as HTMLElement
  ).getBoundingClientRect();
  expect(visible(controls)).toBe(true);
  const row = q(".thread-quick-actions") as HTMLElement;
  const composerTop = (
    q(".agent-composer") as HTMLElement
  ).getBoundingClientRect().top;
  for (const chip of row.querySelectorAll<HTMLElement>(
    ".thread-quick-action",
  )) {
    chip.scrollIntoView({ inline: "nearest", block: "nearest" });
    await settle();
    const box = chip.getBoundingClientRect();
    expect(overlaps(box, controls), chip.textContent ?? "").toBe(false);
    // The point a tap lands on is the chip, not a control above it.
    const hit = document.elementFromPoint(
      Math.min(box.right - 4, row.getBoundingClientRect().right - 4),
      box.top + box.height / 2,
    );
    expect(chip.contains(hit), chip.textContent ?? "").toBe(true);
  }
  // Controls stay near the row, not floating far above it.
  const chipTop = row
    .querySelector<HTMLElement>(".thread-quick-action")
    ?.getBoundingClientRect().top as number;
  expect(controls.bottom).toBeLessThanOrEqual(chipTop);
  expect(chipTop - controls.bottom).toBeLessThanOrEqual(24);
  expect(controls.bottom).toBeLessThan(composerTop);
};

describe("quick replies and the transcript controls", () => {
  for (const [name, viewport] of [
    ["phone", [390, 844]],
    ["desktop", [1440, 900]],
  ] as const) {
    it(`never cover each other on ${name}`, async () => {
      await mount(viewport);
      await until(
        () =>
          document.querySelectorAll("[data-thread-quick-action='reply']")
            .length === REPLIES.length,
      );
      await settle(300);
      await page.screenshot({ path: `${SHOTS}/${name}-chips.png` });
      await assertChipsClear();

      // Typing hides the reply chips; the controls come back down to the
      // composer instead of keeping the row's height.
      const draft = q<HTMLTextAreaElement>(
        "[aria-label='Message']",
      ) as HTMLTextAreaElement;
      await userEvent.click(draft);
      await userEvent.keyboard("x");
      await until(() => q("[data-thread-quick-action='reply']") === null);
      await settle(300);
      await page.screenshot({ path: `${SHOTS}/${name}-typing.png` });
      const controls = (
        q(".transcript-controls") as HTMLElement
      ).getBoundingClientRect();
      const top = (
        q(".thread-quick-actions .thread-quick-action") ??
        (q(".agent-composer") as HTMLElement)
      ).getBoundingClientRect().top;
      expect(controls.bottom).toBeLessThanOrEqual(top);
      expect(top - controls.bottom).toBeLessThanOrEqual(24);
    });
  }
});
