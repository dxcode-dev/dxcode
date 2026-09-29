"use agent";

import { MAX_IMAGES_PER_MESSAGE } from "@dx/api";
import {
  type AgentProps,
  type DeliveredMessage,
  InputTooLargeError,
  type ModelResolutionContext,
  type ToolDefinition,
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useMcpConnection,
  useModel,
  usePromptData,
  useResponseStart,
  useSandbox,
  useTool,
} from "@flue/runtime";
import {
  agentRuntimeComposition,
  type DxPromptData,
} from "../runtime/agent-composition.js";
import { AGENT_RUN_LIMIT_MS } from "../runtime/agent-run-limit.js";
import {
  createAuthorizedMcpFetch,
  resolveMcpCredential,
} from "../settings/mcp-servers/execution.js";
import { invokePluginLive } from "../settings/plugins/execution.js";
import { createPluginTool } from "../settings/plugins/flue.js";
import { createSkillResourceTool } from "../settings/skills/execution.js";
import {
  type DxAgentInitialData,
  DxAgentInitialDataSchema,
} from "./dx-agent-initial-data.js";
import { composeDxAgentPrompt } from "./dx-agent-prompt.js";

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
  const promptData = usePromptData<DxPromptData | undefined>();
  const model = agentRuntimeComposition.model.select(promptData);
  useModel(model.model, model.options);
  useResponseStart(() => ({
    dxResponseStartedAt: new Date().toISOString(),
  }));
  const skills = initialData?.skills ?? [];
  const plugins = initialData?.plugins ?? [];
  if (agentRuntimeComposition.capabilities === "workspace") {
    useSandbox(agentRuntimeComposition.execution);
    for (const connection of initialData?.mcpConnections ?? []) {
      useMcpConnection({
        name: connection.name,
        url: connection.endpoint,
        transport: "streamable-http",
        tools: [...connection.tools],
        timeoutMs: connection.timeoutMs,
        optional: true,
        fetch: createAuthorizedMcpFetch(
          props.id,
          connection.id,
          connection.endpoint,
          connection.timeoutMs,
        ),
        ...(connection.authenticated
          ? {
              auth: () => resolveMcpCredential(props.id, connection.id),
            }
          : {}),
      });
    }
    if (skills.some((skill) => skill.resources.length > 0)) {
      useTool(withToolFailureMessage(createSkillResourceTool(props.id)));
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
DxAgent.resolvePromptData = (
  _initialData: unknown,
  context: ModelResolutionContext,
) => agentRuntimeComposition.model.resolvePromptData(context);
DxAgent.validateInput = (message: Readonly<DeliveredMessage>) => {
  if (
    message.kind === "user" &&
    (message.attachments?.length ?? 0) > MAX_IMAGES_PER_MESSAGE
  )
    throw new InputTooLargeError();
};
