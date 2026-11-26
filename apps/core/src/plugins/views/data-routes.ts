import {
  type PluginDataViewCallRequest,
  PluginDataViewCallRequestSchema,
  PluginDataViewCallResponseSchema,
  type PluginDataViewErrorCode,
  type PluginDataViewOption,
  PluginDataViewStateResponseSchema,
} from "@dx/api";
import type { DataViewPlace, UserId } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import { insertPluginAudit } from "../audit/audit.js";
import {
  draftViewFile,
  readDraftViewState,
  setDraftViewState,
  threadDrafts,
} from "../drafts/views.js";
import { callPluginService } from "../services/call.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import {
  listOwnerCodePluginInstalls,
  listThreadCodePluginInstalls,
} from "../worker-host/resolve.js";
import { TOOL_TIMEOUT_MS } from "../worker-host/runtime.js";
import { callPluginExport } from "../worker-host/worker.js";
import {
  dataViewOf,
  readDataViewFile,
  readPluginViewState,
  setPluginViewState,
} from "./state.js";
import { signViewWatch, viewStateKey } from "./watch-token.js";

/**
 * Views described as data, outside and inside a Thread.
 *
 * - `GET /v1/plugins/views/definitions/:installId/:integrity`: a view file,
 *   by its install and the sha256 of its text. The same address is always
 *   the same file, so the browser keeps it for a year.
 * - `GET /v1/plugins/views/:plugin/data/:view/state` and
 *   `POST …/call`: a page's state and actions, for the caller's own installs
 *   (their personal ones and their workspaces').
 * - `GET /v1/threads/:threadId/plugin-ui/views/:plugin/:view/state` and
 *   `POST …/call`: the same for a Thread's panels, cards, and app, from the
 *   Thread's installs. Everyone who can open the Thread sees the view; a
 *   personal install's actions are its owner's only, and View members act
 *   on none.
 *
 * Reading state starts no plugin code. Each request logs one
 * `plugin_data_view` line with its requestId; each call writes a
 * `view.call` audit row.
 */

const logger = getLogger(["dx", "plugins", "views"]);

const MESSAGES: Record<PluginDataViewErrorCode, [number, string]> = {
  INVALID_REQUEST: [400, "Request validation failed."],
  PLUGIN_VIEW_NOT_FOUND: [
    404,
    "No installed plugin offers that view here. Its plugin may be off or removed.",
  ],
  PLUGIN_VIEW_READ_ONLY: [
    403,
    "People who can only view this Thread cannot use its plugins.",
  ],
  PLUGIN_VIEW_CALL_REFUSED: [400, "The plugin does not offer that function."],
  PLUGIN_VIEW_CALL_FAILED: [502, "The plugin's function failed."],
};

