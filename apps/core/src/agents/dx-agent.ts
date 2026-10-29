"use agent";

import { MAX_IMAGES_PER_MESSAGE } from "@dx/api";
import { isClaudeCodeModel, type PluginToolSet } from "@dx/domain";
import {
  type AgentProps,
  type DeliveredMessage,
  InputTooLargeError,
  type ModelResolutionContext,
  type SandboxFactory,
  type ToolDefinition,
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useModel,
  usePromptData,
  useResponseStart,
  useSandbox,
  useSkill,
  useTool,
} from "@flue/runtime";
import { createAutomationTools } from "../automations/agent-tools.js";
import { claudeCodeDxTools } from "../claude-code/dx-tools.js";
import {
  rememberClaudeCodePrompt,
  resetClaudeCodeThreadState,
} from "../claude-code/provider.js";
import { rememberClaudeCodeSandbox } from "../claude-code/runs.js";
import { claudeCodeMirrorTools } from "../claude-code/tools.js";
import { traceSpan } from "../observability/tracing.js";
import {
  takeWorkspaceDisk,
  WORKSPACE_DISK_SIGNAL,
  workspaceDiskNote,
} from "../orb-disk/note.js";
import {
  agentPluginHostContext,
  agentThreadToolsContext,
  resolveAgentPluginTools,
} from "../plugins/agent-context.js";
import { firstPartyPluginTools } from "../plugins/tools.js";
import { threadPortalPrompt } from "../portals/prompt.js";
import {
  agentRuntimeComposition,
  type DxPromptData,
} from "../runtime/agent-composition.js";
import { AGENT_RUN_LIMIT_MS } from "../runtime/agent-run-limit.js";
import type { McpAgentConnectionData } from "../settings/mcp-servers/execution.js";
import { invokePluginLive } from "../settings/plugins/execution.js";
import { createPluginTool } from "../settings/plugins/flue.js";
import { createSkillResourceTool } from "../settings/skills/execution.js";
import { createThreadStorageTools } from "../thread-storage/agent-tools.js";
import { createThreadTools } from "../threads/agent-tools.js";
import {
  builtInSkillDefinitions,
  installBuiltInSkills,
} from "./built-in-skills.js";
import {
  type DxAgentInitialData,
  DxAgentInitialDataSchema,
} from "./dx-agent-initial-data.js";
import {
  composeClaudeCodePrompt,
  composeDxAgentPrompt,
  dxWorkspaceSkill,
} from "./dx-agent-prompt.js";

/** Per-submission data from `resolvePromptData`. */
interface DxAgentPromptData {
  readonly route?: DxPromptData;
  readonly plugins?: {
    readonly submissionId: string;
    readonly tools: PluginToolSet;
    /** The Thread owner's MCP servers as of this submission. */
    readonly mcpConnections: ReadonlyArray<McpAgentConnectionData>;
  };
}

const localModelPreviewPrompt = `You are dx, a coding assistant running in a local UI preview.
This preview intentionally has no sandbox, filesystem, shell, source-control, MCP, skill, or plugin tools.
Answer from the conversation context only. State plainly when a request would require workspace access.`;

/**
 * The model receives a failed tool's `error.message` as the tool result. dx's
 * tagged errors have an empty message, so name the failure instead.
 */
const withToolFailureMessage = <T extends ToolDefinition>(tool: T): T =>
  ({
    ...tool,
    run: async (context: never) => {
      try {
        return await tool.run(context);
      } catch (error) {
        if (error instanceof Error && error.message.trim() === "")
          throw new Error(`${tool.name} failed: ${error.name}.`, {
            cause: error,
          });
        throw error;
      }
    },
  }) as T;

/**
 * dx's own tools for one submission: skill resources, the thread tools,
 * first-party plugin tools (MCP servers reach the model only as Code's
 * modules, never mounted directly), and installed plugins. Plugin tools and
 * MCP servers come from the submission's resolved set, never from Thread
 * creation data; providers and keys resolve again on every call. Every tool
 * DxAgent offers belongs here: Claude Code mode serves this same list to
 * Claude as `mcp__dx__<name>`, so a tool mounted anywhere else would be
 * missing there (wiki/claude-code-tool-parity.md).
 */
