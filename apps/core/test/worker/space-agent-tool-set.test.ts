import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

const owner = "orb-free-owner" as UserId;
const projectId = "prj_00000000-0000-4000-8000-0000000005a0";

/**
 * What DxAgent mounts for a Space's main thread and for every other Thread,
 * rendered with dx's real tool factories; only Flue's hooks and the model
 * route are stand-ins.
 *
 * Ways it could go wrong: a Space's thread starts an Orb, mounts shell,
 * file, or Git tools, or keeps a tool that writes into a workspace it does
 * not have; it misses a tool the Space contract names; an ordinary Thread,
 * or a thread a Space started, loses a tool, gains a Space tool, or reads
 * the Space's prompt; create_thread changes shape outside a Space.
 */

const flue = vi.hoisted(() => ({
  initialData: undefined as unknown,
  promptData: undefined as unknown,
  tools: [] as Array<{ readonly name: string; readonly input?: unknown }>,
  skills: [] as string[],
  sandboxes: 0,
  agentStarts: 0,
}));

const execution = vi.hoisted(() => ({
  createSandbox: vi.fn(async () => ({})),
}));

vi.mock("@flue/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flue/runtime")>();
  return {
    ...actual,
    useInitialData: () => flue.initialData,
    usePromptData: () => flue.promptData,
    useModel: () => undefined,
    useResponseStart: () => undefined,
    useDelivery: () => undefined,
    useSandbox: () => {
      flue.sandboxes += 1;
    },
    useTool: (tool: { name: string; input?: unknown }) => {
      flue.tools.push(tool);
    },
    useSkill: (skill: { name: string }) => {
      flue.skills.push(skill.name);
    },
    useAgentStart: () => {
      flue.agentStarts += 1;
    },
    useAgentFinish: () => undefined,
  };
});

vi.mock("../../src/runtime/agent-composition.js", () => ({
  agentRuntimeComposition: {
    capabilities: "workspace",
    execution,
    model: {
      select: () => ({
        model: "cloudflare/@cf/zai-org/glm-5.3-flash",
        options: undefined,
      }),
      resolvePromptData: async () => undefined,
    },
  },
}));

const { DxAgent } = await import("../../src/agents/dx-agent.js");
const { dxAgentPrompt } = await import("../../src/agents/dx-agent-prompt.js");
const { buildSpaceSystemPrompt } = await import(
  "../../src/spaces/agent/system-prompt.js"
);
const { SPACE_TOOL_PARAMETER_DESCRIPTIONS } = await import(
  "../../src/spaces/agent/tool-descriptions.js"
);

const plugins = {
  submissionId: "sub_1",
  tools: [
    { pluginId: "search", capabilities: ["web.search", "web.read"] },
    { pluginId: "code", capabilities: ["code.execute"] },
  ],
  mcpConnections: [
    {
      id: "mcp_test",
      name: "dx_mcp_test",
      displayName: "Linear",
      endpoint: "https://example.com/mcp",
      authenticated: false,
      timeoutMs: 10_000,
      tools: ["list_issues"],
    },
  ],
};

const initialData = {
  personalInstructions: "",
  settingsRevision: 0,
  settingsVersion: 1,
};

const space = {
  spaceName: "Checkout v2",
  goal: "Ship the one-page checkout",
  project: { name: "checkout", repositories: ["https://github.com/o/r"] },
  threadUrl: "https://dx.example.com/threads/thr_space",
  origin: "https://dx.example.com",
  ownerName: "Ada Owner",
};

const names = () => flue.tools.map(({ name }) => name).sort();

const inputOf = (name: string) =>
  flue.tools.find((tool) => tool.name === name)?.input;

const inputKeys = (name: string) =>
  Object.keys(
    (
      flue.tools.find((tool) => tool.name === name)?.input as
        | { entries?: Record<string, unknown> }
        | undefined
    )?.entries ?? {},
  ).sort();

/** Every tool an ordinary dx-mode Thread had before Spaces v2. */
const ORDINARY_TOOLS = [
  "artifact",
  "clear_schedule",
  "code_exec",
  "create_github_subscription",
  "create_thread",
  "delete_github_subscription",
  "download_thread_changes",
  "download_thread_file",
  "find_thread",
  "get_github_subscription",
  "get_schedule",
  "get_thread_status",
  "link_github_issue",
  "list_agent_modes",
  "list_github_subscriptions",
  "list_orbs",
  "manage_dx",
  "notify_user",
  "read_thread",
  "read_web_page",
  "send_thread_message",
  "set_schedule",
  "thread_file_url",
  "tool_search",
  "update_github_subscription",
  "update_schedule",
  "update_thread",
  "upload_thread_file",
  "wait_for_threads",
  "web_search",
];

/** The Space contract's tools, as a deployment with web search has them. */
const SPACE_TOOLS = [
  // Space only.
  "add_thread_to_space",
  "archive_threads",
  "edit_post",
  "get_current_time",
  "get_current_user_identity",
  "list_space_threads",
  "list_workspace_members",
  "post",
  "react",
  "read_posts",
  "search_dx_documentation",
  "set_thread_status",
  "unreact",
  "update_space",
  // Kept dx tools.
  "artifact",
  "clear_schedule",
  "code_exec",
  "create_thread",
  "find_thread",
  "get_schedule",
  "get_thread_status",
  "list_agent_modes",
  "list_orbs",
  "notify_user",
  "read_thread",
  "read_web_page",
  "send_thread_message",
  "set_schedule",
  "thread_file_url",
  "tool_search",
  "update_schedule",
  "update_thread",
  "web_search",
].sort();

