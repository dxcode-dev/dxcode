import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import type { McpAgentConnectionData } from "../../settings/mcp-servers/execution.js";
import {
  admitPluginCall,
  meterPluginCall,
  type PluginHostContext,
  type PluginSubmission,
  type ThreadPlugin,
} from "../host.js";
import { codeModules, moduleList, searchTools } from "./catalog.js";
import { CODE_EXEC_TOOL, TOOL_SEARCH_TOOL } from "./definitions.js";
import { codeMcpCall } from "./mcp.js";
import { executeCode } from "./providers/quickjs.js";
import { getCodeWasm } from "./providers/wasm.js";

export const createCodeTools = (
  connections: ReadonlyArray<McpAgentConnectionData>,
  submission: PluginSubmission,
  threadPlugin: ThreadPlugin,
  getContext: () => PluginHostContext,
) => {
  const modules = codeModules(connections);
  if (!threadPlugin.capabilities.includes("code.execute")) return [];
  const admit = async () => {
    const context = getContext();
    const admission = await admitPluginCall(
      context,
      submission.threadId,
      threadPlugin,
      "code.execute",
    );
    if (!admission.admitted)
      throw new Error(`Code is unavailable: ${admission.reason}.`);
    if (admission.configuration.providerId !== "quickjs")
      throw new Error("Code requires the QuickJS provider.");
    return { context, configuration: admission.configuration };
  };
  // code_exec is always mounted; tool_search only when there is something to
  // discover. MCP servers reach the model only through these two tools.
  const codeExec = defineTool({
    name: CODE_EXEC_TOOL.name,
    description: CODE_EXEC_TOOL.description,
    input: v.object({
      code: v.pipe(v.string(), v.description(CODE_EXEC_TOOL.parameter)),
    }),
    run: async ({ data, signal }) => {
      const { context, configuration } = await admit();
      return meterPluginCall(
        context,
        submission.threadId,
        submission.submissionId,
        threadPlugin,
        "code.execute",
        configuration,
        async (meter) => {
          signal?.throwIfAborted();
          const wasm = await getCodeWasm();
          meter.add(1);
          return executeCode(
            wasm,
            modules,
            data.code,
            codeMcpCall(submission.threadId),
            signal,
          );
        },
      );
    },
  });
  if (modules.length === 0) return [codeExec];
  return [
    codeExec,
    defineTool({
      name: TOOL_SEARCH_TOOL.name,
      description: `${TOOL_SEARCH_TOOL.description}\n${moduleList(modules)}`,
      input: v.object({
        query: v.pipe(v.string(), v.description(TOOL_SEARCH_TOOL.parameter)),
      }),
      run: async ({ data }) => {
        await admit();
        return searchTools(modules, data.query);
      },
    }),
  ];
};
