import {
  AnswerPluginPromptRequestSchema,
  type PluginCommand,
  type PluginLinkPattern,
  type PluginPaneEntry,
  PluginPaneMessagesResponseSchema,
  PluginPaneViewResponseSchema,
  type PluginThreadUiErrorCode,
  PluginThreadUiResponseSchema,
  PostPluginPaneMessageRequestSchema,
  PostPluginPaneMessageResponseSchema,
  RunPluginCommandRequestSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  archivedModeFor,
  effectiveArchivedMode,
  type PluginArchivedMode,
  pluginHostKinds,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import { portalConfiguration, portalOrigin } from "../../portals/host.js";
import {
  answerDxPrompt,
  type DxOutcome,
  DxPromptInvalid,
} from "../../settings/manage-dx/apply.js";
import {
  readRepositoryPlugins,
  resolveRepositoryPlugins,
} from "../repository/repository-plugins.js";
import { paneConnectFor } from "../streams/pane-connect.js";
import { pluginTier, tierIsTrusted, viewerTier } from "../streams/tier.js";
import { configuredTierLimits } from "../trust/limits.js";
import { viewerPaneTier } from "../trust/resolve-tier.js";
import {
  findThreadTab,
  threadTabs,
  threadTypeEntry,
} from "../views/thread-views.js";
import {
  pluginShellGate,
  pluginToolNameAllowed,
} from "../worker-host/agent.js";
import {
  describeCodePlugins,
  listThreadCodePluginInstalls,
  type ResolvedCodePlugin,
  resolveThreadCodePlugins,
} from "../worker-host/resolve.js";
import { runPluginCommand, sendPaneMessage } from "../worker-host/worker.js";
import {
  insertPaneEvent,
  listPaneMessages,
  readPaneSnapshot,
  recentPaneOpens,
} from "./panes.js";
import { wakePromptWaiter } from "./prompt-wake.js";
import {
  answerPrompt,
  invalidatePluginUi,
  listThreadPrompts,
  listThreadQuickActions,
} from "./store.js";

/**
 * Plugin UI in a Thread, mounted at `/v1/threads` behind `authorizeThread`.
 * Everyone who can open the Thread sees its notices and link patterns; the
 * owner and Contribute members also see and answer prompts, use quick
 * actions, and run palette commands. A secret input takes only the owner's
 * answer. Commands run as the Thread's owner, as everything in a Thread does,
 * so the owner's personal plugins take commands, command quick actions, and
 * pane messages from the owner only; workspace plugins take them from every
 * member, and record that member as the call's actor.
 */

const logger = getLogger(["dx", "plugins", "thread-ui"]);

const MESSAGES: Record<PluginThreadUiErrorCode, [number, string]> = {
  INVALID_REQUEST: [400, "Request validation failed."],
  PLUGIN_UI_READ_ONLY: [
    403,
    "People who can only view this Thread cannot answer plugins.",
  ],
  PLUGIN_PROMPT_NOT_FOUND: [
    404,
    "That plugin question was answered or has expired.",
  ],
  PLUGIN_PROMPT_OWNER_ONLY: [
    403,
    "Only the Thread's owner can answer this plugin question.",
  ],
  PLUGIN_UI_OWNER_ONLY: [
    403,
    "This is the Thread owner's own plugin: only they can use it here.",
  ],
  PLUGIN_COMMAND_NOT_FOUND: [
    404,
    "No installed plugin offers that command in this Thread.",
  ],
  PLUGIN_COMMAND_FAILED: [502, "The plugin's command failed."],
  PLUGIN_PANE_NOT_FOUND: [
    404,
    "No installed plugin offers that pane in this Thread.",
  ],
  PLUGIN_PANE_FAILED: [502, "The plugin's pane could not answer."],
  PLUGIN_THREAD_ARCHIVED: [
    409,
    "The Thread is archived. Restore it to use its plugins.",
  ],
};

const refuse = (
  context: Context<AppEnv>,
  code: PluginThreadUiErrorCode,
  detail?: string,
) => {
  const [status, message] = MESSAGES[code];
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error" as const,
      data: {
        code,
        message,
        requestId: context.get("requestId"),
        ...(detail === undefined ? {} : { detail }),
      },
    },
    status as 400,
  );
};

