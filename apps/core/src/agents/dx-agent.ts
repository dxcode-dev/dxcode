"use agent";

import { MAX_IMAGES_PER_MESSAGE } from "@dx/api";
import type { PluginToolSet } from "@dx/domain";
import {
  type AgentProps,
  type DeliveredMessage,
  InputTooLargeError,
  type ModelResolutionContext,
  type ToolDefinition,
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useModel,
  usePromptData,
  useResponseStart,
  useSandbox,
  useTool,
} from "@flue/runtime";
import {
  agentPluginHostContext,
  resolveAgentPluginTools,
} from "../plugins/agent-context.js";
import { firstPartyPluginTools } from "../plugins/tools.js";
import {
  agentRuntimeComposition,
  type DxPromptData,
} from "../runtime/agent-composition.js";
import { AGENT_RUN_LIMIT_MS } from "../runtime/agent-run-limit.js";
import { invokePluginLive } from "../settings/plugins/execution.js";
import { createPluginTool } from "../settings/plugins/flue.js";
import { createSkillResourceTool } from "../settings/skills/execution.js";
import {
  type DxAgentInitialData,
  DxAgentInitialDataSchema,
} from "./dx-agent-initial-data.js";
import { composeDxAgentPrompt } from "./dx-agent-prompt.js";

/** Per-submission data from `resolvePromptData`. */
interface DxAgentPromptData {
  readonly route?: DxPromptData;
  readonly plugins?: {
    readonly submissionId: string;
    readonly tools: PluginToolSet;
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
    useSandbox(agentRuntimeComposition.execution);
    // MCP servers are never mounted directly; the Code plugin exposes them as
    // modules for code_exec and tool_search.
    if (skills.some((skill) => skill.resources.length > 0)) {
      useTool(withToolFailureMessage(createSkillResourceTool(props.id)));
    }
    // Plugin tools come from this submission's resolved set, never from
    // Thread creation data; providers and keys resolve again on every call.
    const pluginTools = promptData?.plugins;
    if (pluginTools !== undefined) {
      for (const tool of firstPartyPluginTools(
        { threadId: props.id, submissionId: pluginTools.submissionId },
        pluginTools.tools,
        agentPluginHostContext,
        initialData?.mcpConnections ?? [],
      )) {
        useTool(withToolFailureMessage(tool));
      }
    }
    for (const plugin of plugins) {
      for (const tool of plugin.tools) {
        useTool(
          withToolFailureMessage(
            createPluginTool(props.id, {
              id: plugin.id as never,
              version: plugin.version,
              name: tool.name as never,
              description: tool.description,
            }),
          ),
        );
      }
    }
    useAgentStart(async ({ harness, log }) => {
      for (const plugin of plugins.filter(({ lifecycle }) =>
        lifecycle.includes("agent-start"),
      )) {
        try {
          await invokePluginLive(
            props.id,
            plugin.id,
            plugin.version,
            { kind: "lifecycle", name: "agent-start" },
            null,
            harness.sandbox,
          );
        } catch {
          log.error("Trusted plugin agent-start hook failed.", {
            pluginId: plugin.id,
            version: plugin.version,
          });
        }
      }
    });
    if (plugins.some(({ lifecycle }) => lifecycle.includes("agent-finish"))) {
      useAgentFinish(async ({ harness, log }) => {
        for (const plugin of plugins.filter(({ lifecycle }) =>
          lifecycle.includes("agent-finish"),
        )) {
          try {
            await invokePluginLive(
              props.id,
              plugin.id,
              plugin.version,
              { kind: "lifecycle", name: "agent-finish" },
              null,
              harness.sandbox,
            );
          } catch {
            log.error("Trusted plugin agent-finish hook failed.", {
              pluginId: plugin.id,
              version: plugin.version,
            });
          }
        }
      });
    }
  }
  if (agentRuntimeComposition.capabilities === "model-only")
    return localModelPreviewPrompt;
  return composeDxAgentPrompt(initialData?.personalInstructions ?? "", skills);
}

DxAgent.agentName = "dx-agent";
DxAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
DxAgent.initialData = DxAgentInitialDataSchema;
/**
 * Runs once per submission before rendering. The model route and the plugin
 * tool set are both resolved here from current settings and recorded for the
 * submission, so retries and recovery reuse them and the next submission sees
 * changes. A resolution failure fails the submission visibly.
 */
DxAgent.resolvePromptData = async (
  _initialData: unknown,
  context: ModelResolutionContext,
): Promise<DxAgentPromptData | undefined> => {
  const scope = context.scope;
  const [route, plugins] = await Promise.all([
    agentRuntimeComposition.model.resolvePromptData(context),
    agentRuntimeComposition.capabilities === "workspace" &&
    scope?.kind === "prompt"
      ? resolveAgentPluginTools(context.instanceId, scope.submissionId)
      : Promise.resolve(undefined),
  ]);
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
