import { IssueWorkloadIdentityRequestSchema } from "@dx/api";
import {
  generateThreadTitle,
  pluginThreadGrants,
  type UserId,
  WorkloadIdentityUnauthorized,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
import type { Bindings } from "../../http/types.js";
import { ownerRequest } from "../../threads/owner-request.js";
import { workloadIdentityBroker } from "../../workload-identity/broker.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { postPluginThreadMessage } from "../worker-host/thread-access.js";
import {
  actingUserOf,
  loadServiceInstall,
  type ServiceInstall,
} from "./installs.js";
import { pluginServiceLogger } from "./log.js";
import { runnablePluginOrb } from "./orb-owner.js";
import { setServiceViewState } from "./views.js";

/**
 * A plugin service's requests to dx (wiki/plugin-platform-direction.md
 * "Plugin services"). The service sends HTTP to `DX_API` with its own
 * `DX_TOKEN`; dxd maps the token to the install and relays the request as
 * `service.request` over its connection. Core acts for that install only,
 * after checking, on every request, that the install still runs, is still
 * placed on this plugin Orb, and that the Orb may still run (its payer
 * still belongs to its workspace). Nothing here reaches a model.
 *
 * Paths: `/state/<key>` (GET, PUT, DELETE), `/state?prefix=` (GET),
 * `/settings` (GET, the install's settings over their defaults),
 * `/views/<viewId>/state` (POST), `/threads` (POST), `/threads/<id>/messages`
 * (POST), `/id-token` (POST). Replies are JSON; errors are
 * `{ error: { code, message } }`.
 */

export interface ServiceReply {
  readonly status: number;
  readonly body: unknown;
}

const reply = (status: number, body: unknown = {}): ServiceReply => ({
  status,
  body,
});
const refuse = (status: number, code: string, message: string) =>
  reply(status, { error: { code, message } });

export const STATE_KEY_LIMIT = 1_000;
export const STATE_VALUE_BYTES = 65_536;
const THREAD_PROMPT_CHARS = 32_000;
const THREAD_KEY_CHARS = 200;
const POST_CHARS = 30_000;
/** Opening Threads is bounded per install: at most this many an hour. */
const THREAD_OPENS_PER_HOUR = 20;

/** The install as the worker host's helpers expect it. */
export const installRecord = (
  install: ServiceInstall,
): PluginInstallRecord => ({
  pluginId: install.pluginId,
  name: install.name,
  displayName: install.displayName,
  scope: install.scope,
  targetId: install.targetId,
  version: install.version,
  integrity: install.integrity,
  code: install.code,
  ...(install.installedByUserId === undefined
    ? {}
    : { installedByUserId: install.installedByUserId }),
  ...(install.package === undefined ? {} : { package: install.package }),
});

/** The person a service acts as: the installer of a workspace install. */
const actingUser = actingUserOf;

const audit = (
  db: D1Database,
  install: ServiceInstall,
  input: {
    readonly action: string;
    readonly target?: string;
    readonly outcome: "success" | "rejected" | "failed";
    readonly detail?: Record<string, unknown>;
    readonly threadId?: string;
  },
) =>
  db
    .prepare(
      `INSERT INTO plugin_audit (
         id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
         thread_id, action, target, outcome, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `pla_${crypto.randomUUID()}`,
      install.pluginId,
      install.name.slice(0, 214),
      install.version.slice(0, 160),
      install.scope,
      actingUser(install) ?? install.targetId,
      input.threadId ?? null,
      input.action,
      input.target?.slice(0, 256) ?? null,
      input.outcome,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      new Date().toISOString(),
    )
    .run()
    .catch(() => undefined);

export const handleServiceRequest = async (
  bindings: Bindings,
  request: {
    readonly orbId: string;
    readonly installId: string;
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  },
): Promise<ServiceReply> => {
  const db = bindings.DB;
  if (db === undefined)
    return refuse(503, "unavailable", "dx's database is unavailable.");
  // The install, its placement on this Orb, and the Orb's payer, every time.
  const [install, orb, placed] = await Promise.all([
    loadServiceInstall(db, request.installId),
    runnablePluginOrb(db, request.orbId),
    db
      .prepare(
        "SELECT 1 AS placed FROM plugin_service WHERE plugin_id = ? AND orb_id = ?",
      )
      .bind(request.installId, request.orbId)
      .first<{ placed: number }>(),
  ]);
  if (install === undefined || orb === undefined || placed === null) {
    pluginServiceLogger.warn("Plugin service request refused.", {
      event: "plugin_service_request",
      orbId: request.orbId,
      installId: request.installId,
      outcome: "refused",
      reason:
        install === undefined
          ? "install"
          : orb === undefined
            ? "orb"
            : "placement",
    });
    return refuse(
      403,
      "not-installed",
      "This plugin is no longer installed and on here.",
    );
  }
  const url = new URL(request.path, "http://service.invalid");
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const started = Date.now();
  const result = await route(bindings, db, install, request, url, segments);
  pluginServiceLogger.info("Plugin service request.", {
    event: "plugin_service_request",
    orbId: request.orbId,
    installId: install.pluginId,
    plugin: install.name,
    method: request.method,
    route: segments[0] ?? "",
    status: result.status,
    ms: Date.now() - started,
  });
  return result;
};

const route = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
  request: { readonly method: string; readonly body: unknown },
  url: URL,
  segments: ReadonlyArray<string>,
): Promise<ServiceReply> => {
  const [head, second, third] = segments.map(decodeURIComponent);
  const body = (request.body ?? {}) as Record<string, unknown>;
  switch (head) {
    case "state":
      return installState(db, install, request.method, second, url, body);
    case "views":
      if (
        request.method !== "POST" ||
        second === undefined ||
        third !== "state"
      )
        break;
      return setServiceViewState(
        bindings,
        installRecord(install),
        second,
        body,
      );
    case "threads":
      if (request.method !== "POST") break;
      if (second === undefined)
        return openInstallThread(bindings, db, install, body);
      if (third === "messages")
        return postInstallThread(bindings, db, install, second, body);
      break;
    case "settings":
      if (request.method !== "GET" || second !== undefined) break;
      return settings(db, install);
    case "id-token":
      if (request.method !== "POST") break;
      return issueInstallToken(bindings, db, install, body);
  }
  return refuse(
    404,
    "not-found",
    `dx has no ${request.method} ${url.pathname}.`,
  );
};

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * The install's key-value state, stored by dx (`plugin_install_storage`,
 * the same store `ctx.storage` uses), so replacing the Orb loses nothing.
 */
export const installState = async (
  db: D1Database,
  install: ServiceInstall,
  method: string,
  key: string | undefined,
  url: URL,
  body: Record<string, unknown>,
): Promise<ServiceReply> => {
  if (key === undefined) {
    if (method !== "GET") return refuse(405, "method", "List state with GET.");
    const prefix = url.searchParams.get("prefix") ?? "";
    const { results } = await db
      .prepare(
        `SELECT key FROM plugin_install_storage
          WHERE plugin_id = ? AND substr(key, 1, ?) = ?
          ORDER BY key LIMIT ?`,
      )
      .bind(install.pluginId, prefix.length, prefix, STATE_KEY_LIMIT)
      .all<{ key: string }>();
    return reply(200, { keys: results.map((row) => row.key) });
  }
  if (key.length > 256)
    return refuse(400, "bad-key", "A state key is at most 256 characters.");
  if (method === "GET") {
    const row = await db
      .prepare(
        "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
      )
      .bind(install.pluginId, key)
      .first<{ value_json: string }>();
    return row === null
      ? refuse(404, "not-found", `No state is stored under ${key}.`)
      : reply(200, { value: JSON.parse(row.value_json) as unknown });
  }
  if (method === "DELETE") {
    await db
      .prepare(
        "DELETE FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
      )
      .bind(install.pluginId, key)
      .run();
    return reply(200);
  }
  if (method !== "PUT")
    return refuse(405, "method", "Use GET, PUT, or DELETE on a state key.");
  if (!("value" in body))
    return refuse(400, "bad-body", 'Send { "value": … }.');
  const json = JSON.stringify(body.value ?? null);
  if (new TextEncoder().encode(json).byteLength > STATE_VALUE_BYTES)
    return refuse(
      413,
      "too-large",
      `A state value is at most ${STATE_VALUE_BYTES.toLocaleString("en-US")} bytes of JSON.`,
    );
  // The key limit is checked in the write itself, so concurrent writes
  // cannot pass it together.
  const written = await db
    .prepare(
      `INSERT INTO plugin_install_storage (plugin_id, key, value_json, updated_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE EXISTS (SELECT 1 FROM plugin_install_storage WHERE plugin_id = ?1 AND key = ?2)
           OR (SELECT count(*) FROM plugin_install_storage WHERE plugin_id = ?1) < ?5
       ON CONFLICT (plugin_id, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(
      install.pluginId,
      key,
      json,
      new Date().toISOString(),
      STATE_KEY_LIMIT,
    )
    .run();
  if (written.meta.changes === 0)
    return refuse(
      413,
      "too-many-keys",
      `A plugin stores at most ${STATE_KEY_LIMIT.toLocaleString("en-US")} keys.`,
    );
  return reply(200);
};

// ─── Settings ──────────────────────────────────────────────────────────────

/** The install's settings, as `ctx.settings.get()` gives function code. */
const settings = async (
  db: D1Database,
  install: ServiceInstall,
): Promise<ServiceReply> => {
  const { results } = await db
    .prepare(
      "SELECT key, value_json FROM plugin_install_setting WHERE plugin_id = ?",
    )
    .bind(install.pluginId)
    .all<{ key: string; value_json: string }>();
  const stored = new Map(
    results.map(({ key, value_json }) => [
      key,
      JSON.parse(value_json) as unknown,
    ]),
  );
  const values: Record<string, string | number | boolean> = {};
  for (const setting of install.code.settings) {
    const type = setting.type === "string" ? "string" : setting.type;
    const saved = stored.get(setting.key);
    const value = typeof saved === type ? saved : setting.default;
    if (typeof value === type)
      values[setting.key] = value as string | number | boolean;
  }
  return reply(200, { values });
};

// ─── Threads ───────────────────────────────────────────────────────────────

/** The Thread ID an open with `key` after `previous` uses: retries agree. */
const keyedThreadId = async (
  pluginId: string,
  key: string,
  previous: string | null,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `plugin-thread-key:${pluginId}:${key}:${previous ?? ""}`,
      ),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"));
  return `thr_${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

const threadUrl = async (bindings: Bindings, threadId: string) => {
  const origin = await Effect.runPromise(
    loadAuthenticationRequirements(bindings),
  )
    .then((requirements) => new URL(requirements.authUrl).origin)
    .catch(() => "");
  return `${origin}/threads/${threadId}`;
};

/**
 * Opens a Thread as the install's person (a workspace install's installer),
 * in a Project when given. With a `key`, the Thread already open for that
 * key (active: not archived or deleted) is returned instead
 * (`created: false`), so repeated incidents open one Thread. Two opens at
 * once derive the same Thread ID from the key and the Thread it replaces,
 * so they create one Thread.
 */
export const openInstallThread = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
  body: Record<string, unknown>,
): Promise<ServiceReply> => {
  if (
    !pluginThreadGrants(install.code.permissions.threads).includes("create")
  ) {
    await audit(db, install, {
      action: "thread.open",
      outcome: "rejected",
      detail: { reason: "not-granted" },
    });
    return refuse(
      403,
      "not-granted",
      `${install.displayName} was not granted opening Threads (permissions.threads: ["create"]).`,
    );
  }
  const owner = actingUser(install);
  if (owner === undefined)
    return refuse(403, "no-owner", "No person installed this plugin.");
  const { key, title, prompt, projectId } = body;
  if (typeof prompt !== "string" || prompt.trim() === "")
    return refuse(400, "bad-body", "Opening a Thread needs a prompt.");
  if (prompt.length > THREAD_PROMPT_CHARS)
    return refuse(400, "too-long", "A prompt is at most 32,000 characters.");
  if (
    key !== undefined &&
    (typeof key !== "string" || key === "" || key.length > THREAD_KEY_CHARS)
  )
    return refuse(400, "bad-key", "A key is text of 1 to 200 characters.");
  if (title !== undefined && (typeof title !== "string" || title.length > 200))
    return refuse(400, "bad-title", "A title is at most 200 characters.");
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      !/^prj_[A-Za-z0-9_-]{1,64}$/.test(projectId))
  )
    return refuse(400, "bad-project", "projectId must be a dx Project ID.");
  let previous: string | null = null;
  if (typeof key === "string") {
    const open = await db
      .prepare(
        `SELECT pk.thread_id, threads.lifecycle_state FROM plugin_thread_key AS pk
           LEFT JOIN threads ON threads.id = pk.thread_id
          WHERE pk.plugin_id = ? AND pk.key = ?`,
      )
      .bind(install.pluginId, key)
      .first<{ thread_id: string; lifecycle_state: string | null }>();
    if (open?.lifecycle_state === "active") {
      await audit(db, install, {
        action: "thread.open",
        target: open.thread_id,
        outcome: "success",
        detail: { key, created: false },
      });
      return reply(200, {
        threadId: open.thread_id,
        url: await threadUrl(bindings, open.thread_id),
        created: false,
      });
    }
    previous = open?.thread_id ?? null;
  }
  // The audit row is the admission: at most this many opens an hour.
  const admitted = await db
    .prepare(
      `INSERT INTO plugin_audit (
         id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
         thread_id, action, target, outcome, detail_json, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, 'thread.open', ?7, 'success', ?8, ?9
        WHERE (SELECT count(*) FROM plugin_audit
                WHERE plugin_id = ?2 AND action = 'thread.open'
                  AND outcome = 'success' AND created_at > ?10
                  AND json_extract(detail_json, '$.created') = 1) < ?11`,
    )
    .bind(
      `pla_${crypto.randomUUID()}`,
      install.pluginId,
      install.name.slice(0, 214),
      install.version.slice(0, 160),
      install.scope,
      owner,
      typeof key === "string" ? key.slice(0, 256) : null,
      JSON.stringify({
        created: true,
        ...(typeof key === "string" ? { key } : {}),
      }),
      new Date().toISOString(),
      new Date(Date.now() - 3_600_000).toISOString(),
      THREAD_OPENS_PER_HOUR,
    )
    .run();
  if (admitted.meta.changes === 0)
    return refuse(
      429,
      "rate-limited",
      `A plugin opens at most ${THREAD_OPENS_PER_HOUR} Threads an hour.`,
    );
  const threadId =
    typeof key === "string"
      ? await keyedThreadId(install.pluginId, key, previous)
      : `thr_${crypto.randomUUID()}`;
  const existing = await db
    .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ owner_user_id: string }>();
  let created = false;
  if (existing === null) {
    const { response, payload } = await ownerRequest(
      {
        bindings,
        ownerUserId: owner as UserId,
        // A program's text, not the person's own word.
        automation: "external",
      },
      "POST",
      "/v1/threads",
      {
        threadId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(typeof title === "string"
          ? { title: generateThreadTitle(title), generateTitle: false }
          : {}),
        initialMessage: {
          body: `${prompt}\n\n(Opened by the ${install.displayName} plugin.)`,
          attachments: [],
        },
      },
    );
    const data = payload?.data as { readonly id?: string } | undefined;
    if (!response.ok || data?.id !== threadId) {
      // Another open made it first.
      const raced = await db
        .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
        .bind(threadId)
        .first<{ owner_user_id: string }>();
      if (raced?.owner_user_id !== owner) {
        // dx's error replies carry the message under `data`.
        const failure = (
          (payload?.error ?? payload?.data) as
            | { readonly message?: unknown }
            | undefined
        )?.message;
        return refuse(
          502,
          "failed",
          `dx could not open the Thread (HTTP ${response.status}${
            typeof failure === "string" ? `: ${failure}` : ""
          }).`,
        );
      }
    } else created = true;
  } else if (existing.owner_user_id !== owner)
    return refuse(409, "conflict", "dx could not open the Thread.");
  if (typeof key === "string")
    await db
      .prepare(
        `INSERT INTO plugin_thread_key (plugin_id, key, thread_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (plugin_id, key) DO UPDATE SET
           thread_id = excluded.thread_id, created_at = excluded.created_at`,
      )
      .bind(install.pluginId, key, threadId, new Date().toISOString())
      .run();
  return reply(200, {
    threadId,
    url: await threadUrl(bindings, threadId),
    created,
  });
};

/**
 * Posts into a Thread this install opened, as a note (no model call) or,
 * with `wake: true` and the `post` grant, a message the agent answers.
 */
export const postInstallThread = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
  threadId: string,
  body: Record<string, unknown>,
): Promise<ServiceReply> => {
  const grants = pluginThreadGrants(install.code.permissions.threads);
  const wake = body.wake === true;
  if (!grants.includes("create") && !grants.includes("post"))
    return refuse(
      403,
      "not-granted",
      `${install.displayName} was not granted posting into Threads.`,
    );
  if (wake && !grants.includes("post"))
    return refuse(
      403,
      "not-granted",
      `${install.displayName} may add notes to its Threads but not wake the agent (permissions.threads: ["post"]).`,
    );
  const owner = actingUser(install);
  const text = body.text;
  if (typeof text !== "string" || text.trim() === "")
    return refuse(400, "bad-body", "A post needs text.");
  if (text.length > POST_CHARS)
    return refuse(400, "too-long", "A post is at most 30,000 characters.");
  // A service posts only into Threads it opened and that are still open.
  const opened = await db
    .prepare(
      `SELECT 1 AS opened FROM plugin_thread_key AS pk
         JOIN threads ON threads.id = pk.thread_id
        WHERE pk.plugin_id = ? AND pk.thread_id = ?
          AND threads.lifecycle_state = 'active'`,
    )
    .bind(install.pluginId, threadId)
    .first<{ opened: number }>();
  if (opened === null || owner === undefined) {
    await audit(db, install, {
      action: wake ? "thread.post" : "thread.note",
      target: threadId,
      outcome: "rejected",
      detail: { reason: "not-opened" },
    });
    return refuse(
      403,
      "not-opened",
      "A plugin posts only into open Threads it opened with a key.",
    );
  }
  try {
    await postPluginThreadMessage(bindings, {
      ownerUserId: owner,
      threadId,
      install: installRecord(install),
      body: text,
      note: !wake,
      idempotencyKey: `service:${crypto.randomUUID()}`,
    });
  } catch (cause) {
    return refuse(
      502,
      "failed",
      cause instanceof Error ? cause.message : "dx could not post.",
    );
  }
  await audit(db, install, {
    action: wake ? "thread.post" : "thread.note",
    target: threadId,
    outcome: "success",
    detail: { chars: text.length },
    threadId,
  });
  return reply(200);
};

// ─── Cloud identity ────────────────────────────────────────────────────────

export const issueInstallToken = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
  body: Record<string, unknown>,
  runtime: "service" | "function" = "service",
): Promise<ServiceReply> => {
  const request = Schema.decodeUnknownOption(
    IssueWorkloadIdentityRequestSchema,
  )(body);
  if (Option.isNone(request))
    return refuse(
      400,
      "bad-body",
      'Send { "audience": "…", "ttlSeconds": 60 to 3600 }.',
    );
  try {
    const issued = await workloadIdentityBroker.issueForInstall(bindings, {
      ...request.value,
      install: {
        pluginId: install.pluginId,
        name: install.name,
        scope: install.scope,
        targetId: install.targetId,
      },
      runtime,
    });
    await audit(db, install, {
      action: "identity.token",
      target: request.value.audience,
      outcome: "success",
      detail: {
        subject: issued.subject,
        expiresAt: issued.expiresAt,
        runtime,
      },
    });
    return reply(200, { token: issued.token, expiresAt: issued.expiresAt });
  } catch (cause) {
    await audit(db, install, {
      action: "identity.token",
      target: request.value.audience,
      outcome: "rejected",
    });
    return cause instanceof WorkloadIdentityUnauthorized
      ? refuse(403, "denied", "This audience needs an attested Orb.")
      : refuse(
          503,
          "unavailable",
          "This deployment does not issue cloud identity tokens.",
        );
  }
};

/**
 * The same actions for function code (the Worker and durable function
 * tiers): one contract for both runtimes, so a plugin that moves between
 * them keeps its state, its Thread keys, and its identity. A repository's
 * plugin gets none of them; nobody installed it.
 */
export const actingInstallOf = (
  record: PluginInstallRecord,
): ServiceInstall | undefined =>
  record.scope === "repository"
    ? undefined
    : {
        pluginId: record.pluginId,
        name: record.name,
        displayName: record.displayName,
        scope: record.scope,
        targetId: record.targetId,
        version: record.version,
        integrity: record.integrity,
        code: record.code,
        installedByUserId: record.installedByUserId,
        package: record.package,
      };
