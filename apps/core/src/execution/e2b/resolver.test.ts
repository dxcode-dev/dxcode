import { E2B_ORB_PROFILES } from "@dx/domain";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionWorkspaceLogger } from "../../logging.js";
import {
  type E2BResolverApi,
  ExecutionWorkspaceConflict,
  type ExecutionWorkspaceRecord,
  type ExecutionWorkspaceStateStore,
  ExecutionWorkspaceUnavailable,
  makeConnectExistingExecutionWorkspace,
  makeDestroyExecutionWorkspace,
  makePauseExecutionWorkspace,
  makeResolveExecutionWorkspace,
} from "./resolver.js";

const threadId = "thr_00000000-0000-4000-8000-000000000001";
const requirements = {
  apiKey: Redacted.make("e2b-test-credential"),
  template: "dx-workspace",
  timeoutMs: 600_000,
  inactivityMs: 300_000,
  dxEnv: "test",
} as const;

const uninitialized: ExecutionWorkspaceRecord = {
  state: "uninitialized",
  providerSandboxId: null,
  initializationAttemptId: null,
  conflictCount: null,
};

const initialized = (providerSandboxId: string): ExecutionWorkspaceRecord => ({
  state: "initialized",
  providerSandboxId,
  initializationAttemptId: null,
  conflictCount: null,
});

const provisioning = (
  initializationAttemptId: string,
): ExecutionWorkspaceRecord => ({
  state: "provisioning",
  providerSandboxId: null,
  initializationAttemptId,
  conflictCount: null,
});

const legacy: ExecutionWorkspaceRecord = {
  state: "legacy",
  providerSandboxId: null,
  initializationAttemptId: null,
  conflictCount: null,
};

const stateStore = (initial: ExecutionWorkspaceRecord) => {
  let current = initial;
  const read = vi.fn(async () => current);
  const transition = vi.fn(
    async (
      _threadId: string,
      expected: ExecutionWorkspaceRecord,
      next: ExecutionWorkspaceRecord,
    ) => {
      if (
        current !== expected &&
        JSON.stringify(current) !== JSON.stringify(expected)
      )
        return false;
      current = next;
      return true;
    },
  );
  return {
    value: { read, transition } as ExecutionWorkspaceStateStore,
    read,
    transition,
    current: () => current,
  };
};

const currentMetadata = {
  app: "dx",
  environment: "test",
  threadId,
  executionContract: "command-environment-v1",
};

const info = (
  sandboxId: string,
  metadata: Record<string, string> = currentMetadata,
  state: "running" | "paused" = "running",
) => ({ sandboxId, state, metadata }) as never;

const paginator = (pages: readonly (readonly unknown[])[]) => {
  let index = 0;
  return {
    get hasNext() {
      return index < pages.length;
    },
    nextItems: vi.fn(async () => pages[index++] ?? []),
  };
};

const notFound = new Error("sandbox was deleted");

const provider = (
  options: {
    pages?: readonly (readonly unknown[])[];
    list?: () => ReturnType<typeof paginator>;
    getInfo?: (sandboxId: string) => Promise<unknown>;
    create?: (options: unknown) => Promise<unknown>;
    connect?: (sandboxId: string) => Promise<unknown>;
    kill?: (sandboxId: string) => Promise<boolean>;
    pause?: (sandboxId: string) => Promise<boolean>;
  } = {},
) => {
  const pages = paginator(options.pages ?? [[]]);
  const connect = vi.fn(
    options.connect ?? (async (sandboxId: string) => ({ sandboxId })),
  );
  const getInfo = vi.fn(
    options.getInfo ??
      (async (sandboxId: string) => info(sandboxId, currentMetadata)),
  );
  const create = vi.fn(
    options.create ?? (async () => ({ sandboxId: "sandbox-created" })),
  );
  const kill = vi.fn(options.kill ?? (async () => true));
  const pause = vi.fn(options.pause ?? (async () => true));
  const list = vi.fn(options.list ?? (() => pages));
  return {
    value: {
      list,
      getInfo,
      connect,
      create,
      kill,
      pause,
      isNotFound: (cause: unknown) => cause === notFound,
    } as unknown as E2BResolverApi,
    pages,
    getInfo,
    connect,
    create,
    kill,
    pause,
    list,
  };
};

