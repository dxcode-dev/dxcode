import {
  type PluginId,
  type PluginToolName,
  pluginFlueToolName,
} from "@dx/domain";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { invokePluginLive } from "./execution.js";

export interface PluginToolRegistration {
  readonly id: PluginId;
  readonly version: string;
  readonly name: PluginToolName;
  readonly description: string;
}

const Attribution = v.object({
  pluginId: v.string(),
  version: v.string(),
  invocationId: v.string(),
  capability: v.string(),
});

export const createPluginTool = (
  threadId: string,
  registration: PluginToolRegistration,
) =>
  defineTool({
    name: pluginFlueToolName(registration.id, registration.name),
    description: `${registration.description} Runs the trusted ${registration.version} plugin in an isolated, permission-bounded E2B sandbox.`,
    input: v.object({ input: v.unknown() }),
    output: v.object({
      attribution: Attribution,
      result: v.unknown(),
      truncated: v.boolean(),
    }),
    harness: true,
    async run({ data, harness }) {
      return {
        output: await invokePluginLive(
          threadId,
          registration.id,
          registration.version,
          { kind: "tool", name: registration.name },
          data.input,
          harness.sandbox,
        ),
      };
    },
  });