const dxTools = (
  threadId: string,
  initialData: DxAgentInitialData | undefined,
  promptData: DxAgentPromptData | undefined,
  withoutPlugins: ReadonlyArray<string> = [],
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];
  if ((initialData?.skills ?? []).some((skill) => skill.resources.length > 0))
    tools.push(withToolFailureMessage(createSkillResourceTool(threadId)));
  // Built in, not a plugin: the owner's other Threads are always in reach.
  for (const tool of createThreadTools(
    threadId,
    agentThreadToolsContext,
    promptData?.plugins?.submissionId,
    promptData?.route !== undefined &&
      isClaudeCodeModel(promptData.route.model),
  ))
    tools.push(withToolFailureMessage(tool));
  // Files between the owner's Threads, and temporary links, through
  // Thread storage.
  for (const tool of createThreadStorageTools(
    threadId,
    agentThreadToolsContext,
  ))
    tools.push(withToolFailureMessage(tool));
  // Schedules, GitHub subscriptions, and notify_user: work after the turn.
  for (const tool of createAutomationTools(
    threadId,
    agentThreadToolsContext,
    promptData?.plugins?.submissionId,
  ))
    tools.push(withToolFailureMessage(tool));
  const pluginTools = promptData?.plugins;
  if (pluginTools !== undefined)
    for (const tool of firstPartyPluginTools(
      { threadId, submissionId: pluginTools.submissionId },
      pluginTools.tools.filter(
        ({ pluginId }) => !withoutPlugins.includes(pluginId),
      ),
      agentPluginHostContext,
      pluginTools.mcpConnections,
    ))
      tools.push(withToolFailureMessage(tool));
  for (const plugin of initialData?.plugins ?? [])
    for (const tool of plugin.tools)
      tools.push(
        withToolFailureMessage(
          createPluginTool(threadId, {
            id: plugin.id as never,
            version: plugin.version,
            name: tool.name as never,
            description: tool.description,
          }),
        ),
      );
  return tools;
};

type AgentSandbox = Awaited<ReturnType<SandboxFactory["createSandbox"]>>;

/**
 * Each attempt starts its Thread's workspace activation in
 * `resolvePromptData`, so the provider's create or connect overlaps model
 * routing; the attempt's first `createSandbox` takes that activation and
 * fails with its error. Only agent initialization creates a workspace.
 */
const startedActivations = new Map<string, Promise<AgentSandbox>>();
const execution = agentRuntimeComposition.execution;

const startActivation = (threadId: string) => {
  if (
    agentRuntimeComposition.capabilities !== "workspace" ||
    execution === undefined
  )
    return undefined;
  const started = execution.createSandbox({ id: threadId });
  // The attempt's createSandbox surfaces the failure.
  started.catch(() => undefined);
  startedActivations.set(threadId, started);
  return started;
};

const agentSandbox: SandboxFactory | undefined =
  execution === undefined
    ? undefined
    : {
        ...execution,
        createSandbox: (request) => {
          const started = startedActivations.get(request.id);
          if (started === undefined) return execution.createSandbox(request);
          startedActivations.delete(request.id);
          return started;
        },
      };

/**
 * Installed plugins' agent-start and agent-finish hooks. The agent-start
 * hook first writes dx's built-in skills into the workspace, for the dx
 * agent and Claude Code alike, then tells the agent when its disk is nearly
 * or completely full; Flue runs separate start hooks concurrently, so all
 * stay in one.
 */
const usePluginLifecycle = (
  threadId: string,
  plugins: DxAgentInitialData["plugins"],
) => {
  const hook =
    (name: "agent-start" | "agent-finish") =>
    async ({
      harness,
      log,
    }: Parameters<Parameters<typeof useAgentStart>[0]>[0]) => {
      for (const plugin of plugins.filter(({ lifecycle }) =>
        lifecycle.includes(name),
      )) {
        try {
          await invokePluginLive(
            threadId,
            plugin.id,
            plugin.version,
            { kind: "lifecycle", name },
            null,
            harness.sandbox,
          );
        } catch {
          log.error(`Trusted plugin ${name} hook failed.`, {
            pluginId: plugin.id,
            version: plugin.version,
          });
        }
      }
    };
  useAgentStart(async (context) => {
    // Opening the sandbox runs this turn's activation and its disk guard.
    await installBuiltInSkills(context.harness.sandbox);
    const disk = takeWorkspaceDisk(threadId);
    const note = disk === undefined ? undefined : workspaceDiskNote(disk);
    if (note !== undefined)
      context.append({
        kind: "signal",
        type: WORKSPACE_DISK_SIGNAL,
        body: note,
      });
    await hook("agent-start")(context);
  });
  if (plugins.some(({ lifecycle }) => lifecycle.includes("agent-finish")))
    useAgentFinish(hook("agent-finish"));
};