/**
 * The most a plugin UI request body may hold: a pane message of 65,536
 * characters (up to 3 bytes each in UTF-8) plus its envelope. Read with the
 * cap enforced while it streams in, so a chunked body is never buffered whole.
 */
const MAX_PLUGIN_UI_BODY_BYTES = 256 * 1_024;

const decodeBody = async <S extends Schema.Top>(
  context: Context<AppEnv>,
  schema: S,
) => {
  try {
    const text = await readBoundedText(
      context.req.raw,
      MAX_PLUGIN_UI_BODY_BYTES,
    );
    if (text === undefined) return undefined;
    const decoded = Schema.decodeUnknownOption(schema as never)(
      JSON.parse(text) as unknown,
    ) as Option.Option<S["Type"]>;
    return Option.getOrUndefined(decoded);
  } catch {
    return undefined;
  }
};

/** Keeps `work` running after the response where the runtime allows it. */
const keepAlive = (context: Context<AppEnv>, work: Promise<unknown>) => {
  const settled = work.catch(() => undefined);
  try {
    context.executionCtx.waitUntil(settled);
  } catch {
    // No request context (tests): the work already runs.
  }
};

const access = (context: Context<AppEnv>) =>
  context.get("threadAccess") ?? "owner";

/**
 * Who clicked, when it was not the owner: a member of a shared Thread. The
 * call still runs as the owner's install; this is `ctx.caller` and the
 * audit's `actorUserId`.
 */
const actorOf = (context: Context<AppEnv>) => {
  const actor = (context.get("actor") ?? context.get("principal"))?.userId;
  return actor === undefined || actor === context.get("threadOwnerUserId")
    ? {}
    : { actorUserId: actor };
};

/**
 * A personal install is its owner's own: in a shared Thread its commands,
 * command quick actions, and pane messages are for the owner only, since
 * they run with the owner's secrets, network, and shell. Workspace installs
 * were approved for every member.
 */
const ownerOnly = (
  context: Context<AppEnv>,
  plugin: { readonly scope: string },
) => plugin.scope === "personal" && access(context) !== "owner";

/** Refuses a member a personal install's interactive call, and logs it. */
const refuseOwnerOnly = (
  context: Context<AppEnv>,
  started: number,
  route: string,
  plugin: { readonly pluginId: string; readonly name: string },
) => {
  logUi(context, started, {
    route,
    outcome: "refused:owner-only",
    installId: plugin.pluginId,
    plugin: plugin.name,
    access: access(context),
    ...actorOf(context),
  });
  return refuse(context, "PLUGIN_UI_OWNER_ONLY");
};

// --- Archived Threads ---

const archivedOf = (context: Context<AppEnv>) =>
  context.get("threadLifecycleState") === "archived";

/** One downgrade line per plugin and mode per request. */
const downgradesLogged = new WeakMap<Context<AppEnv>, Set<string>>();

/**
 * What one pane (or, without one, the plugin) shows in an archived Thread.
 * A `live` that cannot be granted yet is served as `hide` and logged.
 */
const archivedMode = (
  context: Context<AppEnv>,
  plugin: Pick<ResolvedCodePlugin, "pluginId" | "name" | "code" | "tier">,
  paneMode?: PluginArchivedMode,
) => {
  const declared = archivedModeFor(plugin.code.archivedThreads, paneMode);
  // The durable host counts when the manifest declares it and the
  // deployment runs it.
  const granted = effectiveArchivedMode(
    declared,
    plugin.tier,
    pluginHostKinds(plugin.code).filter(
      (kind) =>
        kind !== "durable" || context.env.PLUGIN_DURABLE_HOST !== undefined,
    ),
  );
  const key = `${plugin.pluginId}/${paneMode ?? ""}`;
  const logged = downgradesLogged.get(context) ?? new Set<string>();
  downgradesLogged.set(context, logged);
  if (granted.downgraded !== undefined && !logged.has(key) && logged.add(key))
    logger.info("Plugin archivedThreads live served as hide.", {
      event: "plugin_archived_live_downgraded",
      requestId: context.get("requestId"),
      installId: plugin.pluginId,
      plugin: plugin.name,
      host: "worker",
      tier: plugin.tier ?? "sandboxed",
      outcome: "hide",
      reason: granted.downgraded,
    });
  return granted.mode;
};

