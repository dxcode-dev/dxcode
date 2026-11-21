// Editing and deleting messages sent while the agent works, through the real
// Thread page (`ThreadWorkspace`, its transcript, message menu, composer, and
// delete dialog), with Flue a stand-in whose conversation the test sets and
// dx's server answered at `fetch`.
//
// Ways it could go wrong: a waiting message offers no Edit or Delete; an edit
// of a waiting message goes to the read-message route (stopping the agent and
// rewinding) instead of replacing it in the queue; its echo stays after the
// server replaced or withdrew it; the bar keeps saying "replaces" after the
// agent read the message, or never says what happened when the server
// restarted from it; Delete removes more than the person saw when the agent
// took the message first, instead of asking again; a read delete misses the
// exact original or the entry; a removed attachment is still sent; a message
// queued from another tab cannot be changed. Screenshots go to
// apps/web/.cache/message-queue/.

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
  const forgotten: string[] = [];
  let snapshot: Record<string, unknown> = {};
  const publish = (next: Record<string, unknown>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const actions = {
    abort: () => Promise.resolve(),
    refresh: () => undefined,
    resendPrompt: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    retrySend: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    loadOlder: () => Promise.resolve(),
    // As Flue's session does: the echo and its submission go.
    forgetSend: (localId: string) => {
      forgotten.push(localId);
      publish({
        messages: (snapshot.messages as Array<{ id: string }>).filter(
          ({ id }) => id !== localId,
        ),
        localSubmissions: (
          snapshot.localSubmissions as Array<{ localId: string }>
        ).filter((entry) => entry.localId !== localId),
      });
    },
  };
  const reset = () => {
    forgotten.length = 0;
    snapshot = {
      error: undefined,
      failedSends: [],
      historyReady: true,
      hasMore: false,
      messages: [],
      settlements: [],
      finalOutputs: [],
      localSubmissions: [],
      status: "streaming",
      ...actions,
    };
  };
  reset();
  return {
    forgotten,
    reset,
    get: () => snapshot,
    set: publish,
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
import { Toaster } from "../../shared/ui/sonner.js";
import { projectKeys } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { defaultPaneLayout } from "./panes/pane-layout.js";
import { paneLayoutKeys } from "./panes/pane-layout-queries.js";
import { threadKeys } from "./thread-queries.js";
import { ThreadWorkspace } from "./thread-workspace.js";
import "../../styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHOTS = "../../../.cache/message-queue";
const viewer = "usr_queue_viewer" as UserId;
const THREAD = "thr_00000000-0000-4000-8000-0000000000f1" as ThreadId;
const PROJECT = "prj_00000000-0000-4000-8000-0000000000f2" as ProjectId;
const NOTES = `att_${"7".repeat(32)}`;
const SHOT = `att_${"8".repeat(32)}`;

const thread = {
  id: THREAD,
  title: "Migrate billing",
  projectId: PROJECT,
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "working",
  agentUrl: `/v1/agents/dx/${THREAD}`,
  agentInitialization: {
    selection: defaultThreadModelSelection(),
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;

const tag = `<dx_message_author role="owner" user_id="${viewer}" identifier="Rhea Banerjee" />\n`;
const notesAttachment = `<dx_attachment id="${NOTES}" name="notes.txt" type="text/plain" size="12" url="https://dx.test/v1/attachments/${NOTES}/notes.txt" />`;
const shotAttachment = `<dx_attachment id="${SHOT}" name="shot.png" type="image/png" size="40" url="https://dx.test/v1/attachments/${SHOT}/shot.png" />`;
const attachments = (...items: string[]) =>
  `<dx_attachments>\n${items.join("\n")}\n</dx_attachments>`;

const EARLIER = "List the billing tables. Reply only: listed";
const EARLIER_ORIGINAL = `${tag}${EARLIER}`;
const HOST = "Run the billing migration on staging";
const STEER = "Skip the archived_invoices table";

const message = (
  fields: Partial<FlueConversationMessage> & {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  },
): FlueConversationMessage => {
  const { text, ...rest } = fields;
  return {
    purpose: fields.role,
    display: "visible",
    ...rest,
    parts: [{ type: "text", text, state: "done" }],
  } as unknown as FlueConversationMessage;
};

/** The history: an earlier answered prompt, then the turn that is running. */
const history = () => [
  message({
    id: "entry_earlier",
    role: "user",
    text: EARLIER_ORIGINAL,
    submissionId: "sub_earlier",
    turnId: "entry_earlier",
    timestamp: "2026-11-20T09:00:00.000Z",
  }),
  message({
    id: "entry_earlier_reply",
    role: "assistant",
    text: "listed",
    submissionId: "sub_earlier",
    turnId: "entry_earlier",
    timestamp: "2026-11-20T09:00:05.000Z",
  }),
  message({
    id: "entry_host",
    role: "user",
    text: `${tag}${HOST}`,
    submissionId: "sub_host",
    turnId: "entry_host",
    timestamp: "2026-11-20T09:31:00.000Z",
  }),
  {
    id: "entry_step",
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    submissionId: "sub_host",
    turnId: "turn_step",
    timestamp: "2026-11-20T09:31:10.000Z",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "shell_command",
        toolCallId: "call-migrate",
        state: "input-available",
        input: { command: "pnpm migrate --env staging" },
      },
    ],
  } as unknown as FlueConversationMessage,
];

/** This tab's steer, as Flue's echo before the agent reads it. */
const echo = (text: string, id = "local:1") =>
  message({ id, role: "user", text });

/** The steer once the agent read it: Flue's record of it. */
const steerRead = (text: string) =>
  message({
    id: "entry_steer",
    role: "user",
    text: `${tag}${text}`,
    submissionId: "sub_steer",
    turnId: "turn_step",
    timestamp: "2026-11-20T09:32:00.000Z",
  });

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}
let calls: Call[] = [];
/** How the server answers the next change request; each answer once. */
let answers: Array<() => Promise<Response> | Response> = [];
/** The viewer's queued messages, as the server reads them. */
let queued: unknown[] = [];

const ok = (data: unknown) => Response.json({ status: "success", data });
const refuse = (status: number, code: string, message: string, extra = {}) =>
  Response.json(
    {
      status: "error",
      data: { code, message, requestId: "req_test", ...extra },
    },
    { status },
  );
const readFirst = (entryId: string) =>
  refuse(
    409,
    "MESSAGE_READ",
    "The agent read this message before the change arrived.",
    { entryId },
  );

const serve = () => {
  calls = [];
  answers = [];
  queued = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "https://dx.test").pathname;
    const method = init?.method ?? "GET";
    if (path.endsWith("/messages/queued") && method === "GET")
      return ok({ messages: queued });
    if (path.includes("/messages/") && method === "POST") {
      calls.push({ path, method, body: JSON.parse(String(init?.body)) });
      const answer = answers.shift();
      if (answer !== undefined) return answer();
      if (path.endsWith("/delete"))
        return ok({
          outcome: path.includes("/queued/") ? "withdrawn" : "rewound",
        });
      // Replaced in place: the message keeps its submission.
      if (path.includes("/queued/"))
        return ok({
          outcome: "replaced",
          submissionId: decodeURIComponent(path.split("/")[6] ?? ""),
        });
      return ok({ submissionId: "sub_new" });
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

const mount = async ({
  messages = [...history(), echo(STEER)],
  localSubmissions = [{ localId: "local:1", submissionId: "sub_steer" }],
  serverQueue = [],
  viewport = [1440, 900] as const,
}: {
  readonly messages?: ReadonlyArray<FlueConversationMessage>;
  readonly localSubmissions?: ReadonlyArray<{
    localId: string;
    submissionId: string;
  }>;
  readonly serverQueue?: unknown[];
  readonly viewport?: readonly [number, number];
} = {}) => {
  serve();
  queued = serverQueue;
  flue.reset();
  flue.set({ messages, localSubmissions });
  await page.viewport(viewport[0], viewport[1]);
  document.documentElement.dataset.resolvedAppearance = "light";
  document.documentElement.dataset.palette = "daydream";
  const queryClient = createQueryClient();
  queryClient.setQueryData(settingsContextQueryOptions(viewer).queryKey, {
    activeScope: "personal",
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
          <Toaster position="bottom-right" closeButton />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await until(() => document.querySelector("[aria-label='Message']") !== null);
  await until(() => rowOf(HOST) !== null);
  return queryClient;
};

const q = <T extends HTMLElement = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
) => scope.querySelector<T>(selector);
const composer = () => q<HTMLTextAreaElement>("[aria-label='Message']");
const editingBar = () => q(".composer-editing-bar");
const dialog = () => q(".confirm-dialog");
/** The transcript prompt whose text starts with `text`. */
const rowOf = (text: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      "article.transcript-row[data-row-kind='user-prompt']",
    ),
  ].find((row) =>
    (
      row.querySelector(".message-content")?.textContent?.trim() ?? ""
    ).startsWith(text),
  ) ?? null;

const openMenu = async (text: string) => {
  const row = rowOf(text) as HTMLElement;
  row.focus();
  await userEvent.click(
    q("[aria-label='Message Actions']", row) as HTMLElement,
  );
  await until(() => q(".message-menu[role='menu']") !== null);
};
const menuLabels = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".message-menu [role='menuitem']",
    ),
  ].map((item) => item.textContent ?? "");
