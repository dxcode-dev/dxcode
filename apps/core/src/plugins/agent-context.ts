import { env, waitUntil } from "cloudflare:workers";
import { ARTIFACT_BOARDS_FEATURE } from "@dx/api";
import {
  type ExperimentalFeatureId,
  mcpModuleIdFor,
  Principal,
} from "@dx/domain";
import { FlueError } from "@flue/runtime";
import { getLogger } from "@logtape/logtape";
import { Effect, Schema } from "effect";
import { readOrbThreadState } from "../agents/orb-free.js";
import { mayUseBugReportTools } from "../bug-reports/agent-tools.js";
import type { Bindings } from "../http/types.js";
import { markRunFailure } from "../runtime/run-failure.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
import {
  type McpAgentConnectionData,
  resolveMcpAgentConnections,
} from "../settings/mcp-servers/execution.js";
import { resolveLocalMcpAgentConnections } from "../settings/mcp-servers/local-servers.js";
import { loadThreadWorkspaceAgentInstructions } from "../settings/workspace-agent-instructions/thread.js";
import {
  readGatedSpacePromptData,
  readGatedStartingSpace,
} from "../spaces/gated-prompt-data.js";
import type { PluginAgentDefinition } from "./agents/definition.js";
import { pluginAgentThreadOf } from "./agents/threads.js";
import type { PluginHostContext } from "./host.js";
import {
  clearRepositoryLocalMcpServers,
  recordRepositoryLocalMcpServers,
} from "./repository/repository-local-mcp.js";
import {
  clearRepositoryMcpServers,
  discoverRepositoryMcpServers,
} from "./repository/repository-mcp.js";
import {
  type RepositoryPluginSandbox,
  readRepositoryPlugins,
  resolveRepositoryPlugins,
} from "./repository/repository-plugins.js";
import { resolveSubmissionPluginTools } from "./submission-tools.js";
import {
  describeCodePlugins,
  MAX_CODE_PLUGINS_PER_THREAD,
  resolveThreadCodePlugins,
} from "./worker-host/resolve.js";

/** The Worker bindings first-party plugin tools resolve against at call time. */
export const agentPluginHostContext = (): PluginHostContext => {
  const bindings = env as Bindings;
  if (bindings.DB === undefined)
    throw new Error("Plugin host requires the D1 binding.");
  return { db: bindings.DB, bindings };
};

/**
 * What the Thread tools resolve against: the plugin host context, plus the
 * runtime's `waitUntil` for work a route starts and finishes later.
 */
export const agentThreadToolsContext = () => ({
  ...agentPluginHostContext(),
  waitUntil,
});

/**
 * The plugin tool set for one agent submission, recorded with it, and the
 * MCP servers Code offers in it. Both come from current settings, never from
 * the agent's creation data, so a server connected or signed in to after the
 * Thread started reaches its next submission.
 */
export const resolveAgentPluginTools = async (
  threadId: string,
  submissionId: string,
) => {
  const context = agentPluginHostContext();
  const [tools, mcpConnections, localConnections] = await Promise.all([
    resolveSubmissionPluginTools(context, threadId, submissionId),
    Effect.runPromise(resolveMcpAgentConnections(context.db, threadId)),
    // A failed read of local servers leaves the remote ones working.
    resolveLocalMcpAgentConnections(context.db, threadId).catch(() => []),
  ]);
  // A remote server keeps its module name; a local one with the same name
  // is left out rather than take calls meant for the remote server.
  const moduleOf = (connection: McpAgentConnectionData) =>
    connection.moduleId ??
    mcpModuleIdFor(connection.displayName ?? connection.name);
  const remoteModules = new Set(mcpConnections.map(moduleOf));
  return {
    submissionId,
    tools,
    mcpConnections: [
      ...mcpConnections,
      ...localConnections.filter(
        (connection) => !remoteModules.has(moduleOf(connection)),
      ),
    ],
  };
};

/**
 * Whether this submission's Thread gets the bug report tools: its owner is
 * one of the deployment's report readers. A failed read mounts none.
 */
export const resolveAgentBugReportReader = async (threadId: string) => {
  try {
    return await mayUseBugReportTools(agentPluginHostContext(), threadId);
  } catch {
    return false;
  }
};

/**
 * Whether the Thread's owner turned on drawing boards, so its agent's
 * `artifact` tool creates and edits them. Read per submission; a failed read
 * offers documents only.
 */
