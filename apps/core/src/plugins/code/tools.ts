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
import { withLocalTools } from "./local-mcp.js";
import { codeMcpCall } from "./mcp.js";
import {
  collectMcpAppViews,
  mcpAppOutputNote,
  newMcpAppCardSetId,
  storeMcpAppViews,
} from "./mcp-apps.js";
import { executeCode } from "./providers/quickjs.js";
import { getCodeWasm } from "./providers/wasm.js";

export const createCodeTools = (
  connections: ReadonlyArray<McpAgentConnectionData>,
  submission: PluginSubmission,
  threadPlugin: ThreadPlugin,
  getContext: () => PluginHostContext,
) => {
  if (!threadPlugin.capabilities.includes("code.execute")) return [];
  const remote = connections.filter(({ local }) => local === undefined);
  const local = connections.filter(({ local }) => local !== undefined);
  const staticModules = codeModules(remote);
  // A plugin's local server runs in the Orb: its tools are listed from the
  // running server once per submission, and only when the code names its
  // module or the agent searches, so other code never starts it.
  const listed = new Map<
    string,
    Promise<{ connection?: McpAgentConnectionData; problem?: string }>
  >();
  const listLocal = (
    context: PluginHostContext,
    connection: McpAgentConnectionData,
  ) => {
    let pending = listed.get(connection.id);
    if (pending === undefined) {
      pending = withLocalTools(
        context.bindings,
        submission.threadId,
        connection,
      )
        .then((resolved) => ({ connection: resolved }))
        .catch((error: unknown) => {
          // A failed start may succeed on the next try, such as after an
          // install finished or the daemon updated.
          listed.delete(connection.id);
          return {
            problem: `${connection.displayName ?? connection.name} (runs in the Orb) is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          };
        });
      listed.set(connection.id, pending);
    }
    return pending;
  };
  const modulesFor = async (
    context: PluginHostContext,
    wanted: (connection: McpAgentConnectionData) => boolean,
  ) => {
    if (local.length === 0) return { modules: staticModules, problems: [] };
    const results = await Promise.all(
      local.filter(wanted).map((connection) => listLocal(context, connection)),
    );
    return {
      modules: codeModules([
        ...remote,
        ...results.flatMap(({ connection }) =>
          connection === undefined ? [] : [connection],
        ),
      ]),
      problems: results.flatMap(({ problem }) =>
        problem === undefined ? [] : [problem],
      ),
    };
  };
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
          const { modules, problems } = await modulesFor(
            context,
            (connection) =>
              connection.moduleId !== undefined &&
              data.code.includes(connection.moduleId),
          );
          // The code names a local server that could not start.
          if (problems.length > 0) throw new Error(problems.join("\n"));
          const wasm = await getCodeWasm();
          meter.add(1);
          const collector = collectMcpAppViews();
          const output = await executeCode(
            wasm,
            modules,
            data.code,
            codeMcpCall(submission.threadId, context.bindings, collector),
            signal,
          );
          const { views } = collector;
          const cardSetId = newMcpAppCardSetId();
          const db = context.bindings.DB;
          // The cards are the person's; the model only learns one was shown.
          if (
            views.length === 0 ||
            db === undefined ||
            !(await storeMcpAppViews(db, submission.threadId, cardSetId, views))
          )
            return output;
          const note = mcpAppOutputNote(views, cardSetId);
          return output === "" ? note : `${output}\n${note}`;
        },
      );
    },
  });
  if (staticModules.length === 0 && local.length === 0) return [codeExec];
  const localLines = local.map(
    (connection) =>
      `${connection.moduleId ?? connection.name} — ${connection.displayName ?? connection.name} MCP server (runs in the Orb): search to list its tools`,
  );
  return [
    codeExec,
    defineTool({
      name: TOOL_SEARCH_TOOL.name,
      description: [
        TOOL_SEARCH_TOOL.description,
        ...(staticModules.length === 0 ? [] : [moduleList(staticModules)]),
        ...localLines,
      ].join("\n"),
      input: v.object({
        query: v.pipe(v.string(), v.description(TOOL_SEARCH_TOOL.parameter)),
      }),
      run: async ({ data }) => {
        const { context } = await admit();
        const { modules, problems } = await modulesFor(context, () => true);
        return [searchTools(modules, data.query), ...problems].join("\n\n");
      },
    }),
  ];
};