const refuse = (
  context: Context<AppEnv>,
  code: PluginDataViewErrorCode,
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

const logView = (
  context: Context<AppEnv>,
  started: number,
  fields: Readonly<Record<string, unknown>> & {
    readonly route: string;
    readonly outcome: string;
  },
) => {
  const line = {
    event: "plugin_data_view",
    requestId: context.get("requestId"),
    threadId: context.req.param("threadId"),
    ms: Date.now() - started,
    ...fields,
  };
  if (fields.outcome === "success")
    logger.info(`Plugin view ${fields.route}.`, line);
  else logger.warn(`Plugin view ${fields.route} ${fields.outcome}.`, line);
};

const waitUntilOf = (context: Context<AppEnv>) => {
  try {
    const execution = context.executionCtx;
    return (promise: Promise<unknown>) =>
      execution.waitUntil(promise.catch(() => undefined));
  } catch {
    return undefined;
  }
};

/** The options a person sees for an install's views, in one place. */
export const dataViewOptions = (
  install: PluginInstallRecord,
  places: ReadonlyArray<DataViewPlace>,
): ReadonlyArray<PluginDataViewOption> =>
  install.scope === "repository"
    ? []
    : (install.code.dataViews ?? [])
        .filter((view) => view.show.some((place) => places.includes(place)))
        .map((view) => ({
          plugin: install.name,
          view: view.id,
          title: view.title,
          pluginTitle: install.displayName,
          ...(view.icon === undefined ? {} : { icon: view.icon }),
          show: view.show,
          installId: install.pluginId,
          integrity: view.integrity,
        }));

interface Found {
  readonly install: PluginInstallRecord;
  readonly ownerUserId: string;
  /** Who acts, when it is not the owner: a member of a shared Thread. */
  readonly actorUserId?: string;
  readonly access: "owner" | "contribute" | "view";
}

const findPageView = async (
  context: Context<AppEnv>,
  db: D1Database,
): Promise<Found | undefined> => {
  const userId = context.get("principal").userId;
  const installs = await listOwnerCodePluginInstalls(db, userId);
  const install = installs.find(
    (candidate) => candidate.name === context.req.param("plugin"),
  );
  if (
    install === undefined ||
    install.scope === "repository" ||
    dataViewOf(install, context.req.param("view") ?? "") === undefined
  )
    return undefined;
  return { install, ownerUserId: userId, access: "owner" };
};

const findThreadView = async (
  context: Context<AppEnv>,
  db: D1Database,
): Promise<Found | undefined> => {
  const threadId = context.req.param("threadId") ?? "";
  const name = context.req.param("plugin");
  const viewId = context.req.param("view") ?? "";
  // A draft of the plugin, loaded in this Thread, comes first, as it does
  // for the Thread's agent.
  const draft = (await threadDrafts(context.env, threadId)).find(
    ({ plugin }) => plugin.name === name,
  )?.plugin;
  const install =
    draft !== undefined && dataViewOf(draft, viewId) !== undefined
      ? draft
      : (await listThreadCodePluginInstalls(db, threadId)).find(
          (candidate) => candidate.name === name,
        );
  if (
    install === undefined ||
    install.scope === "repository" ||
    dataViewOf(install, viewId) === undefined
  )
    return undefined;
  const ownerUserId = context.get("threadOwnerUserId");
  const actor = (context.get("actor") ?? context.get("principal"))?.userId;
  return {
    install,
    ownerUserId,
    ...(actor === undefined || actor === ownerUserId
      ? {}
      : { actorUserId: actor }),
    access: context.get("threadAccess") ?? "owner",
  };
};

const readState = async (
  context: Context<AppEnv>,
  find: (
    context: Context<AppEnv>,
    db: D1Database,
  ) => Promise<Found | undefined>,
) => {
  const started = Date.now();
  const db = context.env.DB;
  const found = db === undefined ? undefined : await find(context, db);
  if (db === undefined || found === undefined) {
    logView(context, started, {
      route: "state",
      outcome: "not-found",
      plugin: context.req.param("plugin"),
      view: context.req.param("view"),
    });
    return refuse(context, "PLUGIN_VIEW_NOT_FOUND");
  }
  const viewId = context.req.param("view") ?? "";
  const stored =
    found.install.draft !== undefined
      ? await readDraftViewState(
          context.env,
          found.install.draft.threadId,
          found.install.name,
          viewId,
        )
      : await readPluginViewState(db, found.install.pluginId, viewId);
  const key = viewStateKey(found.install.pluginId, viewId);
  const viewer = (context.get("actor") ?? context.get("principal")).userId;
  let watch: string | undefined;
  try {
    watch = await signViewWatch(context.env, { userId: viewer, key });
  } catch {
    // Without a signing secret the view still shows; it refetches instead.
  }
  logView(context, started, {
    route: "state",
    outcome: "success",
    installId: found.install.pluginId,
    plugin: found.install.name,
    view: viewId,
    version: stored?.version ?? 0,
  });
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(PluginDataViewStateResponseSchema)({
      status: "success",
      data: {
        // Before the plugin first sets it, the browser draws the file's own
        // `state`.
        state: stored?.state ?? null,
        version: stored?.version ?? 0,
        key,
        ...(watch === undefined ? {} : { watch }),
      },
    }),
  );
};

const MAX_CALL_BODY_BYTES = 64 * 1_024;

