"use agent";

import { MAX_IMAGES_PER_MESSAGE } from "@dx/api";
import { isClaudeCodeModel, type PluginToolSet, type UserId } from "@dx/domain";
import {
  type AgentProps,
  type DeliveredMessage,
  defineSkill,
  InputTooLargeError,
  type ModelResolutionContext,
  type SandboxFactory,
  type ToolDefinition,
  useAgentStart,
  useDelivery,
  useInitialData,
  useModel,
  usePromptData,
  useResponseStart,
  useSandbox,
  useSkill,
  useTool,
} from "@flue/runtime";
import { createAutomationTools } from "../automations/agent-tools.js";
import { githubToken } from "../automations/github.js";
import { createBugReportTools } from "../bug-reports/agent-tools.js";
import {
  claudeCodeDxSandboxTool,
  claudeCodeDxTools,
} from "../claude-code/dx-tools.js";
import {
  rememberClaudeCodePrompt,
  resetClaudeCodeThreadState,
} from "../claude-code/provider.js";
import { rememberClaudeCodeSandbox } from "../claude-code/runs.js";
import {
  type ClaudeCodeToolGate,
  type ClaudeCodeToolResultObserver,
  setClaudeCodeToolGate,
  setClaudeCodeToolResultObserver,
} from "../claude-code/tool-gate.js";
import {
  CLAUDE_CODE_MIRROR_TOOLS,
  claudeCodeMirrorTools,
  claudeCodeReadTool,
} from "../claude-code/tools.js";
import { createClaudeCodeViewMediaTool } from "../claude-code/view-media.js";
import {
  ADDITIONAL_REPOSITORIES_SIGNAL,
  takeAdditionalRepositoryNote,
} from "../execution/additional-repository-note.js";
import { takeDxFilesSandbox } from "../execution/dx-files-sandbox.js";
import { withoutRepositorySkills } from "../execution/workspace-context.js";
import {
  executorAvailable,
  executorSandbox,
  runClaudeCodeOnExecutor,
} from "../executor/sandbox.js";
import { traceSpan } from "../observability/tracing.js";
import {
  takeWorkspaceDisk,
  WORKSPACE_DISK_SIGNAL,
  workspaceDiskNote,
} from "../orb-disk/note.js";
import {
  takeWorkspaceRecovery,
  WORKSPACE_RECOVERY_SIGNAL,
  workspaceRecoveryNote,
} from "../orb-disk/read-only.js";
import {
  diskReliefNote,
  takeDiskRelief,
  WORKSPACE_DISK_RELIEF_SIGNAL,
} from "../orb-disk/relief.js";
import {
  takeUnsavedStop,
  unsavedStopNote,
  WORKSPACE_UNSAVED_STOP_SIGNAL,
} from "../orb-disk/unsaved-stop.js";
import {
  agentPluginHostContext,
  agentThreadToolsContext,
  type ResolvedThreadAgent,
  resolveAgentBugReportReader,
  resolveAgentCodePlugins,
  resolveAgentOrbThreadState,
  resolveAgentPluginTools,
  resolveAgentRepositoryPlugins,
  resolveAgentSpace,
  resolveAgentStartingSpace,
  resolveAgentWorkspaceInstructions,
} from "../plugins/agent-context.js";
import {
  agentKeepsTool,
  agentPromptSection,
} from "../plugins/agents/definition.js";
import { analyzeOnThreadRoute } from "../plugins/execution/media/analysis.js";
import { createViewMediaTool } from "../plugins/execution/media/view-media.js";
import type { RepositoryPluginSkill } from "../plugins/repository/repository-plugins.js";
import { firstPartyPluginTools } from "../plugins/tools.js";
import {
  type CodePluginRuntime,
  createPluginTools,
  decidePluginToolCall,
  observePluginToolResult,
  usePluginCodeLifecycle,
  withPluginToolEvents,
  withPluginWorkspaceToolEvents,
} from "../plugins/worker-host/agent.js";
import {
  MAX_CODE_PLUGINS_PER_THREAD,
  type ResolvedCodePlugin,
} from "../plugins/worker-host/resolve.js";
import { threadPortalPrompt } from "../portals/prompt.js";
import {
  agentRuntimeComposition,
  type DxPromptData,
} from "../runtime/agent-composition.js";
import { AGENT_RUN_LIMIT_MS } from "../runtime/agent-run-limit.js";
import {
  threadEnvironmentMasker,
  withMaskedToolResults,
} from "../settings/environment-variables/sandbox.js";
import { createManageDxTool } from "../settings/manage-dx/tool.js";
import type { McpAgentConnectionData } from "../settings/mcp-servers/execution.js";
import {
  SPACE_CLAUDE_CODE_PREFACE,
  spaceAgentProfile,
  spaceProfileTools,
} from "../spaces/agent/profile.js";
import type { SpaceSystemPromptInput } from "../spaces/agent/system-prompt.js";
import { createSpaceTools } from "../spaces/agent/tools.js";
import { deliveryRequester } from "../spaces/agent-prompt.js";
import {
  ARTIFACTS_EDITED_SIGNAL,
  artifactsEditedByPeopleNote,
  createArtifactTools,
} from "../thread-artifacts/agent-tools.js";
import { createThreadStorageTools } from "../thread-storage/agent-tools.js";
import { createThreadTools } from "../threads/agent-tools.js";
import { readCallingThread } from "../threads/calling-thread.js";
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
  type StartingSpacePromptData,
  settingsInstructions,
  settingsInstructionsPrompt,
} from "./dx-agent-prompt.js";
import { runsWithoutOrb } from "./orb-free.js";
import {
  installSettingsSkills,
  settingsSkillDefinitions,
} from "./settings-skills.js";

