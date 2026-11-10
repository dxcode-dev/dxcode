// Editing an earlier message, through the real Thread page (`ThreadWorkspace`,
// its transcript, message menu, and composer), with Flue a stand-in whose
// conversation the test sets and dx's server answered at `fetch`.
//
// Ways it could go wrong: Edit shows on the agent's replies, on another
// person's message, or where nobody may edit (an archived Thread, a viewer, a
// Space); the composer keeps the person's draft instead of the message; the
// edited message is not marked, or nothing after it dims, or the person's own
// prompts before it dim; Esc leaves the editing bar up or loses the draft
// they had; the request misses the exact original (author tag and attachment
// block) or a retry of the same text takes a new key; a refusal drops the
// text or leaves editing; the transcript keeps the removed turns once Flue
// reloads. Screenshots go to apps/web/.cache/message-edit/.

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

const SHOTS = "../../../.cache/message-edit";
const viewer = "usr_edit_viewer" as UserId;
const ada = "usr_edit_ada" as UserId;
const THREAD = "thr_00000000-0000-4000-8000-0000000000e1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000e2" as ProjectId;
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

interface EditCall {
  readonly path: string;
  readonly body: {
    readonly original: string;
    readonly body: string;
    readonly idempotencyKey: string;
  };
}
let edits: EditCall[] = [];
/** How the server answers the next edit; each answer is taken once. */
let answers: Array<() => Promise<Response> | Response> = [];

const refuse = (status: number, code: string, message: string) =>
  Response.json(
    { status: "error", data: { code, message, requestId: "req_test" } },
    { status },
  );

