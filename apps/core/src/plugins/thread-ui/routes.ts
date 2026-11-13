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
import {
  readRepositoryPlugins,
  resolveRepositoryPlugins,
} from "../repository/repository-plugins.js";
import { pluginShellGate } from "../worker-host/agent.js";
import {
  describeCodePlugins,
  type ResolvedCodePlugin,
  resolveThreadCodePlugins,
} from "../worker-host/resolve.js";
import { runPluginCommand, sendPaneMessage } from "../worker-host/worker.js";
import { insertPaneEvent, listPaneMessages, recentPaneOpens } from "./panes.js";
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
  route: string,
  plugin: { readonly pluginId: string; readonly name: string },
) => {
  logger.info(`Plugin ${plugin.name} refused a member's ${route} call.`, {
    event: "plugin_ui_request",
    route,
    outcome: "refused:owner-only",
    installId: plugin.pluginId,
    plugin: plugin.name,
    threadId: context.req.param("threadId"),
    access: access(context),
    ...actorOf(context),
  });
  return refuse(context, "PLUGIN_UI_OWNER_ONLY");
};

/** Whether the install may show panes: its manifest grants `pane`. */
const showsPanes = (plugin: ResolvedCodePlugin) =>
  plugin.loadError === undefined &&
  (plugin.code.permissions.ui ?? []).includes("pane");

/** The running install that offers `plugin`'s pane `pane`, and the pane. */
const findPane = async (context: Context<AppEnv>, db: D1Database) => {
  const name = context.req.param("plugin") ?? "";
  const id = context.req.param("pane") ?? "";
  const plugins = await resolveThreadCodePlugins(
    context.env,
    db,
    context.req.param("threadId") ?? "",
  );
  const plugin = plugins.find(
    (candidate) => candidate.name === name && showsPanes(candidate),
  );
  const pane = plugin?.panes.find((candidate) => candidate.id === id);
  return plugin === undefined || pane === undefined
    ? undefined
    : { plugin, pane, plugins };
};

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
    const readOnly = access(context) === "view";
    // Every read starts at once: the Thread's plugins, its prompts, its
    // quick actions, and its recent pane opens take one D1 round trip.
    const pluginsPromise = resolveThreadCodePlugins(
      context.env,
      db,
      threadId,
    ).catch((error: unknown) => {
      logger.warn("Plugin UI could not resolve the Thread's plugins.", {
        event: "plugin_ui_resolve_failed",
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    const runningPromise = pluginsPromise.then((plugins) =>
      plugins.filter((plugin) => plugin.loadError === undefined),
    );
    const [running, shown, quickActions, opens] = await Promise.all([
      runningPromise,
      listThreadPrompts(db, threadId),
      readOnly
        ? []
        : listThreadQuickActions(
            db,
            threadId,
            runningPromise.then(
              (plugins) =>
                new Map(plugins.map(({ pluginId, name }) => [pluginId, name])),
            ),
          ),
      recentPaneOpens(db, threadId),
    ]);
    const linkPatterns: PluginLinkPattern[] = running.flatMap((plugin) =>
      plugin.linkPatterns.map((link) => ({
        ...link,
        plugin: plugin.displayName,
      })),
    );
    const commands: PluginCommand[] = readOnly
      ? []
      : running
          .filter((plugin) => !ownerOnly(context, plugin))
          .flatMap((plugin) =>
            plugin.commands.map((command) => ({
              ...command,
              id: `${plugin.pluginId}:${command.id}`,
              plugin: plugin.displayName,
            })),
          );
    const panes: PluginPaneEntry[] = running
      .filter(showsPanes)
      .flatMap((plugin) =>
        plugin.panes.map((pane) => {
          const openedAt = opens.get(`${plugin.name}/${pane.id}`);
          return {
            plugin: plugin.name,
            pane: pane.id,
            title: pane.title,
            pluginTitle: plugin.displayName,
            version: plugin.version,
            ...(openedAt === undefined ? {} : { openedAt }),
            ...(ownerOnly(context, plugin) ? { ownerOnly: true as const } : {}),
          };
        }),
      );
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
        },
      }),
    );
  })
  .post("/:threadId/plugin-ui/prompts/:promptId", async (context) => {
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
      return refuseOwnerOnly(context, "command", plugin);
    // The command may wait on a person's answer to one of its prompts; the
    // request stays open while it does, and a closed page has a moment more.
    const run = runPluginCommand(
      {
        db,
        bindings: context.env,
        install: plugin,
        threadId,
        ownerUserId: context.get("threadOwnerUserId"),
        ...actorOf(context),
        ...shellGateFor(context, db, threadId, plugins, plugin),
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
        threadId,
        error: detail,
      });
      return refuse(context, "PLUGIN_COMMAND_FAILED", detail);
    }
    context.header("Cache-Control", "no-store");
    return context.json({ status: "success", data: { ran: true } });
  })
  .get("/:threadId/plugin-ui/panes/:plugin/:pane", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return refuse(context, "INVALID_REQUEST");
    const found = await findPane(context, db);
    if (found === undefined) return refuse(context, "PLUGIN_PANE_NOT_FOUND");
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
    const [found, messages] = await Promise.all([
      findPane(context, db),
      listPaneMessages(db, {
        threadId: context.req.param("threadId"),
        pluginName: context.req.param("plugin"),
        paneId: context.req.param("pane"),
        after,
      }),
    ]);
    if (found === undefined) return refuse(context, "PLUGIN_PANE_NOT_FOUND");
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
        return refuseOwnerOnly(context, "pane-message", found.plugin);
      const threadId = context.req.param("threadId");
      // A view's script could call in a loop with nobody clicking.
      try {
        await insertPaneEvent(db, {
          threadId,
          pluginId: found.plugin.pluginId,
          pluginName: found.plugin.name,
          paneId: found.pane.id,
          kind: "call",
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
          install: found.plugin,
          threadId,
          ownerUserId: context.get("threadOwnerUserId"),
          ...actorOf(context),
          ...shellGateFor(context, db, threadId, found.plugins, found.plugin),
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
