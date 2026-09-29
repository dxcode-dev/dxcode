// @vitest-environment happy-dom
import type {
  ProjectData,
  ThreadAgentInitializationData,
  ThreadDetailData,
} from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const network = vi.hoisted(() => ({
  blocked: false,
  reads: 0,
  active: 0,
  maximum: 0,
  disposed: 0,
  imageDisposals: 0,
  absent: new Map<string, () => void>(),
  send: vi.fn(),
}));
vi.mock("@flue/sdk", () => ({
  FlueApiError: class FlueApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown,
    ) {
      super();
    }
  },
  createFlueClient: ({ url }: { url: string }) => ({
    url,
    send: network.send,
  }),
}));
vi.mock("@flue/react", () => ({
  createFlueAgentSession: ({ client }: { client: { url: string } }) => {
    let active = false;
    let disposed = false;
    let snapshot = {
      historyReady: false,
      status: "idle",
      messages: [] as string[],
      error: undefined,
    };
    const listeners = new Set<() => void>();
    network.absent.set(client.url, () => {
      snapshot = {
        ...snapshot,
        historyReady: true,
        status: "idle",
        messages: [],
      };
      for (const listener of listeners) listener();
    });
    const stop = () => {
      if (active) network.active--;
      active = false;
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: () => {
        if (active || disposed) return;
        active = true;
        network.active++;
        network.maximum = Math.max(network.maximum, network.active);
        if (!snapshot.historyReady) {
          network.reads++;
          if (!network.blocked)
            snapshot = {
              ...snapshot,
              historyReady: true,
              status: "ready",
              messages: [client.url],
            };
        }
        for (const listener of listeners) listener();
      },
      stop,
      dispose: () => {
        stop();
        disposed = true;
        network.disposed++;
      },
    };
  },
  useFlueAgentSession: (session: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => unknown;
  }) => React.useSyncExternalStore(session.subscribe, session.getSnapshot),
}));
vi.mock("../../shared/use-mobile.js", () => ({ useMobile: () => false }));
vi.mock("./agent-panel.js", () => ({
  AgentPanel: ({
    agent,
    imageCollection,
    images = [],
    onImagesChange,
  }: {
    agent: { messages: string[] };
    imageCollection?: {
      addImage: (image: unknown) => ReadonlyArray<{ filename: string }>;
    };
    images?: ReadonlyArray<{ filename: string }>;
    onImagesChange?: (images: ReadonlyArray<{ filename: string }>) => void;
  }) => (
    <section>
      {agent.messages[0] ?? "Loading conversation…"}
      {images.map((image) => (
        <span key={image.filename}>{image.filename}</span>
      ))}
      {imageCollection === undefined || onImagesChange === undefined ? null : (
        <button
          type="button"
          aria-label="Attach image"
          onClick={() =>
            onImagesChange(
              imageCollection.addImage({
                id: "pending-image",
                type: "image",
                data: "aGVsbG8=",
                mimeType: "image/png",
                filename: "pending.png",
                previewUrl: "blob:pending-image",
                disposePreview: () => network.imageDisposals++,
              }),
            )
          }
        />
      )}
    </section>
  ),
}));

import { FlueApiError } from "@flue/sdk";
import { ApiError } from "../../shared/api/client.js";
import { AuthContext, useIdentity } from "../../shared/auth/auth-context.js";
import { projectKeys } from "../projects/project-queries.js";
import type { PendingImage } from "./image-attachments.js";
import { threadKeys } from "./thread-queries.js";
import {
  ThreadPresentationContext,
  ThreadSessionRegistryContext,
} from "./thread-session-context.js";
import { ThreadSessionProvider } from "./thread-session-provider.js";
import {
  createThreadAgentClient,
  retainSubmissionImages,
  ThreadSessionRegistry,
} from "./thread-session-registry.js";
import { ThreadSession } from "./thread-workspace.js";
import { useThreadPresentation } from "./use-thread-presentation.js";

