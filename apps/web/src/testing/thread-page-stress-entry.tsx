// Real thread page under a deterministic, local-only load. Renders the product
// router, ProductShell, ThreadWorkspace, the real AuthGate and RealtimeClient,
// and the real Flue AgentSession. Only the network is replaced: the query cache
// is seeded, the endpoints a scenario refetches are served as JSON through the
// product's own decoders, other fetches stay pending, a fake WebSocket plays
// the realtime hub, and each Thread's conversation observation mirrors
// @flue/sdk delivery (one publish per chunk, one microtask between chunks of a
// network batch). Driven by `node test/thread-page-stress.mjs`; never contacts
// providers.
import {
  GetThreadResponseSchema,
  type ProjectData,
  type ThreadDetailData,
} from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  createFlueAgentSession,
  type FlueConversationMessage,
} from "@flue/react";
import type { FlueClient } from "@flue/sdk";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { DateTime, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { AuthGate } from "../features/authentication/auth-gate.js";
import { sessionQueryOptions } from "../features/authentication/sign-in-queries.js";
import { projectKeys } from "../features/projects/project-queries.js";
import { composerDefaultsQueryOptions } from "../features/settings/account/composer-defaults-queries.js";
import { personalAccountQueryOptions } from "../features/settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../features/settings/settings-context-queries.js";
import { RealtimeProvider } from "../features/threads/realtime/realtime-provider.js";
import { ThreadFileNavigationContext } from "../features/threads/thread-file-navigation.js";
import { threadKeys } from "../features/threads/thread-queries.js";
import { THREAD_ROW_COALESCE_MS } from "../features/threads/thread-row-queries.js";
import {
  ThreadPresentationContext,
  ThreadSessionRegistryContext,
} from "../features/threads/thread-session-context.js";
import {
  THREAD_HISTORY_PAGE,
  ThreadSessionRegistry,
} from "../features/threads/thread-session-registry.js";
import { createAppRouter } from "../router.js";
import { AuthContext } from "../shared/auth/auth-context.js";
import { createQueryClient } from "../shared/query/query-client.js";
import { ThemeProvider } from "../shared/theme/theme-provider.js";
import {
  MarkdownFileLinkContext,
  MarkdownImageSourceContext,
} from "../shared/ui/markdown-file-link-context.js";
import { MarkdownMentionContext } from "../shared/ui/markdown-mention-context.js";
import "../styles.css";

// Production builds drop context names; name the ones the cause notation
// should report as `context:<Name>`.
Object.assign(AuthContext, { displayName: "Auth" });
Object.assign(ThreadPresentationContext, { displayName: "ThreadPresentation" });
Object.assign(ThreadSessionRegistryContext, {
  displayName: "ThreadSessionRegistry",
});
Object.assign(ThreadFileNavigationContext, {
  displayName: "ThreadFileNavigation",
});
Object.assign(MarkdownFileLinkContext, { displayName: "MarkdownFileLink" });
Object.assign(MarkdownImageSourceContext, {
  displayName: "MarkdownImageSource",
});
Object.assign(MarkdownMentionContext, { displayName: "MarkdownMention" });

type Message = FlueConversationMessage;
type Conversation = {
  conversationId: string;
  messages: Message[];
  settlements: { submissionId: string; outcome: "completed" }[];
  finalOutputs: never[];
};

const params = new URLSearchParams(location.search);
const HISTORY_TURNS = Number(params.get("turns") ?? 40);
// `history=1` opens the Thread with the product's own Flue client and session;
// the proof script answers its history reads from recorded pages.
const RECORDED_HISTORY = params.get("history") === "1";
const TOOL_OUTPUT_CHARS = Number(params.get("tool") ?? 2_000);
// `changes=N` serves N changed files, each with a diff, to the Changes pane.
const CHANGED_FILES = Number(params.get("changes") ?? 0);
// `portal=1` gives the workspace a Portal domain, so Preview is a tool.
const PORTAL = params.get("portal") === "1";

const userId = "usr_perf" as UserId;
const projectId = "prj_00000000-0000-4000-8000-000000000147" as ProjectId;
const threadId = "thr_00000000-0000-4000-8000-000000000147" as ThreadId;
const project = {
  id: projectId,
  name: "Storefront",
  revision: 1,
  configuration: { runnerProfileId: "standard" },
  createdAt: DateTime.makeUnsafe(Date.now()),
  updatedAt: DateTime.makeUnsafe(Date.now()),
} as unknown as ProjectData;
// `shared=1` lists Threads shared with this person and Threads they shared,
// and serves attachment uploads, for the sidebar and composer proof.
const SHARED = params.get("shared") === "1";
// `long=1` gives every sidebar Thread a title too long for its row.
const LONG_TITLES = params.get("long") === "1";
const otherUserId = "usr_other" as UserId;
const me = { userId, name: "Perf User" };
const other = { userId: otherUserId, name: "Riley Brook" };
// Stable list timestamps: lastActivityAt below uses a fixed per-load origin.
const listOrigin = Date.now();
const iso = (at: number) => new Date(at).toISOString();

// The open Thread's server state. Detail refetches serve whatever it holds,
// so a scenario changes it and lets realtime invalidation fetch it.
const openThread = {
  title: params.get("title") ?? "Perf: long thread",
  // `titlePending=1` opens a Thread whose title the title agent still owns.
  titlePending: params.get("titlePending") === "1",
  activityStatus: "idle" as "idle" | "working",
  lastActivityAt: listOrigin,
};
const SIDEBAR_THREADS = Number(params.get("sidebar") ?? 100);
const sidebarThreadId = (i: number) =>
  i === 0
    ? threadId
    : (`thr_00000000-0000-4000-8000-${String(i).padStart(12, "0")}` as ThreadId);
const sidebarIndex = (id: string) =>
  Array.from({ length: SIDEBAR_THREADS }, (_, i) => sidebarThreadId(i)).indexOf(
    id as ThreadId,
  );
const sidebarStatuses = new Map<number, "idle" | "working">();
const sidebarActivity = new Map<number, number>();
const sidebarChanges = new Map<
  number,
  { additions: number; deletions: number; files: number }
>();
const sidebarTitle = (i: number) =>
  i === 0
    ? openThread.title
    : `Sidebar thread ${i}${LONG_TITLES ? ": a title longer than its row" : ""}`;

const agentInitialization = {
  personalInstructions: "",
  settingsRevision: 0,
  settingsVersion: 1,
  selection: { kind: "mode", profileId: "default", mode: "medium" },
  mcpConnections: [],
  plugins: [],
  skills: [],
};
/** The Thread detail as Core serves it; decoded by the product's schema. */
const threadDetailJson = (id: ThreadId) => {
  const i = sidebarIndex(id);
  const open = id === threadId;
  const created = iso(Date.parse("2026-10-01T10:00:00.000Z") - i * 60_000);
  return {
    status: "success",
    data: {
      id,
      title: sidebarTitle(i),
      ...(open && openThread.titlePending ? { titlePending: true } : {}),
      projectId,
      visibility: "private",
      lifecycleState: "active",
      activityStatus: open
        ? openThread.activityStatus
        : (sidebarStatuses.get(i) ?? "idle"),
      createdAt: created,
      updatedAt: created,
      lastActivityAt: iso(
        open
          ? openThread.lastActivityAt
          : (sidebarActivity.get(i) ?? listOrigin - i * 60_000),
      ),
      agentUrl: `/v1/agents/dx/${id}`,
      executionWorkspace: { ready: true, preparationStatus: null },
      agentInitialization,
    },
  };
};
const decodeDetail = (id: ThreadId): ThreadDetailData =>
  Schema.decodeUnknownSync(GetThreadResponseSchema)(threadDetailJson(id)).data;

// The sidebar list is served as JSON so the real listThreads decode path and
// TanStack structural sharing run on every refetch, as in production.
const threadListJson = () => ({
  status: "success",
  data: {
    items: Array.from({ length: SIDEBAR_THREADS }, (_, i) => {
      const at = new Date(Date.parse("2026-10-01T10:00:00.000Z") - i * 60_000);
      const changes = sidebarChanges.get(i);
      return {
        id: sidebarThreadId(i),
        title: sidebarTitle(i),
        projectId,
        visibility: "private",
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        lastActivityAt: iso(
          i === 0
            ? openThread.lastActivityAt
            : (sidebarActivity.get(i) ?? listOrigin - i * 60_000),
        ),
        activityStatus:
          i === 0
            ? openThread.activityStatus
            : (sidebarStatuses.get(i) ?? "idle"),
        lifecycleState: "active",
        agentUrl: `/v1/agents/dx/${sidebarThreadId(i)}`,
        mode: "medium",
        ...(i === 0 && openThread.titlePending ? { titlePending: true } : {}),
        ...(changes === undefined ? {} : { changes }),
        // Thread 3 started one child Thread.
        ...(SHARED && i === 3 ? { childCount: 1 } : {}),
        // Threads 1 and 2 are shared with the workspace by their owner.
        ...(SHARED && (i === 1 || i === 2)
          ? {
              access: "owner",
              sharing: { workspaceAccess: "view" },
              participants: [{ ...me, owner: true }, other],
            }
          : {}),
      };
    }),
  },
});
const sharedThreadId = "thr_00000000-0000-4000-8000-0000000005a1" as ThreadId;
const sharedThreadsJson = () => ({
  status: "success",
  data: {
    items: SHARED
      ? [
          {
            id: sharedThreadId,
            title: "Shared with me",
            projectId,
            visibility: "workspace",
            createdAt: new Date(listOrigin).toISOString(),
            updatedAt: new Date(listOrigin).toISOString(),
            lastActivityAt: new Date(listOrigin - 30_000).toISOString(),
            activityStatus: "idle",
            lifecycleState: "active",
            agentUrl: `/v1/agents/dx/${sharedThreadId}`,
            mode: "medium",
            access: "view",
            sharing: { workspaceAccess: "view" },
            participants: [{ ...other, owner: true }, me],
          },
        ]
      : [],
  },
});
// Better Auth's session payload; its client revives the timestamps as new
// Date objects on every read, so an unchanged session is never `===`.
const sessionJson = () => ({
  session: {
    id: "ses_perf",
    userId,
    token: "perf-token",
    expiresAt: iso(listOrigin + 7 * 86_400_000),
    createdAt: iso(listOrigin - 86_400_000),
    updatedAt: iso(listOrigin - 86_400_000),
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: userId,
    name: "Perf",
    email: "perf@dx.test",
    emailVerified: true,
    image: null,
    createdAt: iso(listOrigin - 30 * 86_400_000),
    updatedAt: iso(listOrigin - 86_400_000),
  },
});
let uploads = 0;
const attachmentId = (n: number) => `att_${String(n).padStart(32, "0")}`;

// --- Changes: N files across a few directories, each with a 40-line hunk.
let changesCapture = 1;
let changedFileRevision = 0;
const sha = (digit: string) => digit.repeat(40);
const changedPath = (i: number) =>
  `src/${["checkout", "catalog", "cart", "account", "shared"][i % 5]}/module-${String(i).padStart(2, "0")}.ts`;
const changedFile = (i: number) => ({
  path: changedPath(i),
  status: i % 9 === 0 ? "added" : "modified",
  additions: 24 + (i === 0 ? changedFileRevision : 0),
  deletions: i % 9 === 0 ? 0 : 16,
  binary: false,
  truncated: false,
});
const changesFiles = () =>
  Array.from({ length: CHANGED_FILES }, (_, i) => changedFile(i));
const captureFields = () => ({
  captureId: `capture-${String(changesCapture).padStart(8, "0")}`,
  freshness: "complete",
  capturedAt: iso(listOrigin + changesCapture * 1_000),
});
const changesJson = () => {
  const files = changesFiles();
  return {
    status: "success",
    data: {
      kind: "changes",
      ...captureFields(),
      range: { kind: "all" },
      truncated: false,
      baseline: sha("a"),
      head: sha("b"),
      branch: "perf/changes",
      ahead: 0,
      summary: {
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        files: files.length,
      },
      files,
      commits: [],
    },
  };
};
const patchFor = (i: number) => {
  const path = changedPath(i);
  const removed = i % 9 === 0 ? 0 : 16;
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed + 8} +1,${24 + 8 + (i === 0 ? changedFileRevision : 0)} @@`,
    ' import { compute } from "../shared/compute";',
    " ",
    ...Array.from(
      { length: removed },
      (_, k) => `-export const legacy${k} = compute(${k}, "old") ?? undefined;`,
    ),
    ...Array.from(
      { length: 24 + (i === 0 ? changedFileRevision : 0) },
      (_, k) =>
        `+export const value${k} = (input: number) => compute(input * ${k}, "module-${i}") ?? null;`,
    ),
    " ",
    " export function run(input: number) {",
    "   return value0(input) + value1(input);",
    " }",
    " ",
    " export default run;",
  ];
  return `${lines.join("\n")}\n`;
};
const diffJson = (path: string) => {
  const i = Array.from({ length: CHANGED_FILES }, (_, k) =>
    changedPath(k),
  ).indexOf(path);
  return {
    status: "success",
    data: {
      kind: "diff",
      ...captureFields(),
      range: { kind: "all" },
      file: changedFile(i),
      patch: patchFor(i),
    },
  };
};

// --- Conversations: one fake observation per Thread, same snapshot contract
// and chunk semantics as the SDK.
const answerMarkdown = (seed: number) =>
  `### Result ${seed}\n\nThe change updates **${seed}** files. See \`src/app.ts:${seed}\`.\n\n` +
  "```ts\n" +
  Array.from(
    { length: 30 },
    (_, i) => `export const value${i} = compute(${i}, "${seed}") ?? null;`,
  ).join("\n") +
  "\n```\n\n| file | change |\n| --- | --- |\n| a.ts | +12 |\n| b.ts | -4 |\n\n" +
  "- first point\n- second point with a [link](https://example.com)\n";

const historyTurn = (i: number): Message[] => [
  {
    id: `u${i}`,
    role: "user",
    purpose: "user",
    display: "visible",
    submissionId: `s${i}`,
    turnId: `t${i}`,
    parts: [
      { type: "text", text: `Prompt ${i}: fix the thing`, state: "done" },
    ],
  } as Message,
  {
    id: `a${i}`,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    submissionId: `s${i}`,
    turnId: `t${i}`,
    parts: [
      { type: "reasoning", text: `Thinking about step ${i}…`, state: "done" },
      ...Array.from({ length: 6 }, (_, k) => ({
        type: "dynamic-tool",
        toolName: k % 2 ? "read" : "bash",
        toolCallId: `c${i}-${k}`,
        state: "output-available",
        input: k % 2 ? { path: `src/f${k}.ts` } : { command: `rg value${k}` },
        output: "x".repeat(TOOL_OUTPUT_CHARS),
      })),
      { type: "text", text: answerMarkdown(i), state: "done" },
    ],
  } as unknown as Message,
];

// Every request and Flue send, for proofs that assert what a page sent.
const requests: { method: string; url: string }[] = [];
const sends: unknown[] = [];
// What the Terminal sent as typed input, and each vibration a gesture asked for.
const terminalInput: string[] = [];
const vibrations: unknown[] = [];
Object.assign(window, {
  __requests: requests,
  __sends: sends,
  __terminalInput: terminalInput,
  __vibrations: vibrations,
});
Object.assign(navigator, {
  vibrate: (pattern: VibratePattern) => {
    vibrations.push(pattern);
    return true;
  },
});
/** A send's round trip before Flue's 202 and the echoed user message. */
const SEND_RTT_MS = 40;
let liveTurn = 0;

class FakeConversation {
  conversation: Conversation;
  readonly observers = new Set<() => void>();
  observed = {
    conversation: undefined as Conversation | undefined,
    phase: "loading" as string,
    incarnation: "perf",
    error: undefined,
    hasMore: false,
    loadingOlder: false,
  };
  /** The live turn the last send started, which `reply` streams into. */
  sentTurn: number | undefined;
  readonly client: FlueClient;

  constructor(id: ThreadId) {
    this.conversation = {
      conversationId: id,
      messages: Array.from({ length: HISTORY_TURNS }, (_, i) =>
        historyTurn(i),
      ).flat(),
      settlements: Array.from({ length: HISTORY_TURNS }, (_, i) => ({
        submissionId: `s${i}`,
        outcome: "completed" as const,
      })),
      finalOutputs: [],
    };
    this.client = {
      url: `${location.origin}/v1/agents/dx/${id}`,
      observe: () => ({
        subscribe: (listener: () => void) => {
          this.observers.add(listener);
          return () => this.observers.delete(listener);
        },
        getSnapshot: () => this.observed,
        start: () => queueMicrotask(this.publish),
        stop: () => undefined,
        refresh: () => undefined,
        close: () => this.observers.clear(),
        loadOlder: () => Promise.resolve(),
      }),
      send: async (options: { message?: { body?: string } }) => {
        sends.push([options]);
        const n = ++liveTurn;
        await new Promise((resolve) => setTimeout(resolve, SEND_RTT_MS));
        this.startTurn(n, options.message?.body ?? "");
        this.sentTurn = n;
        return {
          submissionId: `s-live-${n}`,
          streamUrl: this.client.url,
          offset: String(n),
          uid: "perf",
        };
      },
    } as unknown as FlueClient;
  }

  readonly publish = () => {
    this.observed = {
      ...this.observed,
      conversation: this.conversation,
      phase: "live",
    };
    for (const listener of this.observers) listener();
  };

  appendDelta(messageId: string, delta: string) {
    const index = this.conversation.messages.findIndex(
      (m) => m.id === messageId,
    );
    const message = this.conversation.messages[index];
    const parts = [...message.parts];
    const last = parts.at(-1);
    if (last?.type === "text" && last.state === "streaming")
      parts[parts.length - 1] = { ...last, text: last.text + delta };
    else parts.push({ type: "text", text: delta, state: "streaming" });
    const messages = [...this.conversation.messages];
    messages[index] = { ...message, parts };
    this.conversation = { ...this.conversation, messages };
  }

  settleTurn(n: number) {
    const messageId = `a-live-${n}`;
    this.conversation = {
      ...this.conversation,
      messages: this.conversation.messages.map((message) =>
        message.id === messageId
          ? ({
              ...message,
              parts: message.parts.map((part) =>
                part.type === "text" ? { ...part, state: "done" } : part,
              ),
            } as Message)
          : message,
      ),
      settlements: [
        ...this.conversation.settlements,
        { submissionId: `s-live-${n}`, outcome: "completed" as const },
      ],
    };
    this.publish();
  }

  startTurn(n: number, userText = "Stream please") {
    this.conversation = {
      ...this.conversation,
      messages: [
        ...this.conversation.messages,
        {
          id: `u-live-${n}`,
          role: "user",
          purpose: "user",
          display: "visible",
          submissionId: `s-live-${n}`,
          turnId: `t-live-${n}`,
          parts: [{ type: "text", text: userText, state: "done" }],
        } as Message,
        {
          id: `a-live-${n}`,
          role: "assistant",
          purpose: "assistant",
          display: "visible",
          submissionId: `s-live-${n}`,
          turnId: `t-live-${n}`,
          parts: [],
        } as unknown as Message,
      ],
    };
    this.publish();
  }
}
const conversations = new Map<ThreadId, FakeConversation>();
const conversationFor = (id: ThreadId) => {
  let conversation = conversations.get(id);
  if (conversation === undefined) {
    conversation = new FakeConversation(id);
    conversations.set(id, conversation);
  }
  return conversation;
};

class PerfRegistry extends ThreadSessionRegistry {
  readonly #faked = new WeakSet<object>();
  override prepare(...args: Parameters<ThreadSessionRegistry["prepare"]>) {
    const entry = super.prepare(...args);
    if (RECORDED_HISTORY) return entry;
    if (this.#faked.has(entry)) return entry;
    this.#faked.add(entry);
    const { client } = conversationFor(entry.id);
    // Same session options the product uses; only its client differs.
    return Object.assign(entry, {
      client,
      session: createFlueAgentSession({
        client,
        live: "sse",
        ...THREAD_HISTORY_PAGE,
      }),
    });
  }
}

// --- Network: serve what scenarios read and refetch; the rest stays pending.
const pending = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    ),
  );