/** Whether any of the install's panes could show in an archived Thread. */
const mayShowArchived = (
  context: Context<AppEnv>,
  install: Pick<ResolvedCodePlugin, "pluginId" | "name" | "code" | "tier">,
) =>
  archivedMode(context, install) !== "hide" ||
  (install.code.panes ?? []).some(
    (pane) => archivedMode(context, install, pane.archivedThreads) !== "hide",
  );

/**
 * The Thread's plugins for this request. In an archived Thread only those
 * that show something there are started; a `hide` plugin's code never runs
 * for it.
 */
const threadPlugins = async (context: Context<AppEnv>, db: D1Database) => {
  const threadId = context.req.param("threadId") ?? "";
  if (!archivedOf(context))
    // Declared jobs start in the background.
    return resolveThreadCodePlugins(context.env, db, threadId, (promise) => {
      try {
        context.executionCtx.waitUntil(promise);
      } catch {}
    });
  const installs = await listThreadCodePluginInstalls(db, threadId);
  return describeCodePlugins(
    context.env,
    db,
    installs.filter((install) => mayShowArchived(context, install)),
  );
};

/** One line per plugin UI request, tied to its request id. */
const logUi = (
  context: Context<AppEnv>,
  started: number,
  fields: {
    readonly route: string;
    readonly outcome: string;
    readonly installId?: string;
    readonly plugin?: string;
    readonly [key: string]: unknown;
  },
) =>
  logger.info("Plugin UI request.", {
    event: "plugin_ui_request",
    requestId: context.get("requestId"),
    threadId: context.req.param("threadId"),
    archived: archivedOf(context),
    host: "worker",
    ms: Date.now() - started,
    ...fields,
  });

/** Refuses input to a plugin in an archived Thread, and logs it. */
const refuseArchived = (
  context: Context<AppEnv>,
  started: number,
  route: string,
) => {
  logUi(context, started, { route, outcome: "blocked-archived" });
  return refuse(context, "PLUGIN_THREAD_ARCHIVED");
};

/** Whether the install may show panes: its manifest grants `pane`. */
const showsPanes = (plugin: ResolvedCodePlugin) =>
  plugin.loadError === undefined &&
  (plugin.code.permissions.ui ?? []).includes("pane");

/** The running install that offers `plugin`'s pane `pane`, and the pane. */
const findPane = async (context: Context<AppEnv>, db: D1Database) => {
  const name = context.req.param("plugin") ?? "";
  const id = context.req.param("pane") ?? "";
  const plugins = await threadPlugins(context, db);
  const plugin = plugins.find(
    (candidate) => candidate.name === name && showsPanes(candidate),
  );
  const pane = plugin?.panes.find((candidate) => candidate.id === id);
  // An archived Thread shows only panes whose plugin says "show".
  if (
    plugin !== undefined &&
    pane !== undefined &&
    archivedOf(context) &&
    archivedMode(context, plugin, pane.archivedThreads) === "hide"
  )
    return undefined;
  if (plugin !== undefined && pane !== undefined)
    return { plugin, pane, plugins };
  // A plugin's Thread tab is served as its panes are.
  const owner = plugins.find((candidate) => candidate.name === name);
  const tab =
    owner === undefined
      ? undefined
      : findThreadTab(owner, id, viewState(context));
  return owner === undefined || tab === undefined
    ? undefined
    : { plugin: owner, pane: tab.pane, plugins };
};

/** What the Thread's state means for its plugin views. */
const viewState = (context: Context<AppEnv>) => ({
  archived: context.get("threadLifecycleState") === "archived",
  viewerUserId: (context.get("actor") ?? context.get("principal"))?.userId,
});

