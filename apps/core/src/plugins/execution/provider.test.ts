import { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Redacted, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionActivation,
  ExecutionCredentialUnavailable,
  type ExecutionProfile,
  type ExecutionProvider,
  type ExecutionTargetResolver,
  providerServesProfile,
  type ResolvedExecutionProvider,
  resolveExecutionProviders,
} from "./provider.js";

const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000000",
);
const deployed = {
  DX_RUNTIME_MODE: "deployed",
  E2B_API_KEY: "deployment-key",
} satisfies Bindings;
const sandbox = {} as Sandbox;
const workspaceToolNames = [
  "shell_command",
  "shell_command_status",
  "shell_command_kill",
  "create_file",
  "edit_file",
];
const e2bProfile = {
  id: "e2b-test",
  label: "Test",
  adapter: "e2b",
  template: "dx-test",
  resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
  isolation: "sandbox",
  availability: "available",
  capabilities: ["git"],
} as unknown as ExecutionProfile;
const profileResolver = (profile = e2bProfile) =>
  vi.fn<ExecutionTargetResolver>(async () => ({
    profile,
    credential: { scope: "deployment" },
  }));

/**
 * Core's pipeline, stubbed: it records the provider it was composed over and
 * the context of every operation. execution-workspaces tests exercise the
 * real pipeline over the E2B and local providers.
 */
const stubActivation = () => {
  const composedOver: ExecutionProvider[] = [];
  const pipeline = {
    activate: vi.fn<ExecutionActivation["activate"]>(async () => sandbox),
    reconnect: vi.fn<ExecutionActivation["reconnect"]>(async () => sandbox),
    ensureDaemon: vi.fn<ExecutionActivation["ensureDaemon"]>(async () => ({
      bootstrapped: false,
    })),
    recordResidentTerminalInput: vi.fn<
      ExecutionActivation["recordResidentTerminalInput"]
    >(async () => undefined),
    recordResidentTerminalHeartbeat: vi.fn(),
  };
  const activation = (provider: ExecutionProvider) => {
    composedOver.push(provider);
    return pipeline;
  };
  return { activation, pipeline, composedOver };
};

/**
 * A provider with partial capabilities: an ephemeral workspace with files and
 * commands only. It runs no resident daemon and claims no pause-resume, so
 * releasing it merely stops it.
 */
const workspaceOnly = () => {
  const create = vi.fn();
  const connect = vi.fn();
  const release = vi.fn(async () => undefined);
  const provider: ExecutionProvider = {
    workspace: { create, connect, release },
  };
  const resolved: ResolvedExecutionProvider = {
    providerId: "e2b",
    capabilities: ["execution.workspace"],
  };
  return { provider, resolved, release };
};

const residentDaemon = { install: vi.fn(async () => ({})) };