export const resolveAgentArtifactBoards = async (threadId: string) => {
  try {
    const context = agentPluginHostContext();
    const owner = await context.db
      .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
      .bind(threadId)
      .first<string>("owner_user_id");
    if (owner === null) return false;
    return await experimentalFeatureEnabled(
      context.bindings,
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      }),
      ARTIFACT_BOARDS_FEATURE as ExperimentalFeatureId,
    );
  } catch {
    return false;
  }
};

/**
 * The workspace's AGENTS.md for this submission, read from current settings
 * so an admin's change reaches the next message in every member's Thread.
 * Async, so a missing binding rejects with the other reads instead of
 * throwing while they are already in flight.
 */
export const resolveAgentWorkspaceInstructions = async (threadId: string) =>
  loadThreadWorkspaceAgentInstructions(agentPluginHostContext().db, threadId);

/**
 * The Space this submission's Thread is, read from current settings so a
 * renamed Space or a new goal reaches the next message; undefined for any
 * other Thread, and while Spaces is off for its owner (spaces/gate.ts).
 */
export const resolveAgentSpace = async (threadId: string) => {
  return readGatedSpacePromptData(agentPluginHostContext().bindings, threadId);
};

/**
 * The Thread's Orb-relevant state (`runsWithoutOrb`), from D1: the server's
 * record, never the creation data a client sent. A Space runs without an Orb
 * whether or not its owner's `spaces` flag is on: turning the flag off never
 * wakes an Orb for it.
 */
export const resolveAgentOrbThreadState = async (threadId: string) =>
  readOrbThreadState(agentPluginHostContext().db, threadId);

/**
 * The Space that started this Thread, for the child's prompt; undefined
 * while Spaces is off for its owner.
 */
export const resolveAgentStartingSpace = async (threadId: string) =>
  readGatedStartingSpace(agentPluginHostContext().bindings, threadId);

/**
 * Installed plugins with code for this submission, with what each one's
 * Dynamic Worker handles. Undefined when none is installed, so a Thread
 * without plugin code records nothing.
 */
/** The plugin agent a Thread runs, as its submission applies it. */
export interface ResolvedThreadAgent {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginDisplayName: string;
  readonly modeKey?: string;
  readonly definition: PluginAgentDefinition;
}

export const resolveAgentCodePlugins = async (threadId: string) => {
  const { db, bindings } = agentPluginHostContext();
  // Independent reads: one round trip instead of two. The owner's row
  // carries the plugin agent the Thread runs, when it runs one.
  const [owner, plugins] = await Promise.all([
    db
      .prepare(
        `SELECT thread.owner_user_id, agent.plugin_id, agent.plugin_name,
                agent.plugin_display_name, agent.plugin_version, agent.mode_key,
                agent.definition_json
           FROM threads thread
           LEFT JOIN plugin_agent_thread agent
             ON agent.thread_id = thread.id
            AND agent.owner_user_id = thread.owner_user_id
          WHERE thread.id = ? LIMIT 1`,
      )
      .bind(threadId)
      .first<{
        owner_user_id: string;
        plugin_id: string | null;
        plugin_name: string | null;
        plugin_display_name: string | null;
        plugin_version: string | null;
        mode_key: string | null;
        definition_json: string | null;
      }>(),
    resolveThreadCodePlugins(bindings, db, threadId),
  ]);
  if (owner === null) return undefined;
  const bound =
    owner.plugin_id === null ||
    owner.plugin_name === null ||
    owner.plugin_version === null ||
    owner.definition_json === null
      ? undefined
      : pluginAgentThreadOf({
          plugin_id: owner.plugin_id,
          plugin_name: owner.plugin_name,
          plugin_version: owner.plugin_version,
          mode_key: owner.mode_key,
          definition_json: owner.definition_json,
        });
  let agent: ResolvedThreadAgent | undefined;
  if (bound !== undefined) {
    // Fail closed: without its plugin the Thread would run as a plain dx
    // agent, without the agent's instructions or tool limits.
    const plugin = plugins.find(
      ({ pluginId, loadError }) =>
        pluginId === bound.pluginId && loadError === undefined,
    );
    if (plugin === undefined || plugin.code.permissions.agents !== true)
      // Flue keeps only a FlueError's message on the failed settlement,
      // and the Thread's error card reads its stamp.
      throw new FlueError({
        type: "plugin_agent_unavailable",
        message: markRunFailure({
          class: "account",
          code: "PLUGIN_AGENT_UNAVAILABLE",
          message: `This Thread runs the ${bound.definition.display?.label ?? bound.definition.name} agent from the ${owner.plugin_display_name ?? bound.pluginName} plugin, which no longer runs for you or no longer may run agents. Enable or reinstall the plugin in Settings → Plugins, then retry.`,
          retryable: false,
        }),
        details: "",
        dev: "",
        meta: { code: "PLUGIN_AGENT_UNAVAILABLE", pluginId: bound.pluginId },
      });
    agent = {
      pluginId: bound.pluginId,
      pluginName: bound.pluginName,
      pluginDisplayName: plugin.displayName,
      ...(bound.modeKey === undefined ? {} : { modeKey: bound.modeKey }),
      definition: bound.definition,
    };
  }
  return plugins.length === 0
    ? undefined
    : {
        ownerUserId: owner.owner_user_id,
        plugins,
        ...(agent === undefined ? {} : { agent }),
      };
};