afterEach(() => {
  Object.assign(network, {
    blocked: false,
    reads: 0,
    active: 0,
    maximum: 0,
    disposed: 0,
    imageDisposals: 0,
  });
  vi.useRealTimers();
  network.absent.clear();
  network.send.mockReset();
});
const userId = "user" as UserId;
const projectId = "project" as ProjectId;
const authenticated = (children: React.ReactNode, queryClient: QueryClient) => (
  <QueryClientProvider client={queryClient}>
    <AuthContext
      value={{
        identity: {
          id: userId,
          name: "Fixture",
          email: "fixture@example.test",
        },
        logout: () => {},
      }}
    >
      {children}
    </AuthContext>
  </QueryClientProvider>
);

it("initializes the first Flue candidate with its stable delivery identity", async () => {
  const initialData = {
    skills: [],
  } as unknown as ThreadAgentInitializationData;
  network.send
    .mockRejectedValueOnce(
      new FlueApiError(409, {
        error: { type: "agent_instance_exists", meta: { uid: "agent-1" } },
      }),
    )
    .mockResolvedValueOnce({ submissionId: "submission-1" })
    .mockResolvedValueOnce({ submissionId: "submission-2" });
  const client = createThreadAgentClient("agent-url", initialData);
  const message = { kind: "user" as const, body: "Start locally" };

  await client.send({ idempotencyKey: "first-input", message });
  await client.send({ idempotencyKey: "next-input", message });

  expect(network.send).toHaveBeenCalledTimes(3);
  expect(network.send.mock.calls[0]?.[0]).toMatchObject({
    uid: null,
    initialData,
    idempotencyKey: "first-input",
    message,
  });
  expect(network.send.mock.calls[1]?.[0]).toMatchObject({
    uid: "agent-1",
    idempotencyKey: "first-input",
    message,
  });
  expect(network.send.mock.calls[1]?.[0]).not.toHaveProperty("initialData");
  expect(network.send.mock.calls[2]?.[0]).toEqual({
    idempotencyKey: "next-input",
    message,
  });
});

it("keeps authoritative empty history distinct from Thread access revocation", () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const cold = registry.prepare("cold" as ThreadId, projectId, "cold");
  network.absent.get("cold")?.();
  registry.activate(cold);
  expect(cold.disposed).toBe(false);
  const known = registry.prepare("known" as ThreadId, projectId, "known");
  registry.activate(known);
  known.presentation.set("draft", "sensitive");
  network.absent.get("known")?.();
  expect(known.disposed).toBe(false);
  expect(known.session.getSnapshot().messages).toEqual([]);
  expect(known.presentation.get("draft")).toBe("sensitive");
  registry.clear();
});

it("hands a failed create's exact draft metadata and attachments back once", () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const disposePreview = vi.fn();
  const image = {
    id: "pending-image",
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
    filename: "pending.png",
    previewUrl: "blob:pending-image",
    disposePreview,
  } as PendingImage;
  const creation = {
    id: "pending" as ThreadId,
    project: { id: projectId } as ProjectData,
    title: "Pending Thread" as ThreadDetailData["title"],
    profile: "high" as const,
    body: "Restore this exact draft",
    images: [image],
  };

  registry.beginCreation(creation);
  const failed = registry.failCreation(creation.id);
  if (failed === undefined) throw new Error("Expected pending creation.");
  registry.retainFailedCreation({
    ...failed,
    error: "Creation failed exactly",
  });

  expect(registry.claimFailedCreation()).toEqual({
    ...creation,
    error: "Creation failed exactly",
  });
  expect(registry.claimFailedCreation()).toBeUndefined();
  expect(disposePreview).not.toHaveBeenCalled();
  image.disposePreview();
  registry.clear();
});