const runCall = async (
  context: Context<AppEnv>,
  find: (
    context: Context<AppEnv>,
    db: D1Database,
  ) => Promise<Found | undefined>,
) => {
  const started = Date.now();
  const db = context.env.DB;
  const viewId = context.req.param("view") ?? "";
  let request: PluginDataViewCallRequest | undefined;
  try {
    const text = await readBoundedText(context.req.raw, MAX_CALL_BODY_BYTES);
    request =
      text === undefined
        ? undefined
        : Option.getOrUndefined(
            Schema.decodeUnknownOption(PluginDataViewCallRequestSchema)(
              JSON.parse(text) as unknown,
            ),
          );
  } catch {
    request = undefined;
  }
  if (request === undefined) return refuse(context, "INVALID_REQUEST");
  const found = db === undefined ? undefined : await find(context, db);
  if (db === undefined || found === undefined) {
    logView(context, started, {
      route: "call",
      outcome: "not-found",
      plugin: context.req.param("plugin"),
      view: viewId,
    });
    return refuse(context, "PLUGIN_VIEW_NOT_FOUND");
  }
  const { install } = found;
  const base = {
    route: "call",
    installId: install.pluginId,
    plugin: install.name,
    view: viewId,
    fn: request.fn,
    access: found.access,
    ...(found.actorUserId === undefined
      ? {}
      : { actorUserId: found.actorUserId }),
  };
  const audit = (
    outcome: "success" | "rejected" | "failed",
    detail: Record<string, unknown>,
  ) =>
    insertPluginAudit(db, {
      pluginId: install.pluginId,
      pluginName: install.name,
      pluginVersion: install.version,
      scope: install.scope,
      ownerUserId: found.ownerUserId,
      ...(context.req.param("threadId") === undefined
        ? {}
        : { threadId: context.req.param("threadId") }),
      requestId: context.get("requestId"),
      action: "view.call",
      target: `${viewId}.${request.fn}`.slice(0, 256),
      outcome,
      detail,
      ...(found.actorUserId === undefined
        ? {}
        : { actorUserId: found.actorUserId }),
    });
  if (found.access === "view") {
    logView(context, started, { ...base, outcome: "refused:read-only" });
    await audit("rejected", { code: "read-only" });
    return refuse(context, "PLUGIN_VIEW_READ_ONLY");
  }
  // Everyone who can write in the Thread acts on its plugins as the owner
  // does, personal ones included; the audit and `ctx.caller` name them.
  const exported = (install.code.exports ?? []).some(
    ({ name }) => name === request.fn,
  );
  // A function the plugin's program answers: a plugin with a service gets
  // the call at `POST /calls/<fn>`, unless its code exports the name.
  const service =
    !exported &&
    (install.code as { readonly service?: unknown }).service !== undefined;
  if (!exported && !service) {
    logView(context, started, { ...base, outcome: "refused:not-exported" });
    await audit("rejected", { code: "not-exported" });
    return refuse(
      context,
      "PLUGIN_VIEW_CALL_REFUSED",
      `${install.name} does not expose ${request.fn}; its manifest's exports lists ${(install.code.exports ?? []).map(({ name }) => name).join(", ") || "nothing"}.`,
    );
  }
  // Written before the plugin runs, so no call goes unaudited.
  await audit("success", {});
  const waitUntil = waitUntilOf(context);
  let value: unknown;
  if (service) {
    const served = await callPluginService(context.env, {
      install,
      kind: "call",
      name: request.fn,
      args: request.args ?? {},
      actorUserId: found.actorUserId ?? found.ownerUserId,
      ...(context.req.param("threadId") === undefined
        ? {}
        : { threadId: context.req.param("threadId") as string }),
    });
    if (!served.ok) {
      logView(context, started, {
        ...base,
        outcome: "failed",
        reason: served.code,
        runtime: "service",
      });
      await audit("failed", { reason: served.code, runtime: "service" });
      return refuse(context, "PLUGIN_VIEW_CALL_FAILED", served.message);
    }
    value = served.value;
  } else
    try {
      value = await callPluginExport(
        {
          db,
          bindings: context.env,
          install,
          ...(context.req.param("threadId") === undefined
            ? {}
            : { threadId: context.req.param("threadId") as string }),
          ownerUserId: found.ownerUserId as UserId,
          ...(found.actorUserId === undefined
            ? {}
            : { actorUserId: found.actorUserId }),
          requestId: context.get("requestId"),
          ...(waitUntil === undefined ? {} : { waitUntil }),
        },
        request.fn,
        request.args ?? {},
        TOOL_TIMEOUT_MS,
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 300) : "unknown";
      logView(context, started, { ...base, outcome: "failed", reason });
      await audit("failed", { reason });
      return refuse(context, "PLUGIN_VIEW_CALL_FAILED", reason);
    }
  let version: number | undefined;
  if (request.result !== undefined) {
    const set = await (install.draft !== undefined
      ? setDraftViewState
      : setPluginViewState)(context.env, {
      install,
      viewId,
      path: request.result,
      value: value ?? null,
      ...(waitUntil === undefined ? {} : { waitUntil }),
    });
    if (!set.ok) {
      logView(context, started, {
        ...base,
        outcome: "failed",
        reason: set.code,
      });
      return refuse(context, "PLUGIN_VIEW_CALL_FAILED", set.message);
    }
    version = set.version;
  }
  logView(context, started, { ...base, outcome: "success" });
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(PluginDataViewCallResponseSchema)({
      status: "success",
      data: {
        value: value ?? null,
        ...(version === undefined ? {} : { version }),
      },
    }),
  );
};