/** Per-submission data from `resolvePromptData`. */
interface DxAgentPromptData {
  readonly route?: DxPromptData;
  readonly plugins?: {
    readonly submissionId: string;
    readonly tools: PluginToolSet;
    /** The Thread owner's MCP servers as of this submission. */
    readonly mcpConnections: ReadonlyArray<McpAgentConnectionData>;
  };
  /** The owner is a report reader, so the bug report tools mount. */
  readonly bugReportReader?: true;
  /** The AGENTS.md of the owner's workspace, as of this submission. */
  readonly workspaceInstructions?: string;
  /**
   * The Space this Thread is, as of this submission: it runs the Space
   * agent profile, with no Orb.
   */
  readonly space?: SpaceSystemPromptInput;
  /** The Space that started this Thread. */
  readonly startingSpace?: StartingSpacePromptData;
  /** The Thread runs without an Orb (`runsWithoutOrb`, from D1). */
  readonly orbFree?: true;
  /**
   * Installed plugins with code, as of this submission: what each one's
   * Dynamic Worker handles and the tools it registered.
   */
  readonly codePlugins?: {
    readonly ownerUserId: string;
    readonly plugins: ReadonlyArray<ResolvedCodePlugin>;
    /** The plugin agent this Thread runs as, when it runs one. */
    readonly agent?: ResolvedThreadAgent;
  };
  /**
   * Plugins the Thread's repository carries, as of this submission's HEAD
   * commit; their code is in `codePlugins`, after the installed plugins.
   */
  readonly repositoryPlugins?: {
    readonly commit: string;
    readonly plugins: ReadonlyArray<{
      readonly name: string;
      readonly displayName: string;
      readonly folder: string;
      readonly integrity: string;
      readonly skills: ReadonlyArray<RepositoryPluginSkill>;
    }>;
    readonly skipped: ReadonlyArray<{
      readonly folder: string;
      readonly reason: string;
    }>;
  };
}

/**
 * Flue skills for the repository plugins' skills, leaving out any name the
 * Thread already mounts: two skills of one name would fail the Thread.
 */
const repositoryPluginSkills = (
  promptData: DxAgentPromptData | undefined,
  taken: ReadonlySet<string>,
) =>
  (promptData?.repositoryPlugins?.plugins ?? []).flatMap((plugin) =>
    plugin.skills
      .filter(({ name }) => !taken.has(name))
      .map((skill) =>
        defineSkill({
          name: skill.name,
          description: skill.description.trim() || skill.name,
          instructions: `This skill comes from the ${plugin.displayName} plugin in this repository (\`${plugin.folder}\`). Its directory is \`${skill.directory}/\`; resolve relative paths in these instructions from there.\n\n${skill.instructions}`,
        }),
      ),
  );

/** This submission's plugin code, or undefined when none runs. */
const codePluginRuntime = (
  threadId: string,
  promptData: DxAgentPromptData | undefined,
): CodePluginRuntime | undefined => {
  const resolved = promptData?.codePlugins;
  if (resolved === undefined || resolved.plugins.length === 0) return undefined;
  return {
    threadId,
    ownerUserId: resolved.ownerUserId,
    plugins: resolved.plugins,
    host: agentPluginHostContext,
  };
};

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
 * dx's own tools for one submission: the thread tools,
 * first-party plugin tools (MCP servers reach the model only as Code's
 * modules, never mounted directly), and installed plugins. Plugin tools and
 * MCP servers come from the submission's resolved set, never from Thread
 * creation data; providers and keys resolve again on every call. Every tool
 * DxAgent offers belongs here: Claude Code mode serves this same list to
 * Claude under the same names, so a tool mounted anywhere else would be
 * missing there (wiki/claude-code-tool-parity.md).
 */