it("renders retained A immediately after A-B-A with history network blocked", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const render = (id: string) =>
    React.act(() =>
      root.render(
        <React.StrictMode>
          {authenticated(
            <ThreadSessionProvider userId={userId} queryClient={queryClient}>
              <ThreadSession
                key={id}
                thread={
                  {
                    id,
                    projectId,
                    agentUrl: id,
                    lifecycleState: "archived",
                    executionWorkspace: { ready: false },
                  } as ThreadDetailData
                }
                project={{} as ProjectData}
              />
            </ThreadSessionProvider>,
            queryClient,
          )}
        </React.StrictMode>,
      ),
    );
  try {
    await render("A");
    expect(container.textContent).toContain("A");
    await render("B");
    network.blocked = true;
    await render("A");
    expect(container.textContent).toContain("A");
    expect(container.textContent).not.toContain("Loading conversation");
    expect(network.reads).toBe(2);
    expect(network.maximum).toBe(1);
  } finally {
    await React.act(() => root.unmount());
  }
  expect(network.active).toBe(0);
  expect(network.disposed).toBe(2);
});

it("keeps pending composer images across an A-B-A switch", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const render = (id: string) =>
    React.act(() =>
      root.render(
        authenticated(
          <ThreadSessionProvider userId={userId} queryClient={queryClient}>
            <ThreadSession
              key={id}
              thread={
                {
                  id,
                  projectId,
                  agentUrl: id,
                  lifecycleState: "active",
                  executionWorkspace: { ready: false },
                } as ThreadDetailData
              }
              project={{} as ProjectData}
            />
          </ThreadSessionProvider>,
          queryClient,
        ),
      ),
    );
  try {
    await render("A");
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Attach image"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(container.textContent).toContain("pending.png");
    await render("B");
    expect(container.textContent).not.toContain("pending.png");
    expect(network.imageDisposals).toBe(0);
    await render("A");
    expect(container.textContent).toContain("pending.png");
    expect(network.imageDisposals).toBe(0);
  } finally {
    await React.act(() => root.unmount());
  }
  expect(network.imageDisposals).toBe(1);
});

it("evicts the least recently selected ninth entry, never a prepared render", () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const prepare = (id: string) =>
    registry.prepare(id as ThreadId, projectId, id);
  const a = prepare("A");
  registry.activate(a);
  const b = prepare("B");
  registry.activate(b);
  registry.activate(a);
  for (const id of ["C", "D", "E", "F", "G", "H"])
    registry.activate(prepare(id));
  prepare("abandoned");
  expect(b.disposed).toBe(false);
  registry.activate(prepare("I"));
  expect(b.disposed).toBe(true);
  expect(a.disposed).toBe(false);
  expect(prepare("A")).toBe(a);
  expect(prepare("B")).not.toBe(b);
  expect(network.maximum).toBe(1);
  registry.clear();
  expect(network.active).toBe(0);
});

it("ignores late activation cleanup and retains metadata beyond five minutes without requests", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const registry = new ThreadSessionRegistry(client, userId);
  const id = "A" as ThreadId;
  client.setQueryData(threadKeys.detail(userId, id), {
    executionWorkspace: { ready: false },
  });
  client.setQueryData(projectKeys.detail(userId, projectId), {
    name: "retained",
  });
  const entry = registry.prepare(id, projectId, "A");
  const oldCleanup = registry.activate(entry);
  const currentCleanup = registry.activate(entry);
  oldCleanup();
  expect(network.active).toBe(1);
  currentCleanup();
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(client.getQueryData(threadKeys.detail(userId, id))).toBeDefined();
  expect(
    client.getQueryData(projectKeys.detail(userId, projectId)),
  ).toBeDefined();
  expect(network.reads).toBe(1);
  registry.clear();
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(client.getQueryData(threadKeys.detail(userId, id))).toBeUndefined();
});

