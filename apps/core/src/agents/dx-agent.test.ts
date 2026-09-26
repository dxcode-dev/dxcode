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
  InputTooLargeError: class InputTooLargeError extends Error {},
}));

const mcp = vi.hoisted(() => ({
  createAuthorizedMcpFetch: vi.fn(() => vi.fn()),
  resolveMcpCredential: vi.fn(),
}));
const skills = vi.hoisted(() => ({
  createSkillResourceTool: vi.fn(() => ({ name: "read_dx_skill_resource" })),
}));
const plugins = vi.hoisted(() => ({
  createPluginTool: vi.fn((_threadId, { name }) => ({ name })),
  invokePluginLive: vi.fn(),
}));
const runtime = vi.hoisted(() => ({
  capabilities: "workspace" as "model-only" | "workspace",
  execution: { createSandbox: vi.fn() },
  selectModel: vi.fn(),
}));

vi.mock("@flue/runtime", () => hooks);
vi.mock("../runtime/agent-composition.js", () => ({
  agentRuntimeComposition: {
    get capabilities() {
      return runtime.capabilities;
    },
    execution: runtime.execution,
    model: { select: runtime.selectModel },
  },
}));
vi.mock("../source-control/tools.js", () => ({
  sourceControlTools: vi.fn((threadId: string) => [
    { name: "pull_request", threadId },
  ]),
}));
vi.mock("../settings/mcp-servers/execution.js", () => mcp);
vi.mock("../settings/skills/execution.js", () => skills);
vi.mock("../settings/plugins/execution.js", () => ({
  invokePluginLive: plugins.invokePluginLive,
}));
vi.mock("../settings/plugins/flue.js", () => ({
  createPluginTool: plugins.createPluginTool,
}));

import { sourceControlTools } from "../source-control/tools.js";
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
    expect(sourceControlTools).toHaveBeenCalledWith(props.id);
    expect(hooks.useTool).toHaveBeenCalledWith({
      name: "pull_request",
      threadId: props.id,
    });
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

  it("pins the durable identity", () => {
    expect(DxAgent.agentName).toBe("dx-agent");
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

  it("mounts reviewed MCP tools through Flue with stable names and current authorization adapters", () => {
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

    expect(hooks.useMcpConnection).toHaveBeenCalledOnce();
    expect(hooks.useMcpConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "dx_mcp_00000000-0000-4000-8000-000000000036",
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        tools: ["read_status"],
        timeoutMs: 10_000,
        optional: true,
        auth: expect.any(Function),
        fetch: expect.any(Function),
      }),
    );
    expect(mcp.createAuthorizedMcpFetch).toHaveBeenCalledWith(
      "thr_00000000-0000-4000-8000-000000000036",
      "mcp_00000000-0000-4000-8000-000000000036",
      "https://mcp.example.com/mcp",
      10_000,
    );
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
    expect(hooks.useTool).toHaveBeenCalledTimes(2);
    expect(hooks.useTool).toHaveBeenCalledWith({
      name: "read_dx_skill_resource",
    });
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
    expect(hooks.useTool).toHaveBeenCalledWith({ name: "summarize" });
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
