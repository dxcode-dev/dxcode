import type { ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import {
  type CodePluginRuntime,
  createPluginTools,
  withPluginToolEvents,
} from "../worker-host/agent.js";
import type { ResolvedCodePlugin } from "../worker-host/resolve.js";
import { draftShortName } from "./names.js";

/**
 * `plugin_tool`: one fixed dx tool that calls any tool a plugin running in
 * this Thread registered, draft or installed. Claude Code fixes its tool
 * list when a turn starts and refreshes it only when its MCP server says
 * the list changed, so a tool a draft added a moment ago may not be in it
 * yet; this one always is. The call passes the Thread's plugins'
 * `tool.call` gate under the plugin tool's own name, exactly as a direct
 * call would.
 */

export const PLUGIN_TOOL_NAME = "plugin_tool";

const pluginNames = (plugin: ResolvedCodePlugin) => [
  plugin.name,
  draftShortName(plugin.name),
  plugin.displayName,
  plugin.displayName.replace(/ \(draft\)$/, ""),
];

export const createPluginToolTool = (input: {
  /** Asks for the Thread's drafts again, so one loaded just now is found. */
  readonly refresh: () => Promise<void>;
  /** The Thread's plugins as of now, drafts first. */
  readonly runtime: () => CodePluginRuntime | undefined;
  /** The Thread's other tools, which a plugin tool may call. */
  readonly threadTools: () => ReadonlyArray<ToolDefinition>;
}): ToolDefinition =>
  ({
    name: PLUGIN_TOOL_NAME,
    description:
      "Calls a tool that a plugin in this Thread registered, by plugin and tool name. Use it for a tool that is not in your tool list yet, such as one a draft plugin added with `dxd plugin load` or `dxd plugin reload` during this turn. When the tool is in your tool list, call it directly instead.",
    input: v.object({
      plugin: v.pipe(
        v.string(),
        v.description(
          "The plugin's name as `dxd plugin load` or `dxd plugin list` printed it, such as grafana.",
        ),
      ),
      tool: v.pipe(v.string(), v.description("The tool's name.")),
      args: v.optional(
        v.pipe(
          v.record(v.string(), v.unknown()),
          v.description("The tool's input, as its input schema describes."),
        ),
      ),
    }),
    output: undefined,
    harness: true,
    async run(context: Parameters<ToolDefinition["run"]>[0]) {
      const data = (context as { readonly data?: unknown }).data as {
        readonly plugin: string;
        readonly tool: string;
        readonly args?: Record<string, unknown>;
      };
      await input.refresh();
      const runtime = input.runtime();
      const plugins = runtime?.plugins ?? [];
      const plugin = plugins.find((candidate) =>
        pluginNames(candidate).includes(data.plugin),
      );
      if (runtime === undefined || plugin === undefined) {
        const names = plugins.map(({ name }) => draftShortName(name));
        throw new Error(
          `No plugin named ${data.plugin} runs in this Thread.${names.length === 0 ? "" : ` Plugins here: ${names.join(", ")}.`}`,
        );
      }
      if (plugin.loadError !== undefined)
        throw new Error(
          `${plugin.displayName}'s code did not start: ${plugin.loadError}`,
        );
      const [tool] = createPluginTools(
        { ...runtime, plugins: [plugin] },
        new Set(),
        input.threadTools,
      ).filter(({ name }) => name === data.tool);
      if (tool === undefined)
        throw new Error(
          `${plugin.displayName} has no tool named ${data.tool}.${plugin.tools.length === 0 ? "" : ` Its tools: ${plugin.tools.map(({ name }) => name).join(", ")}.`}`,
        );
      return withPluginToolEvents(tool, runtime).run({
        ...context,
        data: data.args ?? {},
      } as never);
    },
  }) as unknown as ToolDefinition;
