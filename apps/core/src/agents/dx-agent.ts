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
import { createOwnerAskTools } from "../owner-asks/agent-tools.js";
import {
  agentPluginHostContext,
  agentThreadToolsContext,
  resolveAgentBugReportReader,
  resolveAgentPluginTools,
  resolveAgentWorkspaceInstructions,
} from "../plugins/agent-context.js";
import { analyzeOnThreadRoute } from "../plugins/execution/media/analysis.js";
import { createViewMediaTool } from "../plugins/execution/media/view-media.js";
import { firstPartyPluginTools } from "../plugins/tools.js";
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
import type { McpAgentConnectionData } from "../settings/mcp-servers/execution.js";
import { invokePluginLive } from "../settings/plugins/execution.js";
import { createPluginTool } from "../settings/plugins/flue.js";
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
  settingsInstructions,
} from "./dx-agent-prompt.js";
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
 * dx's own tools for one submission: the thread tools,
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
  // request_attention: an ask for the owner in the Thread's Plan artifact,
  // which notifies them.
  for (const tool of createOwnerAskTools(
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
  // A tool outside the Orb can still return a secret, so each result and
  // failure is masked as the Thread's sandbox masks its reads.
  return tools.map((tool) =>
    withMaskedToolResults(tool, () => threadEnvironmentMasker(threadId)),
  );
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
 * Installed plugins' agent-start and agent-finish hooks. The agent-start
 * hook first writes dx's built-in skills and the Thread's settings skills
 * into the workspace, for the dx agent and Claude Code alike, then tells the agent when its disk is nearly
 * or completely full; Flue runs separate start hooks concurrently, so all
 * stay in one.
 */
const usePluginLifecycle = (
  threadId: string,
  plugins: DxAgentInitialData["plugins"],
  skills: NonNullable<DxAgentInitialData["skills"]>,
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
  const settingsSkillNames = new Set(skills.map(({ name }) => name));
  const plugins = initialData?.plugins ?? [];
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
    useSandbox(
      claudeViewMedia === undefined
        ? withViewMedia(sandbox, props.id)
        : withClaudeCodeImageTools(sandbox, props.id, claudeViewMedia),
    );
    usePluginLifecycle(props.id, plugins, skills);
    // Claude Code mode: the CLI in the workspace runs the loop and its own
    // tools; Flue records each call through a mirror of the same name. dx's
    // own tools reach Claude through the dx MCP server, except web search
    // and page reading, which Claude Code has itself.
    if (claudeViewMedia !== undefined) {
      for (const tool of claudeCodeMirrorTools(props.id)) useTool(tool);
      // view_media runs as a sandbox tool, which can record its image; the
      // MCP server still lists it among the dx tools.
      for (const tool of claudeCodeDxTools(props.id, [
        ...dxTools(props.id, initialData, promptData, ["search"]),
        claudeViewMedia,
      ]))
        if (tool.name !== `mcp__dx__${claudeViewMedia.name}`) useTool(tool);
      // Each delivered message starts on fresh Claude Code state: nothing a
      // failed submission cached may fail it.
      useAgentStart(({ harness }) => {
        resetClaudeCodeThreadState(props.id);
        rememberClaudeCodeSandbox(props.id, harness.sandbox);
      });
      const prompt = composeClaudeCodePrompt(
        threadPortalPrompt(props.id),
        initialData?.startedByThreadId,
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
      );
      return prompt;
    }
    for (const tool of dxTools(props.id, initialData, promptData))
      useTool(tool);
    // Flue lists them in the Available Skills catalog and loads each on
    // demand through activate_skill, like a repository's .agents/skills. A
    // settings skill replaces dx's own skill of the same name.
    for (const skill of [dxWorkspaceSkill, ...builtInSkillDefinitions])
      if (!settingsSkillNames.has(skill.name)) useSkill(skill);
    for (const skill of settingsSkillDefinitions(skills)) useSkill(skill);
  }
  if (agentRuntimeComposition.capabilities === "model-only")
    return localModelPreviewPrompt;
  return composeDxAgentPrompt(
    initialData?.personalInstructions ?? "",
    agentRuntimeComposition.capabilities === "workspace"
      ? threadPortalPrompt(props.id)
      : "",
    initialData?.startedByThreadId,
    promptData?.workspaceInstructions,
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
  const [route, plugins, bugReportReader, workspaceInstructions] =
    await traceSpan(
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
          agentRuntimeComposition.capabilities === "workspace" &&
          scope?.kind === "prompt"
            ? resolveAgentBugReportReader(context.instanceId)
            : Promise.resolve(false),
          agentRuntimeComposition.capabilities === "workspace"
            ? resolveAgentWorkspaceInstructions(context.instanceId)
            : Promise.resolve(""),
        ]),
    ).catch((error: unknown) => {
      if (startedActivations.get(context.instanceId) === activation)
        startedActivations.delete(context.instanceId);
      throw error;
    });
  if (
    route === undefined &&
    plugins === undefined &&
    !bugReportReader &&
    workspaceInstructions.length === 0
  )
    return undefined;
  return {
    ...(route === undefined ? {} : { route }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(bugReportReader ? { bugReportReader: true as const } : {}),
    ...(workspaceInstructions.length === 0 ? {} : { workspaceInstructions }),
  };
};
DxAgent.validateInput = (message: Readonly<DeliveredMessage>) => {
  if (
    message.kind === "user" &&
    (message.attachments?.length ?? 0) > MAX_IMAGES_PER_MESSAGE
  )
    throw new InputTooLargeError();
};
