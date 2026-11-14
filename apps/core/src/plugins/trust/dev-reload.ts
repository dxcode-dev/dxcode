import {
  PluginBundleRepository,
  type PluginTarget,
  type ThreadId,
  UserId,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { pluginBundleLayers } from "../../settings/plugins/bundles/layers.js";
import { PluginBundleService } from "../../settings/plugins/bundles/service.js";
import { writeZip } from "../../settings/plugins/bundles/zip-writer.js";
import { insertPluginAudit } from "../audit/audit.js";
import { DEV_LINK_IDLE_MS, devLinkLastUse } from "./policy.js";
import {
  installedPluginTier,
  installTrustColumns,
  installTrustFromRow,
} from "./resolve-tier.js";

/**
 * Personal-dev hot reload. `dxd plugin dev <folder>` in a
 * Thread's Orb sends the folder's files with the Thread's daemon key; dx
 * updates the Thread owner's personal install of the same name to them, and
 * the next call in any of the owner's Threads, this one included, runs the
 * new code. No new Thread, no card.
 *
 * It never grants anything new: like `manage_dx` updating a personal plugin
 * at once, it applies only a version that asks for nothing the installed
 * one doesn't. The first install, and any wider version, go through the
 * Plugins page or `manage_dx`, where the owner reviews them.
 */

const logger = getLogger(["dx", "plugins", "trust"]);

const DevPluginFolder = Schema.Struct({
  /** The folder's path in the Orb, as shown on the Plugins page. */
  folder: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      /** base64 */
      content: Schema.String,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5_000)),
});

export type DevReloadOutcome =
  | "reloaded"
  | "not-enabled"
  | "other-thread"
  | "unchanged"
  | "not-installed"
  | "widens"
  | "invalid"
  | "failed";

const reply = (
  outcome: DevReloadOutcome,
  status: number,
  body: Record<string, unknown>,
) =>
  Response.json(
    { outcome, ...body },
    { status, headers: { "cache-control": "no-store" } },
  );

const bytesOf = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