/**
 * The shell gate for a command or pane call outside a turn: the same
 * `tool.call` check the Thread's agent gets. The installed plugins come
 * from this route's resolution; the repository's own plugins, which a turn
 * reads from the Orb, are read from it the first time the call runs a
 * command, so a call that runs none reads nothing more.
 */
const shellGateFor = (
  context: Context<AppEnv>,
  db: D1Database,
  threadId: string,
  plugins: ReadonlyArray<ResolvedCodePlugin>,
  caller: ResolvedCodePlugin,
) =>
  caller.code.permissions.shell === true
    ? {
        shellGate: pluginShellGate(
          {
            threadId,
            ownerUserId: context.get("threadOwnerUserId"),
            plugins,
            host: () => ({ db, bindings: context.env }),
          },
          caller,
          async (workspace) => {
            const read = await readRepositoryPlugins(workspace);
            if (read === undefined) return [];
            const resolution = await resolveRepositoryPlugins(
              db,
              threadId,
              read,
            );
            if (resolution === undefined) return [];
            return describeCodePlugins(
              context.env,
              db,
              resolution.plugins.flatMap(({ code }) =>
                code === undefined ? [] : [code],
              ),
            );
          },
        ),
      }
    : {};

/**
 * A trusted pane's `live` entry; below the trusted tier the pane stays
 * sealed and anything its `connect` declared is dropped, with a log line.
 * Read from what resolution already loaded: no D1 read.
 */
const paneLive = (
  context: Context<AppEnv>,
  threadId: string,
  plugin: ResolvedCodePlugin,
  paneId: string,
) => {
  const installTier = pluginTier(plugin);
  // The pane's powers follow who views it: a personal install is trusted
  // only in its owner's own browser.
  const viewer = (context.get("actor") ?? context.get("principal")).userId;
  const tier = viewerTier(plugin, viewer);
  const connect = paneConnectFor(
    plugin.code.paneConnect,
    plugin.code.permissions.network,
    paneId,
  );
  if (!tierIsTrusted(tier)) {
    if (connect !== undefined || tierIsTrusted(installTier))
      logger.warn("A pane's connect was dropped below the trusted tier.", {
        event: "plugin_pane_connect_dropped",
        requestId: context.get("requestId"),
        threadId,
        installId: plugin.pluginId,
        streamId: `${plugin.name}/${paneId}`,
        tier,
        installTier,
        viewer: viewer === plugin.targetId ? "install-owner" : "other-member",
        outcome: "blocked-tier",
        dropped: {
          hosts: connect?.hosts.length ?? 0,
          portal: connect?.portal.length ?? 0,
          webrtc: connect?.webrtc === true,
        },
      });
    return {};
  }
  const portal = portalConfiguration(context.env);
  return {
    live: {
      hosts: connect?.hosts ?? [],
      webrtc: connect?.webrtc === true,
      // View-only people do not see the Thread's Portals.
      portals:
        portal === undefined || access(context) === "view"
          ? []
          : (connect?.portal ?? []).map((port) => ({
              port,
              url: `${portalOrigin(portal, threadId as ThreadId, port)}/`,
            })),
    },
  };
};