// The page's real fetch, kept by thread-page-stress.html; only recorded
// history pages reach the network.
const networkFetch = (window as unknown as { __networkFetch: typeof fetch })
  .__networkFetch;
// Requests left pending, for diagnosing which data a page waits on.
const pendingUrls: string[] = [];
Object.assign(window, { __pendingUrls: pendingUrls });
const json = (body: unknown) => Promise.resolve(Response.json(body));
const threadPath = /^\/v1\/threads\/(thr_[0-9a-f-]{36})(\/.*)?$/;
const answer = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  requests.push({ method, url: `${url.pathname}${url.search}` });
  if (RECORDED_HISTORY && url.pathname === `/v1/agents/dx/${threadId}`) {
    const view = url.searchParams.get("view");
    if (view === "history")
      return networkFetch(`/__history${url.search}`, { signal: init?.signal });
    // An idle Thread: the update stream opens and stays quiet.
    if (view === "updates")
      return Promise.resolve(
        new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
      );
  }
  // Built assets fetched at runtime, such as the Terminal's WebAssembly.
  if (url.origin === location.origin && url.pathname.startsWith("/assets/"))
    return networkFetch(input, init);
  if (url.pathname === "/api/auth/get-session") return json(sessionJson());
  if (url.pathname === "/v1/threads") return json(threadListJson());
  if (url.pathname === "/v1/shared-threads") return json(sharedThreadsJson());
  // A person with no notifications and the default sidebar layout.
  if (url.pathname === "/v1/notifications")
    return json({ status: "success", data: { items: [], unreadCount: 0 } });
  if (url.pathname === "/v1/sidebar-layout" && method === "GET")
    return json({ status: "success", data: { entries: [] } });
  const thread = threadPath.exec(url.pathname);
  if (thread !== null && method === "GET") {
    const [, id, rest] = thread as unknown as [string, ThreadId, string?];
    if (rest === undefined && sidebarIndex(id) >= 0)
      return json(threadDetailJson(id));
    // A realtime hint reads the changed Thread's row, not the whole list.
    if (rest === "/list-item" && sidebarIndex(id) >= 0)
      return json({
        status: "success",
        data: threadListJson().data.items[sidebarIndex(id)],
      });
    if (CHANGED_FILES > 0 && id === threadId && rest === "/changes")
      return json(changesJson());
    if (CHANGED_FILES > 0 && id === threadId && rest === "/changes/diff")
      return json(diffJson(url.searchParams.get("path") ?? ""));
  }
  // Uploads: one part, PUT to a URL the harness script answers.
  if (url.pathname === "/v1/attachments" && method === "POST") {
    const id = attachmentId(++uploads);
    return json({
      id,
      partSize: 10 * 1024 * 1024,
      partCount: 1,
      parts: [{ partNumber: 1, url: `/__upload/${id}/1` }],
    });
  }
  const completed = /^\/v1\/attachments\/(att_[0-9a-f]{32})\/complete$/.exec(
    url.pathname,
  );
  if (completed !== null)
    return json({
      id: completed[1],
      filename: "proof.png",
      mimeType: "image/png",
      size: 68,
      url: `/v1/attachments/${completed[1]}/proof.png`,
    });
  pendingUrls.push(`${url.pathname}${url.search}`);
  return pending(input, init);
};
// Installed before any module loaded by thread-page-stress.html.
Object.assign(window, { __dxFetch: answer });