const dxTools = (
  threadId: string,
  promptData: DxAgentPromptData | undefined,
  withoutPlugins: ReadonlyArray<string> = [],
  /** The person whose message this turn answers; see `deliveryRequester`. */
  requesterUserId?: UserId,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];
  const space = promptData?.space !== undefined;
  // Built in, not a plugin: the owner's other Threads are always in reach.
  const threadToolArguments = [
    threadId,
    agentThreadToolsContext,
    promptData?.plugins?.submissionId,
    promptData?.route !== undefined &&
      isClaudeCodeModel(promptData.route.model),
    requesterUserId,
  ] as const;
  for (const tool of space
    ? createThreadTools(...threadToolArguments, { space: true })
    : createThreadTools(...threadToolArguments))
    tools.push(withToolFailureMessage(tool));
  // Files between the owner's Threads, and temporary links, through
  // Thread storage.
  for (const tool of createThreadStorageTools(
    threadId,
    agentThreadToolsContext,
  ))
    tools.push(withToolFailureMessage(tool));
  // artifact: documents people and the agent edit together.
  for (const tool of createArtifactTools(
    threadId,
    agentThreadToolsContext,
    promptData?.plugins?.submissionId,
  ))
    tools.push(withToolFailureMessage(tool));
  // Schedules, GitHub subscriptions, and notify_user: work after the turn.
  for (const tool of createAutomationTools(
    threadId,
    agentThreadToolsContext,
    promptData?.plugins?.submissionId,
  ))
    tools.push(withToolFailureMessage(tool));
  // list_bug_reports and read_bug_report: only for the deployment's report
  // readers, resolved per submission.
  if (promptData?.bugReportReader === true)
    for (const tool of createBugReportTools(threadId, agentThreadToolsContext))
      tools.push(withToolFailureMessage(tool));
  // manage_dx: the owner's dx settings, changed only after they apply each
  // change on a card above the composer.
  tools.push(
    withToolFailureMessage(
      createManageDxTool(
        threadId,
        agentThreadToolsContext,
        requesterUserId,
        promptData?.plugins?.submissionId,
      ),
    ),
  );
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
  // Tools installed plugins registered. A plugin tool calling a dx tool
  // goes through the same gate as the model's own calls.
  const codePlugins = space
    ? undefined
    : codePluginRuntime(threadId, promptData);
  let gated: ToolDefinition[] = [];
  for (const tool of createPluginTools(
    codePlugins,
    new Set(tools.map(({ name }) => name)),
    () => gated,
  ))
    tools.push(withToolFailureMessage(tool));
  // A Space's main thread has the Space agent profile's tools: its own,
  // then the dx tools it keeps.
  const mounted = space
    ? spaceProfileTools(
        createSpaceTools(
          threadId,
          agentThreadToolsContext,
          promptData?.plugins?.submissionId,
          requesterUserId,
        ).map(withToolFailureMessage),
        tools,
      )
    : tools;
  // A tool outside the Orb can still return a secret, so each result and
  // failure is masked as the Thread's sandbox masks its reads.
  // Plugins' tool.call and tool.result handlers see what the model sees.
  gated = mounted.map((tool) =>
    withPluginToolEvents(
      withMaskedToolResults(tool, () => threadEnvironmentMasker(threadId)),
      codePlugins,
    ),
  );
  return gated;
};

const CLAUDE_CODE_MIRRORED: ReadonlySet<string> = new Set(
  CLAUDE_CODE_MIRROR_TOOLS,
);

/** The workspace's tools behind installed plugins' tool.call gate. */
const withPluginSandboxEvents = (
  factory: SandboxFactory,
  runtime: CodePluginRuntime | undefined,
): SandboxFactory =>
  runtime === undefined
    ? factory
    : {
        ...factory,
        tools: (sandbox, options) =>
          (factory.tools?.(sandbox, options) ?? []).map((tool) =>
            // Claude Code's Read mirror is gated by its PreToolUse hook.
            CLAUDE_CODE_MIRRORED.has(tool.name)
              ? tool
              : withPluginWorkspaceToolEvents(tool, runtime),
          ),
      };

/**
 * Installed plugins' decision for one of Claude Code's own tool calls, or
 * no gate when none of them handles tool.call. Claude Code cannot be given
 * a result for a call it did not run, so a synthesized result is returned
 * to Claude as the reason the call did not run.
 */
const claudeCodeToolGateFor = (
  runtime: CodePluginRuntime | undefined,
): ClaudeCodeToolGate | undefined =>
  runtime?.plugins.some(({ events }) => events.includes("tool.call")) !== true
    ? undefined
    : async (request) => {
        const decision = await decidePluginToolCall(runtime, {
          tool: request.toolName,
          callId: request.toolUseId,
          input: request.input,
        });
        if (decision === undefined || decision.kind === "allow")
          return decision?.kind === "allow" && decision.modified
            ? { decision: "allow", input: decision.input }
            : { decision: "allow" };
        return {
          decision: "deny",
          reason:
            decision.kind === "reject"
              ? decision.message
              : typeof decision.output === "string"
                ? decision.output
                : JSON.stringify(decision.output),
        };
      };

/**
 * What plugins see as the output of one of Claude Code's own tools: Bash's
 * text, as dx mode's shell_command gives it, and other tools' results as
 * Claude Code reports them.
 */
