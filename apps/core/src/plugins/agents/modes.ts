import type { Bindings } from "../../http/types.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import {
  listOwnerCodePluginInstalls,
  listThreadCodePluginInstalls,
} from "../worker-host/resolve.js";
import { describePlugin, logPluginFailure } from "../worker-host/worker.js";
import type { PluginAgentDefinition } from "./definition.js";

/**
 * The agent modes installed plugins offer a Thread's owner: declared in a
 * manifest's `agentModes`, granted `permissions.agents`, and registered by
 * the plugin's code. Each is named `plugin:<plugin name>/<key>`.
 */

export const PLUGIN_MODE_PREFIX = "plugin:";

export interface PluginAgentModeChoice {
  readonly agentMode: string;
  readonly install: PluginInstallRecord;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly color?: string;
  readonly definition: PluginAgentDefinition;
}

export const pluginAgentModeId = (pluginName: string, key: string) =>
  `${PLUGIN_MODE_PREFIX}${pluginName}/${key}`;

export const isPluginAgentMode = (agentMode: string) =>
  agentMode.startsWith(PLUGIN_MODE_PREFIX);

/**
 * The owner's plugin agent modes, as the calling Thread's plugins resolve.
 * One D1 read; each plugin's worker describes itself from the isolate's
 * cache when warm. A plugin that fails to start offers none.
 */
export const listPluginAgentModes = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<PluginAgentModeChoice>> =>
  agentModesOf(bindings, db, await listThreadCodePluginInstalls(db, threadId));

/** A person's plugin agent modes, for a Thread they have not started yet. */
export const listOwnerPluginAgentModes = async (
  bindings: Bindings,
  db: D1Database,
  ownerUserId: string,
): Promise<ReadonlyArray<PluginAgentModeChoice>> =>
  agentModesOf(
    bindings,
    db,
    await listOwnerCodePluginInstalls(db, ownerUserId),
  );

const agentModesOf = async (
  bindings: Bindings,
  db: D1Database,
  all: ReadonlyArray<PluginInstallRecord>,
): Promise<ReadonlyArray<PluginAgentModeChoice>> => {
  const installs = all.filter(
    ({ code }) =>
      code.permissions.agents === true && (code.agentModes ?? []).length > 0,
  );
  const lists = await Promise.all(
    installs.map(async (install) => {
      try {
        const described = await describePlugin(bindings, db, install);
        return described.agentModes.flatMap(({ key, agent }) => {
          const declared = (install.code.agentModes ?? []).find(
            (mode) => mode.key === key,
          );
          if (declared === undefined) return [];
          return [
            {
              agentMode: pluginAgentModeId(install.name, key),
              install,
              key,
              label: declared.label,
              ...(declared.description === undefined
                ? {}
                : { description: declared.description }),
              ...(declared.color === undefined
                ? {}
                : { color: declared.color }),
              // A mode's Thread shows the declared label unless the agent
              // names its own.
              definition:
                agent.display === undefined
                  ? {
                      ...agent,
                      display: {
                        label: declared.label,
                        ...(declared.color === undefined
                          ? {}
                          : { color: declared.color }),
                      },
                    }
                  : agent,
            },
          ];
        });
      } catch (error) {
        logPluginFailure(install, "start", error);
        return [];
      }
    }),
  );
  return lists.flat();
};

/** The mode `agentMode` names among the owner's, or why there is none. */
export const findPluginAgentMode = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  agentMode: string,
): Promise<PluginAgentModeChoice> => {
  const modes = await listPluginAgentModes(bindings, db, threadId);
  const mode = modes.find((choice) => choice.agentMode === agentMode);
  if (mode !== undefined) return mode;
  throw new Error(
    modes.length === 0
      ? `No installed plugin offers the agent mode ${agentMode}; this Thread's owner has no plugin agent modes.`
      : `No installed plugin offers the agent mode ${agentMode}. Plugin agent modes: ${modes.map((choice) => choice.agentMode).join(", ")}.`,
  );
};
