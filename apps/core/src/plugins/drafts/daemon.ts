import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARCHIVE_ENTRIES,
  type ThreadId,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { resolveExecutionEnvironment } from "../../settings/environment-variables/execution.js";
import { readPluginBundle } from "../../settings/plugins/bundles/read-bundle.js";
import { readZipArchive } from "../../settings/plugins/bundles/zip.js";
import { writeZip } from "../../settings/plugins/bundles/zip-writer.js";
import { ownerWorkspaceIdSql } from "../../settings/workspace-policy/repository-d1.js";
import { insertPluginAudit } from "../audit/audit.js";
import { postPluginThreadMessage } from "../worker-host/thread-access.js";
import { draftShortName } from "./names.js";
import { describeDraft, draftInstallId } from "./orb.js";
import {
  type DraftStore,
  MAX_DRAFTS_PER_THREAD,
  type StoredDraft,
} from "./store.js";

/**
 * `dxd plugin load | reload | unload | list` in a Thread's Orb, after the
 * Thread execution object checked the daemon key. A draft is the Thread's
 * own: it loads with no card, runs only in this Thread's Orb, and has only
 * the powers the Orb already has, so dx refuses one that asks for more:
 *
 * - a secret the Thread's own commands do not receive;
 * - anything where the owner's workspace keeps plugins out of Thread Orbs.
 *
 * Every line `dxd` prints comes from here.
 */

const logger = getLogger(["dx", "plugins", "drafts"]);

const DraftRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("load"),
    folder: Schema.String.check(
      Schema.isMinLength(2),
      Schema.isMaxLength(4_096),
      Schema.isPattern(/^\//),
    ),
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(256),
        ),
        /** base64 */
        content: Schema.String,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(5_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("unload"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(214)),
  }),
  Schema.Struct({ action: Schema.Literal("list") }),
]);

const reply = (ok: boolean, message: string, extra = {}) =>
  Response.json(
    { ok, message, ...extra },
    { status: 200, headers: { "cache-control": "no-store" } },
  );

const bytesOf = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** What a draft adds, in one line: "1 tool: grafana_query". */
export const draftSummary = (plugin: StoredDraft["plugin"]) => {
  const parts: Array<string> = [];
  if (plugin.tools.length > 0)
    parts.push(
      `${plural(plugin.tools.length, "tool")}: ${plugin.tools.map(({ name }) => name).join(", ")}`,
    );
  if (plugin.commands.length > 0)
    parts.push(plural(plugin.commands.length, "command"));
  const views = plugin.code.dataViews ?? [];
  if (views.length > 0)
    parts.push(
      `${plural(views.length, "view")} in this Thread's panel: ${views.map(({ title }) => title).join(", ")}`,
    );
  if (plugin.exports.length > 0)
    parts.push(`exposes ${plugin.exports.join(", ")}`);
  if (plugin.events.length > 0)
    parts.push(`handles ${plugin.events.join(", ")}`);
  return parts.length === 0
    ? "nothing registered yet: no tools, commands, views, or events"
    : parts.join("; ");
};

const describeLine = (draft: StoredDraft) =>
  `${draftShortName(draft.plugin.name)} (draft, this Thread${draft.loads > 1 ? `, load ${draft.loads}` : ""}): ${draftSummary(draft.plugin)}`;

/** One line per draft, as `dxd plugin list` prints them. */
const listMessage = (drafts: ReadonlyArray<StoredDraft>) =>
  drafts.length === 0
    ? "No draft plugins are loaded in this Thread."
    : drafts
        .map(
          (draft) => `${describeLine(draft)}\n  ${draft.plugin.draft.folder}`,
        )
        .join("\n");

const draftsJson = (drafts: ReadonlyArray<StoredDraft>) =>
  drafts.map(({ plugin, loads, loadedAt }) => ({
    name: plugin.name,
    displayName: plugin.displayName.replace(/ \(draft\)$/, ""),
    folder: plugin.draft.folder,
    installId: plugin.pluginId,
    loads,
    loadedAt,
    tools: plugin.tools.map(({ name }) => name),
  }));

const findDraft = (drafts: ReadonlyArray<StoredDraft>, name: string) =>
  drafts.find(({ plugin }) => plugin.name === name) ??
  drafts.find(
    ({ plugin }) =>
      draftShortName(plugin.name) === name ||
      plugin.displayName.replace(/ \(draft\)$/, "") === name,
  );