const claudeToolOutput = (response: unknown): unknown => {
  if (
    typeof response === "object" &&
    response !== null &&
    typeof (response as { stdout?: unknown }).stdout === "string"
  ) {
    const { stdout, stderr } = response as {
      stdout: string;
      stderr?: unknown;
    };
    return typeof stderr === "string" && stderr !== ""
      ? `${stdout}${stdout.endsWith("\n") || stdout === "" ? "" : "\n"}${stderr}`
      : stdout;
  }
  return response;
};

/**
 * A replaced output in the shape Claude Code checks for the tool, which
 * falls back to the tool's own output when it does not match: Bash keeps
 * its fields with the new text as stdout.
 */
const claudeToolResponse = (response: unknown, output: unknown): unknown =>
  typeof response === "object" &&
  response !== null &&
  typeof (response as { stdout?: unknown }).stdout === "string"
    ? {
        ...response,
        stdout: typeof output === "string" ? output : JSON.stringify(output),
        stderr: "",
      }
    : typeof response === "string" && typeof output !== "string"
      ? JSON.stringify(output)
      : output;

/**
 * Installed plugins' tool.result handlers for Claude Code's own tools,
 * through its PostToolUse hook, or none when no plugin handles tool.result.
 */
const claudeCodeToolResultObserverFor = (
  runtime: CodePluginRuntime | undefined,
): ClaudeCodeToolResultObserver | undefined =>
  runtime?.plugins.some(({ events }) => events.includes("tool.result")) !== true
    ? undefined
    : async (result) => {
        const observed = await observePluginToolResult(
          runtime,
          {
            tool: result.toolName,
            callId: result.toolUseId,
            input: result.input,
          },
          { status: "done", output: claudeToolOutput(result.response) },
        );
        return observed?.modified === true
          ? {
              replace: true,
              output: claudeToolResponse(result.response, observed.output),
            }
          : { replace: false };
      };

/** The delivered message's text, for plugins' agent.start. */
const deliveredText = (): string => {
  try {
    const message = useDelivery();
    return "body" in message ? message.body : "";
  } catch {
    return "";
  }
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

/** What `view_media` needs from this Thread, in both modes. */
const viewMediaDeps = (threadId: string) => {
  const calling = () => {
    const context = agentThreadToolsContext();
    return readCallingThread(context.db, threadId).then((thread) => ({
      context,
      thread,
    }));
  };
  const origin = agentThreadToolsContext().bindings.DX_AUTH_URL;
  return {
    githubToken: async () => {
      const { context, thread } = await calling();
      return githubToken(
        context.bindings,
        context.db,
        threadId,
        thread.ownerUserId,
      );
    },
    ...(origin === undefined || origin === ""
      ? {}
      : { dxOrigin: new URL(origin).origin }),
    calling,
  };
};

/**
 * The workspace's tools plus `view_media`. It is a sandbox tool because
 * only those return image blocks; Claude Code mode gets it from the dx MCP
 * server instead.
 */
const withViewMedia = (
  factory: SandboxFactory,
  threadId: string,
): SandboxFactory => ({
  ...factory,
  tools: (sandbox, options) => {
    const { calling, ...deps } = viewMediaDeps(threadId);
    const coordinator =
      agentThreadToolsContext().bindings.BYOK_CREDENTIAL_COORDINATOR;
    return [
      ...(factory.tools?.(sandbox, options) ?? []),
      createViewMediaTool(sandbox, {
        ...deps,
        analyze:
          coordinator === undefined
            ? async () => {
                throw new Error("Media analysis needs model routing.");
              }
            : analyzeOnThreadRoute({
                coordinator,
                thread: async () => {
                  const { thread } = await calling();
                  return {
                    threadId,
                    ownerUserId: thread.ownerUserId,
                    selection: thread.selection,
                  };
                },
              }),
      }),
    ];
  },
});

/**
 * A Claude Code Thread's workspace tools plus the calls whose results can
 * hold an image, Claude's Read and dx's view_media, which only sandbox tools
 * can record.
 */
const withClaudeCodeImageTools = (
  factory: SandboxFactory,
  threadId: string,
  viewMedia: ToolDefinition,
): SandboxFactory => ({
  ...factory,
  tools: (sandbox, options) => [
    ...(factory.tools?.(sandbox, options) ?? []),
    claudeCodeReadTool(threadId, sandbox),
    claudeCodeDxSandboxTool(threadId, viewMedia, sandbox),
  ],
});

/** `view_media` for a Claude Code Thread, on the submission's plan route. */
const claudeCodeViewMedia = (
  threadId: string,
  promptData: DxAgentPromptData | undefined,
) => {
  const { calling: _calling, ...deps } = viewMediaDeps(threadId);
  return createClaudeCodeViewMediaTool({
    deps,
    token: async () => {
      const coordinator =
        agentThreadToolsContext().bindings.BYOK_CREDENTIAL_COORDINATOR;
      const submissionId = promptData?.plugins?.submissionId;
      const canonical = promptData?.route?.model;
      if (
        coordinator === undefined ||
        submissionId === undefined ||
        canonical === undefined
      )
        throw new Error("The Claude plan credential is unavailable.");
      const response = await coordinator
        .get(coordinator.idFromName(`byok-${threadId}`))
        .fetch("https://dx-byok.invalid/claude-code-credential", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId, submissionId, canonical }),
        });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `The Claude plan credential is unavailable (${response.status}).`,
        );
      }
      return (await response.json<{ token: string }>()).token;
    },
  });
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
 * The Thread's sandbox without repository skills named like one of its
 * settings skills: Flue fails a Thread whose repository skill shares a
 * mounted skill's name, so the settings skill wins.
 */