it.each([401, 403, 404])(
  "removes active and inactive retained content on confirmed metadata %s",
  async (status) => {
    const client = new QueryClient();
    const registry = new ThreadSessionRegistry(client, userId);
    const container = document.createElement("div");
    const root = createRoot(container);
    const a = registry.prepare("A" as ThreadId, projectId, "A");
    registry.activate(a);
    const b = registry.prepare("B" as ThreadId, projectId, "B");
    registry.activate(b);
    await React.act(() =>
      root.render(
        authenticated(
          <ThreadSessionRegistryContext value={registry}>
            <ThreadSession
              thread={
                {
                  id: "A" as ThreadId,
                  projectId,
                  agentUrl: "A",
                  lifecycleState: "archived",
                  executionWorkspace: { ready: false },
                } as unknown as ThreadDetailData
              }
              project={{} as ProjectData}
            />
          </ThreadSessionRegistryContext>,
          client,
        ),
      ),
    );
    expect(container.textContent).toBe("A");
    for (const entry of [b, a]) {
      await React.act(async () => {
        await client
          .fetchQuery({
            queryKey: threadKeys.detail(userId, entry.id),
            retry: false,
            queryFn: () =>
              Promise.reject(new ApiError(status, "Access removed")),
          })
          .catch(() => {});
      });
      expect(entry.disposed).toBe(true);
      expect(entry.presentation.size).toBe(0);
      expect(entry.presentationListeners.size).toBe(0);
    }
    expect(container.textContent).toBe("Thread unavailable");
    await React.act(() => root.unmount());
    registry.clear();
  },
);

it("retains dictation per Thread and clears it with the owning session", () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const a = registry.prepare("A" as ThreadId, projectId, "A");
  const b = registry.prepare("B" as ThreadId, projectId, "B");
  registry.activate(a);
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  a.dictation.retain(audio, "insert", "Retry this recording.");
  registry.activate(b);

  expect(
    registry.prepare("A" as ThreadId, projectId, "A").dictation.getSnapshot(),
  ).toMatchObject({
    state: "retained",
    audio,
  });
  expect(b.dictation.getSnapshot()).toEqual({ state: "empty" });

  registry.remove(a.id);
  expect(a.dictation.getSnapshot()).toEqual({ state: "empty" });
  registry.clear();
});

it("keeps image URLs on switches and releases them on eviction and clear", async () => {
  const client = new QueryClient();
  const registry = new ThreadSessionRegistry(client, userId);
  const preview = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:retained-image");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const a = registry.prepare("A" as ThreadId, projectId, "A");
  registry.activate(a);
  await a.images.addFiles([
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "image.png",
      { type: "image/png" },
    ),
  ]);
  for (const id of ["B", "C", "D", "E", "F", "G", "H"])
    registry.activate(registry.prepare(id as ThreadId, projectId, id));
  expect(revoke).not.toHaveBeenCalled();
  registry.activate(registry.prepare("I" as ThreadId, projectId, "I"));
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retained-image");
  registry.clear();
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledOnce();
  preview.mockRestore();
  revoke.mockRestore();
});

it("releases an in-flight image exactly once when its retained entry is cleared", async () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:in-flight-image");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const entry = registry.prepare("A" as ThreadId, projectId, "A");
  registry.activate(entry);
  await entry.images.addFiles([
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "in-flight.png",
      { type: "image/png" },
    ),
  ]);
  entry.pendingSubmissionImages = entry.images.take();

  registry.clear();
  await entry.images.settle();

  expect(entry.pendingSubmissionImages).toBeUndefined();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:in-flight-image");
});

it("keeps newer composer state when an older retained send fails", () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const entry = registry.prepare("A" as ThreadId, projectId, "A");
  registry.activate(entry);
  const disposeOld = vi.fn();
  const oldImages = [
    {
      id: "old",
      type: "image",
      data: "old-data",
      mimeType: "image/png",
      filename: "old.png",
      previewUrl: "blob:old",
      disposePreview: disposeOld,
    } satisfies PendingImage,
  ];
  const disposeNew = vi.fn();
  const newerImages = [
    {
      id: "newer",
      type: "image",
      data: "newer-data",
      mimeType: "image/png",
      filename: "newer.png",
      previewUrl: "blob:newer",
      disposePreview: disposeNew,
    } satisfies PendingImage,
  ];
  const setPending = (pending: boolean) =>
    entry.presentation.set("submission-pending", pending);
  const retention = retainSubmissionImages(entry, setPending);
  expect(retention.retain(oldImages)).toBe(true);
  entry.images.addImage(newerImages[0]);
  entry.presentation.set("draft", "newer draft");
  entry.presentation.set("pending-images", newerImages);

  expect(retention.restore(oldImages, "older failed draft")).toBe(true);

  expect(entry.presentation.get("draft")).toBe("newer draft");
  expect(entry.presentation.get("pending-images")).toBe(newerImages);
  expect(entry.presentation.get("submission-pending")).toBe(false);
  expect(disposeOld).toHaveBeenCalledOnce();
  registry.clear();
  expect(disposeNew).toHaveBeenCalledOnce();
});

