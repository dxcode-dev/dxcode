import { threadAgentName } from "@dx/api";
import { MAX_MCP_SERVERS_PER_THREAD } from "@dx/domain";
import * as v from "valibot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useInitialData: vi.fn(),
  useAgentFinish: vi.fn(),
  useAgentStart: vi.fn(),
  useMcpConnection: vi.fn(),
  useModel: vi.fn(),
  useResponseStart: vi.fn(),
  usePromptData: vi.fn(() => undefined),
  useSandbox: vi.fn(),
  useTool: vi.fn(),
  useSkill: vi.fn(),
  defineTool: vi.fn((tool: unknown) => tool),
  defineSkill: vi.fn((skill: unknown) => skill),
  InputTooLargeError: class InputTooLargeError extends Error {},
}));
const pluginHost = vi.hoisted(() => ({
  agentPluginHostContext: vi.fn(() => {
    throw new Error("Host context is read only when a tool runs.");
  }),
  agentThreadToolsContext: vi.fn(() => {
    throw new Error("Host context is read only when a tool runs.");
  }),
  resolveAgentPluginTools: vi.fn(),
}));

const mcp = vi.hoisted(() => ({
  createAuthorizedMcpFetch: vi.fn(() => vi.fn()),
  resolveMcpCredential: vi.fn(),
}));
const skills = vi.hoisted(() => ({
  createSkillResourceTool: vi.fn(() => ({
    name: "read_dx_skill_resource",
    run: vi.fn(),
  })),
}));
const plugins = vi.hoisted(() => ({
  createPluginTool: vi.fn((_threadId, { name }) => ({ name, run: vi.fn() })),
  invokePluginLive: vi.fn(),
}));
const threadTools = vi.hoisted(() => ({
  createThreadTools: vi.fn((): unknown[] => []),
}));
const automationTools = vi.hoisted(() => ({
  createAutomationTools: vi.fn((): unknown[] => []),
}));
const storageTools = vi.hoisted(() => ({
  createThreadStorageTools: vi.fn((): unknown[] => []),
}));
const runtime = vi.hoisted(() => ({
  capabilities: "workspace" as "model-only" | "workspace",
  execution: { createSandbox: vi.fn() },
  selectModel: vi.fn(),
  resolvePromptData: vi.fn(),
}));

vi.mock("@flue/runtime", () => hooks);
vi.mock("../runtime/agent-composition.js", () => ({
  agentRuntimeComposition: {
    get capabilities() {
      return runtime.capabilities;
    },
    execution: runtime.execution,
    model: {
      select: runtime.selectModel,
      resolvePromptData: runtime.resolvePromptData,
    },
  },
}));
vi.mock("../settings/mcp-servers/execution.js", () => mcp);
vi.mock("../settings/skills/execution.js", () => skills);
vi.mock("../settings/plugins/execution.js", () => ({
  invokePluginLive: plugins.invokePluginLive,
}));
vi.mock("../plugins/agent-context.js", () => pluginHost);
vi.mock("../threads/agent-tools.js", () => threadTools);
vi.mock("../automations/agent-tools.js", () => automationTools);
vi.mock("../thread-storage/agent-tools.js", () => storageTools);
vi.mock("../portals/prompt.js", () => ({ threadPortalPrompt: () => "" }));
vi.mock("../plugins/code/providers/wasm.js", () => ({ getCodeWasm: vi.fn() }));
vi.mock("../settings/plugins/flue.js", () => ({
  createPluginTool: plugins.createPluginTool,
}));

import { BUILT_IN_SKILL_NAMES } from "./built-in-skill-names.js";
import { DxAgent } from "./dx-agent.js";
import { DxAgentInitialDataSchema } from "./dx-agent-initial-data.js";
import { dxAgentPrompt } from "./dx-agent-prompt.js";