const repositoryLogger = getLogger(["dx", "plugins", "repository"]);

/**
 * The plugins the Thread's repository carries, read from its Orb once the
 * submission's activation is ready, with their code started. Skills named
 * like a `.agents/skills` skill or one in `reservedSkillNames` are left out.
 * Reading never fails the submission: a failure loads none and is logged.
 */
export const resolveAgentRepositoryPlugins = async (
  threadId: string,
  activation: Promise<RepositoryPluginSandbox>,
  reservedSkillNames: ReadonlySet<string>,
  /** Installed plugins with code this submission already runs. */
  installedCodePlugins = 0,
) => {
  // Whatever doesn't reach discovery below loads no repository server.
  const forgetServers = () =>
    Promise.all([
      clearRepositoryMcpServers(agentPluginHostContext().db, threadId),
      clearRepositoryLocalMcpServers(agentPluginHostContext().db, threadId),
    ]).catch(() => undefined);
  try {
    const sandbox = await activation;
    const read = await readRepositoryPlugins(sandbox);
    if (read === undefined) {
      await forgetServers();
      return undefined;
    }
    // Flue discovers `.agents/skills` under the sandbox's working folder.
    const repositorySkills = await sandbox
      .readdir(`${sandbox.cwd.replace(/\/$/, "")}/.agents/skills`)
      .catch(() => [] as string[]);
    const { db, bindings } = agentPluginHostContext();
    const resolution = await resolveRepositoryPlugins(
      db,
      threadId,
      read,
      new Set([...reservedSkillNames, ...repositorySkills]),
    );
    if (resolution === undefined) {
      await forgetServers();
      return undefined;
    }
    // Only as many as a Thread runs start a worker.
    const code = await describeCodePlugins(
      bindings,
      db,
      resolution.plugins
        .flatMap(({ code: install }) =>
          install === undefined ? [] : [install],
        )
        .slice(0, MAX_CODE_PLUGINS_PER_THREAD - installedCodePlugins),
    );
    const mcp = await discoverRepositoryMcpServers(
      db,
      threadId,
      resolution.projectId,
      resolution.plugins.map(({ name, mcpServers }) => ({
        name,
        servers: mcpServers,
      })),
    );
    const local = await recordRepositoryLocalMcpServers(
      db,
      bindings.DX_STORAGE,
      threadId,
      resolution.projectId,
      resolution.plugins.map(({ name, mcpServers, package: pkg }) => ({
        name,
        servers: mcpServers,
        ...(pkg === undefined ? {} : { package: pkg }),
      })),
    );
    const skipped = [...resolution.skipped, ...mcp.skipped, ...local.skipped];
    if (skipped.length > 0)
      repositoryLogger.info("Some repository plugins were skipped.", {
        event: "repository_plugins_skipped",
        threadId,
        skipped,
      });
    return {
      ownerUserId: resolution.ownerUserId,
      commit: resolution.commit,
      plugins: resolution.plugins.map(
        ({ name, displayName, folder, integrity, skills }) => ({
          name,
          displayName,
          folder,
          integrity,
          skills,
        }),
      ),
      skipped,
      code,
      mcpConnections: [...mcp.connections, ...local.connections],
    };
  } catch (error) {
    await forgetServers();
    repositoryLogger.warn("The repository's plugins could not be read.", {
      event: "repository_plugins_unavailable",
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};