export const pluginThreadUiRoutes = new Hono<AppEnv>()
  .get("/:threadId/plugin-ui", async (context) => {
    const threadId = context.req.param("threadId");
    const db = context.env.DB;
    context.header("Cache-Control", "no-store");
    const empty = {
      prompts: [],
      notices: [],
      quickActions: [],
      commands: [],
      linkPatterns: [],
      panes: [],
    };
    if (db === undefined)
      return context.json(
        Schema.encodeUnknownSync(PluginThreadUiResponseSchema)({
          status: "success",
          data: empty,
        }),
      );
    const started = Date.now();
    // An archived Thread shows no prompts, actions, commands, or links,
    // only the panes whose plugin says "show", read-only.
    const archived = archivedOf(context);
    const readOnly = access(context) === "view" || archived;
    // Every read starts at once: the Thread's plugins, its prompts, its
    // quick actions, and its recent pane opens take one D1 round trip.
    const pluginsPromise = threadPlugins(context, db).catch(
      (error: unknown) => {
        logger.warn("Plugin UI could not resolve the Thread's plugins.", {
          event: "plugin_ui_resolve_failed",
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      },
    );
    const runningPromise = pluginsPromise.then((plugins) =>
      plugins.filter((plugin) => plugin.loadError === undefined),
    );
    const namesPromise = runningPromise.then(
      (plugins) =>
        new Map(plugins.map(({ pluginId, name }) => [pluginId, name])),
    );
    const [running, shown, quickActions, opens] = await Promise.all([
      runningPromise,
      archived
        ? { prompts: [], notices: [] }
        : listThreadPrompts(db, threadId, namesPromise),
      readOnly ? [] : listThreadQuickActions(db, threadId, namesPromise),
      archived ? new Map<string, string>() : recentPaneOpens(db, threadId),
    ]);
    const linkPatterns: PluginLinkPattern[] = (archived ? [] : running).flatMap(
      (plugin) =>
        plugin.linkPatterns.map((link) => ({
          ...link,
          plugin: plugin.displayName,
          pluginName: plugin.name,
        })),
    );
    const commands: PluginCommand[] = readOnly
      ? []
      : running.flatMap((plugin) =>
          // A personal install's commands are for the owner only.
          (ownerOnly(context, plugin) ? [] : plugin.commands).map(
            (command) => ({
              ...command,
              id: `${plugin.pluginId}:${command.id}`,
              plugin: plugin.displayName,
              pluginName: plugin.name,
            }),
          ),
        );
    const panes: PluginPaneEntry[] = running
      .filter(showsPanes)
      .flatMap((plugin) =>
        plugin.panes.flatMap((pane) => {
          if (
            archived &&
            archivedMode(context, plugin, pane.archivedThreads) === "hide"
          )
            return [];
          const openedAt = opens.get(`${plugin.name}/${pane.id}`);
          return [
            {
              plugin: plugin.name,
              pane: pane.id,
              title: pane.title,
              pluginTitle: plugin.displayName,
              version: plugin.version,
              ...(openedAt === undefined ? {} : { openedAt }),
              ...(pane.icon === undefined ? {} : { icon: pane.icon }),
              // A `live` pane stays interactive in an archived Thread.
              ...(archived &&
              archivedMode(context, plugin, pane.archivedThreads) !== "live"
                ? { readOnly: true }
                : {}),
              ...(ownerOnly(context, plugin)
                ? { ownerOnly: true as const }
                : {}),
              // What a trusted pane may reach.
              ...paneLive(context, threadId, plugin, pane.id),
            },
          ];
        }),
      );
    // Only tools the agent mounts, first plugin first, as createPluginTools
    // does: a name dx refuses never carries a plugin's icon onto dx's rows.
    const toolNames = new Set<string>();
    const tools = running.flatMap((plugin) =>
      plugin.tools.flatMap((tool) => {
        if (!pluginToolNameAllowed(tool.name) || toolNames.has(tool.name))
          return [];
        toolNames.add(tool.name);
        return [
          {
            name: tool.name,
            plugin: plugin.displayName,
            pluginName: plugin.name,
            ...(tool.icon === undefined ? {} : { icon: tool.icon }),
          },
        ];
      }),
    );
    const plugins = running.map((plugin) => ({
      title: plugin.displayName,
      name: plugin.name,
      ...(plugin.iconSet === undefined ? {} : { icon: plugin.iconSet }),
    }));
    logUi(context, started, {
      route: "list",
      outcome: "ok",
      plugins: running.length,
      panes: panes.length,
    });
    return context.json(
      Schema.encodeUnknownSync(PluginThreadUiResponseSchema)({
        status: "success",
        data: {
          prompts: readOnly
            ? []
            : access(context) === "owner"
              ? shown.prompts
              : // A dx card's details are the owner's settings: others
                // see only that it waits on the owner.
                shown.prompts.map((prompt) =>
                  prompt.kind === "change"
                    ? { ...prompt, items: [], message: undefined }
                    : prompt,
                ),
          notices: shown.notices,
          // A personal install's run-command buttons are the owner's only.
          quickActions: quickActions.filter(
            // A run-command action names its install: `<install id>:<id>`.
            (action) =>
              action.action !== "run-command" ||
              !running.some(
                (plugin) =>
                  action.args.command?.startsWith(`${plugin.pluginId}:`) ===
                    true && ownerOnly(context, plugin),
              ),
          ),
          commands,
          linkPatterns,
          panes,
          plugins,
          tools,
          // Tabs and the Thread's type, from the same resolution.
          tabs: threadTabs(running, viewState(context)),
          ...(context.get("threadPluginType") === undefined
            ? {}
            : {
                threadType: threadTypeEntry(
                  context.get("threadPluginType"),
                  running,
                  viewState(context),
                ),
              }),
        },
      }),
    );
  })
  .post("/:threadId/plugin-ui/prompts/:promptId", async (context) => {
    if (archivedOf(context))
      return refuseArchived(context, Date.now(), "prompt-answer");
    if (access(context) === "view")
      return refuse(context, "PLUGIN_UI_READ_ONLY");
    const input = await decodeBody(context, AnswerPluginPromptRequestSchema);
    const db = context.env.DB;
    if (input === undefined || db === undefined)
      return refuse(context, "INVALID_REQUEST");
    const threadId = context.req.param("threadId");
    const promptId = context.req.param("promptId");
    const userId = (context.get("actor") ?? context.get("principal")).userId;
    const result = await answerPrompt(db, {
      threadId,
      promptId,
      userId,
      isOwner: access(context) === "owner",
      answer: input.answer,
    });
    if (result === "not-found")
      return refuse(context, "PLUGIN_PROMPT_NOT_FOUND");
    if (result === "owner-only")
      return refuse(context, "PLUGIN_PROMPT_OWNER_ONLY");
    let outcome: DxOutcome | undefined;
    if (typeof result === "object") {
      // dx's own prompt: applying it is the answer (manage-dx/apply.ts).
      try {
        outcome = await answerDxPrompt(context, {
          threadId,
          promptId,
          userId,
          prompt: result,
          answer: input.answer,
        });
      } catch (error) {
        if (error instanceof DxPromptInvalid)
          return refuse(context, "INVALID_REQUEST", error.message);
        throw error;
      }
      if (outcome === undefined)
        return refuse(context, "PLUGIN_PROMPT_NOT_FOUND");
    }
    wakePromptWaiter(promptId);
    keepAlive(context, invalidatePluginUi(context.env, threadId));
    context.header("Cache-Control", "no-store");
    return context.json({
      status: "success",
      data: {
        answered: true,
        ...(outcome === undefined
          ? {}
          : outcome.approved
            ? {
                applied: outcome.applied,
                ...(outcome.error === undefined
                  ? {}
                  : { error: outcome.error }),
              }
            : { applied: false }),
      },
    });
  })
  .post("/:threadId/plugin-ui/commands", async (context) => {
    if (archivedOf(context))
      return refuseArchived(context, Date.now(), "command");
    if (access(context) === "view")
      return refuse(context, "PLUGIN_UI_READ_ONLY");
    const input = await decodeBody(context, RunPluginCommandRequestSchema);
    const db = context.env.DB;
    if (input === undefined || db === undefined)
      return refuse(context, "INVALID_REQUEST");
    const threadId = context.req.param("threadId");
    const split = input.command.lastIndexOf(":");
    const pluginId = input.command.slice(0, split);
    const commandId = input.command.slice(split + 1);
    const plugins = await resolveThreadCodePlugins(context.env, db, threadId);
    const plugin = plugins.find(
      (candidate) =>
        candidate.pluginId === pluginId &&
        candidate.loadError === undefined &&
        candidate.commands.some(({ id }) => id === commandId),
    );
    if (split < 1 || plugin === undefined)
      return refuse(context, "PLUGIN_COMMAND_NOT_FOUND");
    if (ownerOnly(context, plugin))
      return refuseOwnerOnly(context, Date.now(), "command", plugin);
    // The command may wait on a person's answer to one of its prompts; the
    // request stays open while it does, and a closed page has a moment more.
    const requestId = context.get("requestId");
    const started = Date.now();
    const outcome = {
      requestId,
      installId: plugin.pluginId,
      host: "worker",
      tier: plugin.tier ?? "sandboxed",
      threadId,
      command: commandId,
    };
    const run = runPluginCommand(
      {
        db,
        bindings: context.env,
        install: plugin,
        threadId,
        ownerUserId: context.get("threadOwnerUserId"),
        ...actorOf(context),
        requestId,
        ...shellGateFor(context, db, threadId, plugins, plugin),
        // Plugin calls reach the installs this request resolved.
        peers: async () => plugins,
      },
      commandId,
    );
    keepAlive(context, run);
    try {
      await run;
    } catch (error) {
      const detail =
        error instanceof Error && error.message !== ""
          ? error.message.slice(0, 500)
          : undefined;
      logger.warn(`Plugin ${plugin.name} command ${commandId} failed.`, {
        event: "plugin_command_failed",
        pluginId: plugin.pluginId,
        ...outcome,
        outcome: "failed",
        ms: Date.now() - started,
        error: detail,
      });
      return refuse(context, "PLUGIN_COMMAND_FAILED", detail);
    }
    logger.info(`Plugin ${plugin.name} command ${commandId} ran.`, {
      event: "plugin_command",
      ...outcome,
      outcome: "ok",
      ms: Date.now() - started,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ status: "success", data: { ran: true } });
  })
  .get("/:threadId/plugin-ui/panes/:plugin/:pane", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return refuse(context, "INVALID_REQUEST");
    const started = Date.now();
    const found = await findPane(context, db);
    if (found === undefined) {
      logUi(context, started, {
        route: "pane-view",
        outcome: "not-found",
        plugin: context.req.param("plugin"),
        pane: context.req.param("pane"),
      });
      return refuse(context, "PLUGIN_PANE_NOT_FOUND");
    }
    logUi(context, started, {
      route: "pane-view",
      outcome: archivedOf(context) ? "read-only" : "ok",
      installId: found.plugin.pluginId,
      tier: found.plugin.tier ?? "sandboxed",
      plugin: found.plugin.name,
      pane: found.pane.id,
    });
    // The tab asks by plugin version; a new version is a new URL.
    context.header("Cache-Control", "private, no-cache");
    return context.json(
      Schema.encodeUnknownSync(PluginPaneViewResponseSchema)({
        status: "success",
        data: { html: found.pane.html, version: found.plugin.version },
      }),
    );
  })
  .get("/:threadId/plugin-ui/panes/:plugin/:pane/messages", async (context) => {
    const db = context.env.DB;
    const after = Number(context.req.query("after") ?? "0");
    if (db === undefined || !Number.isSafeInteger(after) || after < 0)
      return refuse(context, "INVALID_REQUEST");
    // A pane its plugin no longer offers shows nothing it kept. Both reads
    // start at once; the messages are dropped when the pane is gone.
    const started = Date.now();
    const pane = {
      threadId: context.req.param("threadId"),
      pluginName: context.req.param("plugin"),
      paneId: context.req.param("pane"),
    };
    // An archived Thread's pane shows its last snapshot, once; with a durable host, a
    // `live` one keeps reading its posts.
    const found = await findPane(context, db);
    if (found === undefined) return refuse(context, "PLUGIN_PANE_NOT_FOUND");
    const live =
      archivedOf(context) &&
      archivedMode(
        context,
        found.plugin,
        "archivedThreads" in found.pane
          ? found.pane.archivedThreads
          : undefined,
      ) === "live";
    const messages =
      archivedOf(context) && !live
        ? after > 0
          ? []
          : await readPaneSnapshot(db, pane)
        : await listPaneMessages(db, { ...pane, after });
    if (archivedOf(context) && !live)
      logUi(context, started, {
        route: "pane-snapshot",
        outcome: messages.length === 0 ? "no-snapshot" : "snapshot",
        installId: found.plugin.pluginId,
        tier: found.plugin.tier ?? "sandboxed",
        plugin: found.plugin.name,
        pane: found.pane.id,
      });
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(PluginPaneMessagesResponseSchema)({
        status: "success",
        data: { messages },
      }),
    );
  })
  .post(
    "/:threadId/plugin-ui/panes/:plugin/:pane/messages",
    async (context) => {
      // Only a `live` pane takes messages in an archived Thread; it is
      // checked once the pane is found below.
      if (access(context) === "view")
        return refuse(context, "PLUGIN_UI_READ_ONLY");
      const input = await decodeBody(
        context,
        PostPluginPaneMessageRequestSchema,
      );
      const db = context.env.DB;
      if (input === undefined || db === undefined)
        return refuse(context, "INVALID_REQUEST");
      if (JSON.stringify(input.message ?? null).length > 65_536)
        return refuse(context, "INVALID_REQUEST");
      const found = await findPane(context, db);
      if (found === undefined || !found.pane.handlesMessages)
        return refuse(context, "PLUGIN_PANE_NOT_FOUND");
      if (ownerOnly(context, found.plugin))
        return refuseOwnerOnly(context, Date.now(), "pane-message", {
          pluginId: found.plugin.pluginId,
          name: found.plugin.name,
        });
      const archivedLive =
        archivedOf(context) &&
        archivedMode(
          context,
          found.plugin,
          "archivedThreads" in found.pane
            ? found.pane.archivedThreads
            : undefined,
        ) === "live";
      if (archivedOf(context) && !archivedLive)
        return refuseArchived(context, Date.now(), "pane-message");
      const threadId = context.req.param("threadId");
      // The view runs in the viewer's browser: a personal install's own tier
      // applies only for its owner; anyone else's call runs sandboxed.
      const viewerTierNow = viewerPaneTier(
        found.plugin.tier ?? "sandboxed",
        found.plugin.scope,
        found.plugin.targetId,
        (context.get("actor") ?? context.get("principal"))?.userId,
      );
      // A view's script could call in a loop with nobody clicking.
      try {
        await insertPaneEvent(db, {
          threadId,
          pluginId: found.plugin.pluginId,
          pluginName: found.plugin.name,
          paneId: found.pane.id,
          kind: "call",
          perMinute: configuredTierLimits(context.env, viewerTierNow)
            .paneMessagesPerMinute,
        });
      } catch (error) {
        return refuse(
          context,
          "PLUGIN_PANE_FAILED",
          error instanceof Error ? error.message : undefined,
        );
      }
      const run = sendPaneMessage(
        {
          db,
          bindings: context.env,
          install: { ...found.plugin, tier: viewerTierNow },
          threadId,
          ownerUserId: context.get("threadOwnerUserId"),
          ...actorOf(context),
          ...shellGateFor(context, db, threadId, found.plugins, found.plugin),
          // Plugin calls reach the installs this request resolved.
          requestId: context.get("requestId"),
          // Plugin calls reach the installs this request resolved.
          peers: async () => found.plugins,
          // Live in an archived Thread: no posts, wakes, or Orb.
          ...(archivedLive
            ? { archivedLive: true }
            : shellGateFor(context, db, threadId, found.plugins, found.plugin)),
        },
        found.pane.id,
        input.message ?? null,
      );
      keepAlive(context, run);
      try {
        const result = await run;
        context.header("Cache-Control", "no-store");
        return context.json(
          Schema.encodeUnknownSync(PostPluginPaneMessageResponseSchema)({
            status: "success",
            data: { result: result ?? null },
          }),
        );
      } catch (error) {
        const detail =
          error instanceof Error && error.message !== ""
            ? error.message.slice(0, 500)
            : undefined;
        logger.warn(
          `Plugin ${found.plugin.name} pane ${found.pane.id} failed.`,
          {
            event: "plugin_pane_message_failed",
            pluginId: found.plugin.pluginId,
            threadId,
            error: detail,
          },
        );
        return refuse(context, "PLUGIN_PANE_FAILED", detail);
      }
    },
  );