const resolve = (
  fake: ReturnType<typeof provider>,
  store: ReturnType<typeof stateStore>,
  options: Record<string, unknown> = {},
) =>
  Effect.runPromise(
    makeResolveExecutionWorkspace(fake.value)({
      id: threadId,
      requirements,
      stateStore: store.value,
      ...options,
    }),
  );

afterEach(() => vi.restoreAllMocks());

describe("resolveExecutionWorkspace", () => {
  it("initializes a new Thread once and persists the returned provider ID", async () => {
    const fake = provider();
    const store = stateStore(uninitialized);
    const observed = vi.fn();
    const observeOpening = vi.fn();

    await expect(
      resolve(fake, store, { observeResolution: observed, observeOpening }),
    ).resolves.toEqual({ sandboxId: "sandbox-created" });

    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.create).toHaveBeenCalledWith({
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
      template: "dx-workspace",
      timeoutMs: 600_000,
      metadata: {
        ...currentMetadata,
        initializationAttempt: expect.any(String),
      },
      allowInternetAccess: true,
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
    expect(observeOpening).toHaveBeenCalledWith("starting");
    expect(store.current()).toEqual(initialized("sandbox-created"));
    expect(observed).toHaveBeenCalledWith({
      decision: "create",
      outcome: "success",
      durationMs: expect.any(Number),
      cpuCores: null,
      memoryMb: null,
    });
    expect(observed.mock.calls[0]?.[0]).not.toHaveProperty("sandboxId");
  });

  it.each(E2B_ORB_PROFILES)(
    "sends $id's dedicated template to the E2B create adapter",
    async (profile) => {
      const fake = provider();
      const store = stateStore(uninitialized);

      await resolve(fake, store, {
        requirements: {
          ...requirements,
          template: `dx-workspace-${profile.templateSuffix}`,
        },
      });

      expect(fake.create).toHaveBeenCalledWith(
        expect.objectContaining({
          template: `dx-workspace-${profile.templateSuffix}`,
        }),
      );
    },
  );

  it("kills a newly created sandbox when authority changes before persistence", async () => {
    const store = stateStore(uninitialized);
    const originalTransition = store.transition.getMockImplementation();
    let transitions = 0;
    store.transition.mockImplementation(async (thread, current, next) => {
      transitions += 1;
      if (transitions === 2) return false;
      return originalTransition?.(thread, current, next) ?? false;
    });
    const fake = provider();

    await expect(resolve(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );

    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("sandbox-created", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
    });
    expect(fake.pause).not.toHaveBeenCalled();
    expect(store.current()).toMatchObject({ state: "provisioning" });
  });

  it("connects a running persisted workspace under a resolution lease", async () => {
    const fake = provider();
    const store = stateStore(initialized("immutable-sandbox"));
    const observeOpening = vi.fn();
    const observePhase = vi.fn();
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));
    const authorizeResolution = vi.fn(async () => undefined);

    await expect(
      resolve(fake, store, {
        coordination: { acquire },
        authorizeResolution,
        observeOpening,
        observePhase,
      }),
    ).resolves.toEqual({ sandboxId: "immutable-sandbox" });

    expect(fake.connect).toHaveBeenCalledWith("immutable-sandbox", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
      timeoutMs: 600_000,
    });
    expect(observeOpening).toHaveBeenCalledWith("waking");
    expect(observePhase.mock.calls.map(([phase]) => phase)).toEqual([
      "workspace_state_resolved",
      "provider_connected",
    ]);
    expect({
      stateReads: store.read.mock.calls.length,
      stateTransitions: store.transition.mock.calls.length,
      leaseAcquires: acquire.mock.calls.length,
      leaseReleases: release.mock.calls.length,
      providerGetInfo: fake.getInfo.mock.calls.length,
      providerConnects: fake.connect.mock.calls.length,
      providerLists: fake.list.mock.calls.length,
      providerCreates: fake.create.mock.calls.length,
      authorizations: authorizeResolution.mock.calls.length,
    }).toEqual({
      stateReads: 2,
      stateTransitions: 0,
      leaseAcquires: 1,
      leaseReleases: 1,
      providerGetInfo: 1,
      providerConnects: 1,
      providerLists: 0,
      providerCreates: 0,
      authorizations: 3,
    });
  });

  it("observes a running persisted workspace before connecting it", async () => {
    const fake = provider({
      getInfo: async (sandboxId) => info(sandboxId, currentMetadata, "running"),
    });
    const store = stateStore(initialized("immutable-sandbox"));
    const observeResidency = vi.fn();

    await expect(resolve(fake, store, { observeResidency })).resolves.toEqual({
      sandboxId: "immutable-sandbox",
    });

    expect(fake.getInfo).toHaveBeenCalledWith("immutable-sandbox", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
    });
    expect(observeResidency).toHaveBeenCalledWith("running");
    expect(fake.connect).toHaveBeenCalledOnce();
  });

  it("waits for paused residency reporting before waking the workspace", async () => {
    const events: string[] = [];
    const fake = provider({
      getInfo: async (sandboxId) => info(sandboxId, currentMetadata, "paused"),
      connect: async (sandboxId) => {
        events.push("connect");
        return { sandboxId } as never;
      },
    });

    await resolve(fake, stateStore(initialized("paused-sandbox")), {
      observeResidency: async () => {
        await Promise.resolve();
        events.push("reported");
      },
    });

    expect(events).toEqual(["reported", "connect"]);
  });

  it.each([
    [
      "paused provider state",
      info("immutable-sandbox", currentMetadata, "paused"),
    ],
    ["mismatched provider identity", info("different-sandbox")],
  ])("falls back to the lease for %s", async (_case, providerInfo) => {
    const fake = provider({ getInfo: async () => providerInfo });
    const store = stateStore(initialized("immutable-sandbox"));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));
    const authorizeResolution = vi.fn(async () => undefined);

    await expect(
      resolve(fake, store, {
        coordination: { acquire },
        authorizeResolution,
      }),
    ).resolves.toEqual({ sandboxId: "immutable-sandbox" });

    expect({
      stateReads: store.read.mock.calls.length,
      leaseAcquires: acquire.mock.calls.length,
      leaseReleases: release.mock.calls.length,
      providerGetInfo: fake.getInfo.mock.calls.length,
      providerConnects: fake.connect.mock.calls.length,
      authorizations: authorizeResolution.mock.calls.length,
    }).toEqual({
      stateReads: 2,
      leaseAcquires: 1,
      leaseReleases: 1,
      providerGetInfo: 1,
      providerConnects: 1,
      authorizations: 2,
    });
    expect(fake.connect).toHaveBeenCalledWith("immutable-sandbox", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
      timeoutMs: 600_000,
    });
  });

  it("reports paused and unknown residency conservatively", async () => {
    const paused = provider({
      getInfo: async (sandboxId) => info(sandboxId, currentMetadata, "paused"),
    });
    const pausedResidency = vi.fn();
    await resolve(paused, stateStore(initialized("paused-sandbox")), {
      observeResidency: pausedResidency,
    });
    expect(pausedResidency).toHaveBeenCalledWith("paused");

    const unavailableInfo = provider({
      getInfo: async () => {
        throw new Error("provider status unavailable");
      },
    });
    const unknownResidency = vi.fn();
    await resolve(unavailableInfo, stateStore(initialized("unknown-sandbox")), {
      observeResidency: unknownResidency,
    });
    expect(unknownResidency).toHaveBeenCalledWith("unknown");
    expect(unavailableInfo.connect).toHaveBeenCalledOnce();
  });

  it("marks a missing workspace lost when residency lookup confirms deletion", async () => {
    const fake = provider({
      getInfo: async () => {
        throw notFound;
      },
    });
    const store = stateStore(initialized("deleted-before-connect"));

    await expect(
      resolve(fake, store, { observeResidency: vi.fn() }),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceUnavailable);

    expect(store.current()).toEqual({
      ...initialized("deleted-before-connect"),
      state: "lost",
    });
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("keeps existing-only callers from initializing a new Thread", async () => {
    const fake = provider();
    const store = stateStore(uninitialized);

    const error = await Effect.runPromise(
      Effect.flip(
        makeConnectExistingExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
        }),
      ),
    );

    expect(error).toBeInstanceOf(ExecutionWorkspaceUnavailable);
    expect(store.current()).toEqual(uninitialized);
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous first create by its persisted attempt and never creates again", async () => {
    let createdMetadata: Record<string, string> | undefined;
    const list = vi.fn(() =>
      paginator([
        [
          info("created-despite-timeout", {
            ...(createdMetadata ?? currentMetadata),
          }),
        ],
      ]),
    );
    const fake = provider({
      list,
      create: async (options) => {
        createdMetadata = (options as { metadata: Record<string, string> })
          .metadata;
        throw new Error("private provider timeout");
      },
    });
    const store = stateStore(uninitialized);

    await expect(resolve(fake, store)).resolves.toEqual({
      sandboxId: "created-despite-timeout",
    });

    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.list).toHaveBeenCalledOnce();
    expect(fake.connect).toHaveBeenCalledWith("created-despite-timeout", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
      timeoutMs: 600_000,
    });
    expect(store.current()).toEqual(initialized("created-despite-timeout"));

    await resolve(fake, store);
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.list).toHaveBeenCalledOnce();
  });

  it("only reconciles a persisted provisioning attempt after a prior ambiguous failure", async () => {
    const attempt = "attempt-from-prior-request";
    const fake = provider({
      pages: [
        [
          info("reconciled", {
            ...currentMetadata,
            initializationAttempt: attempt,
          }),
        ],
      ],
    });
    const store = stateStore(provisioning(attempt));

    await expect(resolve(fake, store)).resolves.toEqual({
      sandboxId: "reconciled",
    });

    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.list).toHaveBeenCalledOnce();
    expect(store.current()).toEqual(initialized("reconciled"));
  });

  it("leaves an unresolved provisioning attempt in place instead of retrying create", async () => {
    const store = stateStore(provisioning("ambiguous-attempt"));
    const fake = provider({ list: () => paginator([[]]) });

    await expect(resolve(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );
    await expect(resolve(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );

    expect(fake.create).not.toHaveBeenCalled();
    expect(store.current()).toEqual(provisioning("ambiguous-attempt"));
  });

  it("coalesces concurrent initializers and gives both the same physical sandbox", async () => {
    let releaseCreate: (() => void) | undefined;
    const createRelease = new Promise<void>((resolveRelease) => {
      releaseCreate = resolveRelease;
    });
    let signalCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolveStarted) => {
      signalCreate = resolveStarted;
    });
    const fake = provider({
      create: async () => {
        signalCreate?.();
        await createRelease;
        return { sandboxId: "one-sandbox" };
      },
    });
    const store = stateStore(uninitialized);
    const resolver = makeResolveExecutionWorkspace(fake.value);
    const options = { id: threadId, requirements, stateStore: store.value };

    const first = Effect.runPromise(resolver(options));
    await createStarted;
    const second = Effect.runPromise(resolver(options));
    releaseCreate?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sandboxId: "one-sandbox" },
      { sandboxId: "one-sandbox" },
    ]);
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("falls back to the lease when connect reports not-found, then marks the workspace lost", async () => {
    const fake = provider({
      connect: async () => {
        throw notFound;
      },
    });
    const store = stateStore(initialized("deleted-sandbox"));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));

    await expect(
      resolve(fake, store, {
        coordination: { acquire },
        authorizeResolution: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceUnavailable);
    expect(store.current()).toEqual({
      ...initialized("deleted-sandbox"),
      state: "lost",
    });
    expect({
      stateReads: store.read.mock.calls.length,
      stateTransitions: store.transition.mock.calls.length,
      leaseAcquires: acquire.mock.calls.length,
      leaseReleases: release.mock.calls.length,
      providerGetInfo: fake.getInfo.mock.calls.length,
      providerConnects: fake.connect.mock.calls.length,
    }).toEqual({
      stateReads: 3,
      stateTransitions: 1,
      leaseAcquires: 2,
      leaseReleases: 2,
      providerGetInfo: 1,
      providerConnects: 2,
    });

    fake.connect.mockClear();
    await expect(
      resolve(fake, store, {
        coordination: { acquire },
        authorizeResolution: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceUnavailable);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("does not mark the workspace lost on a transient provider failure", async () => {
    const fake = provider({
      connect: async () => {
        throw new Error("provider outage");
      },
    });
    const store = stateStore(initialized("still-authoritative"));

    await expect(resolve(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );

    expect(store.current()).toEqual(initialized("still-authoritative"));
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("reconciles one compatible legacy sandbox and stores its ID", async () => {
    const fake = provider({ pages: [[info("legacy-match")]] });
    const store = stateStore(legacy);

    await expect(resolve(fake, store)).resolves.toEqual({
      sandboxId: "legacy-match",
    });

    expect(fake.list).toHaveBeenCalledOnce();
    expect(fake.create).not.toHaveBeenCalled();
    expect(store.current()).toEqual(initialized("legacy-match"));
  });

  it("makes a zero-match legacy Thread unavailable without treating it as new", async () => {
    const fake = provider();
    const store = stateStore(legacy);

    await expect(resolve(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );

    expect(store.current()).toEqual({
      state: "legacy_unavailable",
      providerSandboxId: null,
      initializationAttemptId: null,
      conflictCount: null,
    });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("records duplicate or incompatible reconciliation as a terminal conflict", async () => {
    const duplicate = provider({
      pages: [[info("one"), info("two")]],
    });
    const duplicateStore = stateStore(legacy);
    const duplicateError = await Effect.runPromise(
      Effect.flip(
        makeResolveExecutionWorkspace(duplicate.value)({
          id: threadId,
          requirements,
          stateStore: duplicateStore.value,
        }),
      ),
    );
    expect(duplicateError).toBeInstanceOf(ExecutionWorkspaceConflict);
    expect(duplicateError).toMatchObject({ count: 2 });
    expect(duplicateStore.current()).toMatchObject({
      state: "conflict",
      conflictCount: 2,
    });

    const incompatible = provider({
      pages: [
        [
          info("future", {
            ...currentMetadata,
            executionContract: "command-environment-v2",
          }),
        ],
      ],
    });
    const incompatibleStore = stateStore(legacy);
    await expect(
      resolve(incompatible, incompatibleStore),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceConflict);
    expect(incompatibleStore.current()).toMatchObject({
      state: "conflict",
      conflictCount: 1,
    });
    expect(incompatible.create).not.toHaveBeenCalled();
  });

  it("rejects an archived Thread before acquiring the distributed lease", async () => {
    const fake = provider();
    const store = stateStore(initialized("existing"));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));
    const authorizeResolution = vi.fn(async () => {
      throw new Error("Thread was archived while resolution waited.");
    });

    const error = await Effect.runPromise(
      Effect.flip(
        makeResolveExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
          coordination: { acquire },
          authorizeResolution,
        }),
      ),
    );

    expect(error).toBeInstanceOf(ExecutionWorkspaceUnavailable);
    expect(authorizeResolution).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("does not connect when archive commits after provider status lookup", async () => {
    let active = true;
    let statusStarted: (() => void) | undefined;
    const checkingStatus = new Promise<void>((resolveStarted) => {
      statusStarted = resolveStarted;
    });
    let finishStatus: (() => void) | undefined;
    const statusRelease = new Promise<void>((resolveStatus) => {
      finishStatus = resolveStatus;
    });
    const fake = provider({
      getInfo: async (sandboxId) => {
        statusStarted?.();
        await statusRelease;
        return info(sandboxId);
      },
    });
    const store = stateStore(initialized("archive-race"));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));
    const coordination = { acquire };

    const resolving = resolve(fake, store, {
      coordination,
      authorizeResolution: async () => {
        if (!active) throw new Error("Thread is archived");
      },
    });
    await checkingStatus;
    active = false;
    await Effect.runPromise(
      makePauseExecutionWorkspace(fake.value)({
        id: threadId,
        requirements,
        stateStore: store.value,
        coordination,
        authorizePause: async () => undefined,
      }),
    );
    finishStatus?.();

    await expect(resolving).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );
    expect({
      stateReads: store.read.mock.calls.length,
      leaseAcquires: acquire.mock.calls.length,
      leaseReleases: release.mock.calls.length,
      providerGetInfo: fake.getInfo.mock.calls.length,
      providerConnects: fake.connect.mock.calls.length,
      providerPauses: fake.pause.mock.calls.length,
    }).toEqual({
      stateReads: 2,
      leaseAcquires: 2,
      leaseReleases: 2,
      providerGetInfo: 1,
      providerConnects: 0,
      providerPauses: 1,
    });
  });

  it("serializes the fast-path authorization with an archive pause", async () => {
    let locked = false;
    const waiters: Array<() => void> = [];
    const coordination = {
      acquire: vi.fn(async () => {
        if (locked)
          await new Promise<void>((resolveAcquire) =>
            waiters.push(resolveAcquire),
          );
        locked = true;
        return {
          release: async () => {
            locked = false;
            waiters.shift()?.();
          },
        };
      }),
    };
    let authorizationCount = 0;
    let signalFinalAuthorization: (() => void) | undefined;
    const finalAuthorizationStarted = new Promise<void>((resolveStarted) => {
      signalFinalAuthorization = resolveStarted;
    });
    let finishFinalAuthorization: (() => void) | undefined;
    const finalAuthorizationRelease = new Promise<void>(
      (resolveAuthorization) => {
        finishFinalAuthorization = resolveAuthorization;
      },
    );
    const authorizeResolution = async () => {
      authorizationCount += 1;
      if (authorizationCount !== 2) return;
      signalFinalAuthorization?.();
      await finalAuthorizationRelease;
    };
    const fake = provider();
    const store = stateStore(initialized("archive-serialization"));

    const resolving = resolve(fake, store, {
      coordination,
      authorizeResolution,
    });
    await finalAuthorizationStarted;
    const pausing = Effect.runPromise(
      makePauseExecutionWorkspace(fake.value)({
        id: threadId,
        requirements,
        stateStore: store.value,
        coordination,
      }),
    );
    await Promise.resolve();

    expect(fake.pause).not.toHaveBeenCalled();
    finishFinalAuthorization?.();
    await expect(resolving).resolves.toEqual({
      sandboxId: "archive-serialization",
    });
    await expect(pausing).resolves.toBe(1);
    expect(fake.pause).toHaveBeenCalledOnce();
  });

  it("keeps telemetry and lease-release failures outside workspace lifecycle", async () => {
    const warning = vi
      .spyOn(executionWorkspaceLogger, "warn")
      .mockImplementation(() => undefined);
    const fake = provider({
      getInfo: async (sandboxId) => info(sandboxId, currentMetadata, "paused"),
    });
    const store = stateStore(initialized("existing"));

    await expect(
      resolve(fake, store, {
        coordination: {
          acquire: vi.fn(async () => ({
            release: async () => {
              throw new Error("private coordinator detail");
            },
          })),
        },
        observeResolution: () => Promise.reject(new Error("telemetry down")),
        observeResidency: vi.fn(),
      }),
    ).resolves.toEqual({ sandboxId: "existing" });

    expect(warning).toHaveBeenCalledWith(
      "E2B resolution lease release could not be recorded.",
      {
        event: "execution_workspace_resolution_lock_release_failed",
        threadId,
        outcome: "error",
      },
    );
  });
});

describe("pauseExecutionWorkspace", () => {
  it("pauses the persisted ID directly without listing or connecting", async () => {
    const fake = provider();
    const store = stateStore(initialized("immutable-sandbox"));

    await expect(
      Effect.runPromise(
        makePauseExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
        }),
      ),
    ).resolves.toBe(1);

    expect(fake.pause).toHaveBeenCalledWith("immutable-sandbox", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: 30_000,
      keepMemory: true,
    });
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("treats an already-paused sandbox as paused", async () => {
    const fake = provider({ pause: async () => false });
    const store = stateStore(initialized("idle-paused-sandbox"));

    await expect(
      Effect.runPromise(
        makePauseExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
        }),
      ),
    ).resolves.toBe(1);
    expect(fake.pause).toHaveBeenCalledOnce();
    expect(store.current()).toEqual(initialized("idle-paused-sandbox"));
  });

  it("still fails when E2B rejects the pause", async () => {
    const fake = provider({
      pause: async () => {
        throw new Error("E2B unavailable");
      },
    });
    const store = stateStore(initialized("running-sandbox"));

    await expect(
      Effect.runPromise(
        makePauseExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceUnavailable);
    expect(store.current()).toEqual(initialized("running-sandbox"));
  });

  it("does nothing for a never-initialized Thread", async () => {
    const fake = provider();
    const store = stateStore(uninitialized);

    await expect(
      Effect.runPromise(
        makePauseExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
        }),
      ),
    ).resolves.toBe(0);
    expect(fake.pause).not.toHaveBeenCalled();
  });

  it("marks a confirmed deletion as lost and keeps archived authorization inside the lease", async () => {
    const fake = provider({
      pause: async () => {
        throw notFound;
      },
    });
    const store = stateStore(initialized("deleted"));
    const release = vi.fn(async () => undefined);
    const authorizePause = vi.fn(async () => undefined);

    await expect(
      Effect.runPromise(
        makePauseExecutionWorkspace(fake.value)({
          id: threadId,
          requirements,
          stateStore: store.value,
          coordination: {
            acquire: vi.fn(async () => ({ release })),
          },
          authorizePause,
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionWorkspaceUnavailable);

    expect(authorizePause).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(store.current()).toEqual({
      ...initialized("deleted"),
      state: "lost",
    });
  });
});

describe("destroyExecutionWorkspace", () => {
  const destroy = (
    fake: ReturnType<typeof provider>,
    store: ReturnType<typeof stateStore>,
  ) =>
    Effect.runPromise(
      makeDestroyExecutionWorkspace(fake.value)({
        id: threadId,
        requirements,
        stateStore: store.value,
      }),
    );

  it("kills an initialized sandbox with the context key and records it lost", async () => {
    const fake = provider();
    const store = stateStore(initialized("to-destroy"));
    await expect(destroy(fake, store)).resolves.toBe(1);
    expect(fake.kill).toHaveBeenCalledWith("to-destroy", {
      apiKey: "e2b-test-credential",
      requestTimeoutMs: expect.any(Number),
    });
    expect(store.current().state).toBe("lost");
  });

  it("treats a sandbox E2B no longer has as destroyed", async () => {
    const fake = provider({
      kill: async () => {
        throw notFound;
      },
    });
    const store = stateStore(initialized("already-gone"));
    await expect(destroy(fake, store)).resolves.toBe(1);
    expect(store.current().state).toBe("lost");
  });

  it("does nothing for a workspace that never existed", async () => {
    const fake = provider();
    await expect(destroy(fake, stateStore(uninitialized))).resolves.toBe(0);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("fails closed while provisioning, keeping the record", async () => {
    const fake = provider();
    const store = stateStore(provisioning("in-flight"));
    await expect(destroy(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );
    expect(fake.kill).not.toHaveBeenCalled();
    expect(store.current().state).toBe("provisioning");
  });

  it("fails closed when E2B refuses the kill, keeping the record", async () => {
    const fake = provider({
      kill: async () => {
        throw new Error("provider unavailable");
      },
    });
    const store = stateStore(initialized("still-there"));
    await expect(destroy(fake, store)).rejects.toBeInstanceOf(
      ExecutionWorkspaceUnavailable,
    );
    expect(store.current().state).toBe("initialized");
  });
});