describe("Execution provider contract", () => {
  it("serves a workspace-only provider and fails its missing capabilities closed", async () => {
    const { provider, resolved, release } = workspaceOnly();
    const { activation, pipeline, composedOver } = stubActivation();
    const resolveProfile = profileResolver();
    // No THREAD_EXECUTION binding: a daemon drain would throw.
    const workspaces = composeExecutionWorkspaces(
      deployed,
      { e2b: provider },
      activation,
      [resolved],
      resolveProfile,
    );

    expect(workspaces.providers).toEqual([resolved]);
    expect(composedOver).toEqual([provider]);
    await expect(
      workspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBe(sandbox);
    await expect(
      workspaces.existingSandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBe(sandbox);
    expect(pipeline.activate).toHaveBeenCalledWith(
      {
        account: { scope: "deployment" },
        credential: expect.anything(),
        profile: e2bProfile,
      },
      { id: threadId },
    );
    const context = pipeline.activate.mock.calls[0]?.[0];
    expect(Redacted.value(context?.credential as Redacted.Redacted)).toBe(
      "deployment-key",
    );
    expect(pipeline.reconnect).toHaveBeenCalledOnce();
    expect(resolveProfile).toHaveBeenCalledTimes(2);
    expect(resolveProfile).toHaveBeenCalledWith(deployed, threadId, {
      admission: true,
    });
    expect(
      workspaces.sandboxFactory
        .tools?.(sandbox, { subagents: {} })
        .map(({ name }) => name),
    ).toEqual(workspaceToolNames);

    const daemonUnavailable = {
      _tag: "ExecutionCapabilityUnavailable",
      capability: "execution.resident-daemon",
    };
    await expect(
      workspaces.ensureDaemon({
        threadId,
        endpoint: "https://core.test/",
        mintCredential: vi.fn(),
        awaitRegistration: vi.fn(),
      }),
    ).rejects.toMatchObject(daemonUnavailable);
    await expect(
      workspaces.recordResidentTerminalInput(threadId),
    ).rejects.toMatchObject(daemonUnavailable);
    expect(() =>
      workspaces.recordResidentTerminalHeartbeat(threadId, true),
    ).not.toThrow();
    expect(pipeline.ensureDaemon).not.toHaveBeenCalled();
    expect(pipeline.recordResidentTerminalHeartbeat).not.toHaveBeenCalled();

    await workspaces.archive(threadId);
    await workspaces.destroy(threadId);
    // The provider releases its raw workspace directly, by owner.
    expect(release.mock.calls.map((call) => call.slice(1))).toEqual([
      [{ threadId }, "archive"],
      [{ threadId }, "destroy"],
    ]);
    // Releasing never requires admission (profile availability, policy).
    expect(resolveProfile).toHaveBeenLastCalledWith(deployed, threadId, {
      admission: false,
    });
  });

  it("never reports snapshot, usage, or display, which have no operations yet", () => {
    const { provider } = workspaceOnly();
    const workspaces = composeExecutionWorkspaces(
      deployed,
      { e2b: provider },
      stubActivation().activation,
      [
        {
          providerId: "e2b",
          capabilities: [
            "execution.workspace",
            "execution.snapshot",
            "execution.usage",
            "execution.display",
          ],
        },
      ],
      profileResolver(),
    );
    expect(workspaces.providers[0]?.capabilities).toEqual([
      "execution.workspace",
    ]);
  });

  it("exposes a resident daemon only when the provider both claims and implements it", async () => {
    const { provider, resolved } = workspaceOnly();
    const claimed = stubActivation();
    const claimedOnly = composeExecutionWorkspaces(
      deployed,
      { e2b: provider },
      claimed.activation,
      [
        {
          ...resolved,
          capabilities: [...resolved.capabilities, "execution.resident-daemon"],
        },
      ],
      profileResolver(),
    );
    expect(claimedOnly.providers[0]?.capabilities).toEqual(
      resolved.capabilities,
    );
    await expect(
      claimedOnly.recordResidentTerminalInput(threadId),
    ).rejects.toMatchObject({ _tag: "ExecutionCapabilityUnavailable" });

    const implemented = stubActivation();
    const implementedOnly = composeExecutionWorkspaces(
      deployed,
      { e2b: { ...provider, residentDaemon } },
      implemented.activation,
      [resolved],
      profileResolver(),
    );
    await expect(
      implementedOnly.recordResidentTerminalInput(threadId),
    ).rejects.toMatchObject({ _tag: "ExecutionCapabilityUnavailable" });
    expect(
      implemented.pipeline.recordResidentTerminalInput,
    ).not.toHaveBeenCalled();
    // The pipeline never sees a daemon the provider does not claim.
    expect(implemented.composedOver[0]?.residentDaemon).toBeUndefined();
  });

  it("hands the pipeline a lazy context for terminal input", async () => {
    const { provider, resolved } = workspaceOnly();
    const { activation, pipeline } = stubActivation();
    const resolveProfile = profileResolver();
    const workspaces = composeExecutionWorkspaces(
      deployed,
      { e2b: { ...provider, residentDaemon } },
      activation,
      [
        {
          ...resolved,
          capabilities: [...resolved.capabilities, "execution.resident-daemon"],
        },
      ],
      resolveProfile,
    );
    await workspaces.recordResidentTerminalInput(threadId);
    expect(resolveProfile).not.toHaveBeenCalled();
    const loadContext = pipeline.recordResidentTerminalInput.mock.calls[0]?.[0];
    await expect(loadContext?.()).resolves.toMatchObject({
      profile: e2bProfile,
    });
    expect(resolveProfile).toHaveBeenCalledWith(deployed, threadId, {
      admission: true,
    });
    workspaces.recordResidentTerminalHeartbeat(threadId, true);
    expect(pipeline.recordResidentTerminalHeartbeat).toHaveBeenCalledWith(
      threadId,
      true,
    );
  });

  it("drains the resident daemon before a daemon provider releases", async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      order.push(
        `drain:${new Headers(init.headers).get("x-dx-daemon-drain-reason")}`,
      );
      return new Response(null, { status: 204 });
    });
    const bindings = {
      ...deployed,
      THREAD_EXECUTION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    } satisfies Bindings;
    const workspaces = composeExecutionWorkspaces(
      bindings,
      {
        e2b: {
          workspace: {
            create: vi.fn(),
            connect: vi.fn(),
            release: async (_context, _owner, mode) => {
              order.push(mode);
            },
          },
          residentDaemon,
        },
      },
      stubActivation().activation,
      undefined,
      profileResolver(),
    );
    await workspaces.archive(threadId);
    await workspaces.destroy(threadId);
    expect(order).toEqual([
      "drain:thread-archived",
      "archive",
      "drain:thread-deleted",
      "destroy",
    ]);
  });

  it("rejects a Thread whose runner profile names another provider", async () => {
    const { provider, resolved } = workspaceOnly();
    const { activation, pipeline } = stubActivation();
    const workspaces = composeExecutionWorkspaces(
      deployed,
      { e2b: provider },
      activation,
      [resolved],
      profileResolver({
        ...e2bProfile,
        adapter: "local",
      } as unknown as ExecutionProfile),
    );
    await expect(
      workspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toMatchObject({ _tag: "ExecutionProviderUnavailable" });
    expect(pipeline.activate).not.toHaveBeenCalled();
  });

  it("fails every operation closed when no provider resolves, without fallback", async () => {
    const { provider } = workspaceOnly();
    const { activation, pipeline, composedOver } = stubActivation();
    const bindings = { DX_RUNTIME_MODE: "deployed" } satisfies Bindings;
    expect(resolveExecutionProviders(bindings)).toEqual([]);
    // A local implementation exists, but deployed runtime never selects it.
    const workspaces = composeExecutionWorkspaces(
      bindings,
      { local: provider },
      activation,
    );
    expect(workspaces.providers).toEqual([]);
    const unavailable = { _tag: "ExecutionProviderUnavailable" };
    await expect(
      workspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      workspaces.existingSandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toMatchObject(unavailable);
    await expect(workspaces.archive(threadId)).rejects.toMatchObject(
      unavailable,
    );
    await expect(workspaces.destroy(threadId)).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      workspaces.recordResidentTerminalInput(threadId),
    ).rejects.toMatchObject(unavailable);
    expect(composedOver).toEqual([]);
    expect(pipeline.activate).not.toHaveBeenCalled();
  });

  it("resolves the registered providers from deployment bindings", () => {
    const e2b = {
      providerId: "e2b",
      capabilities: [
        "execution.workspace",
        "execution.resident-daemon",
        "execution.pause-resume",
      ],
      pauseResumePreserves: "processes",
    };
    const cloudflare = {
      providerId: "cloudflare",
      capabilities: [
        "execution.workspace",
        "execution.resident-daemon",
        "execution.pause-resume",
      ],
      pauseResumePreserves: "filesystem",
    };
    const orbContainer = {} as DurableObjectNamespace;
    expect(resolveExecutionProviders(deployed)).toEqual([e2b]);
    // Containers needs no key: its namespace binding is the installation.
    expect(
      resolveExecutionProviders({
        DX_RUNTIME_MODE: "deployed",
        ORB_CONTAINER: orbContainer as never,
      }),
    ).toEqual([cloudflare]);
    expect(
      resolveExecutionProviders({
        ...deployed,
        ORB_CONTAINER: orbContainer as never,
      }),
    ).toEqual([e2b, cloudflare]);
    // Local runtime never selects a deployed provider.
    expect(
      resolveExecutionProviders({
        DX_RUNTIME_MODE: "local",
        E2B_API_KEY: "deployment-key",
        ORB_CONTAINER: orbContainer as never,
      }),
    ).toEqual([
      {
        providerId: "local",
        capabilities: ["execution.workspace", "execution.resident-daemon"],
      },
    ]);
  });

  it("dispatches each Thread to the provider its runner profile names", async () => {
    const e2b = workspaceOnly();
    const cloudflare = workspaceOnly();
    const pipelines = new Map<
      ExecutionProvider,
      ReturnType<typeof stubActivation>["pipeline"]
    >();
    const activation = (provider: ExecutionProvider) => {
      const pipeline = stubActivation().pipeline;
      pipelines.set(provider, pipeline);
      return pipeline;
    };
    const cloudflareProfile = {
      ...e2bProfile,
      adapter: "cloudflare",
      instance: "standard-2",
    } as unknown as ExecutionProfile;
    const resolveProfile = vi.fn<ExecutionTargetResolver>(
      async (_bindings, id) => ({
        profile: id === threadId ? cloudflareProfile : e2bProfile,
        credential: { scope: "deployment" },
      }),
    );
    const drain = vi.fn(async () => new Response(null, { status: 204 }));
    const workspaces = composeExecutionWorkspaces(
      {
        ...deployed,
        THREAD_EXECUTION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: drain }),
        } as unknown as DurableObjectNamespace,
      },
      {
        e2b: { ...e2b.provider, residentDaemon },
        cloudflare: { ...cloudflare.provider, residentDaemon },
      },
      activation,
      [
        {
          providerId: "e2b",
          capabilities: ["execution.workspace", "execution.resident-daemon"],
        },
        {
          providerId: "cloudflare",
          capabilities: ["execution.workspace", "execution.resident-daemon"],
        },
      ],
      resolveProfile,
    );
    const other = Schema.decodeUnknownSync(ThreadId)(
      "thr_00000000-0000-4000-8000-000000000001",
    );
    await workspaces.sandboxFactory.createSandbox({ id: threadId });
    await workspaces.sandboxFactory.createSandbox({ id: other });
    const cloudflarePipeline = pipelines.get(
      [...pipelines.keys()].find(
        (provider) => provider.workspace === cloudflare.provider.workspace,
      ) as ExecutionProvider,
    );
    const e2bPipeline = pipelines.get(
      [...pipelines.keys()].find(
        (provider) => provider.workspace === e2b.provider.workspace,
      ) as ExecutionProvider,
    );
    expect(cloudflarePipeline?.activate).toHaveBeenCalledOnce();
    expect(cloudflarePipeline?.activate.mock.calls[0]?.[0]).toMatchObject({
      profile: cloudflareProfile,
      // Containers is keyless; the deployment key belongs to E2B.
      credential: undefined,
    });
    expect(e2bPipeline?.activate).toHaveBeenCalledOnce();
    // The daemon installation reports the Thread's pinned provider.
    await expect(
      workspaces.ensureDaemon({
        threadId,
        endpoint: "https://core.test/",
        mintCredential: vi.fn(),
        awaitRegistration: vi.fn(),
      }),
    ).resolves.toEqual({ bootstrapped: false, provider: "cloudflare" });
    // Terminal input for a known Thread goes to its provider's pipeline.
    await workspaces.recordResidentTerminalInput(threadId);
    expect(
      cloudflarePipeline?.recordResidentTerminalInput,
    ).toHaveBeenCalledOnce();
    expect(e2bPipeline?.recordResidentTerminalInput).not.toHaveBeenCalled();
    await workspaces.archive(threadId);
    expect(cloudflare.release).toHaveBeenCalledOnce();
    expect(e2b.release).not.toHaveBeenCalled();
  });

  it("runs a pinned personal key in its owner's account, and fails closed when it is gone", async () => {
    const { provider, resolved, release } = workspaceOnly();
    const { activation, pipeline } = stubActivation();
    const drain = vi.fn(async () => new Response(null, { status: 204 }));
    let credential: Awaited<ReturnType<ExecutionTargetResolver>>["credential"] =
      {
        scope: "personal",
        ownerId: "user-1",
        account: "team-a",
        key: Redacted.make("personal-key"),
      };
    const resolveTarget = vi.fn<ExecutionTargetResolver>(async () => ({
      profile: e2bProfile,
      credential,
    }));
    const workspaces = composeExecutionWorkspaces(
      {
        ...deployed,
        THREAD_EXECUTION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: drain }),
        } as unknown as DurableObjectNamespace,
      },
      { e2b: { ...provider, residentDaemon } },
      activation,
      [
        {
          ...resolved,
          capabilities: ["execution.workspace", "execution.resident-daemon"],
        },
      ],
      resolveTarget,
    );
    await workspaces.sandboxFactory.createSandbox({ id: threadId });
    const context = pipeline.activate.mock.calls[0]?.[0];
    expect(context?.account).toEqual({
      scope: "personal",
      userId: "user-1",
      providerAccount: "team-a",
    });
    // The owner's key, never the deployment's.
    expect(Redacted.value(context?.credential as Redacted.Redacted)).toBe(
      "personal-key",
    );

    // The key was removed: every operation fails closed, with no fallback
    // to the deployment key…
    credential = { scope: "unavailable", reason: "removed" };
    await expect(
      workspaces.existingSandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toBeInstanceOf(ExecutionCredentialUnavailable);
    await expect(
      workspaces.ensureDaemon({
        threadId,
        endpoint: "https://core.test/",
        mintCredential: vi.fn(),
        awaitRegistration: vi.fn(),
      }),
    ).rejects.toMatchObject({
      _tag: "ExecutionCredentialUnavailable",
      reason: "removed",
    });
    // …terminal input from any member runs on the owner's (gone) key…
    await expect(
      workspaces.recordResidentTerminalInput(threadId),
    ).resolves.toBeUndefined();
    const loadContext = pipeline.recordResidentTerminalInput.mock.calls[0]?.[0];
    await expect(loadContext?.()).rejects.toBeInstanceOf(
      ExecutionCredentialUnavailable,
    );
    expect(pipeline.reconnect).not.toHaveBeenCalled();
    // …but archive still drains dxd and succeeds without the provider call.
    await expect(workspaces.archive(threadId)).resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("never runs a person's key on a keyless provider", async () => {
    const { provider, resolved } = workspaceOnly();
    const { activation } = stubActivation();
    const cloudflareProfile = {
      ...e2bProfile,
      adapter: "cloudflare",
    } as unknown as ExecutionProfile;
    const workspaces = composeExecutionWorkspaces(
      { ...deployed, ORB_CONTAINER: {} as Bindings["ORB_CONTAINER"] },
      { cloudflare: provider },
      activation,
      [{ ...resolved, providerId: "cloudflare" }],
      vi.fn<ExecutionTargetResolver>(async () => ({
        profile: cloudflareProfile,
        credential: {
          scope: "workspace",
          ownerId: "workspace-1",
          account: "team-a",
          key: Redacted.make("workspace-key"),
        },
      })),
    );
    await expect(
      workspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toMatchObject({ _tag: "ExecutionProviderUnavailable" });
  });

  it("lets a runner profile rely only on pause-resume beyond the workspace", () => {
    const { resolved } = workspaceOnly();
    // git, environment variables, persistence, and internet access are
    // traits or network settings, not provider capabilities.
    expect(
      providerServesProfile(resolved, {
        adapter: "e2b",
        capabilities: [
          "git",
          "environment-variables",
          "persistent-workspace",
          "internet-access",
        ],
      }),
    ).toBe(true);
    expect(
      providerServesProfile(resolved, {
        adapter: "e2b",
        capabilities: ["pause-resume"],
      }),
    ).toBe(false);
    expect(
      providerServesProfile(resolved, { adapter: "local", capabilities: [] }),
    ).toBe(false);
    expect(
      providerServesProfile(resolved, {
        adapter: "e2b",
        capabilities: ["commit-signing"],
      }),
    ).toBe(false);
  });
});
