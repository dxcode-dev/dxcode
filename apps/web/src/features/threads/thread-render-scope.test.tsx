// @vitest-environment happy-dom

// Render-scope regressions for the thread page: typing, layout, scrolling, and
// Flue stream chunks must not rebuild unchanged transcript turns or the page.
// Markdown parsing is the dominant cost, so parses are counted directly.

import type { ProjectData, ThreadDetailData } from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  createFlueAgentSession,
  type FlueConversationMessage,
} from "@flue/react";
import type { FlueClient } from "@flue/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

const counts = vi.hoisted(() => ({ parses: [] as string[], changes: 0 }));

vi.mock("react-markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-markdown")>()),
  default: ({ children }: { children: string }) => {
    counts.parses.push(children);
    return <div data-markdown="">{children}</div>;
  },
}));
vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: (options: Record<string, unknown>) => {
    const instance = React.useRef({});
    const count = options.count as number;
    const getItemKey = options.getItemKey as (index: number) => React.Key;
    return Object.assign(instance.current, {
      getTotalSize: () => count * 56,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: getItemKey(index),
          size: 56,
          start: index * 56,
          end: (index + 1) * 56,
        })),
      isAtEnd: () => true,
      measureElement: () => {},
      options,
      scrollToEnd: () => {},
      scrollToIndex: () => {},
      getOffsetForIndex: (index: number) => [index * 56, "start"],
      scrollToOffset: () => {},
      takeSnapshot: () => [],
    });
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (l: { href: string }) => string }) =>
    select({ href: "/threads/thread-1" }),
  useNavigate: () => () => undefined,
  useParams: () => ({ threadId: "thread-1" }),
}));
vi.mock("../../shared/use-mobile.js", () => ({ useMobile: () => false }));
vi.mock("./changes/changes-pane.js", () => ({
  ChangesPane: () => {
    counts.changes += 1;
    return <div data-testid="changes-pane" />;
  },
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";
import { ThreadSessionRegistry } from "./thread-session-registry.js";
import { ThreadTranscript } from "./thread-transcript.js";
import { ThreadSession } from "./thread-workspace.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";

type Message = FlueConversationMessage;
const userId = "usr_render_scope" as UserId;
const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;
const thread = {
  id: threadId,
  title: "Render scope",
  projectId,
  visibility: "private",
  lifecycleState: "active",
  agentUrl: "https://dx.test/v1/agents/dx/thread-1",
  agentInitialization: {
    selection: { kind: "mode", profileId: "default", mode: "medium" },
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;
const project = {
  id: projectId,
  name: "Project",
  revision: 1,
} as unknown as ProjectData;

const turn = (i: number, answer: string): Message[] => [
  {
    id: `u${i}`,
    role: "user",
    purpose: "user",
    display: "visible",
    submissionId: `s${i}`,
    turnId: `t${i}`,
    parts: [{ type: "text", text: `Prompt ${i}`, state: "done" }],
  } as Message,
  {
    id: `a${i}`,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    submissionId: `s${i}`,
    turnId: `t${i}`,
    parts: [{ type: "text", text: answer, state: "done" }],
  } as Message,
];
const history = [...turn(0, "First **answer**"), ...turn(1, "Second answer")];
const settlements = [
  { submissionId: "s0", outcome: "completed" as const },
  { submissionId: "s1", outcome: "completed" as const },
];

// Same contract as @flue/sdk: one published snapshot per stream chunk.
const createObservation = (messages: Message[]) => {
  const listeners = new Set<() => void>();
  let snapshot = {
    conversation: undefined as unknown,
    phase: "loading",
    incarnation: "test",
    error: undefined,
  };
  const publish = (next: Message[]) => {
    snapshot = {
      ...snapshot,
      phase: "live",
      conversation: {
        conversationId: threadId,
        messages: next,
        settlements,
        finalOutputs: [],
      },
    };
    for (const listener of listeners) listener();
  };
  const client = {
    url: thread.agentUrl,
    observe: () => ({
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      start: () => publish(messages),
      stop: () => undefined,
      refresh: () => undefined,
      close: () => listeners.clear(),
      loadOlder: () => Promise.resolve(),
    }),
    send: async () => ({ submissionId: "sent" }),
  } as unknown as FlueClient;
  return { client, publish };
};

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  counts.parses.length = 0;
  counts.changes = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const renderThread = async (messages: Message[]) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const observation = createObservation(messages);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    dictationAvailable: false,
  } as never);
  class TestRegistry extends ThreadSessionRegistry {
    override prepare(...args: Parameters<ThreadSessionRegistry["prepare"]>) {
      return Object.assign(super.prepare(...args), {
        client: observation.client,
        session: createFlueAgentSession({
          client: observation.client,
          live: "sse",
        }),
      });
    }
  }
  const registry = new TestRegistry(queryClient, userId);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThreadSessionRegistryContext value={registry}>
          <AuthContext
            value={{
              identity: { id: userId, name: "Test", email: "t@dx.test" },
              logout: () => undefined,
            }}
          >
            <ThreadSession thread={thread} project={project} />
          </AuthContext>
        </ThreadSessionRegistryContext>
      </QueryClientProvider>,
    );
  });
  mounted.push(() => {
    React.act(() => root.unmount());
    registry.clear();
  });
  return { container, publish: observation.publish };
};

