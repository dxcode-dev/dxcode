import type { AgentProps } from "@flue/runtime";
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
  defineTool: vi.fn((tool: unknown) => tool),
  InputTooLargeError: class InputTooLargeError extends Error {},
}));
const pluginHost = vi.hoisted(() => ({
  agentPluginHostContext: vi.fn(() => {
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
vi.mock("../plugins/code/providers/wasm.js", () => ({ getCodeWasm: vi.fn() }));
vi.mock("../settings/plugins/flue.js", () => ({
  createPluginTool: plugins.createPluginTool,
}));

import { DxAgent } from "./dx-agent.js";
import { DxAgentInitialDataSchema } from "./dx-agent-initial-data.js";
import { dxAgentPrompt } from "./dx-agent-prompt.js";

describe("DxAgent", () => {
  beforeEach(() => {
    runtime.capabilities = "workspace";
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
    runtime.selectModel.mockReset().mockImplementation(() => ({
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      options: undefined,
    }));
  });

  it("selects its model, workspace, and instructions", () => {
    const props = Object.freeze({
      id: "thr_00000000-0000-4000-8000-000000000005",
    }) satisfies AgentProps;

    expect(DxAgent(props)).toBe(dxAgentPrompt);
    expect(props.id).toBe("thr_00000000-0000-4000-8000-000000000005");
    expect(hooks.useModel).toHaveBeenCalledOnce();
    expect(hooks.useModel).toHaveBeenCalledWith(
      "cloudflare/@cf/zai-org/glm-5.3-flash",
      undefined,
    );
    expect(hooks.useResponseStart).toHaveBeenCalledOnce();
    const responseStart = hooks.useResponseStart.mock.calls[0]?.[0];
    expect(responseStart?.()).toEqual({
      dxResponseStartedAt: expect.any(String),
    });
    expect(hooks.useSandbox).toHaveBeenCalledOnce();
    expect(hooks.useSandbox).toHaveBeenCalledWith(runtime.execution);
    expect(hooks.useAgentStart).toHaveBeenCalledOnce();
    expect(hooks.useTool).not.toHaveBeenCalled();
  });

  it("injects the resolved personal content exactly once at the top-level prompt boundary", () => {
    const content = "EXACTLY-ONCE-PERSONAL-INSTRUCTION";
    hooks.useInitialData.mockReturnValue({
      personalInstructions: content,
      settingsRevision: 5,
      settingsVersion: 1,
      selection: { kind: "mode", profileId: "default", mode: "high" },
    });

    const prompt = DxAgent({ id: "thr_existing" });
    expect(prompt.split(content)).toHaveLength(2);
    expect(prompt).toContain("top-level dx agent");
    expect(prompt).toContain(
      "do not automatically apply to delegated agents, specialized agents, or system tasks",
    );
    expect(hooks.useModel).toHaveBeenCalledWith(
      "cloudflare/@cf/zai-org/glm-5.3-flash",
      undefined,
    );
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
      hooks.useInitialData.mockReturnValue({ mcpConnections: connections });
      hooks.usePromptData.mockReturnValueOnce({
        plugins: {
          submissionId: "sub_code",
          tools: active
            ? [{ pluginId: "code", capabilities: ["code.execute"] }]
            : [],
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

  it("pins the durable identity", () => {
    expect(DxAgent.agentName).toBe("dx-agent");
  });

  it("lets Flue run a submission for seven days", () => {
    expect(DxAgent.durability).toEqual({ timeoutMs: 604_800_000 });
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
    hooks.useInitialData.mockReturnValue({
      personalInstructions: "",
      settingsRevision: 0,
      settingsVersion: 1,
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
    });

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
        mcpConnections: Array.from({ length: 21 }, (_, index) => ({
          id: `mcp_${index}`,
          name: `server_${index}`,
          endpoint: "https://mcp.example.com/mcp",
          timeoutMs: 10_000,
          authenticated: false,
          tools: [],
        })),
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