const choose = async (label: string) => {
  const item = [
    ...document.querySelectorAll<HTMLElement>(
      ".message-menu [role='menuitem']",
    ),
  ].find((element) => element.textContent?.startsWith(label));
  await userEvent.click(item as HTMLElement);
};
const editVia = async (text: string) => {
  await openMenu(text);
  await choose("Edit");
  await until(() => editingBar() !== null);
};
const deleteVia = async (text: string) => {
  await openMenu(text);
  await choose("Delete");
  await until(() => dialog() !== null);
};
const replaceDraft = async (text: string) => {
  const box = composer() as HTMLTextAreaElement;
  await userEvent.clear(box);
  await userEvent.type(box, text);
};
const confirmDelete = async () => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"),
  ].find((element) => element.textContent?.trim() === "Delete");
  await userEvent.click(button as HTMLButtonElement);
};
const toastText = () => q("[data-sonner-toast]")?.textContent ?? "";
/** Flue's record of the steer arrives: the agent read it. */
const agentReads = (text = STEER) =>
  React.act(() => flue.set({ messages: [...history(), steerRead(text)] }));

describe("a message sent while the agent works", () => {
  it("offers Edit and Delete before the agent reads it", async () => {
    await mount();
    await openMenu(STEER);
    const labels = menuLabels();
    expect(labels.some((label) => label.startsWith("Edit"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Delete"))).toBe(true);
    await page.screenshot({ path: `${SHOTS}/01-waiting-menu-1440.png` });
  });

  it("edit before pickup replaces it in the queue, and the new text shows", async () => {
    await mount();
    await editVia(STEER);
    expect(editingBar()?.textContent).toContain("hasn't read it yet");
    expect(composer()?.value).toBe(STEER);
    await replaceDraft("Skip archived_invoices and audit_log");
    // What the server reads once the edit replaced it.
    queued = [
      {
        submissionId: "sub_steer",
        text: "Skip archived_invoices and audit_log",
        original: `${tag}Skip archived_invoices and audit_log`,
        attachments: [],
        createdAt: "2026-11-20T09:32:10.000Z",
      },
    ];
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/queued/sub_steer/edit`,
    );
    expect(calls[0]?.body.body).toBe("Skip archived_invoices and audit_log");
    await until(() => editingBar() === null);
    // Still waiting under the same submission: the echo stays and shows the
    // queue's new text.
    expect(flue.forgotten).toEqual([]);
    await until(() => rowOf("Skip archived_invoices and audit_log") !== null);
    expect(rowOf(STEER)).toBeNull();
    await settle(200);
    await page.screenshot({
      path: `${SHOTS}/02-edited-before-pickup-1440.png`,
    });
  });

  it("says so when the agent reads it mid-edit, and the save restarts from it", async () => {
    await mount();
    await editVia(STEER);
    expect(editingBar()?.textContent).toContain("hasn't read it yet");
    await agentReads();
    await until(
      () => editingBar()?.textContent?.includes("just read it") === true,
    );
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/03-read-mid-edit-1440.png` });
    await replaceDraft("Skip archived_invoices, it is 40 GB");
    await userEvent.keyboard("{Enter}");
    // Read by now: the edit restarts from Flue's record, with its original.
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_steer/edit`,
    );
    expect(calls[0]?.body.original).toBe(`${tag}${STEER}`);
    await until(() => toastText().includes("restarted from your edit"));
    await until(() => editingBar() === null);
  });

  it("tells the person when the save lost the race on the server", async () => {
    await mount();
    await editVia(STEER);
    await replaceDraft("Skip archived_invoices only");
    answers.push(() =>
      ok({ outcome: "restarted", submissionId: "sub_restarted" }),
    );
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 1);
    await until(() =>
      toastText().includes(
        "The agent read it first, so it restarted from your edit.",
      ),
    );
    await until(() => editingBar() === null);
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/04-restarted-toast-1440.png` });
  });

  it("restarts from the read message when the queue's route says the agent took it", async () => {
    // The agent took it before the route looked; Flue's record has not
    // reached the page, so the queue's copy gives the original.
    await mount({
      serverQueue: [
        {
          submissionId: "sub_steer",
          text: STEER,
          original: `${tag}${STEER}`,
          attachments: [],
          createdAt: "2026-11-20T09:32:10.000Z",
        },
      ],
    });
    await editVia(STEER);
    await replaceDraft("Skip archived_invoices entirely");
    answers.push(() => readFirst("entry_steer"));
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 2);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/queued/sub_steer/edit`,
    );
    expect(calls[1]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_steer/edit`,
    );
    expect(calls[1]?.body.original).toBe(`${tag}${STEER}`);
    expect(calls[1]?.body.idempotencyKey).toBe(calls[0]?.body.idempotencyKey);
    await until(() => toastText().includes("restarted from your edit"));
    await until(() => editingBar() === null);
  });

  it("delete before pickup takes it out of the queue", async () => {
    await mount();
    await deleteVia(STEER);
    expect(dialog()?.textContent).toContain(
      "The agent hasn't read it yet and won't see it.",
    );
    await page.screenshot({ path: `${SHOTS}/05-delete-waiting-1440.png` });
    await confirmDelete();
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/queued/sub_steer/delete`,
    );
    await until(() => dialog() === null);
    expect(flue.forgotten).toEqual(["local:1"]);
    await until(() => rowOf(STEER) === null);
  });

  it("delete after pickup goes back to just before it, with its original", async () => {
    await mount();
    await deleteVia(EARLIER);
    expect(dialog()?.textContent).toContain("The agent forgets this message");
    await page.screenshot({ path: `${SHOTS}/06-delete-read-1440.png` });
    await confirmDelete();
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_earlier/delete`,
    );
    expect(calls[0]?.body.original).toBe(EARLIER_ORIGINAL);
    await until(() => dialog() === null);
  });

  it("asks again when the agent took it first, then deletes what was read", async () => {
    await mount();
    await deleteVia(STEER);
    answers.push(() => readFirst("entry_steer"));
    await confirmDelete();
    await until(() => calls.length === 1);
    await until(
      () =>
        dialog()?.textContent?.includes(
          "The agent read it while this was open.",
        ) === true,
    );
    expect(dialog()?.textContent).toContain("The agent forgets this message");
    expect(flue.forgotten).toEqual([]);
    await agentReads();
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/07-delete-race-1440.png` });
    await confirmDelete();
    await until(() => calls.length === 2);
    expect(calls[1]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_steer/delete`,
    );
    expect(calls[1]?.body.original).toBe(`${tag}${STEER}`);
    await until(() => dialog() === null);
  });

  it("switches the dialog when the agent reads it while it is open", async () => {
    await mount();
    await deleteVia(STEER);
    await agentReads();
    await until(
      () =>
        dialog()?.textContent?.includes(
          "The agent read it while this was open.",
        ) === true,
    );
    await confirmDelete();
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_steer/delete`,
    );
  });

  it("sends only the attachments the person keeps", async () => {
    await mount({
      messages: [
        ...history(),
        echo(`${STEER}\n\n${attachments(notesAttachment, shotAttachment)}`),
      ],
    });
    await editVia(STEER);
    expect(editingBar()?.textContent).toContain("Keeps its 2 attachments");
    await userEvent.click(
      q("[aria-label='Remove notes.txt']") as HTMLButtonElement,
    );
    await until(
      () =>
        editingBar()?.textContent?.includes("Keeps 1 of its 2 attachments") ===
        true,
    );
    expect(q("[aria-label='Remove notes.txt']")).toBeNull();
    await settle(200);
    await page.screenshot({ path: `${SHOTS}/08-remove-attachment-1440.png` });
    await userEvent.click(composer() as HTMLTextAreaElement);
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 1);
    const body = String(calls[0]?.body.body);
    expect(body).toContain(STEER);
    expect(body).toContain(SHOT);
    expect(body).not.toContain(NOTES);
  });

  it("removes an attachment from a read message's edit too", async () => {
    const original = `${tag}${EARLIER}\n\n${attachments(notesAttachment)}`;
    await mount({
      messages: [
        message({
          id: "entry_earlier",
          role: "user",
          text: original,
          submissionId: "sub_earlier",
          turnId: "entry_earlier",
          timestamp: "2026-11-20T09:00:00.000Z",
        }),
        ...history().slice(1),
      ],
      localSubmissions: [],
    });
    await editVia(EARLIER);
    await userEvent.click(
      q("[aria-label='Remove notes.txt']") as HTMLButtonElement,
    );
    expect(editingBar()?.textContent).toContain("Removes its attachment");
    await userEvent.click(composer() as HTMLTextAreaElement);
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/entry_earlier/edit`,
    );
    expect(calls[0]?.body.original).toBe(original);
    expect(calls[0]?.body.body).toBe(EARLIER);
  });

  it("a message queued from another tab shows and can be edited and deleted", async () => {
    await mount({
      messages: history(),
      localSubmissions: [],
      serverQueue: [
        {
          submissionId: "sub_other_tab",
          text: "Also check the ledger totals",
          original: `${tag}Also check the ledger totals`,
          attachments: [],
          createdAt: "2026-11-20T09:32:30.000Z",
        },
      ],
    });
    await until(() => rowOf("Also check the ledger totals") !== null);
    await openMenu("Also check the ledger totals");
    expect(menuLabels().some((label) => label.startsWith("Delete"))).toBe(true);
    await choose("Edit");
    await until(() => editingBar() !== null);
    expect(editingBar()?.textContent).toContain("hasn't read it yet");
    await replaceDraft("Also check ledger and invoice totals");
    await userEvent.keyboard("{Enter}");
    await until(() => calls.length === 1);
    expect(calls[0]?.path).toBe(
      `/v1/threads/${THREAD}/messages/queued/sub_other_tab/edit`,
    );
    await until(() => editingBar() === null);

    await deleteVia("Also check the ledger totals");
    await confirmDelete();
    await until(() => calls.length === 2);
    expect(calls[1]?.path).toBe(
      `/v1/threads/${THREAD}/messages/queued/sub_other_tab/delete`,
    );
  });
});
