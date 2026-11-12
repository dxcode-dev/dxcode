// Reactions on a shared Thread's messages, through the real Thread page
// (`ThreadWorkspace`, its transcript and message actions), with Flue a
// stand-in whose conversation the test sets and dx's server answered at
// `fetch`.
//
// Ways it could go wrong: a private Thread or a Space offers reactions, or
// asks the server for them; a shared Thread shows none of the reactions the
// server holds, or puts them under the wrong message, or under every part of
// an answer; Add Reaction is missing beside ⋯ on a person's message or the
// agent's answer, on desktop or on a phone; picking one sends nothing, or
// sends it for the wrong message, or the chip waits for the server; a chip
// you gave does not take it back; someone else's reaction never shows up
// when realtime says reactions changed; an archived Thread still takes them.
// Screenshots go to apps/web/.cache/message-reactions/.

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
import { invalidateMessageReactions } from "./sharing/message-reactions-cache-queries.js";
import { threadKeys } from "./thread-queries.js";
import { ThreadWorkspace } from "./thread-workspace.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = "../../../.cache/message-reactions";
const viewer = "usr_edit_viewer" as UserId;
const ada = "usr_edit_ada" as UserId;
const THREAD = "thr_00000000-0000-4000-8000-0000000000f1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000f2" as ProjectId;
const ATTACHMENT = `att_${"7".repeat(32)}`;