// --- Sockets: the realtime hub and per-Thread Changes hints.
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(url: string | URL, _protocol?: string) {
    super();
    this.url = String(url);
    const { pathname } = new URL(this.url);
    if (pathname === "/v1/realtime") realtime.attach(this);
    else if (pathname.endsWith("/terminal")) terminal.attach(this);
    else {
      changesSockets.set(pathname, this);
      setTimeout(() => this.serverOpen(), 0);
    }
  }
  send(data: string | ArrayBufferView | ArrayBuffer) {
    // A server answers in a later task, as over a real socket.
    if (this === terminal.socket) setTimeout(() => terminal.receive(data), 0);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", new CloseEvent("close", { code, reason }));
  }
  serverOpen() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.fire("open", new Event("open"));
  }
  serverMessage(data: unknown) {
    if (this.readyState !== 1) return;
    this.fire(
      "message",
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
  serverBinary(bytes: Uint8Array) {
    if (this.readyState !== 1) return;
    this.fire(
      "message",
      new MessageEvent("message", { data: bytes.slice().buffer }),
    );
  }
  private fire(type: "open" | "message" | "close", event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.(event);
  }
}
const changesSockets = new Map<string, FakeSocket>();
/** Core's realtime hub: one revision counter, ready on connect, gap on resume. */
const realtime = {
  revision: 0,
  socket: undefined as FakeSocket | undefined,
  /** Events published while the socket was down; resuming reports a gap. */
  missed: false,
  attach(socket: FakeSocket) {
    this.socket = socket;
    setTimeout(() => {
      socket.serverOpen();
      socket.serverMessage({ type: "ready", revision: this.revision });
      const cursor = Number(new URL(socket.url).searchParams.get("cursor"));
      if (this.missed && Number.isFinite(cursor))
        socket.serverMessage({
          type: "revision-gap",
          cursor,
          revision: this.revision,
          recovery: "http-refetch",
        });
      this.missed = false;
    }, 0);
  },
  publish(event: Record<string, unknown>) {
    this.revision += 1;
    if (this.socket?.readyState === 1)
      this.socket.serverMessage({ ...event, revision: this.revision });
    else this.missed = true;
  },
};
/**
 * Core's Terminal attachment: ready on attach at the browser's size,
 * heartbeats as dxd sends them, and an answer to every recovery request.
 */
const terminal = {
  socket: undefined as FakeSocket | undefined,
  heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
  attach(socket: FakeSocket) {
    this.socket = socket;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(
      () => socket.serverMessage({ v: 1, type: "heartbeat" }),
      2_000,
    );
    setTimeout(() => socket.serverOpen(), 0);
  },
  receive(data: string | ArrayBufferView | ArrayBuffer) {
    const socket = this.socket;
    if (socket === undefined) return;
    if (typeof data !== "string") {
      terminalInput.push(new TextDecoder().decode(data));
      return;
    }
    const control = JSON.parse(data) as {
      type: string;
      dimensions?: { columns: number; rows: number };
    };
    if (control.type === "attach" && control.dimensions !== undefined) {
      socket.serverMessage({
        v: 1,
        type: "ready",
        terminal: "default",
        dimensions: control.dimensions,
        replayBytes: 1,
        replayTruncated: false,
        restartRequired: false,
      });
      socket.serverBinary(new TextEncoder().encode("perf@dx:~$ "));
    } else if (control.type === "recover")
      socket.serverMessage({ v: 1, type: "heartbeat" });
  },
};
Object.assign(window, { WebSocket: FakeSocket });

// Production query defaults, without retries, refetch timers, or focus refetch.
const queryClient = createQueryClient();
queryClient.setDefaultOptions({
  ...queryClient.getDefaultOptions(),
  queries: {
    ...queryClient.getDefaultOptions().queries,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
});
// The session keeps the production focus refetch; scenarios mark it stale.
queryClient.setQueryDefaults(sessionQueryOptions.queryKey, {
  refetchOnWindowFocus: true,
});
const page = <T,>(items: T[]) => ({
  pages: [{ items, nextCursor: undefined }],
  pageParams: [undefined],
});
queryClient.setQueryData(
  threadKeys.detail(userId, threadId),
  decodeDetail(threadId),
);
queryClient.setQueryData(projectKeys.detail(userId, projectId), project);
queryClient.setQueryData(projectKeys.lists(userId), page([project]));
queryClient.setQueryData(settingsContextQueryOptions(userId).queryKey, {
  dictationAvailable: false,
  ...(PORTAL ? { portalDomain: "ondx.test" } : {}),
} as never);
// The New Thread composer opens once remembered composer choices resolve.
queryClient.setQueryData(composerDefaultsQueryOptions(userId).queryKey, {
  project: null,
  mode: null,
  model: null,
  runnerProfileId: null,
});
queryClient.setQueryData(personalAccountQueryOptions(userId).queryKey, {
  displayName: "Perf User",
  username: "perf",
  email: "perf@dx.test",
  emailVerified: true,
  identityAuthority: "local-password",
  threadCount: 100,
  appearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
} as never);

const registry = new PerfRegistry(queryClient, userId);
const router = createAppRouter(
  { queryClient, userId },
  createMemoryHistory({
    initialEntries: [params.get("route") ?? `/threads/${threadId}`],
  }),
);

// Same composition as Application and AuthenticatedApplication; the session
// comes from the real AuthGate reading `/api/auth/get-session`.
const container = document.getElementById("root");
if (container)
  createRoot(container).render(
    <ThemeProvider
      appearance={params.get("appearance") === "light" ? "light" : "dark"}
      palette="daydream"
      onAppearanceChange={() => undefined}
      onPaletteChange={() => undefined}
    >
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <ThreadSessionRegistryContext value={registry}>
            <RealtimeProvider queryClient={queryClient} userId={userId}>
              <RouterProvider router={router} />
            </RealtimeProvider>
          </ThreadSessionRegistryContext>
        </AuthGate>
      </QueryClientProvider>
    </ThemeProvider>,
  );

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refetchSidebar = () =>
  queryClient.invalidateQueries({ queryKey: threadKeys.lists(userId) });
/**
 * Resolves once no query the harness answers is fetching, or after
 * `timeoutMs`. Queries without data wait on endpoints left pending.
 */
const settled = async (timeoutMs = 3_000) => {
  // Hints wait this long before reading a row; let those reads start.
  await sleep(THREAD_ROW_COALESCE_MS + 50);
  const started = performance.now();
  await macrotask();
  while (
    queryClient
      .getQueryCache()
      .findAll({ fetchStatus: "fetching" })
      .some((query) => query.state.data !== undefined) &&
    performance.now() - started < timeoutMs
  )
    await sleep(10);
};

type StreamOptions = {
  chars?: number;
  /** Exact Markdown to stream instead of generated answers. */
  text?: string;
  /** Finish the turn afterwards, as a completed model response does. */
  settle?: boolean;
  deltaChars?: number;
  batchSize?: number;
  intervalMs?: number;
};
/** Streams into turn `n` of `conversation`, as Flue delivers chunks. */
const streamInto = async (
  conversation: FakeConversation,
  n: number,
  {
    chars: requestedChars = 0,
    text,
    settle = false,
    deltaChars = 20,
    batchSize = 1,
    intervalMs = 0,
  }: StreamOptions,
) => {
  let source = text ?? "";
  const chars = text?.length ?? requestedChars;
  while (source.length < chars) source += answerMarkdown(source.length);
  let worstBatchMs = 0;
  const started = performance.now();
  for (let i = 0; i < chars; i += deltaChars * batchSize) {
    const batchStart = performance.now();
    for (let k = 0; k < batchSize; k++) {
      const at = i + k * deltaChars;
      if (at >= chars) break;
      conversation.appendDelta(
        `a-live-${n}`,
        source.slice(at, at + deltaChars),
      );
      conversation.publish();
      await Promise.resolve();
    }
    worstBatchMs = Math.max(worstBatchMs, performance.now() - batchStart);
    await (intervalMs ? sleep(intervalMs) : macrotask());
  }
  if (settle) conversation.settleTurn(n);
  // Prove the streamed text reached the DOM, so a broken path cannot look
  // fast: compare against the source length, ignoring Markdown syntax.
  await sleep(200);
  const turn = document.querySelector(`[data-turn-id="turn:t-live-${n}"]`);
  const renderedChars = turn?.textContent?.length ?? 0;
  return {
    renderedChars,
    streamMs: Math.round(performance.now() - started),
    worstBatchMs: Math.round(worstBatchMs),
  };
};

Object.assign(window, {
  dxPerf: {
    threadId,
    sidebarThreadId,
    /** Refetch the sidebar list as realtime invalidation and polling do. */
    async refetchSidebar(times: number) {
      for (let i = 0; i < times; i++) {
        await refetchSidebar();
        await macrotask();
      }
    },
    /** Another Thread's status changes, as Core announces it in realtime. */
    async publishStatus(index: number, status: "idle" | "working") {
      sidebarStatuses.set(index, status);
      sidebarActivity.set(index, Date.now());
      realtime.publish({
        type: "thread.invalidated",
        threadId: sidebarThreadId(index),
      });
      await settled();
    },
    /**
     * Shell output into the Terminal: `lines` colored `ls -l` lines, one
     * frame each `intervalMs`, as dxd forwards PTY reads.
     */
    async terminalOutput({
      lines = 200,
      intervalMs = 16,
    }: {
      lines?: number;
      intervalMs?: number;
    }) {
      const encoder = new TextEncoder();
      for (let i = 0; i < lines; i++) {
        terminal.socket?.serverBinary(
          encoder.encode(
            `-rw-r--r-- 1 perf perf ${String(i * 37).padStart(6)} Oct 19 12:00 \u001b[32mmodule-${i}.ts\u001b[0m\r\n`,
          ),
        );
        await sleep(intervalMs);
      }
      return { terminalAttached: terminal.socket !== undefined };
    },
    /**
     * Bulk shell output, as `cat` of a large log: `bytes` of colored lines in
     * dxd's 16 KiB PTY reads, `perTask` messages per task, as a network
     * batch delivers them.
     */
    async terminalBulk({
      bytes = 1_024 * 1_024,
      perTask = 4,
    }: {
      bytes?: number;
      perTask?: number;
    }) {
      const encoder = new TextEncoder();
      let text = "";
      for (let i = 0; text.length < bytes; i++)
        text += `${String(i).padStart(6)} \u001b[2m12:00:${String(i % 60).padStart(2, "0")}\u001b[0m \u001b[36mbuild\u001b[0m compiled src/module-${i % 997}.ts in ${i % 53} ms\r\n`;
      const output = encoder.encode(text.slice(0, bytes));
      const chunk = 16 * 1_024;
      for (let offset = 0; offset < output.length; ) {
        for (let n = 0; n < perTask && offset < output.length; n++) {
          terminal.socket?.serverBinary(
            output.subarray(offset, offset + chunk),
          );
          offset += chunk;
        }
        await macrotask();
      }
      return { terminalBytes: output.length };
    },
    /** Change one sidebar thread's activity status and refetch. */
    async setSidebarStatus(index: number, status: "idle" | "working") {
      sidebarStatuses.set(index, status);
      await refetchSidebar();
    },
    /** Stream a new turn into the open Thread. */
    async stream(options: StreamOptions) {
      const conversation = conversationFor(threadId);
      const n = ++liveTurn;
      conversation.startTurn(n);
      await macrotask();
      return streamInto(conversation, n, options);
    },
    /** Stream the agent's answer to the last message the composer sent. */
    async reply(options: StreamOptions) {
      const conversation = conversationFor(threadId);
      const started = performance.now();
      while (conversation.sentTurn === undefined) {
        if (performance.now() - started > 5_000)
          throw new Error("The composer did not send.");
        await sleep(10);
      }
      const n = conversation.sentTurn;
      conversation.sentTurn = undefined;
      return streamInto(conversation, n, options);
    },
    /**
     * Core publishing for another Thread while it works: `thread.invalidated`
     * on queued, running and settled, `changes.invalidated` on each capture.
     * Each hint arrives in its own task, `burst` back to back, as a socket
     * delivers them. Its list row changes when it starts, every fourth
     * capture (the change summary), and when it settles.
     */
    async realtimeBurst({
      index = 3,
      bursts = 3,
      burst = 10,
      gapMs = 250,
    }: {
      index?: number;
      bursts?: number;
      burst?: number;
      gapMs?: number;
    }) {
      const id = sidebarThreadId(index);
      let capture = 0;
      sidebarStatuses.set(index, "working");
      sidebarActivity.set(index, Date.now());
      realtime.publish({ type: "thread.invalidated", threadId: id });
      for (let b = 0; b < bursts; b++) {
        for (let k = 0; k < burst; k++) {
          await macrotask();
          if (k % 2 === 0) {
            capture += 1;
            if (capture % 4 === 0)
              sidebarChanges.set(index, {
                additions: capture * 3,
                deletions: capture,
                files: Math.ceil(capture / 4),
              });
            realtime.publish({ type: "changes.invalidated", threadId: id });
          } else realtime.publish({ type: "thread.invalidated", threadId: id });
        }
        await sleep(gapMs);
      }
      sidebarStatuses.set(index, "idle");
      sidebarActivity.set(index, Date.now());
      realtime.publish({ type: "thread.invalidated", threadId: id });
      await settled();
    },
    /**
     * The realtime socket drops, events publish while it is down, and the
     * client resumes from its cursor: the hub answers `revision-gap`, and the
     * client refetches every Thread query and every Changes range.
     */
    async realtimeReconnect() {
      realtime.socket?.close(1012, "service-restart");
      // While it is down, Thread 5 starts working: one row really changes.
      sidebarStatuses.set(5, "working");
      sidebarActivity.set(5, Date.now());
      realtime.publish({
        type: "thread.invalidated",
        threadId: sidebarThreadId(5),
      });
      // RealtimeClient reconnects after one second.
      const started = performance.now();
      const before = realtime.socket;
      while (realtime.socket === before && performance.now() - started < 3_000)
        await sleep(20);
      await sleep(50);
      await settled();
    },
    /**
     * The open Thread's own detail through a run, as Core invalidates it:
     * idle → working, a running heartbeat, settled → idle, and finally the
     * title agent settling a pending title.
     */
    async openThreadLifecycle() {
      const step = async (change: Partial<typeof openThread>) => {
        Object.assign(openThread, change, { lastActivityAt: Date.now() });
        realtime.publish({ type: "thread.invalidated", threadId });
        await settled();
        await sleep(100);
      };
      await step({ activityStatus: "working" });
      await step({});
      await step({ activityStatus: "idle" });
      await step({ titlePending: false, title: "Fix the checkout flow" });
      return {
        title: document.querySelector(".thread-title-bar .thread-title")
          ?.textContent,
      };
    },
    /**
     * Returning to the tab after the session went stale: each focus refetches
     * the session through Better Auth, whose answer is equal but new.
     */
    async focusWindow(times: number) {
      for (let i = 0; i < times; i++) {
        await queryClient.invalidateQueries({
          queryKey: sessionQueryOptions.queryKey,
          refetchType: "none",
        });
        document.dispatchEvent(
          new Event("visibilitychange", { bubbles: true }),
        );
        window.dispatchEvent(new Event("focus"));
        await settled();
        await sleep(50);
      }
      return {
        sessionFetches: requests.filter(
          ({ url }) => url === "/api/auth/get-session",
        ).length,
      };
    },
    /**
     * Changes capture hints for the open Thread: `unchanged` captures with
     * the same capture ID, then one new capture where one file grew.
     */
    async changesCaptures({ unchanged = 3 }: { unchanged?: number }) {
      const socket = changesSockets.get(
        `/v1/threads/${encodeURIComponent(threadId)}/changes/events`,
      );
      for (let i = 0; i < unchanged; i++) {
        socket?.serverMessage({ type: "changes-updated" });
        await settled();
        await sleep(100);
      }
      changesCapture += 1;
      changedFileRevision += 4;
      socket?.serverMessage({ type: "changes-updated" });
      await settled();
      await sleep(300);
      await settled();
      return { hintSocket: socket !== undefined };
    },
  },
});