const withSettingsSkills = (
  factory: SandboxFactory,
  names: ReadonlySet<string>,
): SandboxFactory =>
  names.size === 0
    ? factory
    : {
        ...factory,
        createSandbox: async (request) =>
          withoutRepositorySkills(await factory.createSandbox(request), names),
      };

/**
 * The agent-start hook: it writes dx's built-in skills and the Thread's
 * settings skills into the workspace, for the dx agent and Claude Code
 * alike, then tells the agent when its disk is nearly or completely full;
 * Flue runs separate start hooks concurrently, so all stay in one.
 * Installed plugins' code has its own hooks (plugins/worker-host/agent.ts).
 */
const useWorkspaceStart = (
  threadId: string,
  skills: NonNullable<DxAgentInitialData["skills"]>,
) => {
  useAgentStart(async (context) => {
    // Opening the sandbox runs this turn's activation and its disk guard.
    // Skills live outside the repository, so their writes skip Changes
    // coordination while that stays true; the two sets are separate
    // directories.
    // People's artifact edits since the agent's last save, so it reads them
    // before writing. Read beside the skill installs: it waits on D1 alone,
    // and it was the last step before every model request (#1793). Best
    // effort: a failed read never fails the turn.
    const editedNote = (async () =>
      artifactsEditedByPeopleNote(
        agentThreadToolsContext().db,
        threadId,
      ))().catch(() => undefined);
    const outside = takeDxFilesSandbox(threadId);
    const target = {
      coordinated: context.harness.sandbox,
      ...(outside === undefined ? {} : { outside }),
    };
    await Promise.all([
      installBuiltInSkills(target),
      installSettingsSkills(target, threadId, skills),
    ]);
    const disk = takeWorkspaceDisk(threadId);
    const note = disk === undefined ? undefined : workspaceDiskNote(disk);
    if (note !== undefined)
      context.append({
        kind: "signal",
        type: WORKSPACE_DISK_SIGNAL,
        body: note,
      });
    const diskRelief = takeDiskRelief(threadId);
    if (diskRelief !== undefined)
      context.append({
        kind: "signal",
        type: WORKSPACE_DISK_RELIEF_SIGNAL,
        body: diskReliefNote(diskRelief),
      });
    const edited = await editedNote;
    if (edited !== undefined)
      context.append({
        kind: "signal",
        type: ARTIFACTS_EDITED_SIGNAL,
        body: edited,
      });
    const unsavedStop = takeUnsavedStop(threadId);
    if (unsavedStop !== undefined)
      context.append({
        kind: "signal",
        type: WORKSPACE_UNSAVED_STOP_SIGNAL,
        body: unsavedStopNote(unsavedStop),
      });
    const clones = takeAdditionalRepositoryNote(threadId);
    if (clones !== undefined)
      context.append({
        kind: "signal",
        type: ADDITIONAL_REPOSITORIES_SIGNAL,
        body: clones,
      });
    const recovery = takeWorkspaceRecovery(threadId);
    if (recovery !== undefined)
      context.append({
        kind: "signal",
        type: WORKSPACE_RECOVERY_SIGNAL,
        body: workspaceRecoveryNote(recovery),
      });
  });
};

/**
 * The person whose message the response answers, read from the delivered
 * message's author tag. A render outside a delivery (tooling) has none.
 */
const currentRequester = (): UserId | undefined => {
  try {
    return deliveryRequester(useDelivery());
  } catch {
    return undefined;
  }
};

/** Claude Code's own tools a plugin agent's tool list may keep. */
const CLAUDE_CODE_AGENT_BUILT_IN_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Skill",
] as const;

/** Tools the Thread's plugin agent keeps; every tool without one. */
const agentToolFilter =
  (agent: ResolvedThreadAgent | undefined) =>
  <T extends { readonly name: string }>(tools: ReadonlyArray<T>): T[] =>
    agent === undefined
      ? [...tools]
      : tools.filter(({ name }) =>
          agentKeepsTool(agent.definition.tools, name),
        );

/** The workspace's tools, less those the plugin agent leaves out. */
const withAgentSandboxTools = (
  factory: SandboxFactory,
  agent: ResolvedThreadAgent | undefined,
): SandboxFactory =>
  agent === undefined
    ? factory
    : {
        ...factory,
        tools: (sandbox, options) =>
          agentToolFilter(agent)(factory.tools?.(sandbox, options) ?? []),
      };

