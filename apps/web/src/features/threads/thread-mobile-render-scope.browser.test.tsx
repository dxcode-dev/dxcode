// Render-scope regressions for the phone thread layout: a streamed frame must
// not re-render the tool tabs, and a transcript hidden behind another tool
// must keep its turns, so showing it again re-parses only what changed.
//
// The real virtualizer runs against a fake layout: an element inside a
// `hidden` ancestor has no size, as in a browser, and the fake
// ResizeObserver reports size changes when `relayout` runs.

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

const counts = vi.hoisted(() => ({ parses: [] as string[], tabs: 0 }));

vi.mock("react-markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-markdown")>()),
  default: ({ children }: { children: string }) => {
    counts.parses.push(children);
    return <div data-markdown="">{children}</div>;
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (l: { href: string }) => string }) =>
    select({ href: "/threads/thread-1" }),
  useNavigate: () => () => undefined,
  useParams: () => ({ threadId: "thread-1" }),
}));
vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => true,
}));
vi.mock("./changes/changes-pane.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./changes/changes-pane.js")>()),
  ChangesPane: () => <div data-testid="changes-pane" />,
}));
vi.mock("./thread-mobile-layout.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./thread-mobile-layout.js")>();
  return {
    ...actual,
    MobileThreadTabs: (
      props: React.ComponentProps<typeof actual.MobileThreadTabs>,
    ) => {
      counts.tabs += 1;
      return <actual.MobileThreadTabs {...props} />;
    },
  };
});

import { AuthContext } from "../../shared/auth/auth-context.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";
import { ThreadSessionRegistry } from "./thread-session-registry.js";
import { ThreadTranscript } from "./thread-transcript.js";
import { ThreadSession } from "./thread-workspace.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";

// --- Fake layout: a 400×600 viewport, 100 px turns, nothing when hidden.
const sizeOf = (element: Element) => {
  if (element.closest("[hidden]") !== null) return { width: 0, height: 0 };
  if (element.classList.contains("transcript-viewport"))
    return { width: 400, height: 600 };
  return { width: 400, height: 100 };
};
const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  readonly #callback: ResizeObserverCallback;
  readonly #observed = new Map<Element, string>();
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    observers.add(this);
  }
  observe(element: Element) {
    this.#observed.set(element, "");
    this.notify();
  }
  unobserve(element: Element) {
    this.#observed.delete(element);
  }
  disconnect() {
    this.#observed.clear();
    observers.delete(this);
  }
  /** Reports the observed elements whose size changed, as a browser does. */
  notify() {
    const entries: ResizeObserverEntry[] = [];
    for (const [element, reported] of this.#observed) {
      const size = sizeOf(element);
      const key = `${size.width}x${size.height}`;
      if (key === reported) continue;
      this.#observed.set(element, key);
      const box = [{ inlineSize: size.width, blockSize: size.height }];
      entries.push({
        target: element,
        borderBoxSize: box,
        contentBoxSize: box,
        devicePixelContentBoxSize: box,
        contentRect: DOMRectReadOnly.fromRect(size),
      } as unknown as ResizeObserverEntry);
    }
    if (entries.length > 0)
      this.#callback(entries, this as unknown as ResizeObserver);
  }
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: FakeResizeObserver,
});
for (const property of ["offsetWidth", "offsetHeight"] as const)
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get(this: HTMLElement) {
      const size = sizeOf(this);
      return property === "offsetWidth" ? size.width : size.height;
    },
  });
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  return DOMRect.fromRect(sizeOf(this));
};
/** The browser lays out the page and delivers resize observations. */
const relayout = () =>
  React.act(async () => {
    for (const observer of [...observers]) observer.notify();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

type Message = FlueConversationMessage;
const userId = "usr_mobile_scope" as UserId;
const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;
const thread = {
  id: threadId,
  title: "Phone render scope",
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
const history = [0, 1, 2, 3].flatMap((i) => turn(i, `Answer ${i}`));
const settlements = [0, 1, 2, 3].map((i) => ({
  submissionId: `s${i}`,
  outcome: "completed" as const,
}));
const prompt = {
  id: "u-live",
  role: "user",
  purpose: "user",
  display: "visible",
  submissionId: "s-live",
  turnId: "t-live",
  parts: [{ type: "text", text: "Go", state: "done" }],
} as Message;
const streaming = (text: string) =>
  [
    ...history,
    prompt,
    {
      id: "a-live",
      role: "assistant",
      purpose: "assistant",
      display: "visible",
      submissionId: "s-live",
      turnId: "t-live",
      parts: [{ type: "text", text, state: "streaming" }],
    } as Message,
  ] satisfies Message[];

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
  counts.tabs = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const renderPhoneThread = async (messages: Message[]) => {
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
  await relayout();
  return { container, publish: observation.publish };
};

describe("phone thread render scope", () => {
  it("renders streamed frames without re-rendering the tool tabs", async () => {
    const { container, publish } = await renderPhoneThread(
      streaming("Streaming"),
    );
    expect(container.querySelector(".thread-mobile-tabs")).not.toBeNull();
    expect(container.textContent).toContain("Streaming");
    const tabRenders = counts.tabs;
    counts.parses.length = 0;

    for (const text of ["Streaming m", "Streaming more", "Streaming more text"])
      await React.act(async () => {
        publish(streaming(text));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

    expect(container.textContent).toContain("Streaming more text");
    expect(counts.parses).toEqual([
      "Streaming m",
      "Streaming more",
      "Streaming more text",
    ]);
    expect(counts.tabs).toBe(tabRenders);
  });

  it("keeps a hidden transcript's turns, so showing it parses only what streamed meanwhile", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => React.act(() => root.unmount()));
    // The agent pane as a phone tab: hidden while another tool shows.
    const render = (messages: Message[], active: boolean) =>
      React.act(() =>
        root.render(
          <section hidden={!active}>
            <ThreadTranscript
              active={active}
              model={deriveTranscriptViewModel({ messages, settlements })}
            />
          </section>,
        ),
      );
    await render(streaming("Streaming"), true);
    await relayout();
    expect(counts.parses).toContain("Answer 0");
    expect(counts.parses).toContain("Streaming");

    counts.parses.length = 0;
    await render(streaming("Streaming"), false);
    await relayout();
    await render(streaming("Streaming while the Terminal shows"), false);
    await relayout();
    expect(counts.parses).toEqual([]);

    await render(streaming("Streaming while the Terminal shows"), true);
    await relayout();
    expect(container.textContent).toContain("Answer 0");
    expect(container.textContent).toContain(
      "Streaming while the Terminal shows",
    );
    expect(counts.parses).toEqual(["Streaming while the Terminal shows"]);
  });
});