beforeEach(() => {
  flue.tools.length = 0;
  flue.skills.length = 0;
  flue.sandboxes = 0;
  flue.agentStarts = 0;
  execution.createSandbox.mockClear();
});

beforeEach(() => seedSpaceUsers([owner]));

describe("DxAgent's tool set", () => {
  it("keeps an ordinary Thread's Orb, tools, and prompt as they were", () => {
    flue.initialData = initialData;
    flue.promptData = { plugins };
    const prompt = DxAgent({ id: "thr_ordinary" } as never) as string;
    expect(flue.sandboxes).toBe(1);
    expect(names()).toEqual(ORDINARY_TOOLS);
    expect(prompt.startsWith(dxAgentPrompt)).toBe(true);
    expect(prompt).not.toMatch(/\bSpace\b/);
    expect(inputKeys("create_thread")).not.toContain("request_post_id");
    expect(inputKeys("send_thread_message")).toEqual(["message", "thread"]);
  });

  it("keeps a thread a Space started as an ordinary Thread", () => {
    flue.initialData = {
      ...initialData,
      startedByThreadId: "thr_00000000-0000-4000-8000-000000000001",
    };
    flue.promptData = { plugins, startingSpace: { name: "Checkout v2" } };
    DxAgent({ id: "thr_child" } as never);
    expect(flue.sandboxes).toBe(1);
    expect(names()).toEqual(ORDINARY_TOOLS);
  });

  it("gives a Space's main thread no Orb, only the Space's tools, and the Space's prompt", () => {
    flue.initialData = initialData;
    // What resolvePromptData resolved for a Space from D1.
    flue.promptData = { plugins, space, orbFree: true };
    const prompt = DxAgent({ id: "thr_space" } as never) as string;
    expect(flue.sandboxes).toBe(0);
    // Nothing installs skills or plugins into a workspace it lacks.
    expect(flue.agentStarts).toBe(0);
    expect(names()).toEqual(SPACE_TOOLS);
    expect(names()).not.toEqual(
      expect.arrayContaining(["shell_command", "view_media"]),
    );
    expect(prompt.startsWith(buildSpaceSystemPrompt(space))).toBe(true);
    expect(prompt).not.toContain(dxAgentPrompt.slice(0, 60));
    expect(inputKeys("create_thread")).toContain("request_post_id");
    expect(inputKeys("send_thread_message")).toContain("ship");
    // Its words come from the Space's words file.
    expect(JSON.stringify(inputOf("send_thread_message"))).toContain(
      JSON.stringify(
        SPACE_TOOL_PARAMETER_DESCRIPTIONS.send_thread_message?.ship,
      ).slice(1, -1),
    );
    // Skills load on demand, from dx's declarations alone.
    expect(flue.skills.length).toBeGreaterThan(0);
  });

  it("never starts an Orb for a Space's submission, whatever its creation data says", async () => {
    const spaceId = "thr_00000000-0000-4000-8000-0000000005a1";
    const ordinaryId = "thr_00000000-0000-4000-8000-0000000005a2";
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(
          project(projectId, owner, "checkout"),
        );
        const threads = yield* ThreadRepository;
        yield* threads.insert(thread(spaceId, projectId, owner));
        yield* threads.insert(thread(ordinaryId, projectId, owner));
      }),
    );
    // A Space's main Thread is created in executor mode (migration 0159
    // backfills older Spaces); the server's execution mode decides, a
    // client's claim in creation data does not.
    await env.DB.prepare(
      "UPDATE threads SET kind = 'space', execution_mode = 'executor' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    const resolved = await DxAgent.resolvePromptData(
      { ...initialData, space: false },
      { instanceId: spaceId, scope: undefined } as never,
    ).catch(() => undefined);
    expect(execution.createSandbox).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ orbFree: true });
    const ordinary = await DxAgent.resolvePromptData(
      { ...initialData, space: true },
      { instanceId: ordinaryId, scope: undefined } as never,
    ).catch(() => undefined);
    expect(execution.createSandbox).toHaveBeenCalledTimes(1);
    expect(ordinary?.orbFree).toBeUndefined();
  });

  it("runs a Claude Code Space only on its executor, never on an Orb", () => {
    flue.initialData = initialData;
    flue.promptData = {
      plugins,
      space,
      orbFree: true,
      route: { model: "claude-code/claude-opus-5-5", thinking: "medium" },
    };
    // This test Worker binds no executor (THREAD_EXECUTOR), so the Space
    // says so instead of falling back to an Orb.
    expect(() => DxAgent({ id: "thr_space_claude" } as never)).toThrow(
      /does not run dx's executor/,
    );
    expect(flue.sandboxes).toBe(0);
    expect(names().some((name) => name.startsWith("mcp__"))).toBe(false);
  });
});