/** The plugin agent's section after dx's prompt, or the prompt alone. */
const withAgentPrompt = (
  prompt: string,
  agent: ResolvedThreadAgent | undefined,
) =>
  agent === undefined ? prompt : `${prompt}\n\n${agentPromptSection(agent)}`;

export function DxAgent(props: AgentProps) {
  const initialData = useInitialData<DxAgentInitialData | undefined>();
  const promptData = usePromptData<DxAgentPromptData | undefined>();
  const model = agentRuntimeComposition.model.select(promptData?.route);
  useModel(model.model, model.options);
  useResponseStart(() => ({
    dxResponseStartedAt: new Date().toISOString(),
  }));
  const requesterUserId = currentRequester();
  const skills = initialData?.skills ?? [];
  const settingsSkillNames = new Set(skills.map(({ name }) => name));
  const space = promptData?.space;
  if (
    agentRuntimeComposition.capabilities === "workspace" &&
    promptData?.orbFree === true
  ) {
    // Executor mode (wiki/runtime-architecture.md#execution-modes): no Orb,
    // so no shell, file, or Git tools, and nothing installed into a
    // workspace at agent start. Only a Space's main Thread runs in executor
    // mode today, with the Space agent profile.
    if (space === undefined) throw new Error("This Space is unavailable.");
    const profile = spaceAgentProfile({
      space,
      instructions: settingsInstructionsPrompt(
        promptData?.workspaceInstructions ?? "",
        initialData?.personalInstructions ?? "",
      ),
      tools: dxTools(props.id, promptData, [], requesterUserId),
    });
    if (
      promptData.route !== undefined &&
      isClaudeCodeModel(promptData.route.model)
    ) {
      // Claude Code runs on the Thread's executor container: Claude keeps
      // only the profile's built-in tools, and the profile's dx tools reach
      // it through the dx tool bridge. Flue records each call as in an Orb.
      if (!executorAvailable())
        throw new Error(
          "This deployment does not run dx's executor, so a Space cannot run on Claude Code here.",
        );
      runClaudeCodeOnExecutor(props.id, profile.claudeCodeBuiltInTools);
      useSandbox({ createSandbox: async ({ id }) => executorSandbox(id) });
      for (const tool of claudeCodeMirrorTools(props.id)) useTool(tool);
      for (const tool of claudeCodeDxTools(props.id, profile.tools))
        useTool(tool);
      // The same skills as the dx agent's Space: written to the executor,
      // where the launch script links them into ~/.claude/skills.
      useAgentStart(async ({ harness }) => {
        resetClaudeCodeThreadState(props.id);
        rememberClaudeCodeSandbox(props.id, harness.sandbox);
        const target = { coordinated: harness.sandbox };
        await Promise.all([
          installBuiltInSkills(target),
          installSettingsSkills(target, props.id, skills),
        ]);
      });
      // Appended to Claude Code's own prompt, as for every Claude Code
      // Thread; the profile already carries the workspace's and the
      // owner's instructions, so ~/.claude/CLAUDE.md stays empty.
      rememberClaudeCodePrompt(
        props.id,
        `${SPACE_CLAUDE_CODE_PREFACE}\n\n${profile.prompt}`,
        "",
      );
      return profile.prompt;
    }
    for (const tool of profile.tools) useTool(tool);
    // Declared skills load on demand without a workspace.
    for (const skill of builtInSkillDefinitions)
      if (!settingsSkillNames.has(skill.name)) useSkill(skill);
    for (const skill of settingsSkillDefinitions(skills)) useSkill(skill);
    return profile.prompt;
  }
  if (agentRuntimeComposition.capabilities === "workspace") {
    const claudeCode =
      promptData?.route !== undefined &&
      isClaudeCodeModel(promptData.route.model);
    // A workspace composition always has an execution factory.
    const sandbox = withSettingsSkills(
      agentSandbox as SandboxFactory,
      settingsSkillNames,
    );
    const claudeViewMedia = claudeCode
      ? claudeCodeViewMedia(props.id, promptData)
      : undefined;
    const codePlugins = codePluginRuntime(props.id, promptData);
    const agent = promptData?.codePlugins?.agent;
    const keep = agentToolFilter(agent);
    useSandbox(
      withAgentSandboxTools(
        withPluginSandboxEvents(
          claudeViewMedia === undefined
            ? withViewMedia(sandbox, props.id)
            : withClaudeCodeImageTools(sandbox, props.id, claudeViewMedia),
          codePlugins,
        ),
        agent,
      ),
    );
    useWorkspaceStart(props.id, skills);
    usePluginCodeLifecycle(codePlugins, deliveredText());
    // Claude Code mode: the CLI in the workspace runs the loop and its own
    // tools; Flue records each call through a mirror of the same name. dx's
    // own tools reach Claude through the dx MCP server, except web search
    // and page reading, which Claude Code has itself.
    if (claudeViewMedia !== undefined) {
      for (const tool of claudeCodeMirrorTools(props.id)) useTool(tool);
      // view_media runs as a sandbox tool, which can record its image; the
      // dx tool bridge still lists it among the dx tools.
      for (const tool of claudeCodeDxTools(
        props.id,
        keep([
          ...dxTools(props.id, promptData, ["search"], requesterUserId),
          claudeViewMedia,
        ]),
      ))
        if (tool.name !== claudeViewMedia.name) useTool(tool);
      // Claude's own tools run in the CLI: installed plugins' tool.call
      // handlers decide them through Claude Code's PreToolUse hook.
      setClaudeCodeToolGate(props.id, claudeCodeToolGateFor(codePlugins));
      // ...and their tool.result handlers through its PostToolUse hook.
      setClaudeCodeToolResultObserver(
        props.id,
        claudeCodeToolResultObserverFor(codePlugins),
      );
      // Each delivered message starts on fresh Claude Code state: nothing a
      // failed submission cached may fail it.
      useAgentStart(({ harness }) => {
        resetClaudeCodeThreadState(props.id);
        rememberClaudeCodeSandbox(props.id, harness.sandbox);
      });
      const prompt = withAgentPrompt(
        composeClaudeCodePrompt(
          threadPortalPrompt(props.id),
          initialData?.startedByThreadId,
          promptData?.startingSpace,
        ),
        agent,
      );
      // Claude Code gets this prompt itself, not Flue's composition of it,
      // and the workspace's and the person's instructions as its own
      // user-level instructions (~/.claude/CLAUDE.md).
      rememberClaudeCodePrompt(
        props.id,
        prompt,
        settingsInstructions(
          promptData?.workspaceInstructions ?? "",
          initialData?.personalInstructions ?? "",
        ),
        // The repository plugins' skills, as the dx agent mounts them below.
        (promptData?.repositoryPlugins?.plugins ?? []).flatMap((plugin) =>
          plugin.skills
            .filter(
              ({ name }) =>
                !settingsSkillNames.has(name) &&
                name !== dxWorkspaceSkill.name &&
                !builtInSkillDefinitions.some((skill) => skill.name === name),
            )
            .map(({ name, directory }) => ({ name, directory })),
        ),
        // A plugin agent's tool list also decides Claude's own tools.
        agent === undefined
          ? undefined
          : keep(
              CLAUDE_CODE_AGENT_BUILT_IN_TOOLS.map((name) => ({ name })),
            ).map(({ name }) => name),
      );
      return prompt;
    }
    for (const tool of keep(dxTools(props.id, promptData, [], requesterUserId)))
      useTool(tool);
    // Flue lists them in the Available Skills catalog and loads each on
    // demand through activate_skill, like a repository's .agents/skills. A
    // settings skill replaces dx's own skill of the same name.
    for (const skill of [dxWorkspaceSkill, ...builtInSkillDefinitions])
      if (!settingsSkillNames.has(skill.name)) useSkill(skill);
    for (const skill of settingsSkillDefinitions(skills)) useSkill(skill);
    for (const skill of repositoryPluginSkills(
      promptData,
      new Set([
        ...settingsSkillNames,
        dxWorkspaceSkill.name,
        ...builtInSkillDefinitions.map(({ name }) => name),
      ]),
    ))
      useSkill(skill);
  }
  if (agentRuntimeComposition.capabilities === "model-only")
    return localModelPreviewPrompt;
  return withAgentPrompt(
    composeDxAgentPrompt(
      initialData?.personalInstructions ?? "",
      agentRuntimeComposition.capabilities === "workspace"
        ? threadPortalPrompt(props.id)
        : "",
      initialData?.startedByThreadId,
      promptData?.workspaceInstructions,
      promptData?.startingSpace,
    ),
    promptData?.codePlugins?.agent,
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
  // A Thread in executor mode never activates an Orb. Its execution mode is
  // the server's, read from D1, never the creation data a client sent; any
  // other Thread's activation starts as soon as that read answers, still
  // overlapping model routing.
  let activation: Promise<AgentSandbox> | undefined;
  const threadState = (
    agentRuntimeComposition.capabilities === "workspace"
      ? resolveAgentOrbThreadState(context.instanceId)
      : Promise.resolve({ kind: "thread", executionMode: "orb" } as const)
  ).then((state) => {
    if (!runsWithoutOrb(state))
      activation = startActivation(context.instanceId);
    return state;
  });
  const orbDecision = threadState.then(runsWithoutOrb);
  const [
    orbFree,
    route,
    plugins,
    bugReportReader,
    workspaceInstructions,
    space,
    startingSpace,
    installedCodePlugins,
    repositoryPlugins,
  ] = await traceSpan(
    "agent.resolvePromptData",
    "phase",
    {
      "dx.thread_id": context.instanceId,
      "dx.submission_id":
        scope?.kind === "prompt" ? scope.submissionId : undefined,
    },
    () =>
      Promise.all([
        orbDecision,
        agentRuntimeComposition.model.resolvePromptData(context),
        agentRuntimeComposition.capabilities === "workspace" &&
        scope?.kind === "prompt"
          ? resolveAgentPluginTools(context.instanceId, scope.submissionId)
          : Promise.resolve(undefined),
        agentRuntimeComposition.capabilities === "workspace" &&
        scope?.kind === "prompt"
          ? resolveAgentBugReportReader(context.instanceId)
          : Promise.resolve(false),
        agentRuntimeComposition.capabilities === "workspace"
          ? resolveAgentWorkspaceInstructions(context.instanceId)
          : Promise.resolve(""),
        // Only a Space reads its prompt data: the kind read decides.
        threadState.then((state) =>
          state.kind === "space"
            ? resolveAgentSpace(context.instanceId)
            : undefined,
        ),
        agentRuntimeComposition.capabilities === "workspace"
          ? resolveAgentStartingSpace(context.instanceId)
          : Promise.resolve(undefined),
        agentRuntimeComposition.capabilities === "workspace" &&
        scope?.kind === "prompt"
          ? threadState.then((state) =>
              state.kind === "space"
                ? undefined
                : resolveAgentCodePlugins(context.instanceId),
            )
          : Promise.resolve(undefined),
        // The repository's own plugins, read from the Orb once it is ready.
        agentRuntimeComposition.capabilities === "workspace" &&
        scope?.kind === "prompt"
          ? threadState.then((state) =>
              state.kind === "space" || activation === undefined
                ? undefined
                : resolveAgentRepositoryPlugins(
                    context.instanceId,
                    activation,
                    new Set([
                      dxWorkspaceSkill.name,
                      ...builtInSkillDefinitions.map(({ name }) => name),
                    ]),
                  ),
            )
          : Promise.resolve(undefined),
      ]),
  ).catch(async (error: unknown) => {
    // A failed read leaves no started sandbox behind.
    await orbDecision.catch(() => undefined);
    if (
      activation !== undefined &&
      startedActivations.get(context.instanceId) === activation
    )
      startedActivations.delete(context.instanceId);
    throw error;
  });
  // Installed plugins first, then the repository's: the gate order.
  const codePluginList = [
    ...(installedCodePlugins?.plugins ?? []),
    ...(repositoryPlugins?.code ?? []),
  ].slice(0, MAX_CODE_PLUGINS_PER_THREAD);
  const codeOwner =
    installedCodePlugins?.ownerUserId ?? repositoryPlugins?.ownerUserId;
  const codePlugins =
    codeOwner === undefined || codePluginList.length === 0
      ? undefined
      : {
          ownerUserId: codeOwner,
          plugins: codePluginList,
          ...(installedCodePlugins?.agent === undefined
            ? {}
            : { agent: installedCodePlugins.agent }),
        };
  const repositoryPluginData =
    repositoryPlugins === undefined
      ? undefined
      : {
          commit: repositoryPlugins.commit,
          plugins: repositoryPlugins.plugins,
          skipped: repositoryPlugins.skipped,
        };
  // The repository's MCP servers join the owner's in Code; a module name
  // the owner's servers already use keeps the owner's server.
  const takenModules = new Set<string>(
    (plugins?.mcpConnections ?? []).map(
      ({ moduleId, name }): string => moduleId ?? name,
    ),
  );
  const repositoryConnections = (
    repositoryPlugins?.mcpConnections ?? []
  ).filter(({ moduleId, name }) => {
    const module = moduleId ?? name;
    if (takenModules.has(module)) return false;
    takenModules.add(module);
    return true;
  });
  const pluginTools =
    plugins === undefined || repositoryConnections.length === 0
      ? plugins
      : {
          ...plugins,
          mcpConnections: [...plugins.mcpConnections, ...repositoryConnections],
        };
  if (
    route === undefined &&
    plugins === undefined &&
    !bugReportReader &&
    workspaceInstructions.length === 0 &&
    space === undefined &&
    startingSpace === undefined &&
    codePlugins === undefined &&
    repositoryPluginData === undefined &&
    !orbFree
  )
    return undefined;
  return {
    ...(route === undefined ? {} : { route }),
    ...(pluginTools === undefined ? {} : { plugins: pluginTools }),
    ...(bugReportReader ? { bugReportReader: true as const } : {}),
    ...(workspaceInstructions.length === 0 ? {} : { workspaceInstructions }),
    ...(space === undefined ? {} : { space }),
    ...(startingSpace === undefined ? {} : { startingSpace }),
    ...(orbFree ? { orbFree: true as const } : {}),
    ...(codePlugins === undefined ? {} : { codePlugins }),
    ...(repositoryPluginData === undefined
      ? {}
      : { repositoryPlugins: repositoryPluginData }),
  };
};
DxAgent.validateInput = (message: Readonly<DeliveredMessage>) => {
  if (
    message.kind === "user" &&
    (message.attachments?.length ?? 0) > MAX_IMAGES_PER_MESSAGE
  )
    throw new InputTooLargeError();
};
