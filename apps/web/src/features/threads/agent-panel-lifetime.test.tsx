// @vitest-environment happy-dom

import type { ThreadAgentInitializationData } from "@dx/api";
import type { UseFlueAgentResult } from "@flue/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("./thread-transcript.js", () => ({
  ThreadTranscript: ({
    model,
    header,
    pinnedContent,
    footer,
    failures,
    showProcessingIndicator,
  }: {
    readonly model: {
      readonly rows: ReadonlyArray<{
        readonly id: string;
        readonly text?: string;
      }>;
    };
    readonly header?: React.ReactNode;
    readonly pinnedContent?: React.ReactNode;
    readonly footer?: React.ReactNode;
    readonly failures?: ReadonlyMap<
      string,
      { readonly message: string; readonly retry: () => void }
    >;
    readonly showProcessingIndicator?: boolean;
  }) => (
    <section aria-label="Thread transcript">
      {header}
      {pinnedContent}
      {model.rows.map((row) => (
        <span key={row.id}>{row.text}</span>
      ))}
      {[...(failures?.values() ?? [])].map((failure) => (
        <button key={failure.message} type="button" onClick={failure.retry}>
          Retry {failure.message}
        </button>
      ))}
      {showProcessingIndicator && model.rows.length > 0 ? (
        <span className="processing-dot" role="status" />
      ) : null}
      {footer}
    </section>
  ),
}));

import { AgentPanel, PendingAgentPanel } from "./agent-panel.js";
import { createPendingImageCollection } from "./image-attachments.js";
import type { OptimisticThreadCreation } from "./thread-session-registry.js";

const agent = {
  error: undefined,
  failedSends: [],
  historyReady: true,
  messages: [],
  settlements: [],
  abort: vi.fn(),
  refresh: vi.fn(),
  retrySend: vi.fn(),
  sendMessage: vi.fn(),
  status: "ready",
} as unknown as UseFlueAgentResult;
const agentInitialization = {
  skills: [],
} as unknown as ThreadAgentInitializationData;
const optimisticCreation = {
  id: "thread-optimistic",
  project: { id: "project-optimistic" },
  title: "Optimistic thread",
  profile: "medium",
  body: "Build the optimistic path",
  images: [],
} as unknown as OptimisticThreadCreation;
const activePrompt = {
  id: "active-user-message",
  role: "user",
  purpose: "user",
  display: "visible",
  turnId: "turn-active",
  submissionId: "submission-active",
  parts: [
    {
      type: "text",
      text: "Continue the work",
      state: "done",
    },
  ],
} as UseFlueAgentResult["messages"][number];