/** A note in the Thread, so people see what the draft adds. */
const noteInThread = (
  env: Bindings,
  input: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly plugin: StoredDraft["plugin"];
    readonly body: string;
    readonly revision: number;
  },
) =>
  postPluginThreadMessage(env, {
    ownerUserId: input.ownerUserId,
    threadId: input.threadId,
    install: input.plugin,
    body: input.body,
    note: true,
    idempotencyKey: `plugin-draft-${input.threadId}-${input.revision}`,
  }).catch((error: unknown) =>
    logger.warn("A draft plugin's note did not reach the Thread.", {
      event: "plugin_draft_note_failed",
      threadId: input.threadId,
      plugin: input.plugin.name,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

export const handlePluginDraftRequest = async (
  env: Bindings,
  input: {
    readonly threadId: ThreadId;
    readonly body: string;
    readonly store: DraftStore;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
): Promise<Response> => {
  const started = Date.now();
  const { threadId, store } = input;
  const db = env.DB;
  let request: typeof DraftRequest.Type;
  try {
    request = Schema.decodeUnknownSync(DraftRequest)(JSON.parse(input.body));
  } catch {
    return reply(
      false,
      "dx could not read this request; update dxd with the Thread's next start.",
    );
  }
  const line = (outcome: string, fields: Record<string, unknown> = {}) =>
    logger.info(`Plugin draft ${request.action}: ${outcome}.`, {
      event: "plugin_draft",
      threadId,
      action: request.action,
      outcome,
      ms: Date.now() - started,
      ...fields,
    });
  const state = await store.read();
  if (request.action === "list") {
    line("listed", { drafts: state.drafts.length });
    return reply(true, listMessage(state.drafts), {
      drafts: draftsJson(state.drafts),
    });
  }
  if (request.action === "unload") {
    const found = findDraft(state.drafts, request.name);
    if (found === undefined) {
      line("not-loaded");
      return reply(
        false,
        `No draft named ${request.name} is loaded in this Thread.${state.drafts.length === 0 ? "" : ` Loaded: ${state.drafts.map(({ plugin }) => draftShortName(plugin.name)).join(", ")}.`}`,
      );
    }
    await store.remove(found.plugin.name);
    const next = await store.read();
    line("unloaded", { plugin: found.plugin.name });
    if (db !== undefined)
      input.waitUntil(
        insertPluginAudit(db, {
          pluginId: found.plugin.pluginId,
          pluginName: found.plugin.name,
          pluginVersion: found.plugin.version,
          scope: "personal",
          ownerUserId: found.ownerUserId,
          threadId,
          action: "draft.unload",
          outcome: "success",
        }),
      );
    input.waitUntil(
      noteInThread(env, {
        threadId,
        ownerUserId: found.ownerUserId,
        plugin: found.plugin,
        body: "Draft unloaded from this Thread. Its tools are gone from the next tool call.",
        revision: next.revision,
      }),
    );
    return reply(
      true,
      `unloaded ${draftShortName(found.plugin.name)} from this Thread`,
    );
  }

  // ─── load ───
  if (db === undefined) return reply(false, "dx could not reach its database.");
  // One read: the owner, and whether their workspace lets code from a
  // Thread's Orb run as a plugin (the switch for repository plugins, which
  // covers drafts too).
  const owner = await db
    .prepare(
      `SELECT thread.owner_user_id,
              (SELECT policy.allow_repository_plugins FROM workspace_policy policy
                WHERE policy.workspace_id =
                      ${ownerWorkspaceIdSql("thread.owner_user_id")}) AS allowed
         FROM threads thread WHERE thread.id = ?1`,
    )
    .bind(threadId)
    .first<{ owner_user_id: string; allowed: number | null }>();
  if (owner === null) return reply(false, "dx could not find this Thread.");
  const ownerUserId = owner.owner_user_id;
  const label = request.folder.split("/").filter(Boolean).at(-1) ?? "plugin";
  const integrity = `sha256-${await sha256Hex(
    JSON.stringify(request.files.map(({ path, content }) => [path, content])),
  )}`;
  const parsed = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const zip = yield* Effect.promise(() =>
        writeZip(
          request.files.map(({ path, content }) => ({
            path,
            content: bytesOf(content),
          })),
        ),
      );
      const archive = yield* readZipArchive(zip, {
        maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
        maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
      });
      return yield* readPluginBundle(archive, {
        root: "",
        fallbackName: label,
        draft: true,
      });
    }),
  );
  if (Exit.isFailure(parsed)) {
    const failure = Cause.squash(parsed.cause) as {
      readonly reason?: unknown;
      readonly message?: unknown;
    };
    const reason =
      typeof failure?.reason === "string"
        ? failure.reason
        : typeof failure?.message === "string"
          ? failure.message
          : "dx could not read it.";
    line("invalid", { error: reason.slice(0, 300) });
    return reply(false, `${label} did not load: ${reason}`);
  }
  const manifest = parsed.value.manifest;
  const name = manifest.name;
  const short = draftShortName(name);
  const skipped = manifest.skipped.map(({ path, reason }) => ({
    path,
    reason,
  }));
  const notes = skipped.map(({ path, reason }) => `  note: ${path}: ${reason}`);
  const refuse = (outcome: string, message: string) => {
    line(outcome, { plugin: name });
    input.waitUntil(
      insertPluginAudit(db, {
        pluginId: `draft:${name}`.slice(0, 256),
        pluginName: name,
        pluginVersion: manifest.version ?? "draft",
        scope: "personal",
        ownerUserId,
        threadId,
        action: "draft.load",
        outcome: "rejected",
        detail: { reason: outcome },
      }),
    );
    return reply(false, message);
  };
  const code = manifest.code;
  if (code === undefined)
    return refuse(
      "no-code",
      [
        `${short} did not load: it has no code for dx to run. A draft needs extensions["dev.dxcode"] with an entry module; its skills and MCP servers load once the plugin is kept.`,
        ...notes,
      ].join("\n"),
    );
  // A draft is code from the Thread's Orb, like a repository's plugin: the
  // workspace switch that turns those off turns drafts off too.
  if (owner.allowed === 0)
    return refuse(
      "policy",
      `${short} did not load: your workspace's plugin policy turns off plugins that come from a Thread's Orb or repository, drafts included. A workspace admin can change it in Settings → Plugins.`,
    );
  // A draft reads only secrets the Thread's own commands already receive.
  if (code.permissions.secrets.length > 0) {
    const environment = await Effect.runPromise(
      Effect.result(resolveExecutionEnvironment(env, threadId)),
    );
    const names = new Set<string>(
      Result.isSuccess(environment)
        ? environment.success.values.map(({ name: variable }) => variable)
        : [],
    );
    const missing = code.permissions.secrets.filter(
      (secret) => !names.has(secret),
    );
    if (missing.length > 0)
      return refuse(
        "secret",
        `${short} did not load: it asks for ${missing.length === 1 ? "the secret" : "the secrets"} ${missing.join(", ")}, which this Thread's commands do not receive. Add ${missing.length === 1 ? "it" : "them"} in Settings → Secrets & Env Vars (personal, or this Thread's Project), then load it again.`,
      );
  }
  const previous = state.drafts.find(({ plugin }) => plugin.name === name);
  if (previous === undefined && state.drafts.length >= MAX_DRAFTS_PER_THREAD)
    return refuse(
      "too-many",
      `${short} did not load: a Thread holds at most ${MAX_DRAFTS_PER_THREAD} drafts. Unload one with dxd plugin unload <name>.`,
    );
  const record = {
    pluginId: await draftInstallId(name),
    name,
    displayName: `${manifest.displayName} (draft)`,
    scope: "personal" as const,
    targetId: ownerUserId,
    version: manifest.version ?? "draft",
    integrity,
    code,
    installedByUserId: ownerUserId,
    draft: { folder: request.folder, threadId },
  };
  let description: Awaited<ReturnType<typeof describeDraft>>;
  try {
    description = await describeDraft({
      db,
      bindings: env,
      install: record,
      threadId,
      ownerUserId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(
      "start-failed",
      [
        `${short} did not load: its code failed to start: ${reason.slice(0, 1_500)}`,
        `Its log: dxd plugin logs ${short}`,
        ...(previous === undefined
          ? []
          : [`The version loaded before stays loaded.`]),
      ].join("\n"),
    );
  }
  const draft: StoredDraft = {
    plugin: { ...record, ...description },
    ownerUserId,
    loadedAt: new Date().toISOString(),
    loads: (previous?.loads ?? 0) + 1,
    skipped,
  };
  const next = await store.write([
    ...state.drafts.filter(({ plugin }) => plugin.name !== name),
    draft,
  ]);
  // Its views' files, drawn in this Thread's panel; a reload replaces them
  // and keeps each view's state.
  await store.putViewFiles(
    name,
    (code.dataViews ?? []).flatMap((view) => {
      const file = parsed.value.codeModules.find(
        ({ path }) => path === view.file,
      );
      return file === undefined
        ? []
        : [{ integrity: view.integrity, content: file.content }];
    }),
  );
  line(previous === undefined ? "loaded" : "reloaded", {
    plugin: name,
    loads: draft.loads,
    tools: description.tools.length,
  });
  input.waitUntil(
    insertPluginAudit(db, {
      pluginId: record.pluginId,
      pluginName: name,
      pluginVersion: record.version,
      scope: "personal",
      ownerUserId,
      threadId,
      action: "draft.load",
      outcome: "success",
      detail: { loads: draft.loads, tools: description.tools.length },
    }),
  );
  input.waitUntil(
    noteInThread(env, {
      threadId,
      ownerUserId,
      plugin: draft.plugin,
      body: `Draft ${previous === undefined ? "loaded" : `reloaded (load ${draft.loads})`} in this Thread: ${draftSummary(draft.plugin)}. It runs in this Thread's Orb, and no other Thread sees it until it is kept.`,
      revision: next.revision,
    }),
  );
  return reply(
    true,
    [
      `${previous === undefined ? "loaded" : "reloaded"} ${describeLine(draft)}`,
      ...notes,
      // Read by the agent that ran the command: say how to use it.
      ...(description.tools.length === 0
        ? []
        : [
            `Call ${description.tools.map(({ name }) => name).join(", ")} as a tool from your next step, the way you call any tool (not from code). If it is not in your tool list yet, call plugin_tool with plugin "${short}".`,
          ]),
    ].join("\n"),
    { drafts: draftsJson(next.drafts) },
  );
};