export function DxAgent(props: AgentProps) {
  const initialData = useInitialData<DxAgentInitialData | undefined>();
  const promptData = usePromptData<DxAgentPromptData | undefined>();
  const model = agentRuntimeComposition.model.select(promptData?.route);
  useModel(model.model, model.options);
  useResponseStart(() => ({
    dxResponseStartedAt: new Date().toISOString(),
  }));
  const skills = initialData?.skills ?? [];
  const plugins = initialData?.plugins ?? [];
  if (agentRuntimeComposition.capabilities === "workspace") {
    // A workspace composition always has an execution factory.
    useSandbox(agentSandbox as SandboxFactory);
    usePluginLifecycle(props.id, plugins);
    // Claude Code mode: the CLI in the workspace runs the loop and its own
    // tools; Flue records each call through a mirror of the same name. dx's
    // own tools reach Claude through the dx MCP server, except web search
    // and page reading, which Claude Code has itself.
    if (
      promptData?.route !== undefined &&
      isClaudeCodeModel(promptData.route.model)
    ) {
      for (const tool of claudeCodeMirrorTools(props.id)) useTool(tool);
      for (const tool of claudeCodeDxTools(
        props.id,
        dxTools(props.id, initialData, promptData, ["search"]),
      ))
        useTool(tool);
      // Each delivered message starts on fresh Claude Code state: nothing a
      // failed submission cached may fail it.
      useAgentStart(({ harness }) => {
        resetClaudeCodeThreadState(props.id);
        rememberClaudeCodeSandbox(props.id, harness.sandbox);
      });
      const prompt = composeClaudeCodePrompt(
        skills,
        threadPortalPrompt(props.id),
        initialData?.startedByThreadId,
      );
      // Claude Code gets this prompt itself, not Flue's composition of it,
      // and the person's instructions as its own user-level instructions.
      rememberClaudeCodePrompt(
        props.id,
        prompt,
        initialData?.personalInstructions ?? "",
      );
      return prompt;
    }
    for (const tool of dxTools(props.id, initialData, promptData))
      useTool(tool);
    // Flue lists them in the Available Skills catalog and loads each on
    // demand through activate_skill, like a repository's .agents/skills.
    useSkill(dxWorkspaceSkill);
    for (const skill of builtInSkillDefinitions) useSkill(skill);
  }
  if (agentRuntimeComposition.capabilities === "model-only")
    return localModelPreviewPrompt;
  return composeDxAgentPrompt(
    initialData?.personalInstructions ?? "",
    skills,
    agentRuntimeComposition.capabilities === "workspace"
      ? threadPortalPrompt(props.id)
      : "",
    initialData?.startedByThreadId,
  );
}

DxAgent.agentName = "dx-agent";
DxAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
DxAgent.initialData = DxAgentInitialDataSchema;
/**
 * Runs once per submission before rendering. The model route and the plugin
 * tool set are both resolved here from current settings and recorded for the
 * submission, so retries and recovery reuse them and the next submission sees
 * changes. The MCP servers Code offers resolve here too, on every attempt.
 * A resolution failure fails the submission visibly.
 */
DxAgent.resolvePromptData = async (
  _initialData: unknown,
  context: ModelResolutionContext,
): Promise<DxAgentPromptData | undefined> => {
  const scope = context.scope;
  const activation = startActivation(context.instanceId);
  const [route, plugins] = await traceSpan(
    "agent.resolvePromptData",
    "phase",
    {
      "dx.thread_id": context.instanceId,
      "dx.submission_id":
        scope?.kind === "prompt" ? scope.submissionId : undefined,
    },
    () =>
      Promise.all([
        agentRuntimeComposition.model.resolvePromptData(context),
        agentRuntimeComposition.capabilities === "workspace" &&
        scope?.kind === "prompt"
          ? resolveAgentPluginTools(context.instanceId, scope.submissionId)
          : Promise.resolve(undefined),
      ]),
  ).catch((error: unknown) => {
    if (startedActivations.get(context.instanceId) === activation)
      startedActivations.delete(context.instanceId);
    throw error;
  });
  if (route === undefined && plugins === undefined) return undefined;
  return {
    ...(route === undefined ? {} : { route }),
    ...(plugins === undefined ? {} : { plugins }),
  };
};
DxAgent.validateInput = (message: Readonly<DeliveredMessage>) => {
  if (
    message.kind === "user" &&
    (message.attachments?.length ?? 0) > MAX_IMAGES_PER_MESSAGE
  )
    throw new InputTooLargeError();
};