const mountPanel = async (
  agentOverride: Partial<UseFlueAgentResult> = {},
  archived = false,
  workspace: { readonly ready?: boolean; readonly status?: string } = {},
  panelProps: Partial<React.ComponentProps<typeof AgentPanel>> = {},
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentPanel
          agent={{ ...agent, ...agentOverride } as UseFlueAgentResult}
          agentInitialization={agentInitialization}
          archived={archived}
          showArchivedNotice={archived}
          workspaceReady={workspace.ready}
          workspaceStatus={workspace.status}
          {...panelProps}
        />
      </QueryClientProvider>,
    ),
  );
  return { container, root };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("thread composer ownership", () => {
  it("shows the local initial message and locked composer before admission", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(<PendingAgentPanel creation={optimisticCreation} />),
    );

    expect(container.textContent).toContain("Build the optimistic path");
    expect(container.textContent).toContain("Starting thread…");
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')
        ?.disabled,
    ).toBe(true);
    await React.act(() => root.unmount());
  });

  it("keeps one local message until Flue exposes the admission receipt", async () => {
    const observed = vi.fn();
    const pending = await mountPanel(
      {},
      false,
      {},
      {
        optimisticCreation: {
          ...optimisticCreation,
          submissionId: "submission-initial",
        },
        onInitialSubmissionObserved: observed,
      },
    );

    expect(
      pending.container.textContent?.match(/Build the optimistic path/g),
    ).toHaveLength(1);
    await React.act(() => pending.root.unmount());

    const reconciled = await mountPanel(
      {
        messages: [
          {
            id: "initial-user-message",
            role: "user",
            purpose: "user",
            display: "visible",
            turnId: "turn-initial",
            submissionId: "submission-initial",
            parts: [
              {
                type: "text",
                text: "Build the optimistic path",
                state: "done",
              },
            ],
          },
        ],
      },
      false,
      {},
      {
        optimisticCreation: {
          ...optimisticCreation,
          submissionId: "submission-initial",
        },
        onInitialSubmissionObserved: observed,
      },
    );

    expect(
      reconciled.container.textContent?.match(/Build the optimistic path/g),
    ).toHaveLength(1);
    await vi.waitFor(() =>
      expect(observed).toHaveBeenCalledWith("submission-initial"),
    );
    await React.act(() => reconciled.root.unmount());
  });

  it("renders the initial prompt from Flue history without browser-owned state", async () => {
    const mounted = await mountPanel({
      messages: [
        {
          id: "initial-user-message",
          role: "user",
          purpose: "user",
          display: "visible",
          turnId: "turn-initial",
          submissionId: "submission-initial",
          parts: [
            {
              type: "text",
              text: "Build the durable handoff",
              state: "done",
            },
          ],
        },
      ],
    });

    expect(mounted.container.textContent).toContain(
      "Build the durable handoff",
    );
    expect(mounted.container.textContent).not.toContain(
      "What should we work on?",
    );
    await React.act(() => mounted.root.unmount());
  });

  it("replaces the turn dot with workspace progress while a cold prompt is running", async () => {
    const mounted = await mountPanel(
      { status: "submitted", messages: [activePrompt] },
      false,
      { ready: false },
    );

    expect(mounted.container.textContent).toContain("Preparing workspace…");
    expect(mounted.container.querySelectorAll('[role="status"]')).toHaveLength(
      1,
    );
    await React.act(() => mounted.root.unmount());
  });

  it("shows only the turn dot for a follow-up when workspace temperature is unknown", async () => {
    const mounted = await mountPanel(
      { status: "submitted", messages: [activePrompt] },
      false,
      { ready: true },
    );

    expect(mounted.container.textContent).not.toContain(
      "Connecting to the Orb",
    );
    expect(mounted.container.querySelectorAll('[role="status"]')).toHaveLength(
      1,
    );
    await React.act(() => mounted.root.unmount());
  });

  it("replaces the turn dot with the Orb wake status for a cold follow-up", async () => {
    const mounted = await mountPanel(
      { status: "submitted", messages: [activePrompt] },
      false,
      { ready: true, status: "Waking up the Orb…" },
    );

    expect(mounted.container.textContent).toContain("Waking up the Orb…");
    expect(mounted.container.querySelectorAll('[role="status"]')).toHaveLength(
      1,
    );
    await React.act(() => mounted.root.unmount());
  });

  it("keeps an API-created blank Thread ready for its first message", async () => {
    const mounted = await mountPanel();

    expect(mounted.container.textContent).toContain("What should we work on?");
    expect(
      mounted.container.querySelector('[aria-label="Send message"]'),
    ).not.toBeNull();
    await React.act(() => mounted.root.unmount());
  });

  it("unlocks after admission for one steering prompt while the agent streams", async () => {
    let acceptFirst: (() => void) | undefined;
    const firstReceipt = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(firstReceipt)
      .mockResolvedValue(undefined);
    const mounted = await mountPanel({ status: "streaming", sendMessage });
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    );
    const form = mounted.container.querySelector("form");
    if (textarea === null || form === null)
      throw new Error("Expected thread composer form.");

    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "First prompt awaiting admission");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "First prompt awaiting admission",
      { images: [] },
    );
    expect(textarea.disabled).toBe(true);
    expect(
      mounted.container.querySelector<HTMLButtonElement>(
        '[aria-label="Send steering message"]',
      )?.disabled,
    ).toBe(true);
    expect(
      mounted.container.querySelector('[aria-label="Stop agent"]'),
    ).not.toBeNull();

    await React.act(async () => {
      acceptFirst?.();
      await firstReceipt;
    });
    await vi.waitFor(() => expect(textarea.disabled).toBe(false));

    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "Steer at the next tool boundary");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "Steer at the next tool boundary",
      { images: [] },
    );
    expect(
      mounted.container.querySelector('[aria-label="Stop agent"]'),
    ).not.toBeNull();
    await React.act(() => mounted.root.unmount());
  });

  it("reissues Stop after a delayed prompt is admitted", async () => {
    let accept: (() => void) | undefined;
    const receipt = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const abort = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockReturnValue(receipt);
    const mounted = await mountPanel({
      status: "streaming",
      abort,
      sendMessage,
    });
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    );
    const form = mounted.container.querySelector("form");
    if (textarea === null || form === null)
      throw new Error("Expected thread composer form.");

    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "Delayed steering prompt");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    const stop = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop agent"]',
    );
    if (stop === null) throw new Error("Expected Stop agent button.");
    await React.act(async () => {
      stop.click();
      await Promise.resolve();
    });

    expect(abort).toHaveBeenCalledOnce();
    await React.act(async () => {
      accept?.();
      await receipt;
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(textarea.disabled).toBe(false));
    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "Steer after Stop");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "Steer after Stop", {
      images: [],
    });
    await React.act(() => mounted.root.unmount());
  });

  it("retains the admission lock across a composer remount", async () => {
    let accept: (() => void) | undefined;
    const receipt = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const sendMessage = vi.fn().mockReturnValue(receipt);
    let retainedPending = false;
    const setRetainedPending = vi.fn((pending: boolean) => {
      retainedPending = pending;
    });
    const submissionControl = { stopRequested: false };
    const mount = () =>
      mountPanel(
        { status: "submitted", sendMessage },
        false,
        {},
        {
          submissionPending: retainedPending,
          submissionControl,
          onSubmissionPendingChange: setRetainedPending,
        },
      );
    const first = await mount();
    const firstTextarea = first.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    );
    const firstForm = first.container.querySelector("form");
    if (firstTextarea === null || firstForm === null)
      throw new Error("Expected first thread composer form.");

    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(firstTextarea, "Admission still pending");
      firstTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      firstForm.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(retainedPending).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    await React.act(() => first.root.unmount());

    const replacement = await mount();
    const replacementTextarea =
      replacement.container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message"]',
      );
    const replacementForm = replacement.container.querySelector("form");
    if (replacementTextarea === null || replacementForm === null)
      throw new Error("Expected replacement thread composer form.");
    expect(replacementTextarea.disabled).toBe(true);
    await React.act(async () => {
      replacementForm.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    const stop = replacement.container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop agent"]',
    );
    if (stop === null) throw new Error("Expected replacement Stop button.");
    await React.act(async () => {
      stop.click();
      await Promise.resolve();
    });
    expect(agent.abort).toHaveBeenCalledOnce();

    await React.act(async () => {
      accept?.();
      await receipt;
    });
    await vi.waitFor(() => expect(agent.abort).toHaveBeenCalledTimes(2));
    expect(retainedPending).toBe(false);
    await React.act(() => replacement.root.unmount());
  });

  it("unlocks after failed steering admission without re-sending it", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error("Steering admission failed"));
    const mounted = await mountPanel({ status: "streaming", sendMessage });
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    );
    const form = mounted.container.querySelector("form");
    if (textarea === null || form === null)
      throw new Error("Expected thread composer form.");

    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "Failed steering prompt");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(mounted.container.textContent).toContain(
        "Steering admission failed",
      ),
    );
    expect(textarea.disabled).toBe(false);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Failed steering prompt",
      { images: [] },
    );
    expect(
      mounted.container.querySelector('[aria-label="Stop agent"]'),
    ).not.toBeNull();
    await React.act(() => mounted.root.unmount());
  });

  it("keeps archived history visible without mounting message controls", async () => {
    const mounted = await mountPanel({}, true);

    expect(
      mounted.container.querySelector('[aria-label="Thread transcript"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector("form")).toBeNull();
    expect(mounted.container.querySelector("textarea")).toBeNull();
    expect(
      mounted.container.querySelector('[aria-label="Send message"]'),
    ).toBeNull();
    expect(mounted.container.querySelector('[role="note"]')?.textContent).toBe(
      "Archived. Unarchive to resume or run commands.",
    );
    await React.act(() => mounted.root.unmount());
  });

  it("keeps sensitive drafts mount-scoped and resets them on remount", async () => {
    const first = await mountPanel();
    const textarea = first.container.querySelector("textarea");
    if (textarea === null) throw new Error("Expected thread composer.");

    await React.act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "private draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("private draft");

    await React.act(() => first.root.unmount());
    first.container.remove();
    const second = await mountPanel();
    expect(second.container.querySelector("textarea")?.value).toBe("");
    await React.act(() => second.root.unmount());
  });

  it("does not send after Stop is clicked during attachment processing", async () => {
    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const file = new File([], "slow.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockReturnValue(read);
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:stopped-submission-preview",
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await mountPanel();
    const textarea = mounted.container.querySelector("textarea");
    const input =
      mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
    const form = mounted.container.querySelector("form");
    if (textarea === null || input === null || form === null)
      throw new Error("Expected composer controls.");

    await React.act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "do not send");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await React.act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    const stop = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop agent"]',
    );
    if (stop === null) throw new Error("Expected Stop agent button.");
    await React.act(async () => {
      stop.click();
      await Promise.resolve();
    });
    await React.act(async () => {
      resolveRead?.(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
      );
      await read;
    });
    await vi.waitFor(async () => {
      await React.act(() => Promise.resolve());
      expect(
        mounted.container.querySelector('button[aria-label="Send message"]'),
      ).not.toBeNull();
      expect(
        mounted.container.querySelector('button[aria-label="Remove slow.png"]'),
      ).not.toBeNull();
    });

    expect(agent.abort).toHaveBeenCalledOnce();
    expect(agent.sendMessage).not.toHaveBeenCalled();
    await React.act(() => mounted.root.unmount());
    await vi.waitFor(() =>
      expect(revoke).toHaveBeenCalledExactlyOnceWith(
        "blob:stopped-submission-preview",
      ),
    );
  });

  it("disposes previews created by attachment work that settles after unmount", async () => {
    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const file = new File([], "slow.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockReturnValue(read);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:slow-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await mountPanel();
    const input =
      mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("Expected attachment input.");
    await React.act(() => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await React.act(() => mounted.root.unmount());
    resolveRead?.(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    );
    await read;
    await vi.waitFor(() =>
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:slow-preview"),
    );
  });

  it("disposes submitted previews when a send fails after unmount", async () => {
    let rejectSend: ((cause: Error) => void) | undefined;
    const send = new Promise<never>((_resolve, reject) => {
      rejectSend = reject;
    });
    vi.mocked(agent.sendMessage).mockReturnValue(send);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:submitted-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await mountPanel();
    const input =
      mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
    const form = mounted.container.querySelector("form");
    if (input === null || form === null)
      throw new Error("Expected composer controls.");
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "submitted.png",
      { type: "image/png" },
    );
    await React.act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        mounted.container.querySelector(
          'button[aria-label="Remove submitted.png"]',
        ),
      ).not.toBeNull(),
    );
    await React.act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    await React.act(() => mounted.root.unmount());
    rejectSend?.(new Error("send failed"));
    await vi.waitFor(() =>
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:submitted-preview"),
    );
  });

  it("releases retained submission images when Flue keeps a failed candidate", async () => {
    let rejectSend: ((cause: Error) => void) | undefined;
    vi.mocked(agent.sendMessage).mockReturnValue(
      new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retained-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const imageCollection = createPendingImageCollection();
    const restore = vi.spyOn(imageCollection, "restore");
    const onDraftChange = vi.fn();
    let retainedImages: ReturnType<typeof imageCollection.take> | undefined;
    const submissionImageRetention = {
      retain: (images: ReturnType<typeof imageCollection.take>) => {
        if (retainedImages !== undefined) return false;
        retainedImages = images;
        return true;
      },
      complete: (images: ReturnType<typeof imageCollection.take>) => {
        if (retainedImages !== images) return false;
        retainedImages = undefined;
        return true;
      },
      restore: (
        images: ReturnType<typeof imageCollection.take>,
        draft: string,
      ) => {
        if (retainedImages !== images) return false;
        retainedImages = undefined;
        onDraftChange(draft);
        imageCollection.restore(images);
        return true;
      },
    };
    const mounted = await mountPanel(
      {},
      false,
      {},
      {
        draft: "Retry with this image",
        onDraftChange,
        imageCollection,
        submissionImageRetention,
      },
    );
    const input =
      mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
    const form = mounted.container.querySelector("form");
    if (input === null || form === null)
      throw new Error("Expected composer controls.");
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "retained.png",
      { type: "image/png" },
    );
    await React.act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await React.act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    await React.act(() => mounted.root.unmount());
    rejectSend?.(new Error("send failed"));
    await vi.waitFor(() => {
      expect(retainedImages).toBeUndefined();
      expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("");
      expect(restore).not.toHaveBeenCalled();
    });
    imageCollection.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retained-preview");
  });

  it("renders an optimistic Flue message during submission", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let reconcile: (() => void) | undefined;
    const candidate = {
      id: "local:1",
      role: "user",
      purpose: "user",
      display: "visible",
      turnId: "turn:1",
      submissionId: "submission:1",
      parts: [{ type: "text", text: "Start the migration", state: "done" }],
    };
    const canonical = { ...candidate, id: "canonical:1" };

    function Harness() {
      const [messages, setMessages] = React.useState<
        ReadonlyArray<typeof candidate>
      >([]);
      reconcile = () => setMessages([canonical]);
      const optimisticAgent = {
        ...agent,
        messages,
        sendMessage: () => {
          setMessages([candidate]);
          return new Promise<void>(() => {});
        },
      } as unknown as UseFlueAgentResult;
      return (
        <AgentPanel
          agent={optimisticAgent}
          agentInitialization={agentInitialization}
        />
      );
    }

    const queryClient = new QueryClient();
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form");
    if (textarea === null || form === null)
      throw new Error("Expected thread composer form.");
    await React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "Start the migration");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Start the migration");
    await React.act(() => reconcile?.());
    await React.act(() => Promise.resolve());
    expect(container.textContent?.match(/Start the migration/g)).toHaveLength(
      1,
    );
    await React.act(() => root.unmount());
  });

  it("keeps a failed Flue candidate visible and retries its retained identity", async () => {
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const panel = await mountPanel({
      messages: [
        {
          id: "local:failed-message",
          role: "user",
          purpose: "user",
          display: "visible",
          turnId: "turn:failed",
          parts: [
            {
              type: "text",
              text: "Reconnect the workspace",
              state: "done",
            },
          ],
        },
      ],
      failedSends: [
        {
          id: "local:failed-message",
          message: "Reconnect the workspace",
          error: new Error("send failed"),
          retry: "transport",
        },
      ],
      retrySend,
    });
    const retry = panel.container.querySelector<HTMLButtonElement>("button");
    if (retry === null) throw new Error("Expected failed-send retry.");

    await React.act(() => retry.click());

    expect(retrySend).toHaveBeenCalledExactlyOnceWith("local:failed-message");
    await React.act(() => panel.root.unmount());
  });
});