it("delivers late presentation receipts to the replacement mount and ignores them after eviction", async () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const entry = registry.prepare("A" as ThreadId, projectId, "A");
  registry.activate(entry);
  let receipt: (value: string) => void = () => {};
  function Composer() {
    const [value, setValue] = useThreadPresentation("draft", "initial draft");
    receipt = setValue;
    return <span>{value}</span>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (key: number) =>
    React.act(() =>
      root.render(
        <ThreadPresentationContext value={entry}>
          <Composer key={key} />
        </ThreadPresentationContext>,
      ),
    );
  await render(1);
  const oldReceipt = receipt;
  await render(2);
  await React.act(() => oldReceipt("restored after failed send"));
  expect(container.textContent).toBe("restored after failed send");
  await React.act(() => registry.clear());
  await React.act(() => oldReceipt("must not resurrect"));
  expect(entry.presentation.size).toBe(0);
  expect(entry.presentationListeners.size).toBe(0);
  await React.act(() => root.unmount());
});

it("keeps composer drafts isolated across warm Thread navigation", async () => {
  const registry = new ThreadSessionRegistry(new QueryClient(), userId);
  const a = registry.prepare("A" as ThreadId, projectId, "A");
  const b = registry.prepare("B" as ThreadId, projectId, "B");
  function Composer() {
    const [draft, setDraft] = useThreadPresentation("draft", "");
    return (
      <textarea
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (entry: typeof a) =>
    React.act(() =>
      root.render(
        <ThreadPresentationContext value={entry}>
          <Composer key={entry.id} />
        </ThreadPresentationContext>,
      ),
    );
  const edit = (value: string) =>
    React.act(() => {
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      if (textarea === null) throw new Error("Missing draft editor.");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

  await render(a);
  await edit("draft A");
  await render(b);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "",
  );
  await edit("draft B");
  await render(a);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "draft A",
  );
  await render(b);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "draft B",
  );
  await React.act(() => root.unmount());
  registry.clear();
});

it("isolates authenticated users and clears synchronously before logout", async () => {
  const queryClient = new QueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  const logout = vi.fn(() => expect(network.active).toBe(0));
  function Logout() {
    const auth = useIdentity();
    return (
      <button type="button" onClick={auth?.logout}>
        Logout
      </button>
    );
  }
  const render = (id: UserId) =>
    React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthContext
            value={{
              identity: { id, name: "Fixture", email: "fixture@example.test" },
              logout,
            }}
          >
            <ThreadSessionProvider
              key={id}
              userId={id}
              queryClient={queryClient}
            >
              <Logout />
              <ThreadSession
                thread={
                  {
                    id: "A" as ThreadId,
                    projectId,
                    agentUrl: "A",
                    lifecycleState: "archived",
                    executionWorkspace: { ready: false },
                  } as unknown as ThreadDetailData
                }
                project={{} as ProjectData}
              />
            </ThreadSessionProvider>
          </AuthContext>
        </QueryClientProvider>,
      ),
    );
  await render(userId);
  expect(network.reads).toBe(1);
  await render("other-user" as UserId);
  expect(network.reads).toBe(2);
  expect(network.disposed).toBe(1);
  await React.act(() => container.querySelector("button")?.click());
  expect(logout).toHaveBeenCalledOnce();
  expect(network.disposed).toBe(2);
  await React.act(() => root.unmount());
});
