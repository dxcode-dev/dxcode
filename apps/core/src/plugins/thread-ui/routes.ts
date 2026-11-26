import {
  AnswerPluginPromptRequestSchema,
  type PluginCommand,
  type PluginLinkPattern,
  type PluginThreadUiErrorCode,
  PluginThreadUiResponseSchema,
  RunPluginCommandRequestSchema,
} from "@dx/api";
import { archivedModeFor, effectiveArchivedMode } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import {
  answerDxPrompt,
  type DxOutcome,
  DxPromptInvalid,
} from "../../settings/manage-dx/apply.js";
import { draftViewOptions, threadDrafts } from "../drafts/views.js";
import {
  readRepositoryPlugins,
  resolveRepositoryPlugins,
} from "../repository/repository-plugins.js";
import { dataViewOptions } from "../views/data-routes.js";
import { threadTypeEntry } from "../views/thread-views.js";
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
import { runPluginCommand } from "../worker-host/worker.js";
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
 * so the owner's personal plugins take commands and command quick actions
 * from the owner only; workspace plugins take them from every
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
  PLUGIN_COMMAND_NOT_FOUND: [
    404,
    "No installed plugin offers that command in this Thread.",
  ],
  PLUGIN_COMMAND_FAILED: [502, "The plugin's command failed."],
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
 * The most a plugin UI request body may hold: a prompt's answer (up to 3
 * bytes a character in UTF-8) plus its envelope. Read with the cap enforced
 * while it streams in, so a chunked body is never buffered whole.
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

// --- Archived Threads ---

const archivedOf = (context: Context<AppEnv>) =>
  context.get("threadLifecycleState") === "archived";

/** One downgrade line per plugin and mode per request. */
const downgradesLogged = new WeakMap<Context<AppEnv>, Set<string>>();

/**
 * What the plugin shows in an archived Thread. A `live` that cannot be
 * granted yet is served as `hide` and logged.
 */
const archivedMode = (
  context: Context<AppEnv>,
  plugin: Pick<ResolvedCodePlugin, "pluginId" | "name" | "code" | "scope">,
) => {
  const declared = archivedModeFor(plugin.code.archivedThreads);
  const granted = effectiveArchivedMode(declared, plugin.scope);
  const key = plugin.pluginId;
  const logged = downgradesLogged.get(context) ?? new Set<string>();
  downgradesLogged.set(context, logged);
  if (granted.downgraded !== undefined && !logged.has(key) && logged.add(key))
    logger.info("Plugin archivedThreads live served as hide.", {
      event: "plugin_archived_live_downgraded",
      requestId: context.get("requestId"),
      installId: plugin.pluginId,
      plugin: plugin.name,
      host: "worker",
      scope: plugin.scope,
      outcome: "hide",
      reason: granted.downgraded,
    });
  return granted.mode;
};

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
    installs.filter((install) => archivedMode(context, install) !== "hide"),
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

/**
 * The shell gate for a command outside a turn: the same
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
    };
    if (db === undefined)
      return context.json(
        Schema.encodeUnknownSync(PluginThreadUiResponseSchema)({
          status: "success",
          data: empty,
        }),
      );
    const started = Date.now();
    // An archived Thread shows no prompts, actions, commands, or links.
    const archived = archivedOf(context);
    const readOnly = access(context) === "view" || archived;
    // Every read starts at once: the Thread's plugins, its prompts, and its
    // quick actions take one D1 round trip.
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
    const [running, shown, quickActions, drafts] = await Promise.all([
      runningPromise,
      archived
        ? { prompts: [], notices: [] }
        : listThreadPrompts(db, threadId, namesPromise),
      readOnly ? [] : listThreadQuickActions(db, threadId, namesPromise),
      // The Thread's own drafts: one call to its object, never D1.
      archived ? [] : threadDrafts(context.env, threadId).catch(() => []),
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
      : // Everyone who can write in the Thread runs its plugins'
        // commands, personal ones included, as the owner does.
        running.flatMap((plugin) =>
          plugin.commands.map((command) => ({
            ...command,
            id: `${plugin.pluginId}:${command.id}`,
            plugin: plugin.displayName,
            pluginName: plugin.name,
          })),
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
          quickActions,
          commands,
          linkPatterns,
          plugins,
          tools,
          // Views described as data: panels, cards, and the app's view.
          // An archived Thread shows none.
          dataViews: archived
            ? []
            : [
                // A draft's views show only here, only as a panel; a draft
                // of an installed plugin takes its place in this Thread.
                ...draftViewOptions(drafts),
                ...running
                  .filter(
                    ({ name }) =>
                      !drafts.some(({ plugin }) => plugin.name === name),
                  )
                  .flatMap((plugin) =>
                    dataViewOptions(plugin, ["panel", "card", "app"]),
                  ),
              ],
          ...(context.get("threadPluginType") === undefined
            ? {}
            : {
                threadType: threadTypeEntry(
                  context.get("threadPluginType"),
                  running,
                  { archived },
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
    // The command may wait on a person's answer to one of its prompts; the
    // request stays open while it does, and a closed page has a moment more.
    const requestId = context.get("requestId");
    const started = Date.now();
    const outcome = {
      requestId,
      installId: plugin.pluginId,
      host: "worker",
      scope: plugin.scope,
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
  });