describe("DxAgent", () => {
  beforeEach(() => {
    runtime.capabilities = "workspace";
    hooks.useSkill.mockReset();
    hooks.useInitialData.mockReset();
    hooks.useMcpConnection.mockReset();
    hooks.useAgentFinish.mockReset();
    hooks.useAgentStart.mockReset();
    hooks.useModel.mockClear();
    hooks.useResponseStart.mockReset();
    hooks.useSandbox.mockClear();
    hooks.useTool.mockReset();
    skills.createSkillResourceTool.mockClear();
    plugins.createPluginTool.mockClear();
    plugins.invokePluginLive.mockReset();
    runtime.execution.createSandbox.mockReset().mockResolvedValue({});
    runtime.selectModel.mockReset().mockImplementation(() => ({
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      options: undefined,
    }));
  });

  it("always mounts code_exec and adds tool_search only with a reviewed MCP module", () => {
    const connection = {
      id: "mcp_test",
      name: "dx_mcp_test",
      displayName: "Linear",
      endpoint: "https://example.com/mcp",
      authenticated: false,
      timeoutMs: 10_000,
      tools: ["list_issues"],
    };
    for (const [active, connections, expected] of [
      [true, [connection], ["code_exec", "tool_search"]],
      [false, [connection], []],
      [true, [], ["code_exec"]],
      [true, [{ ...connection, tools: [] }], ["code_exec"]],
    ] as const) {
      hooks.useTool.mockClear();
      hooks.usePromptData.mockReturnValueOnce({
        plugins: {
          submissionId: "sub_code",
          tools: active
            ? [{ pluginId: "code", capabilities: ["code.execute"] }]
            : [],
          mcpConnections: connections,
        },
      } as never);
      DxAgent({ id: "thr_code" });
      expect(
        hooks.useTool.mock.calls.map(
          ([tool]) => (tool as { name: string }).name,
        ),
      ).toEqual(expected);
    }
  });

  it("mounts first-party Search tools from the submission's resolved tool set", () => {
    const toolNames = () =>
      hooks.useTool.mock.calls.map(([tool]) => (tool as { name: string }).name);
    const submission = (tools: unknown) => ({
      plugins: { submissionId: "sub_1", tools },
    });

    hooks.usePromptData.mockReturnValueOnce(
      submission([
        { pluginId: "search", capabilities: ["web.search", "web.read"] },
      ]) as never,
    );
    const prompt = DxAgent({ id: "thr_search_enabled" });
    expect(toolNames()).toEqual(["web_search", "read_web_page"]);
    expect(pluginHost.agentPluginHostContext).not.toHaveBeenCalled();
    expect(prompt).toBe(dxAgentPrompt);

    hooks.useTool.mockReset();
    hooks.usePromptData.mockReturnValueOnce(
      submission([{ pluginId: "search", capabilities: ["web.read"] }]) as never,
    );
    DxAgent({ id: "thr_search_read_only" });
    expect(toolNames()).toEqual(["read_web_page"]);

    // Search disabled or unresolvable for this submission: no web tools and
    // no mention of them in the prompt.
    hooks.useTool.mockReset();
    hooks.usePromptData.mockReturnValueOnce(submission([]) as never);
    const disabledPrompt = DxAgent({ id: "thr_search_disabled" });
    expect(toolNames()).toEqual([]);
    expect(disabledPrompt).not.toMatch(/web_search|read_web_page|web search/i);
  });

  it("mounts dx's workspace and built-in skills through Flue in a workspace Thread only", () => {
    const prompt = DxAgent({ id: "thr_workspace" });
    expect(
      hooks.useSkill.mock.calls.map(
        ([skill]) => (skill as { name: string }).name,
      ),
    ).toEqual(["dx-workspace", ...BUILT_IN_SKILL_NAMES]);
    expect(prompt).toContain("activate the dx-workspace skill");

    hooks.useSkill.mockReset();
    runtime.capabilities = "model-only";
    DxAgent({ id: "thr_model_preview" });
    expect(hooks.useSkill).not.toHaveBeenCalled();
  });

  it("mounts the built-in Thread tools in every workspace Thread, with no plugin enabled", () => {
    threadTools.createThreadTools.mockReturnValueOnce([
      { name: "create_thread", run: vi.fn() },
      { name: "send_thread_message", run: vi.fn() },
    ]);
    automationTools.createAutomationTools.mockReturnValueOnce([
      { name: "set_schedule", run: vi.fn() },
    ]);
    storageTools.createThreadStorageTools.mockReturnValueOnce([
      { name: "download_thread_file", run: vi.fn() },
    ]);
    hooks.usePromptData.mockReturnValueOnce({
      plugins: { submissionId: "sub_1", tools: [] },
    } as never);
    const prompt = DxAgent({ id: "thr_existing" });
    expect(storageTools.createThreadStorageTools).toHaveBeenCalledWith(
      "thr_existing",
      pluginHost.agentThreadToolsContext,
    );
    expect(threadTools.createThreadTools).toHaveBeenCalledWith(
      "thr_existing",
      pluginHost.agentThreadToolsContext,
      "sub_1",
      false,
    );
    expect(automationTools.createAutomationTools).toHaveBeenCalledWith(
      "thr_existing",
      pluginHost.agentThreadToolsContext,
      "sub_1",
    );
    expect(
      hooks.useTool.mock.calls.map(([tool]) => (tool as { name: string }).name),
    ).toEqual([
      "create_thread",
      "send_thread_message",
      "download_thread_file",
      "set_schedule",
    ]);
    expect(pluginHost.agentThreadToolsContext).not.toHaveBeenCalled();
    expect(prompt).toMatch(/create_thread/);

    hooks.useTool.mockReset();
    threadTools.createThreadTools.mockClear();
    runtime.capabilities = "model-only";
    DxAgent({ id: "thr_model_preview" });
    expect(threadTools.createThreadTools).not.toHaveBeenCalled();
    expect(hooks.useTool).not.toHaveBeenCalled();
  });

  it("never mounts plugin tools in the model-only preview", () => {
    runtime.capabilities = "model-only";
    hooks.usePromptData.mockReturnValueOnce({
      plugins: {
        submissionId: "sub_1",
        tools: [
          { pluginId: "search", capabilities: ["web.search", "web.read"] },
        ],
      },
    } as never);
    DxAgent({ id: "thr_preview_search" });
    expect(hooks.useTool).not.toHaveBeenCalled();
  });

  it("resolves the plugin tool set once per prompt submission and fails visibly", async () => {
    runtime.resolvePromptData.mockResolvedValue({
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      thinking: "medium",
    });
    pluginHost.resolveAgentPluginTools.mockResolvedValueOnce({
      submissionId: "sub_1",
      tools: [{ pluginId: "search", capabilities: ["web.search"] }],
    });
    const context = {
      instanceId: "thr_1",
      agentName: "dx-agent",
      scope: { kind: "prompt", submissionId: "sub_1" },
      signal: new AbortController().signal,
      recovery: false,
    } as never;
    await expect(
      DxAgent.resolvePromptData?.(undefined, context),
    ).resolves.toEqual({
      route: {
        model: "cloudflare/@cf/zai-org/glm-5.3-flash",
        thinking: "medium",
      },
      plugins: {
        submissionId: "sub_1",
        tools: [{ pluginId: "search", capabilities: ["web.search"] }],
      },
    });
    expect(pluginHost.resolveAgentPluginTools).toHaveBeenCalledWith(
      "thr_1",
      "sub_1",
    );

    pluginHost.resolveAgentPluginTools.mockRejectedValueOnce(
      new Error("D1 unavailable"),
    );
    await expect(
      DxAgent.resolvePromptData?.(undefined, context),
    ).rejects.toThrow("D1 unavailable");

    pluginHost.resolveAgentPluginTools.mockClear();
    runtime.capabilities = "model-only";
    runtime.resolvePromptData.mockResolvedValue(undefined);
    await expect(
      DxAgent.resolvePromptData?.(undefined, context),
    ).resolves.toBeUndefined();
    expect(pluginHost.resolveAgentPluginTools).not.toHaveBeenCalled();
  });

  describe("workspace activation in the attempt", () => {
    const context = (instanceId: string) =>
      ({
        instanceId,
        agentName: "dx-agent",
        scope: { kind: "prompt", submissionId: "sub_1" },
        signal: new AbortController().signal,
        recovery: false,
      }) as never;
    const deferred = <T>() => {
      let resolve: (value: T) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      return { promise, resolve, reject };
    };
    /** The factory the rendered agent hands Flue. */
    const renderedSandbox = (id: string) => {
      hooks.useInitialData.mockReturnValue(undefined);
      DxAgent({ id });
      return hooks.useSandbox.mock.calls.at(-1)?.[0] as {
        createSandbox: (request: { id: string }) => Promise<unknown>;
      };
    };

    beforeEach(() => {
      pluginHost.resolveAgentPluginTools.mockReset().mockResolvedValue({
        submissionId: "sub_1",
        tools: [],
      });
    });

    it("starts while the route resolves and hands Flue that same sandbox", async () => {
      const route = deferred<unknown>();
      runtime.resolvePromptData.mockReturnValueOnce(route.promise);
      const sandbox = { id: "started" };
      runtime.execution.createSandbox.mockResolvedValueOnce(sandbox);

      const resolving = DxAgent.resolvePromptData?.(
        undefined,
        context("thr_overlap"),
      );
      expect(runtime.execution.createSandbox).toHaveBeenCalledExactlyOnceWith({
        id: "thr_overlap",
      });
      route.resolve({ model: "test/model", thinking: "medium" });
      await resolving;

      const factory = renderedSandbox("thr_overlap");
      await expect(factory.createSandbox({ id: "thr_overlap" })).resolves.toBe(
        sandbox,
      );
      expect(runtime.execution.createSandbox).toHaveBeenCalledOnce();
      // A later createSandbox in the same attempt activates on its own.
      await factory.createSandbox({ id: "thr_overlap" });
      expect(runtime.execution.createSandbox).toHaveBeenCalledTimes(2);
    });

    it("fails the run with the activation's own error", async () => {
      runtime.resolvePromptData.mockResolvedValueOnce({
        model: "test/model",
        thinking: "medium",
      });
      const failure = new Error("workspace unavailable");
      runtime.execution.createSandbox.mockRejectedValueOnce(failure);

      await expect(
        DxAgent.resolvePromptData?.(undefined, context("thr_failed")),
      ).resolves.toBeDefined();
      await expect(
        renderedSandbox("thr_failed").createSandbox({ id: "thr_failed" }),
      ).rejects.toBe(failure);
    });

    it("fails with the route error and leaves no started sandbox behind", async () => {
      runtime.resolvePromptData.mockRejectedValueOnce(
        new Error("Model routing unavailable: test"),
      );
      await expect(
        DxAgent.resolvePromptData?.(undefined, context("thr_route")),
      ).rejects.toThrow("Model routing unavailable: test");

      const fresh = { id: "fresh" };
      runtime.execution.createSandbox.mockResolvedValueOnce(fresh);
      await expect(
        renderedSandbox("thr_route").createSandbox({ id: "thr_route" }),
      ).resolves.toBe(fresh);
      expect(runtime.execution.createSandbox).toHaveBeenCalledTimes(2);
    });

    it("starts nothing in the model-only preview", async () => {
      runtime.capabilities = "model-only";
      runtime.resolvePromptData.mockResolvedValueOnce(undefined);
      await DxAgent.resolvePromptData?.(undefined, context("thr_preview"));
      expect(runtime.execution.createSandbox).not.toHaveBeenCalled();
    });
  });

  it("pins the durable identity", () => {
    expect(DxAgent.agentName).toBe("dx-agent");
    // Clients derive keyed submission IDs from it.
    expect(DxAgent.agentName).toBe(threadAgentName);
  });

  it("registers only Workers AI in the local model preview", () => {
    runtime.capabilities = "model-only";

    const prompt = DxAgent({ id: "thr_model_preview" });

    expect(prompt).toContain("local UI preview");
    expect(hooks.useModel).toHaveBeenCalledOnce();
    expect(hooks.useResponseStart).toHaveBeenCalledOnce();
    expect(hooks.useSandbox).not.toHaveBeenCalled();
    expect(hooks.useTool).not.toHaveBeenCalled();
    expect(hooks.useMcpConnection).not.toHaveBeenCalled();
    expect(hooks.useAgentStart).not.toHaveBeenCalled();
    expect(hooks.useAgentFinish).not.toHaveBeenCalled();
  });

  it("rejects more than ten images before Flue admits a user message", () => {
    expect(() =>
      DxAgent.validateInput?.({
        kind: "user",
        body: "Review these images.",
        attachments: Array.from({ length: 11 }, () => ({
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        })),
      }),
    ).toThrow(hooks.InputTooLargeError);
    expect(() =>
      DxAgent.validateInput?.({
        kind: "user",
        body: "Review these images.",
        attachments: Array.from({ length: 10 }, () => ({
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        })),
      }),
    ).not.toThrow();
  });

  it("never mounts MCP servers directly; they are reachable only through Code", () => {
    hooks.usePromptData.mockReturnValueOnce({
      plugins: {
        submissionId: "sub_mcp",
        tools: [{ pluginId: "code", capabilities: ["code.execute"] }],
        mcpConnections: [
          {
            id: "mcp_00000000-0000-4000-8000-000000000036",
            name: "dx_mcp_00000000-0000-4000-8000-000000000036",
            endpoint: "https://mcp.example.com/mcp",
            timeoutMs: 10_000,
            authenticated: true,
            tools: ["read_status"],
          },
        ],
      },
    } as never);

    DxAgent({ id: "thr_00000000-0000-4000-8000-000000000036" });

    expect(hooks.useMcpConnection).not.toHaveBeenCalled();
    expect(mcp.createAuthorizedMcpFetch).not.toHaveBeenCalled();
  });

  it("injects immutable skill instructions once and mounts lazy resources without prompt blobs", () => {
    const instruction = "EXACTLY-ONCE-SKILL-INSTRUCTION";
    hooks.useInitialData.mockReturnValue({
      personalInstructions: "",
      settingsRevision: 0,
      settingsVersion: 1,
      skills: [
        {
          id: "skl_00000000-0000-4000-8000-000000000044",
          version: 3,
          name: "review-guidelines",
          scope: "workspace",
          integrity: "a".repeat(64),
          description: "Repository review guidance.",
          instructions: instruction,
          resources: [
            {
              path: "resources/private.md",
              mediaType: "text/markdown",
              sizeBytes: 24,
              integrity: "b".repeat(64),
            },
          ],
        },
      ],
    });

    const prompt = DxAgent({
      id: "thr_00000000-0000-4000-8000-000000000044",
    });

    expect(prompt.split(instruction)).toHaveLength(2);
    expect(prompt).toContain("skl_00000000-0000-4000-8000-000000000044 v3");
    expect(prompt).toContain("resources/private.md");
    expect(prompt).not.toContain("PRIVATE-RESOURCE-BODY");
    expect(skills.createSkillResourceTool).toHaveBeenCalledOnce();
    expect(skills.createSkillResourceTool).toHaveBeenCalledWith(
      "thr_00000000-0000-4000-8000-000000000044",
    );
    expect(hooks.useTool).toHaveBeenCalledOnce();
    expect(hooks.useTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_dx_skill_resource" }),
    );
  });

  it("mounts trusted plugin tools and dispatches lifecycle hooks through the isolated runtime", async () => {
    const plugin = {
      id: "plg_00000000-0000-4000-8000-000000000045",
      version: "1.0.0",
      name: "review-helper",
      scope: "personal",
      integrity: "a".repeat(64),
      displayName: "Review helper",
      description: "Review input.",
      tools: [{ name: "summarize", description: "Summarize input." }],
      lifecycle: ["agent-start", "agent-finish"],
    };
    hooks.useInitialData.mockReturnValue({
      personalInstructions: "",
      settingsRevision: 0,
      settingsVersion: 1,
      plugins: [plugin],
    });
    const threadId = "thr_00000000-0000-4000-8000-000000000045";
    DxAgent({ id: threadId });

    expect(plugins.createPluginTool).toHaveBeenCalledWith(threadId, {
      id: plugin.id,
      version: "1.0.0",
      name: "summarize",
      description: "Summarize input.",
    });
    expect(hooks.useTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "summarize" }),
    );
    expect(hooks.useAgentStart).toHaveBeenCalledOnce();
    expect(hooks.useAgentFinish).toHaveBeenCalledOnce();

    const sandbox = {};
    const log = { error: vi.fn() };
    await hooks.useAgentStart.mock.calls[0]?.[0]({
      harness: { sandbox },
      log,
    });
    await hooks.useAgentFinish.mock.calls[0]?.[0]({
      harness: { sandbox },
      log,
    });
    expect(plugins.invokePluginLive).toHaveBeenNthCalledWith(
      1,
      threadId,
      plugin.id,
      "1.0.0",
      { kind: "lifecycle", name: "agent-start" },
      null,
      sandbox,
    );
    expect(plugins.invokePluginLive).toHaveBeenNthCalledWith(
      2,
      threadId,
      plugin.id,
      "1.0.0",
      { kind: "lifecycle", name: "agent-finish" },
      null,
      sandbox,
    );
  });

  it("names tool failures whose error has no message", async () => {
    class PluginExecutionLimited extends Error {
      override name = "PluginExecutionLimited";
    }
    const described = new Error("Plugin input is too large.");
    plugins.createPluginTool
      .mockReturnValueOnce({
        name: "silent",
        run: vi.fn(async () => {
          throw new PluginExecutionLimited();
        }),
      })
      .mockReturnValueOnce({
        name: "described",
        run: vi.fn(async () => {
          throw described;
        }),
      });
    hooks.useInitialData.mockReturnValue({
      personalInstructions: "",
      settingsRevision: 0,
      settingsVersion: 1,
      plugins: [
        {
          id: "plg_00000000-0000-4000-8000-000000000046",
          version: "1.0.0",
          name: "limits",
          scope: "personal",
          integrity: "a".repeat(64),
          displayName: "Limits",
          description: "Limits.",
          tools: [
            { name: "silent", description: "Fails silently." },
            { name: "described", description: "Fails with a message." },
          ],
          lifecycle: [],
        },
      ],
    });
    DxAgent({ id: "thr_00000000-0000-4000-8000-000000000046" });

    const [silent, withMessage] = hooks.useTool.mock.calls.map(
      ([tool]) => tool as { run: (context: unknown) => Promise<unknown> },
    );
    await expect(silent?.run({})).rejects.toThrow(
      "silent failed: PluginExecutionLimited.",
    );
    await expect(withMessage?.run({})).rejects.toBe(described);
  });

  it("requires bounded immutable creation data for new Flue instances", () => {
    expect(
      v.safeParse(DxAgentInitialDataSchema, {
        personalInstructions: "Use targeted checks.",
        settingsRevision: 0,
        settingsVersion: 1,
        selection: { kind: "mode", profileId: "default", mode: "medium" },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(DxAgentInitialDataSchema, {
        personalInstructions: "x".repeat(10_001),
        settingsRevision: 0,
        settingsVersion: 1,
        selection: { kind: "mode", profileId: "default", mode: "medium" },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(DxAgentInitialDataSchema, {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        mcpConnections: Array.from(
          { length: MAX_MCP_SERVERS_PER_THREAD + 1 },
          (_, index) => ({
            id: `mcp_${index}`,
            name: `server_${index}`,
            endpoint: "https://mcp.example.com/mcp",
            timeoutMs: 10_000,
            authenticated: false,
            tools: [],
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(DxAgentInitialDataSchema, {
        personalInstructions: "",
        settingsRevision: 0,
        settingsVersion: 1,
        skills: Array.from({ length: 21 }, (_, index) => ({
          id: `skl_${index}`,
          version: 1,
          name: `skill-${index}`,
          scope: "personal",
          integrity: "a".repeat(64),
          description: "Bounded skill",
          instructions: "Use bounded behavior.",
          resources: [],
        })),
      }).success,
    ).toBe(false);
    expect(DxAgent.initialData).toBe(DxAgentInitialDataSchema);
  });
});