const thread = {
  id: THREAD,
  title: "Create probe/a.txt",
  projectId: PROJECT,
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  agentUrl: `/v1/agents/dx/${THREAD}`,
  agentInitialization: {
    selection: defaultThreadModelSelection(),
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;

const tag = (userId: string, name: string, extra = "") =>
  `<dx_message_author role="${userId === viewer ? "owner" : "contributor"}" user_id="${userId}" identifier="${name}"${extra} />\n`;
const attachmentBlock = `<dx_attachments>\n<dx_attachment id="${ATTACHMENT}" name="notes.txt" type="text/plain" size="12" url="https://dx.test/v1/attachments/${ATTACHMENT}/notes.txt" />\n</dx_attachments>`;

let clock = 0;
const user = (
  id: string,
  text: string,
  turn: string,
): FlueConversationMessage =>
  ({
    id,
    role: "user",
    purpose: "user",
    display: "visible",
    turnId: turn,
    submissionId: `sub_${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 10, 9, clock++)).toISOString(),
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as FlueConversationMessage;
const reply = (
  id: string,
  text: string,
  turn: string,
): FlueConversationMessage =>
  ({
    id,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    turnId: turn,
    submissionId: `sub_${turn}`,
    createdAt: new Date(Date.UTC(2026, 10, 10, 9, clock++)).toISOString(),
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as FlueConversationMessage;
const settled = (turn: string) => ({
  submissionId: `sub_${turn}`,
  outcome: "completed",
  provenance: { kind: "agent" },
});

const M2_TEXT =
  "Append a line two to probe/a.txt and create probe/b.txt containing two. Reply only: done 2";
const M2_ORIGINAL = `${tag(viewer, "Rhea Banerjee")}${M2_TEXT}\n\n${attachmentBlock}`;
const ADA_TEXT = "Also create probe/c.txt. Reply only: done 3";
const M4_TEXT = "Summarize what changed. Reply only: done 4";

const conversation = () => [
  user(
    "entry_m1",
    `${tag(viewer, "Rhea Banerjee")}Create the file probe/a.txt containing one. Reply only: done 1`,
    "entry_m1",
  ),
  reply("entry_a1", "done 1", "entry_m1"),
  user("entry_m2", M2_ORIGINAL, "entry_m2"),
  reply("entry_a2", "done 2", "entry_m2"),
  user(
    "entry_m3",
    `${tag(ada, "Ada Lovelace", ' handle="ada"')}${ADA_TEXT}`,
    "entry_m3",
  ),
  reply("entry_a3", "done 3", "entry_m3"),
  user("entry_m4", `${tag(viewer, "Rhea Banerjee")}${M4_TEXT}`, "entry_m4"),
  reply("entry_a4", "done 4", "entry_m4"),
];
const settlements = () =>
  ["entry_m1", "entry_m2", "entry_m3", "entry_m4"].map(settled);

interface ReactionCall {
  readonly method: string;
  readonly messageId: string;
  readonly reaction: string;
}
let calls: ReactionCall[] = [];
let listReads = 0;
/** What the server holds: message id → reaction → who gave it. */
let held = new Map<string, Map<string, Set<string>>>();
let client: ReturnType<typeof createQueryClient> | undefined;

const reactionsOf = (messageId: string) =>
  [...(held.get(messageId) ?? new Map<string, Set<string>>())]
    .filter(([, who]) => who.size > 0)
    .map(([reaction, who]) => ({
      reaction,
      count: who.size,
      mine: who.has(viewer),
      agent: false,
    }));

const give = (messageId: string, reaction: string, userId: string) => {
  const reactions = held.get(messageId) ?? new Map<string, Set<string>>();
  const who = reactions.get(reaction) ?? new Set<string>();
  who.add(userId);
  reactions.set(reaction, who);
  held.set(messageId, reactions);
};

const serve = (shared = true) => {
  calls = [];
  listReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    const method = init?.method ?? "GET";
    if (path === `/v1/threads/${THREAD}/message-reactions`) {
      listReads += 1;
      return Response.json({
        status: "success",
        data: {
          shared,
          items: shared
            ? [...held.keys()]
                .map((messageId) => ({
                  messageId,
                  reactions: reactionsOf(messageId),
                }))
                .filter(({ reactions }) => reactions.length > 0)
            : [],
        },
      });
    }
    const set = new RegExp(
      `^/v1/threads/${THREAD}/message-reactions/([^/]+)/([^/]+)$`,
    ).exec(path);
    if (set !== null) {
      const [, messageId = "", reaction = ""] = set;
      calls.push({ method, messageId, reaction });
      if (method === "PUT") give(messageId, reaction, viewer);
      else held.get(messageId)?.get(reaction)?.delete(viewer);
      return Response.json({
        status: "success",
        data: { messageId, reactions: reactionsOf(messageId) },
      });
    }
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

const SHARED = {
  visibility: "workspace",
  sharing: { workspaceAccess: "view" },
} as unknown as Partial<ThreadDetailData>;

const mount = async (
  detail: Partial<ThreadDetailData> = SHARED,
  viewport: readonly [number, number] = [1440, 900],
) => {
  serve(detail.sharing !== undefined);
  clock = 0;
  flue.set({ messages: conversation(), settlements: settlements() });
  await page.viewport(viewport[0], viewport[1]);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  client = queryClient;
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
  } as never);
  queryClient.setQueryData(threadKeys.detail(viewer, THREAD), {
    ...thread,
    ...detail,
  });
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
  await until(
    () =>
      document.querySelector("[aria-label='Message']") !== null ||
      document.querySelector(".archived-thread-warning") !== null ||
      document.querySelector(".shared-composer-notice") !== null,
  );
  await until(() => rowOf("done 4") !== null);
};

const q = <T extends HTMLElement = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) => scope.querySelector<T>(selector);
/** The transcript row whose text starts with `text`. */
const rowOf = (text: string) => {
  const rows = [
    ...document.querySelectorAll<HTMLElement>("article.transcript-row"),
  ].map((row) => ({
    row,
    content: row.querySelector(".message-content")?.textContent?.trim() ?? "",
  }));
  // A prompt's content also names its files, so it may hold more.
  return (
    rows.find(({ content }) => content === text)?.row ??
    rows.find(
      ({ row, content }) =>
        row.dataset.rowKind === "user-prompt" && content.startsWith(text),
    )?.row ??
    null
  );
};

const addReaction = (row: HTMLElement | null) =>
  row === null ? null : q("[aria-label='Add Reaction']", row);
const chips = (row: HTMLElement | null) =>
  row === null
    ? []
    : [...row.querySelectorAll<HTMLElement>(".reaction-chip")].map((chip) => [
        chip.dataset.reaction,
        chip.querySelector(".reaction-chip-count")?.textContent,
        chip.getAttribute("aria-pressed"),
      ]);

/** Picks a reaction from a message's Add Reaction button. */
const pick = async (text: string, name: string) => {
  const row = rowOf(text) as HTMLElement;
  await userEvent.hover(row);
  await userEvent.click(addReaction(row) as HTMLElement);
  await until(() => q(".reaction-picker") !== null);
  await userEvent.click(
    q(`.reaction-picker [aria-label='${name}']`) as HTMLElement,
  );
  await until(() => q(".reaction-picker") === null);
};

afterEach(() => {
  held = new Map();
  client = undefined;
});

describe("reactions on a shared Thread's messages", () => {
  it("are not offered on a private Thread", async () => {
    give("entry_a2", "heart", ada);
    await mount({});
    await settle(200);
    for (const text of [M2_TEXT, "done 2", ADA_TEXT]) {
      await userEvent.hover(rowOf(text) as HTMLElement);
      expect(addReaction(rowOf(text))).toBeNull();
      expect(chips(rowOf(text))).toEqual([]);
    }
    expect(listReads).toBe(0);
    await page.screenshot({ path: `${SHOTS}/01-private-1440.png` });
  });

  it("are not offered in a Space's transcript", async () => {
    await mount({ ...SHARED, kind: "space" } as Partial<ThreadDetailData>);
    await settle(200);
    await userEvent.hover(rowOf("done 2") as HTMLElement);
    expect(addReaction(rowOf("done 2"))).toBeNull();
    expect(listReads).toBe(0);
  });

  it("show under the message they sit on and are given from beside ⋯", async () => {
    give("entry_a2", "thumbs_up", ada);
    give("entry_m3", "heart", viewer);
    await mount();
    await until(() => chips(rowOf("done 2")).length > 0);
    expect(chips(rowOf("done 2"))).toEqual([["thumbs_up", "1", "false"]]);
    expect(chips(rowOf(ADA_TEXT))).toEqual([["heart", "1", "true"]]);
    expect(chips(rowOf(M2_TEXT))).toEqual([]);
    expect(chips(rowOf("done 1"))).toEqual([]);

    // The agent's answer: Add Reaction sits beside its ⋯.
    await userEvent.hover(rowOf("done 2") as HTMLElement);
    const controls = q(".message-actions-controls", rowOf("done 2") as never);
    expect(addReaction(controls as HTMLElement)).not.toBeNull();
    expect(
      q("[aria-label='Message Actions']", controls as never),
    ).not.toBeNull();
    await page.screenshot({ path: `${SHOTS}/02-hover-1440.png` });

    await pick("done 2", "Thumbs Up");
    // The chip counts the viewer at once, and the server heard it.
    await until(() => chips(rowOf("done 2"))[0]?.[1] === "2");
    expect(chips(rowOf("done 2"))).toEqual([["thumbs_up", "2", "true"]]);
    await until(() => calls.length === 1);
    expect(calls).toEqual([
      { method: "PUT", messageId: "entry_a2", reaction: "thumbs_up" },
    ]);

    // The viewer's own message takes one too.
    await pick(M2_TEXT, "Wave");
    await until(() => chips(rowOf(M2_TEXT)).length > 0);
    expect(chips(rowOf(M2_TEXT))).toEqual([["wave", "1", "true"]]);
    await until(() => calls.length === 2);
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      messageId: "entry_m2",
      reaction: "wave",
    });
    await page.screenshot({ path: `${SHOTS}/03-reacted-1440.png` });

    // A chip you gave takes it back.
    await userEvent.click(
      q(
        ".reaction-chip[data-reaction='heart']",
        rowOf(ADA_TEXT) as never,
      ) as HTMLElement,
    );
    await until(() => chips(rowOf(ADA_TEXT)).length === 0);
    await until(() => calls.length === 3);
    expect(calls.at(-1)).toEqual({
      method: "DELETE",
      messageId: "entry_m3",
      reaction: "heart",
    });
  });

  it("show someone else's reaction when realtime says they changed", async () => {
    await mount();
    await until(() => listReads > 0);
    expect(chips(rowOf("done 4"))).toEqual([]);
    give("entry_a4", "joy", ada);
    await React.act(() =>
      invalidateMessageReactions(client as never, viewer, THREAD),
    );
    await until(() => chips(rowOf("done 4")).length > 0);
    expect(chips(rowOf("done 4"))).toEqual([["joy", "1", "false"]]);
  });

  it("stay readable but take none once the Thread is archived", async () => {
    give("entry_a2", "eyes", ada);
    await mount({
      ...SHARED,
      lifecycleState: "archived",
    } as Partial<ThreadDetailData>);
    await until(() => chips(rowOf("done 2")).length > 0);
    await userEvent.hover(rowOf("done 2") as HTMLElement);
    expect(addReaction(rowOf("done 2"))).toBeNull();
    expect(
      (q(".reaction-chip", rowOf("done 2") as never) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("are given on a phone from the selected message", async () => {
    give("entry_a2", "heart", ada);
    await mount(SHARED, [390, 844]);
    await until(() => chips(rowOf("done 2")).length > 0);
    // A tap selects the message, which shows its actions.
    (rowOf("done 2") as HTMLElement).focus();
    await settle(100);
    const button = addReaction(rowOf("done 2")) as HTMLElement;
    expect(button).not.toBeNull();
    await until(() => getComputedStyle(button).opacity === "1");
    // On screen, not pushed past the phone's edge.
    const box = button.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/04-selected-390.png` });
    await userEvent.click(button);
    await until(() => q(".reaction-picker") !== null);
    await page.screenshot({ path: `${SHOTS}/05-picker-390.png` });
    await userEvent.click(
      q(".reaction-picker [aria-label='Heart']") as HTMLElement,
    );
    await until(() => chips(rowOf("done 2"))[0]?.[1] === "2");
    await page.screenshot({ path: `${SHOTS}/06-reacted-390.png` });
  });
});
