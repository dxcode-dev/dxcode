// Real thread page under a deterministic, local-only load. Renders the product
// router, ProductShell, ThreadWorkspace, and the real Flue AgentSession. Only
// the network is replaced: the query cache is seeded, other fetches stay
// pending, and the conversation observation mirrors @flue/sdk delivery (one
// publish per chunk, one microtask between chunks of a network batch).
// Driven by `node test/thread-page-stress.mjs`; never contacts providers.
import type { ProjectData, ThreadDetailData } from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  createFlueAgentSession,
  type FlueConversationMessage,
} from "@flue/react";
import type { FlueClient } from "@flue/sdk";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { DateTime } from "effect";
import { createRoot } from "react-dom/client";
import { projectKeys } from "../features/projects/project-queries.js";
import { composerDefaultsQueryOptions } from "../features/settings/account/composer-defaults-queries.js";
import { personalAccountQueryOptions } from "../features/settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../features/settings/settings-context-queries.js";
import { threadKeys } from "../features/threads/thread-queries.js";
import { ThreadSessionRegistryContext } from "../features/threads/thread-session-context.js";
import { ThreadSessionRegistry } from "../features/threads/thread-session-registry.js";
import { createAppRouter } from "../router.js";
import { AuthContext } from "../shared/auth/auth-context.js";
import { createQueryClient } from "../shared/query/query-client.js";
import { ThemeProvider } from "../shared/theme/theme-provider.js";
import "../styles.css";

type Message = FlueConversationMessage;
type Conversation = {
  conversationId: string;
  messages: Message[];
  settlements: { submissionId: string; outcome: "completed" }[];
  finalOutputs: never[];
};

const params = new URLSearchParams(location.search);
const HISTORY_TURNS = Number(params.get("turns") ?? 40);
const TOOL_OUTPUT_CHARS = Number(params.get("tool") ?? 2_000);

const userId = "usr_perf" as UserId;
const projectId = "prj_00000000-0000-4000-8000-000000000147" as ProjectId;
const threadId = "thr_00000000-0000-4000-8000-000000000147" as ThreadId;
const now = DateTime.makeUnsafe(Date.now());
const project = {
  id: projectId,
  name: "Storefront",
  revision: 1,
  configuration: { runnerProfileId: "standard" },
  createdAt: now,
  updatedAt: now,
} as unknown as ProjectData;
// `shared=1` lists Threads shared with this person and Threads they shared,
// and serves attachment uploads, for the sidebar and composer proof.
const SHARED = params.get("shared") === "1";
// `long=1` gives every sidebar Thread a title too long for its row.
const LONG_TITLES = params.get("long") === "1";
const otherUserId = "usr_other" as UserId;
const me = { userId, name: "Perf User" };
const other = { userId: otherUserId, name: "Riley Brook" };
const thread = {
  id: threadId,
  title: params.get("title") ?? "Perf: long thread",
  projectId,
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
  agentUrl: `/v1/agents/dx/${threadId}`,
  executionWorkspace: { ready: true, preparationStatus: null },
  agentInitialization: {
    selection: { kind: "mode", profileId: "default", mode: "medium" },
    skills: [],
  },
} as unknown as ThreadDetailData;
// The sidebar list is served as JSON so the real listThreads decode path and
// TanStack structural sharing run on every refetch, as in production.
const SIDEBAR_THREADS = Number(params.get("sidebar") ?? 100);
const sidebarThreadId = (i: number) =>
  i === 0
    ? threadId
    : (`thr_00000000-0000-4000-8000-${String(i).padStart(12, "0")}` as ThreadId);