export const reloadDevPlugin = async (
  env: Bindings,
  request: { readonly threadId: ThreadId; readonly body: string },
): Promise<Response> => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const db = env.DB;
  const line = (
    outcome: DevReloadOutcome,
    fields: Record<string, unknown> = {},
  ) => {
    const message = `Plugin dev reload: ${outcome}.`;
    const properties = {
      event: "plugin_dev_reload",
      requestId,
      threadId: request.threadId,
      host: "worker",
      outcome,
      ms: Date.now() - started,
      ...fields,
    };
    if (outcome === "failed") logger.error(message, properties);
    else logger.info(message, properties);
  };
  if (db === undefined) return reply("failed", 503, { error: "No database." });
  let input: typeof DevPluginFolder.Type;
  let zip: Uint8Array;
  try {
    input = Schema.decodeUnknownSync(DevPluginFolder)(JSON.parse(request.body));
    zip = await writeZip(
      input.files.map(({ path, content }) => ({
        path,
        content: bytesOf(content),
      })),
    );
  } catch {
    line("invalid");
    return reply("invalid", 400, {
      error: "Send the folder as { folder, files: [{ path, content }] }.",
    });
  }
  const owner = await db
    .prepare("SELECT owner_user_id FROM threads WHERE id = ?1")
    .bind(request.threadId)
    .first<{ owner_user_id: string }>();
  const ownerId = Schema.decodeUnknownOption(UserId)(owner?.owner_user_id);
  if (Option.isNone(ownerId))
    return reply("failed", 404, { error: "No such Thread." });
  const target: PluginTarget = { scope: "personal", id: ownerId.value };
  const zipInput = {
    type: "zip" as const,
    label: input.folder.split("/").filter(Boolean).at(-1) ?? "plugin",
    bytes: zip,
  };
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* PluginBundleService;
      const fresh = yield* service.preview(target, zipInput);
      const name = fresh.bundle.manifest.name;
      const installed = (yield* (yield* PluginBundleRepository).list(
        target,
      )).find((bundle) => bundle.name === name);
      if (installed === undefined)
        return { outcome: "not-installed" as const, name };
      const base = { name, pluginId: installed.id, version: installed.version };
      // Only an install its owner turned hot reload on for, from a ZIP:
      // a GitHub, catalog, or shared install keeps its own source. And only
      // from the one Thread it is on for, while it is still in use.
      const link = yield* Effect.tryPromise(() =>
        db
          .prepare(
            `SELECT thread_id, enabled_at, reloaded_at FROM plugin_dev_link
              WHERE plugin_id = ?1`,
          )
          .bind(installed.id)
          .first<{
            thread_id: string | null;
            enabled_at: string;
            reloaded_at: string | null;
          }>(),
      );
      const lastUse =
        link === null
          ? 0
          : devLinkLastUse({
              enabledAt: link.enabled_at,
              ...(link.reloaded_at === null
                ? {}
                : { last: { reloadedAt: link.reloaded_at } }),
            });
      const idle = link !== null && lastUse + DEV_LINK_IDLE_MS < Date.now();
      if (idle)
        yield* Effect.tryPromise(() =>
          db
            .prepare("DELETE FROM plugin_dev_link WHERE plugin_id = ?1")
            .bind(installed.id)
            .run(),
        );
      if (
        link === null ||
        link.thread_id === null ||
        idle ||
        installed.source.type !== "zip"
      )
        return {
          outcome: "not-enabled" as const,
          ...base,
          source: installed.source.type,
          reason: idle ? ("idle" as const) : ("off" as const),
        };
      if (link.thread_id !== request.threadId)
        return {
          outcome: "other-thread" as const,
          ...base,
          boundThreadId: link.thread_id,
        };
      const preview = yield* service.previewUpdate(
        target,
        installed.id,
        zipInput,
      );
      if (preview.conflicts.length > 0)
        return {
          outcome: "invalid" as const,
          ...base,
          conflicts: preview.conflicts,
        };
      if (preview.upToDate) return { outcome: "unchanged" as const, ...base };
      if (preview.permissions.widens)
        return {
          outcome: "widens" as const,
          ...base,
          changes: preview.permissions.changes.filter(
            ({ added }) => added.length > 0,
          ),
        };
      const updated = yield* service.update(
        target,
        installed.id,
        zipInput,
        preview.bundle.integrity,
        { userId: target.id, requestId: `dxd-plugin-dev:${requestId}` },
      );
      return {
        outcome: "reloaded" as const,
        ...base,
        version: updated.version,
      };
    }).pipe(Effect.provide(pluginBundleLayers(db, env.DX_STORAGE))),
  );
  if (Exit.isFailure(exit)) {
    const failure = Cause.squash(exit.cause) as {
      readonly _tag?: unknown;
      readonly reason?: unknown;
      readonly message?: unknown;
    };
    const tag = typeof failure?._tag === "string" ? failure._tag : "Error";
    const reason =
      typeof failure?.reason === "string"
        ? failure.reason
        : typeof failure?.message === "string"
          ? failure.message
          : tag;
    const persistence = tag === "PersistenceUnavailable";
    line(persistence ? "failed" : "invalid", {
      error: `${tag}: ${reason}`.slice(0, 500),
    });
    return persistence
      ? reply("failed", 503, { error: "dx could not reach its database." })
      : reply("invalid", 400, { error: reason.slice(0, 500) });
  }
  const done = exit.value;
  if (done.outcome === "not-installed") {
    line("not-installed", { plugin: done.name });
    return reply("not-installed", 409, {
      plugin: done.name,
      error: `${done.name} isn't one of your installed plugins. Install it once from the Plugins page or ask dx to, then turn on hot reload for it.`,
    });
  }
  const audit = (
    outcome: "success" | "rejected",
    detail: Record<string, unknown>,
  ) =>
    insertPluginAudit(db, {
      pluginId: done.pluginId,
      pluginName: done.name,
      pluginVersion: done.version,
      scope: "personal",
      ownerUserId: target.id,
      threadId: request.threadId,
      action: "dev.reload",
      target: input.folder,
      outcome,
      detail,
      requestId,
    });
  const tierRow = await db
    .prepare(
      `SELECT ${installTrustColumns("plugin")}
         FROM trusted_plugin plugin WHERE plugin.id = ?1`,
    )
    .bind(done.pluginId)
    .first<{ tier_cap: string | null; trusted_signature: number | null }>();
  const tier = installedPluginTier(
    "personal",
    undefined,
    installTrustFromRow(tierRow ?? { tier_cap: null, trusted_signature: 0 }),
  );
  const fields = { plugin: done.name, installId: done.pluginId, tier };
  switch (done.outcome) {
    case "not-enabled": {
      line("not-enabled", {
        ...fields,
        source: done.source,
        reason: done.reason,
      });
      await audit("rejected", {
        reason: done.reason === "idle" ? "idle" : "not-enabled",
        source: done.source,
      });
      const enable = new URL(
        "/settings/plugins",
        env.DX_AUTH_URL ?? "http://localhost",
      );
      enable.searchParams.set("hotReload", done.pluginId);
      enable.searchParams.set("thread", request.threadId);
      return reply("not-enabled", 403, {
        ...fields,
        ...(done.source === "zip" ? { enableUrl: enable.href } : {}),
        error:
          done.source !== "zip"
            ? `${done.name} comes from ${done.source}, not a ZIP; dxd reloads only plugins installed from a ZIP.`
            : `${done.reason === "idle" ? `Hot reload for ${done.name} turned off after 24 hours unused.` : `Hot reload is off for ${done.name}.`} To turn it on for this Thread, open ${enable.href}`,
      });
    }
    case "other-thread":
      line("other-thread", { ...fields, boundThreadId: done.boundThreadId });
      await audit("rejected", {
        reason: "other-thread",
        boundThreadId: done.boundThreadId,
      });
      return reply("other-thread", 403, {
        ...fields,
        error: `Hot reload for ${done.name} is on for another Thread; only that Thread's Orb may reload it.`,
      });
    case "invalid":
      line("invalid", { ...fields, conflicts: done.conflicts });
      await audit("rejected", { reason: "invalid" });
      return reply("invalid", 400, {
        ...fields,
        error: done.conflicts.join(" "),
      });
    case "widens":
      line("widens", { ...fields, changes: done.changes });
      await audit("rejected", { reason: "widens", changes: done.changes });
      return reply("widens", 409, {
        ...fields,
        changes: done.changes,
        error:
          "This version asks for more than the installed one. Update it on the Plugins page or ask dx to; dxd reloads it after that.",
      });
    case "unchanged":
    case "reloaded": {
      // The update already applied; a failed bookkeeping write only logs.
      try {
        await db
          .prepare(
            `UPDATE plugin_dev_link
                SET folder = ?3, reloads = reloads + 1, reloaded_at = ?4
              WHERE plugin_id = ?1 AND thread_id = ?2`,
          )
          .bind(
            done.pluginId,
            request.threadId,
            input.folder,
            new Date().toISOString(),
          )
          .run();
      } catch (error) {
        logger.warn("Plugin dev reload: the link row was not updated.", {
          event: "plugin_dev_reload_link_failed",
          requestId,
          error: String(error).slice(0, 300),
        });
      }
      if (done.outcome === "reloaded")
        await audit("success", { version: done.version });
      line(done.outcome, { ...fields, version: done.version });
      return reply(done.outcome, 200, { ...fields, version: done.version });
    }
  }
};