const serve = () => {
  edits = [];
  answers = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    if (init?.method === "POST" && path.endsWith("/edit")) {
      edits.push({ path, body: JSON.parse(String(init.body)) });
      const answer = answers.shift();
      if (answer !== undefined) return answer();
      return Response.json({
        status: "success",
        data: { submissionId: "sub_edited" },
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

const mount = async (
  detail: Partial<ThreadDetailData> = {},
  viewport: readonly [number, number] = [1440, 900],
) => {
  serve();
  clock = 0;
  flue.set({ messages: conversation(), settlements: settlements() });
  await page.viewport(viewport[0], viewport[1]);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
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
const composer = () => q<HTMLTextAreaElement>("[aria-label='Message']");
const editingBar = () => q(".composer-editing-bar");
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

/** The labels of a message's `⋯` menu. */
const menuOf = async (text: string) => {
  const row = rowOf(text) as HTMLElement;
  await userEvent.hover(row);
  await userEvent.click(
    q("[aria-label='Message Actions']", row) as HTMLElement,
  );
  await until(() => q(".message-menu[role='menu']") !== null);
  const labels = [
    ...document.querySelectorAll<HTMLElement>(
      ".message-menu [role='menuitem']",
    ),
  ].map((item) => item.textContent ?? "");
  return labels;
};
const closeMenu = async () => {
  await userEvent.keyboard("{Escape}");
  await until(() => q(".message-menu[role='menu']") === null);
};
const editVia = async (text: string) => {
  await menuOf(text);
  await userEvent.click(q(".message-menu [data-message-edit]") as HTMLElement);
  await until(() => editingBar() !== null);
};

const dimmed = (element: Element | null) =>
  element !== null &&
  getComputedStyle(element).opacity !== "1" &&
  Number(getComputedStyle(element).opacity) < 1;
/** Dimmed itself, or inside a dimmed turn. */
const shownDimmed = (element: Element | null): boolean =>
  element !== null &&
  (dimmed(element) || shownDimmed(element.parentElement as Element | null));

describe("editing an earlier message", () => {
  it("offers Edit only on the viewer's own messages", async () => {
    await mount();
    expect(
      (await menuOf(M2_TEXT)).some((label) => label.startsWith("Edit")),
    ).toBe(true);
    await page.screenshot({ path: `${SHOTS}/01-menu-1440.png` });
    await closeMenu();
    expect(
      (await menuOf("done 2")).some((label) => label.startsWith("Edit")),
    ).toBe(false);
    await closeMenu();
    expect(
      (await menuOf(ADA_TEXT)).some((label) => label.startsWith("Edit")),
    ).toBe(false);
    await closeMenu();
  });

  for (const [name, detail] of [
    ["an archived Thread", { lifecycleState: "archived" }],
    ["a viewer", { access: "view" }],
    ["a Space", { kind: "space" }],
  ] as const) {
    it(`offers no Edit in ${name}`, async () => {
      await mount(detail as Partial<ThreadDetailData>);
      const labels = await menuOf(M2_TEXT);
      expect(labels.some((label) => label.startsWith("Copy"))).toBe(true);
      expect(labels.some((label) => label.startsWith("Edit"))).toBe(false);
    });
  }

  it("edits in the composer, previews what goes, and Esc gives the draft back", async () => {
    await mount();
    const draft = composer() as HTMLTextAreaElement;
    await userEvent.click(draft);
    await userEvent.keyboard("an unsent draft");
    expect(draft.value).toBe("an unsent draft");

    await editVia(M4_TEXT);
    expect(editingBar()?.textContent).toContain("Editing message");
    // Only the viewer and the agent wrote after it.
    expect(editingBar()?.textContent).not.toContain("Also removes");
    expect(composer()?.value).toBe(M4_TEXT);
    await until(() => document.activeElement === composer());
    expect(rowOf(M4_TEXT)?.hasAttribute("data-editing")).toBe(true);
    await settle(200);
    expect(shownDimmed(rowOf("done 4"))).toBe(true);
    expect(shownDimmed(rowOf(M4_TEXT))).toBe(false);
    expect(shownDimmed(rowOf("done 3"))).toBe(false);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/02-editing-1440.png` });
    const bar = (editingBar() as HTMLElement).getBoundingClientRect();
    const controls = q(".transcript-controls")?.getBoundingClientRect();
    if (controls !== undefined && controls.height > 0)
      expect(controls.bottom).toBeLessThanOrEqual(bar.top);

    await userEvent.keyboard("{Escape}");
    await until(() => editingBar() === null);
    expect(composer()?.value).toBe("an unsent draft");
    expect(rowOf(M4_TEXT)?.hasAttribute("data-editing")).toBe(false);
    await settle(200);
    expect(shownDimmed(rowOf("done 4"))).toBe(false);

    // Another person's later message: the bar says the edit removes it, and
    // that the message's file is kept.
    await editVia(M2_TEXT);
    expect(editingBar()?.textContent).toContain(
      "Also removes 1 message from Ada Lovelace",
    );
    expect(editingBar()?.textContent).toContain("Keeps its attachment");
    expect(composer()?.value).toBe(M2_TEXT);
    await settle(200);
    for (const later of ["done 2", ADA_TEXT, "done 3", M4_TEXT])
      expect(shownDimmed(rowOf(later))).toBe(true);
    expect(shownDimmed(rowOf("done 1"))).toBe(false);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/03-editing-others-1440.png` });

    // Cancel works too.
    await userEvent.click(q(".composer-editing-cancel") as HTMLElement);
    await until(() => editingBar() === null);
    expect(composer()?.value).toBe("an unsent draft");
  });

  it("e on an open menu or a selected message starts editing", async () => {
    await mount();
    await menuOf(M4_TEXT);
    await userEvent.keyboard("e");
    await until(() => editingBar() !== null);
    expect(q(".message-menu[role='menu']")).toBeNull();
    expect(composer()?.value).toBe(M4_TEXT);
    await userEvent.keyboard("{Escape}");
    await until(() => editingBar() === null);

    (rowOf(M2_TEXT) as HTMLElement).focus();
    await userEvent.keyboard("e");
    await until(() => editingBar() !== null);
    expect(composer()?.value).toBe(M2_TEXT);
  });

  it("sends the edit, keeps the text through refusals, and shows the reloaded conversation", async () => {
    await mount();
    await editVia(M2_TEXT);
    const box = composer() as HTMLTextAreaElement;
    await userEvent.clear(box);
    await userEvent.type(box, "Do not touch any files. Reply only: edited 2");

    // Pending: the composer holds the message, Cancel waits.
    let answer: (response: Response) => void = () => {};
    answers.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await userEvent.keyboard("{Enter}");
    await until(() => edits.length === 1);
    await until(
      () =>
        q("[aria-label='Send edited message']")?.getAttribute("aria-busy") ===
        "true",
    );
    expect((q(".composer-editing-cancel") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/04-pending-1440.png` });
    expect(edits[0]?.path).toBe(`/v1/threads/${THREAD}/messages/entry_m2/edit`);
    expect(edits[0]?.body.original).toBe(M2_ORIGINAL);
    expect(edits[0]?.body.body).toBe(
      `Do not touch any files. Reply only: edited 2\n\n${attachmentBlock}`,
    );
    const key = edits[0]?.body.idempotencyKey ?? "";
    expect(key.length).toBeGreaterThan(0);

    // Refused: still editing, the text stays, the server's reason shows.
    await React.act(async () =>
      answer(
        refuse(
          409,
          "AGENT_BUSY",
          "The agent did not stop in time. Try again in a moment.",
        ),
      ),
    );
    await until(() => q(".thread-error-card") !== null);
    expect(q(".thread-error-card")?.textContent).toContain(
      "The agent did not stop in time. Try again in a moment.",
    );
    expect(editingBar()).not.toBeNull();
    expect(composer()?.value).toBe(
      "Do not touch any files. Reply only: edited 2",
    );
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/05-error-1440.png` });

    // The same text again is the same edit: it keeps its key.
    await userEvent.click(composer() as HTMLElement);
    await userEvent.keyboard("{Enter}");
    await until(() => edits.length === 2);
    expect(edits[1]?.body.idempotencyKey).toBe(key);
    await until(() => editingBar() === null);
    expect(q(".thread-error-card")).toBeNull();
    expect(composer()?.value).toBe("");

    // Flue reads the history again: the conversation ends at the edit.
    clock = 10;
    const kept = conversation().slice(0, 2);
    flue.set({
      messages: [
        ...kept,
        user(
          "entry_m2b",
          `${tag(viewer, "Rhea Banerjee", ' edited="true"')}Do not touch any files. Reply only: edited 2\n\n${attachmentBlock}`,
          "entry_m2b",
        ),
        reply("entry_a2b", "edited 2", "entry_m2b"),
      ],
      settlements: [settled("entry_m1"), settled("entry_m2b")],
    });
    await until(() => rowOf("edited 2") !== null && rowOf("done 4") === null);
    for (const gone of ["done 2", ADA_TEXT, "done 3", M4_TEXT])
      expect(rowOf(gone)).toBeNull();
    expect(rowOf("done 1")).not.toBeNull();
  });

  it("moves the text to the composer when the conversation went back but the message was not sent", async () => {
    await mount();
    await editVia(M4_TEXT);
    answers.push(() =>
      refuse(
        502,
        "EDIT_NOT_SENT",
        "The conversation went back to before your message, but the edited message was not sent. Send it again.",
      ),
    );
    await userEvent.keyboard("{Enter}");
    await until(() => q(".thread-error-card") !== null);
    expect(editingBar()).toBeNull();
    expect(composer()?.value).toBe(M4_TEXT);
    expect(q(".thread-error-card")?.textContent).toContain("Send it again.");
  });
});

describe("editing on a phone", () => {
  it("shows the menu, the editing bar, pending, and an error at 390 wide", async () => {
    await mount({}, [390, 844]);
    const m2 = rowOf(M2_TEXT) as HTMLElement;
    m2.focus();
    await userEvent.click(
      q("[aria-label='Message Actions']", m2) as HTMLElement,
    );
    await until(() => q(".message-menu [data-message-edit]") !== null);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/01-menu-390.png` });
    await userEvent.click(
      q(".message-menu [data-message-edit]") as HTMLElement,
    );
    await until(() => editingBar() !== null);
    expect(editingBar()?.textContent).toContain("Also removes 1 message");
    await settle(300);
    await page.screenshot({ path: `${SHOTS}/03-editing-others-390.png` });
    // The bar sits on the composer, fits the screen, and the transcript's
    // controls stay clear of it.
    const bar = (editingBar() as HTMLElement).getBoundingClientRect();
    const form = (q(".agent-composer") as HTMLElement).getBoundingClientRect();
    expect(Math.abs(bar.bottom - form.top)).toBeLessThanOrEqual(1);
    expect(bar.right).toBeLessThanOrEqual(390);
    const controls = q(".transcript-controls")?.getBoundingClientRect();
    if (controls !== undefined && controls.height > 0)
      expect(controls.bottom).toBeLessThanOrEqual(bar.top);

    await userEvent.click(q(".composer-editing-cancel") as HTMLElement);
    await until(() => editingBar() === null);
    (rowOf(M4_TEXT) as HTMLElement).focus();
    await userEvent.keyboard("e");
    await until(() => editingBar() !== null);
    await settle(300);
    await page.screenshot({ path: `${SHOTS}/02-editing-390.png` });

    let answer: (response: Response) => void = () => {};
    answers.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await userEvent.click(composer() as HTMLElement);
    await userEvent.keyboard("{Enter}");
    await until(() => edits.length === 1);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/04-pending-390.png` });
    await React.act(async () =>
      answer(
        refuse(
          409,
          "MESSAGE_CHANGED",
          "This message is no longer in the conversation as shown. Reload and try again.",
        ),
      ),
    );
    await until(() => q(".thread-error-card") !== null);
    expect(editingBar()).not.toBeNull();
    expect(composer()?.value).toBe(M4_TEXT);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/05-error-390.png` });
  });
});