const sidebarStatuses = new Map<number, "idle" | "working">();
const threadListJson = () => ({
  status: "success",
  data: {
    items: Array.from({ length: SIDEBAR_THREADS }, (_, i) => {
      const at = new Date(Date.parse("2026-10-01T10:00:00.000Z") - i * 60_000);
      return {
        id: sidebarThreadId(i),
        title:
          i === 0
            ? thread.title
            : `Sidebar thread ${i}${LONG_TITLES ? ": a title longer than its row" : ""}`,
        projectId,
        visibility: "private",
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        lastActivityAt: new Date(listOrigin - i * 60_000).toISOString(),
        activityStatus: sidebarStatuses.get(i) ?? "idle",
        lifecycleState: "active",
        agentUrl: `/v1/agents/dx/${sidebarThreadId(i)}`,
        mode: "medium",
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
let uploads = 0;
const attachmentId = (n: number) => `att_${String(n).padStart(32, "0")}`;
// Stable list timestamps: lastActivityAt above uses a fixed per-load origin.
const listOrigin = Date.now();

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

// --- Fake observation: same snapshot contract and chunk semantics as the SDK.
let conversation: Conversation = {
  conversationId: threadId,
  messages: Array.from({ length: HISTORY_TURNS }, (_, i) =>
    historyTurn(i),
  ).flat(),
  settlements: Array.from({ length: HISTORY_TURNS }, (_, i) => ({
    submissionId: `s${i}`,
    outcome: "completed" as const,
  })),
  finalOutputs: [],
};
const observers = new Set<() => void>();
let observed = {
  conversation: undefined as Conversation | undefined,
  phase: "loading" as string,
  incarnation: "perf",
  error: undefined,
  hasMore: false,
  loadingOlder: false,
};
const publish = () => {
  observed = { ...observed, conversation, phase: "live" };
  for (const listener of observers) listener();
};
const appendDelta = (messageId: string, delta: string) => {
  const index = conversation.messages.findIndex((m) => m.id === messageId);
  const message = conversation.messages[index];
  const parts = [...message.parts];
  const last = parts.at(-1);
  if (last?.type === "text" && last.state === "streaming")
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  else parts.push({ type: "text", text: delta, state: "streaming" });
  const messages = [...conversation.messages];
  messages[index] = { ...message, parts };
  conversation = { ...conversation, messages };
};
const settleTurn = (n: number) => {
  const messageId = `a-live-${n}`;
  conversation = {
    ...conversation,
    messages: conversation.messages.map((message) =>
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
      ...conversation.settlements,
      { submissionId: `s-live-${n}`, outcome: "completed" as const },
    ],
  };
  publish();
};
const startTurn = (n: number) => {
  conversation = {
    ...conversation,
    messages: [
      ...conversation.messages,
      {
        id: `u-live-${n}`,
        role: "user",
        purpose: "user",
        display: "visible",
        submissionId: `s-live-${n}`,
        turnId: `t-live-${n}`,
        parts: [{ type: "text", text: "Stream please", state: "done" }],
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
  publish();
};

// Every request and Flue send, for proofs that assert what a page sent.
const requests: { method: string; url: string }[] = [];
const sends: unknown[] = [];
Object.assign(window, { __requests: requests, __sends: sends });
const client = {
  url: `${location.origin}${thread.agentUrl}`,
  observe: () => ({
    subscribe: (listener: () => void) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    getSnapshot: () => observed,
    start: () => queueMicrotask(publish),
    stop: () => undefined,
    refresh: () => undefined,
    close: () => observers.clear(),
    loadOlder: () => Promise.resolve(),
  }),
  send: async (...args: unknown[]) => {
    sends.push(args);
    return { submissionId: `s-sent-${Date.now()}` };
  },
} as unknown as FlueClient;

class PerfRegistry extends ThreadSessionRegistry {
  override prepare(...args: Parameters<ThreadSessionRegistry["prepare"]>) {
    const entry = super.prepare(...args);
    // Same session options the product uses; only its client differs.
    return Object.assign(entry, {
      client,
      session: createFlueAgentSession({ client, live: "sse", promptLimit: 2 }),
    });
  }
}

// --- Network: seed exactly what the page reads; everything else stays pending.
const pending = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    ),
  );
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  requests.push({
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    url: `${url.pathname}${url.search}`,
  });
  if (url.pathname === "/v1/threads" && !url.searchParams.has("lifecycleState"))
    return Promise.resolve(Response.json(threadListJson()));
  if (
    url.pathname === "/v1/threads" &&
    url.searchParams.get("lifecycleState") === "active"
  )
    return Promise.resolve(Response.json(threadListJson()));
  if (SHARED && url.pathname === "/v1/shared-threads")
    return Promise.resolve(Response.json(sharedThreadsJson()));
  // Uploads: one part, PUT to a URL the proof script answers.
  if (SHARED && url.pathname === "/v1/attachments" && init?.method === "POST") {
    const id = attachmentId(++uploads);
    return Promise.resolve(
      Response.json({
        id,
        partSize: 10 * 1024 * 1024,
        partCount: 1,
        parts: [{ partNumber: 1, url: `/__upload/${id}/1` }],
      }),
    );
  }
  const completed = /^\/v1\/attachments\/(att_[0-9a-f]{32})\/complete$/.exec(
    url.pathname,
  );
  if (SHARED && completed !== null)
    return Promise.resolve(
      Response.json({
        id: completed[1],
        filename: "proof.png",
        mimeType: "image/png",
        size: 68,
        url: `/v1/attachments/${completed[1]}/proof.png`,
      }),
    );
  pendingUrls.push(`${url.pathname}${url.search}`);
  return pending(input, init);
}) as typeof fetch;
// Requests left pending, for diagnosing which data a page waits on.
const pendingUrls: string[] = [];
Object.assign(window, { __pendingUrls: pendingUrls });
class SilentSocket extends EventTarget {
  readyState = 0;
  send() {}
  close() {}
}
Object.assign(window, { WebSocket: SilentSocket });

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
const page = <T,>(items: T[]) => ({
  pages: [{ items, nextCursor: undefined }],
  pageParams: [undefined],
});
queryClient.setQueryData(threadKeys.detail(userId, threadId), thread);
queryClient.setQueryData(projectKeys.detail(userId, projectId), project);
queryClient.setQueryData(projectKeys.lists(userId), page([project]));
queryClient.setQueryData(settingsContextQueryOptions(userId).queryKey, {
  dictationAvailable: false,
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
const auth = {
  identity: { id: userId, name: "Perf", email: "perf@dx.test" },
  logout: () => undefined,
};

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
        <ThreadSessionRegistryContext value={registry}>
          <AuthContext value={auth}>
            <RouterProvider router={router} />
          </AuthContext>
        </ThreadSessionRegistryContext>
      </QueryClientProvider>
    </ThemeProvider>,
  );

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
let liveTurn = 0;
const refetchSidebar = () =>
  queryClient.invalidateQueries({ queryKey: threadKeys.lists(userId) });
Object.assign(window, {
  dxPerf: {
    /** Refetch the sidebar list as realtime invalidation and polling do. */
    async refetchSidebar(times: number) {
      for (let i = 0; i < times; i++) {
        await refetchSidebar();
        await macrotask();
      }
    },
    /** Change one sidebar thread's activity status and refetch. */
    async setSidebarStatus(index: number, status: "idle" | "working") {
      sidebarStatuses.set(index, status);
      await refetchSidebar();
    },
    async stream({
      chars: requestedChars = 0,
      text,
      settle = false,
      deltaChars = 20,
      batchSize = 1,
      intervalMs = 0,
    }: {
      chars?: number;
      /** Exact Markdown to stream instead of generated answers. */
      text?: string;
      /** Finish the turn afterwards, as a completed model response does. */
      settle?: boolean;
      deltaChars?: number;
      batchSize?: number;
      intervalMs?: number;
    }) {
      const n = ++liveTurn;
      startTurn(n);
      await macrotask();
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
          appendDelta(`a-live-${n}`, source.slice(at, at + deltaChars));
          publish();
          await Promise.resolve();
        }
        worstBatchMs = Math.max(worstBatchMs, performance.now() - batchStart);
        await (intervalMs
          ? new Promise((r) => setTimeout(r, intervalMs))
          : macrotask());
      }
      if (settle) settleTurn(n);
      // Prove the streamed text reached the DOM, so a broken path cannot look
      // fast: compare against the source length, ignoring Markdown syntax.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const turn = document.querySelector(`[data-turn-id="turn:t-live-${n}"]`);
      const renderedChars = turn?.textContent?.length ?? 0;
      return {
        renderedChars,
        streamMs: Math.round(performance.now() - started),
        worstBatchMs: Math.round(worstBatchMs),
      };
    },
  },
});