const typeInto = async (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await React.act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("thread page render scope", () => {
  it("re-parses only rows whose content changed in a re-derived model", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => React.act(() => root.unmount()));
    const render = (messages: Message[]) =>
      React.act(() =>
        root.render(
          <ThreadTranscript
            model={deriveTranscriptViewModel({ messages, settlements })}
          />,
        ),
      );
    await render(history);
    expect(counts.parses).toHaveLength(4);

    // A fresh derivation of unchanged history creates new row objects.
    counts.parses.length = 0;
    await render([...history]);
    expect(counts.parses).toEqual([]);

    // A stream chunk replaces only the last message and its last part.
    const last = history[3] as Message;
    const streamed = {
      ...last,
      parts: [{ type: "text", text: "Second answer, more", state: "done" }],
    } as Message;
    await render([...history.slice(0, 3), streamed]);
    expect(counts.parses).toEqual(["Second answer, more"]);
  });

  it("keeps composer typing from re-rendering the transcript or the page", async () => {
    const { container } = await renderThread(history);
    const composer = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    if (composer === null) throw new Error("Expected the composer.");
    expect(container.textContent).toContain("Second answer");
    counts.parses.length = 0;
    const changesRenders = counts.changes;

    await typeInto(composer, "a");
    await typeInto(composer, "ab");
    await typeInto(composer, "abc");

    expect(composer.value).toBe("abc");
    expect(counts.parses).toEqual([]);
    expect(counts.changes).toBe(changesRenders);
  });

  it("renders a stream batch once, re-rendering only the agent panel and changed row", async () => {
    const live = {
      id: "a-live",
      role: "assistant",
      purpose: "assistant",
      display: "visible",
      submissionId: "s-live",
      turnId: "t-live",
      parts: [{ type: "text", text: "Streaming", state: "streaming" }],
    } as Message;
    const prompt = {
      id: "u-live",
      role: "user",
      purpose: "user",
      display: "visible",
      submissionId: "s-live",
      turnId: "t-live",
      parts: [{ type: "text", text: "Go", state: "done" }],
    } as Message;
    const { container, publish } = await renderThread([
      ...history,
      prompt,
      live,
    ]);
    expect(container.textContent).toContain("Streaming");
    counts.parses.length = 0;
    const changesRenders = counts.changes;

    // A network batch: three chunks published in one task render once.
    await React.act(async () => {
      for (const text of ["Streaming m", "Streaming mo", "Streaming more text"])
        publish([
          ...history,
          prompt,
          {
            ...live,
            parts: [{ type: "text", text, state: "streaming" }],
          } as Message,
        ]);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("Streaming more text");
    expect(counts.parses).toEqual(["Streaming more text"]);
    expect(counts.changes).toBe(changesRenders);
  });

  it("parses only the unsettled tail of a long streaming answer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => React.act(() => root.unmount()));
    const settled = "## Plan\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n";
    const render = (text: string, state: "streaming" | "done") =>
      React.act(() =>
        root.render(
          <ThreadTranscript
            model={deriveTranscriptViewModel({
              messages: [
                {
                  id: "a",
                  role: "assistant",
                  purpose: "assistant",
                  display: "visible",
                  turnId: "t",
                  parts: [{ type: "text", text, state }],
                } as Message,
              ],
              settlements: [],
            })}
          />,
        ),
      );
    await render(`${settled}\nTail\nline`, "streaming");
    counts.parses.length = 0;

    await render(`${settled}\nTail\nline grows`, "streaming");
    expect(counts.parses).toEqual(["Tail\nline grows"]);

    // Settled text renders as one document, exactly as before streaming.
    counts.parses.length = 0;
    await render(`${settled}\nTail\nline grows`, "done");
    expect(counts.parses).toEqual([`${settled}\nTail\nline grows`]);
  });
});