const HASH = /^[0-9a-f]{64}$/;

/** Mounted at `/v1/plugins/views`, before the page routes. */
export const pluginDataViewRoutes = new Hono<AppEnv>()
  .get("/definitions/:installId/:integrity", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    const integrity = context.req.param("integrity");
    const row =
      db === undefined || !HASH.test(integrity)
        ? null
        : await db
            .prepare(
              `SELECT content FROM trusted_plugin_file
                WHERE plugin_id = ? AND integrity = ? AND media_type = 'application/json'
                LIMIT 1`,
            )
            .bind(context.req.param("installId"), integrity)
            .first<{ content: string }>();
    logView(context, started, {
      route: "definition",
      outcome: row === null ? "not-found" : "success",
      installId: context.req.param("installId"),
    });
    if (row === null) return refuse(context, "PLUGIN_VIEW_NOT_FOUND");
    // One address is always one file.
    context.header("Cache-Control", "private, max-age=31536000, immutable");
    context.header("Content-Type", "application/json");
    context.header("X-Content-Type-Options", "nosniff");
    return context.body(row.content);
  })
  .get("/:plugin/data/:view/state", (context) =>
    readState(context, findPageView),
  )
  .post("/:plugin/data/:view/call", (context) =>
    runCall(context, findPageView),
  );

/** Mounted at `/v1/threads`, behind `authorizeThread`. */
export const pluginThreadDataViewRoutes = new Hono<AppEnv>()
  // A view's file through the Thread: how a draft's view, which no install
  // stores, reaches the people who can open the Thread that loaded it.
  .get(
    "/:threadId/plugin-ui/views/:plugin/:view/definition",
    async (context) => {
      const started = Date.now();
      const db = context.env.DB;
      const found =
        db === undefined ? undefined : await findThreadView(context, db);
      const view =
        found === undefined
          ? undefined
          : dataViewOf(found.install, context.req.param("view") ?? "");
      const content =
        found === undefined || view === undefined || db === undefined
          ? undefined
          : found.install.draft !== undefined
            ? await draftViewFile(
                context.env,
                found.install.draft.threadId,
                found.install.name,
                view.integrity,
              )
            : await readDataViewFile(db, found.install, view);
      logView(context, started, {
        route: "definition",
        outcome: content === undefined ? "not-found" : "success",
        plugin: context.req.param("plugin"),
        view: context.req.param("view"),
        ...(found?.install.draft === undefined ? {} : { draft: true }),
      });
      if (content === undefined)
        return refuse(context, "PLUGIN_VIEW_NOT_FOUND");
      // A reload changes the file; the address carries its sha256.
      context.header("Cache-Control", "private, max-age=31536000, immutable");
      context.header("Content-Type", "application/json");
      context.header("X-Content-Type-Options", "nosniff");
      return context.body(content);
    },
  )
  .get("/:threadId/plugin-ui/views/:plugin/:view/state", (context) =>
    readState(context, findThreadView),
  )
  .post("/:threadId/plugin-ui/views/:plugin/:view/call", (context) =>
    runCall(context, findThreadView),
  );
