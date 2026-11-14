import {
  effectiveArchivedMode,
  lowerTier,
  PLUGIN_JOB_INSTANCE_ID,
  pluginHostKinds,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { configuredTierLimits } from "../../trust/limits.js";
import { mapPluginsLimited } from "../../worker-host/concurrency.js";
import type {
  PluginHostDependencies,
  PluginInstallRecord,
} from "../../worker-host/host.js";
import {
  callPluginWorkerHost,
  runPluginJob,
  sendPluginWatchMessage,
} from "../../worker-host/worker.js";
import { logPluginHostCall, tierAllowsHost } from "../registry.js";
import type { PluginTier } from "../tier.js";
import { deleteBlobPrefix } from "./blob-prefix.js";
import {
  type DurableMeta,
  type DurableOpener,
  durableNamespace,
  durableObjectName,
  type PluginDurableCapabilities,
} from "./client.js";
import { type DurableInstallState, loadDurableInstall } from "./install.js";
import { nextCronTime, nextJobRun, resolveScheduledRun } from "./schedule.js";
import { checkPluginSql, MAX_SQL_ROWS } from "./sql-guard.js";
import { durableCostMicroUsd, recordDurableUsage } from "./usage.js";

/**
 * The plugin Durable Object host: one object per install, or per install
 * and Thread (`durableScope: "thread"`). It owns what a Dynamic Worker
 * cannot keep: the install's SQLite (`ctx.sql`), its blob index
 * (`ctx.blobs`, bytes in R2), its jobs and their alarms (`ctx.jobs`), and
 * its open connections (`ctx.watch`). The plugin's code never runs inside
 * this object: each job, watch message, or host call runs in the install's
 * durable Dynamic Worker (`hosts.durable`, or the Worker's module), handed
 * the same `PluginHost` capability object every host gets, whose
 * `ctx.sql`, `ctx.blobs`, `ctx.jobs`, and `ctx.watch` come back here
 * in-process.
 *
 * dx's own tables are `_dx_*`; the guard in sql-guard.ts keeps the
 * plugin's statements away from them.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

/** How long a loaded install is trusted before it is read again. */
const INSTALL_TTL_MS = 120_000;
/** Usage is written to D1 at most this often per object. */
const USAGE_FLUSH_MS = 15 * 60_000;
/** While watches are open, the object checks them this often. */
const WATCH_CHECK_MS = 60_000;
/** A connection up this long counts as stable: its backoff starts over. */
const WATCH_STABLE_MS = 30_000;
/** A watch reconnects after this long, doubling to a minute. */
const WATCH_RETRY_MS = 2_000;
/** Streams such as Wikimedia's refuse requests without a User-Agent. */
const WATCH_USER_AGENT = "dx-plugin-watch/1 (+https://dxcode.dev)";
/** Messages a watch keeps while its handler is busy; older ones drop. */
const WATCH_QUEUE = 100;
/** The largest blob one put takes; Workers RPC carries 32 MiB. */
export const MAX_BLOB_BYTES = 25 * 1_048_576;
const BLOB_KEY = /^[A-Za-z0-9!_.*'()/@:+=-]{1,512}$/;

interface JobRow {
  readonly [key: string]: SqlStorageValue;
  readonly id: string;
  readonly title: string;
  readonly schedule_json: string;
  readonly data_json: string | null;
  readonly next_at: number | null;
  readonly status: string;
  readonly declared: number;
  readonly last_run_at: number | null;
  readonly last_outcome: string | null;
  readonly last_error: string | null;
  readonly last_ms: number | null;
  readonly runs: number;
}

/** A job as the Plugins page shows it. */
export interface DurableJobView {
  readonly id: string;
  readonly title: string;
  readonly schedule: { every?: string; cron?: string; at?: string | number };
  readonly status: "scheduled" | "running" | "stopped" | "paused" | "done";
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly lastOutcome?: string;
  readonly lastError?: string;
  readonly lastMs?: number;
  readonly runs: number;
  readonly threadId?: string;
}

interface Watch {
  readonly target: string;
  opener: DurableOpener;
  close: () => void;
  queue: Array<unknown>;
  draining: boolean;
  dropped: number;
  connectedAt: number;
  /** Connected time is billed from here; each usage flush moves it. */
  billedFrom: number;
  retryMs: number;
  messages: number;
}

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * The object's state and behavior. object.ts's {@link PluginDurableHostObject}
 * constructs it on the object's first call, so the core Worker does not
 * evaluate this module, or what it imports, at startup.
 */
export class PluginDurableHost implements PluginDurableCapabilities {
  readonly ctx: DurableObjectState;
  readonly env: Bindings;
  readonly #sql: SqlStorage;
  #meta: DurableMeta | undefined;
  #install: { state: DurableInstallState | undefined; at: number } | undefined;
  readonly #watches = new Map<string, Watch>();
  /** Active milliseconds and requests since the last usage flush. */
  // Active time and requests since the last flush live in _dx_meta, so an
  // eviction between alarms loses none of them.
  #addUsage(ms: number, requests: number) {
    for (const [key, value] of [
      ["usage_ms", Math.max(0, Math.round(ms))],
      ["usage_requests", requests],
    ] as const)
      if (value > 0)
        this.#sql.exec(
          `INSERT INTO _dx_meta (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)`,
          key,
          String(value),
        );
  }

  #pendingUsage() {
    const rows = new Map(
      this.#sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM _dx_meta WHERE key IN ('usage_ms', 'usage_requests')",
        )
        .toArray()
        .map(({ key, value }) => [key, Number(value)]),
    );
    return {
      activeMs: rows.get("usage_ms") ?? 0,
      requests: rows.get("usage_requests") ?? 0,
    };
  }

  constructor(state: DurableObjectState, env: Bindings) {
    this.ctx = state;
    this.env = env;
    this.#sql = state.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS _dx_meta (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _dx_jobs (
        id TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        data_json TEXT,
        next_at INTEGER,
        status TEXT NOT NULL CHECK (
          status IN ('scheduled', 'running', 'stopped', 'paused', 'done')),
        declared INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        last_outcome TEXT,
        last_error TEXT,
        last_ms INTEGER,
        runs INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS _dx_watches (
        target TEXT NOT NULL PRIMARY KEY,
        opener_json TEXT NOT NULL,
        opened_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _dx_blobs (
        key TEXT NOT NULL PRIMARY KEY,
        bytes INTEGER NOT NULL,
        content_type TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _dx_thread_jobs (
        thread_id TEXT NOT NULL PRIMARY KEY,
        jobs_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // No run is in flight when the object starts: one an eviction or a
    // deploy cut off runs again.
    this.#sql.exec(
      "UPDATE _dx_jobs SET status = 'scheduled', next_at = COALESCE(next_at, ?) WHERE status = 'running'",
      Date.now(),
    );
    const stored = this.#sql
      .exec<{ value: string }>("SELECT value FROM _dx_meta WHERE key = 'meta'")
      .toArray()[0];
    this.#meta =
      stored === undefined ? undefined : (parse(stored.value) as DurableMeta);
  }

  // ─── Meta, install, and limits ─────────────────────────────────────────

  /**
   * Records who the object serves. A caller's meta wins when it names the
   * same install: a newer version or tier replaces the stored one.
   */
  #remember(incoming: DurableMeta) {
    const current = this.#meta;
    if (current !== undefined && current.installId !== incoming.installId)
      throw new Error("This Durable Object serves another install.");
    const meta = incoming;
    if (
      current === undefined ||
      current.integrity !== meta.integrity ||
      current.tier !== meta.tier ||
      current.ownerUserId !== meta.ownerUserId ||
      json(current.jobs) !== json(meta.jobs)
    ) {
      this.#meta = meta;
      this.#install = undefined;
      this.#sql.exec(
        "INSERT INTO _dx_meta (key, value) VALUES ('meta', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        json(meta),
      );
      this.#syncDeclaredJobs(meta);
      for (const key of ["started_at", "usage_at"])
        this.#sql.exec(
          "INSERT INTO _dx_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
          key,
          String(Date.now()),
        );
    }
    this.#register(meta);
    // A call from the install means it runs again: jobs held while it was
    // off or out of tier resume (re-enabling keeps the same version).
    if (this.#trusted(meta.tier)) this.#resumeOff();
    this.#addUsage(0, 1);
    return meta;
  }

  /**
   * Jobs held while the install was off or out of tier run again. The
   * cached install state said "off", so it is read again, or the next
   * alarm would hold them once more.
   */
  #resumeOff() {
    const resumed = this.#resumeHeld(["uninstalled", "blocked-tier"]);
    if (resumed > 0) {
      this.#install = undefined;
      this.ctx.waitUntil(this.#arm());
    }
    return resumed;
  }

  /**
   * Records the object in D1 once, so dx can purge it when its install is
   * removed or its Thread deleted (durable/objects.ts).
   */
  #register(meta: DurableMeta) {
    const done = this.#sql
      .exec("SELECT 1 FROM _dx_meta WHERE key = 'registered'")
      .toArray();
    if (done.length > 0) return;
    const db = this.env.DB as D1Database | undefined;
    if (db === undefined) return;
    this.ctx.waitUntil(
      db
        .prepare(
          `INSERT INTO plugin_durable_object (name, install_id, thread_id, created_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (name) DO UPDATE SET purged_at = NULL`,
        )
        .bind(
          durableObjectName(meta.installId, meta.threadId),
          meta.installId,
          meta.threadId ?? null,
          new Date().toISOString(),
        )
        .run()
        .then(() =>
          this.#sql.exec(
            "INSERT INTO _dx_meta (key, value) VALUES ('registered', '1') ON CONFLICT (key) DO NOTHING",
          ),
        )
        .catch((error: unknown) =>
          logger.warn("A plugin Durable Object was not registered.", {
            event: "plugin_durable_register_failed",
            installId: meta.installId,
            threadId: meta.threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
    );
  }

  /**
   * Re-enabling the install: jobs held while it was off resume, without a
   * caller's meta (the object keeps the owner and tier it was given).
   */
  async resumeInstall() {
    if (this.#meta === undefined || !this.#trusted(this.#meta.tier)) return 0;
    const resumed = this.#resumeOff();
    if (resumed > 0) await this.#afterJobsChanged();
    return resumed;
  }

  /**
   * Deletes everything the object holds: its SQLite (the plugin's tables
   * and dx's), its alarm, its open watches, and its R2 blobs, after billing
   * what was pending. Idempotent: an object never used or purged already
   * returns `wasEmpty`. The caller drops this host, so the next call starts
   * a clean one.
   */
  async purge(installId: string, threadId: string | undefined) {
    const meta = this.#meta;
    if (meta !== undefined && meta.installId !== installId)
      throw new Error("This Durable Object serves another install.");
    const wasEmpty = meta === undefined;
    this.#disconnectWatches();
    if (!wasEmpty) await this.#flushUsageLogged(Date.now());
    const sqlBytes = this.#sql.databaseSize;
    const bucket = this.env.DX_STORAGE;
    const blobs =
      bucket === undefined
        ? 0
        : await deleteBlobPrefix(
            bucket,
            `plugins/${installId}/${threadId ?? "_install"}/`,
          );
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#meta = undefined;
    this.#install = undefined;
    const tablesLeft = this.#sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
      )
      .toArray().length;
    return { wasEmpty, blobs, sqlBytes, tablesLeft };
  }

  /** The install-wide object stops listing a deleted Thread's jobs. */
  async forgetThread(threadId: string) {
    if (this.#meta === undefined) return;
    this.#sql.exec("DELETE FROM _dx_thread_jobs WHERE thread_id = ?", threadId);
  }

  #limits() {
    return configuredTierLimits(this.env, this.#meta?.tier ?? "sandboxed");
  }

  /** The lower of what callers sent and what the loaded version earns. */
  #tierFor(install: PluginInstallRecord): PluginTier {
    return lowerTier(
      this.#meta?.tier ?? "sandboxed",
      install.tier ?? "sandboxed",
    );
  }

  #trusted(tier: PluginTier | undefined) {
    return tier !== undefined && tierAllowsHost(tier, "durable");
  }

  /** The install and its Thread, read again after {@link INSTALL_TTL_MS}. */
  async #installState(): Promise<DurableInstallState | undefined> {
    const meta = this.#meta;
    if (meta === undefined) return undefined;
    const cached = this.#install;
    if (cached !== undefined && Date.now() - cached.at < INSTALL_TTL_MS)
      return cached.state;
    const state = await loadDurableInstall(this.env.DB as D1Database, {
      installId: meta.installId,
      ownerUserId: meta.ownerUserId,
      threadId: meta.threadId,
    });
    this.#install = { state, at: Date.now() };
    return state;
  }

  /** The capability object's inputs for one call this object runs. */
  #dependencies(
    install: PluginInstallRecord,
    opener: DurableOpener,
    requestId: string,
    archivedLive: boolean,
  ): PluginHostDependencies {
    const meta = this.#meta as DurableMeta;
    return {
      db: this.env.DB as D1Database,
      bindings: this.env,
      install,
      ownerUserId: meta.ownerUserId,
      ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
      tier: this.#tierFor(install),
      requestId,
      workspaceId: meta.workspaceId,
      currentHost: "durable",
      durable: this,
      durableOpener: opener,
      ...(archivedLive ? { archivedLive: true } : {}),
    };
  }

  /**
   * Whether code may run now: the install is still enabled for its owner,
   * its tier is trusted, and its Thread (thread scope) is active, or
   * archived with `archivedThreads: "live"`. Otherwise says why not.
   */
  async #admit(): Promise<
    | { ok: true; install: PluginInstallRecord; archivedLive: boolean }
    | {
        ok: false;
        reason: "uninstalled" | "blocked-tier" | "archived" | "deleted";
      }
  > {
    const meta = this.#meta;
    const state = await this.#installState();
    if (meta === undefined || state === undefined)
      return { ok: false, reason: "uninstalled" };
    // The tier the active version earns now, not only the one a caller
    // last sent: a new version asking for less, or a lower cap, stops it.
    if (!this.#trusted(this.#tierFor(state.install)))
      return { ok: false, reason: "blocked-tier" };
    if (state.thread?.deleted === true) return { ok: false, reason: "deleted" };
    if (state.thread?.archived === true) {
      // The archived-Thread rule decides: live needs a trusted tier and this host.
      if (
        effectiveArchivedMode(
          state.archivedThreads,
          meta.tier,
          pluginHostKinds(state.install.code),
        ).mode !== "live"
      )
        return { ok: false, reason: "archived" };
      return { ok: true, install: state.install, archivedLive: true };
    }
    return { ok: true, install: state.install, archivedLive: false };
  }

  // ─── ctx.sql ───────────────────────────────────────────────────────────

  async sqlExec(
    meta: DurableMeta,
    statement: string,
    params: ReadonlyArray<unknown>,
  ) {
    this.#remember(meta);
    const checked = checkPluginSql(statement, params);
    if ("refused" in checked) throw new Error(checked.refused);
    const limit = this.#limits().storageSqlBytes;
    const quota = (size: number) =>
      new Error(
        `The plugin's SQL storage is full: ${size.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} bytes (quota). Delete rows to write again.`,
      );
    if (checked.writes && this.#sql.databaseSize >= limit)
      throw quota(this.#sql.databaseSize);
    // One transaction per statement: a statement that grows the database
    // past the quota (a recursive insert, say) rolls back whole.
    const before = this.#sql.databaseSize;
    try {
      return this.ctx.storage.transactionSync(() => {
        const cursor = this.#sql.exec(checked.statement, ...checked.params);
        const rows: Array<Record<string, unknown>> = [];
        for (const row of cursor) {
          if (rows.length >= MAX_SQL_ROWS)
            throw new Error(
              `A statement returns at most ${MAX_SQL_ROWS} rows; add a LIMIT.`,
            );
          rows.push(row);
        }
        const after = this.#sql.databaseSize;
        if (after > limit && after > before) throw quota(after);
        return { rows, changes: cursor.rowsWritten };
      });
    } catch (error) {
      if (error instanceof Error && /\(quota\)/.test(error.message))
        logger.warn(
          `Plugin ${meta.pluginName}'s SQL write crossed its quota and rolled back.`,
          {
            event: "plugin_durable_sql_quota",
            installId: meta.installId,
            threadId: meta.threadId,
            host: "durable",
            tier: meta.tier,
            outcome: "quota",
            limit,
            sizeBefore: before,
          },
        );
      throw error;
    }
  }

  // ─── ctx.blobs ─────────────────────────────────────────────────────────

  #bucket() {
    const bucket = this.env.DX_STORAGE;
    if (bucket === undefined)
      throw new Error("This deployment has no blob storage (DX_STORAGE).");
    return bucket;
  }

  #blobKey(key: string) {
    if (!BLOB_KEY.test(key) || key.split("/").includes(".."))
      throw new Error(
        "A blob key is 1 to 512 letters, digits, and !_.*'()/@:+=- characters, without .. segments.",
      );
    const meta = this.#meta as DurableMeta;
    return `plugins/${meta.installId}/${meta.threadId ?? "_install"}/blobs/${key}`;
  }

  async blobPut(
    meta: DurableMeta,
    key: string,
    body: ArrayBuffer | string,
    contentType: string | undefined,
  ) {
    this.#remember(meta);
    const objectKey = this.#blobKey(key);
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : new Uint8Array(body);
    if (bytes.byteLength > MAX_BLOB_BYTES)
      throw new Error(`A blob is at most ${MAX_BLOB_BYTES / 1_048_576} MiB.`);
    const used =
      this.#sql
        .exec<{ total: number | null }>(
          "SELECT SUM(bytes) AS total FROM _dx_blobs WHERE key != ?",
          key,
        )
        .one().total ?? 0;
    const limit = this.#limits().blobBytes;
    if (used + bytes.byteLength > limit)
      throw new Error(
        `The plugin's blob storage is full: ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} bytes used, and this blob is ${bytes.byteLength.toLocaleString("en-US")} (quota).`,
      );
    await this.#bucket().put(objectKey, bytes, {
      ...(contentType === undefined ? {} : { httpMetadata: { contentType } }),
    });
    this.#sql.exec(
      `INSERT INTO _dx_blobs (key, bytes, content_type, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes,
         content_type = excluded.content_type, updated_at = excluded.updated_at`,
      key,
      bytes.byteLength,
      contentType ?? null,
      Date.now(),
    );
  }

  async blobGet(meta: DurableMeta, key: string) {
    this.#remember(meta);
    const object = await this.#bucket().get(this.#blobKey(key));
    if (object === null) return undefined;
    const contentType = object.httpMetadata?.contentType;
    return {
      body: await object.arrayBuffer(),
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  async blobDelete(meta: DurableMeta, key: string) {
    this.#remember(meta);
    await this.#bucket().delete(this.#blobKey(key));
    this.#sql.exec("DELETE FROM _dx_blobs WHERE key = ?", key);
  }

  async blobList(meta: DurableMeta, prefix: string) {
    this.#remember(meta);
    return this.#sql
      .exec<{ key: string }>(
        "SELECT key FROM _dx_blobs WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT 1000",
        prefix.length,
        prefix,
      )
      .toArray()
      .map(({ key }) => key);
  }

  // ─── ctx.jobs ──────────────────────────────────────────────────────────

  /**
   * Adds declared every and cron jobs, follows a new version's schedules,
   * and drops declared jobs it removed. A job a person stopped stays
   * stopped. A thread-scoped install's install-wide object runs none.
   */
  #syncDeclaredJobs(meta: DurableMeta) {
    const now = Date.now();
    const declared =
      meta.durableScope === "thread" && meta.threadId === undefined
        ? []
        : meta.jobs;
    const ids = new Set(declared.map(({ id }) => id));
    for (const row of this.#sql
      .exec<{ id: string }>("SELECT id FROM _dx_jobs WHERE declared = 1")
      .toArray())
      if (!ids.has(row.id))
        this.#sql.exec("DELETE FROM _dx_jobs WHERE id = ?", row.id);
    for (const job of declared) {
      if ("at" in job.schedule) {
        // On demand: listed for the Plugins page, scheduled only by code.
        this.#sql.exec(
          `INSERT INTO _dx_jobs (id, title, schedule_json, status, declared, next_at)
           VALUES (?1, ?2, ?3, 'done', 1, NULL)
           ON CONFLICT (id) DO UPDATE SET title = excluded.title,
             schedule_json = CASE WHEN _dx_jobs.status IN ('scheduled', 'running')
                                  THEN _dx_jobs.schedule_json ELSE excluded.schedule_json END,
             status = CASE WHEN _dx_jobs.status IN ('scheduled', 'running')
                           AND _dx_jobs.schedule_json != excluded.schedule_json
                           AND json_extract(_dx_jobs.schedule_json, '$.at') IS NULL
                           THEN 'done' ELSE _dx_jobs.status END,
             next_at = CASE WHEN json_extract(_dx_jobs.schedule_json, '$.at') IS NULL
                            AND _dx_jobs.schedule_json != excluded.schedule_json
                            THEN NULL ELSE _dx_jobs.next_at END`,
          job.id,
          job.title,
          json(job.schedule),
        );
        continue;
      }
      const next = nextJobRun(job.schedule, now);
      this.#sql.exec(
        `INSERT INTO _dx_jobs (id, title, schedule_json, status, declared, next_at)
         VALUES (?1, ?2, ?3, 'scheduled', 1, ?4)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title,
           schedule_json = excluded.schedule_json,
           status = CASE WHEN _dx_jobs.status = 'done'
                           OR (_dx_jobs.status = 'stopped'
                               AND COALESCE(_dx_jobs.last_outcome, '') != 'stopped-by-person')
                         THEN 'scheduled' ELSE _dx_jobs.status END,
           next_at = CASE WHEN _dx_jobs.schedule_json = excluded.schedule_json
                           AND _dx_jobs.next_at IS NOT NULL
                          THEN _dx_jobs.next_at ELSE excluded.next_at END`,
        job.id,
        job.title,
        json(job.schedule),
        next ?? null,
      );
    }
  }

  /** Jobs held for these reasons run again, from now. */
  #resumeHeld(reasons: ReadonlyArray<string>) {
    const now = Date.now();
    let resumed = 0;
    for (const row of this.#sql
      .exec<JobRow>(
        `SELECT * FROM _dx_jobs WHERE status = 'paused'
           AND last_outcome IN (SELECT value FROM json_each(?))`,
        json(reasons),
      )
      .toArray()) {
      const schedule = parse(row.schedule_json) as {
        every?: string;
        cron?: string;
        at?: number;
      };
      const next =
        typeof schedule.at === "number"
          ? Math.max(now, schedule.at)
          : nextJobRun(schedule, now);
      this.#sql.exec(
        "UPDATE _dx_jobs SET status = ?, next_at = ? WHERE id = ?",
        next === undefined ? "done" : "scheduled",
        next ?? null,
        row.id,
      );
      resumed += 1;
    }
    return resumed;
  }

  #jobCount() {
    return this.#sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _dx_jobs WHERE status IN ('scheduled', 'running')",
      )
      .one().count;
  }

  async jobsSchedule(
    meta: DurableMeta,
    id: string,
    when: { at?: number; every?: string; cron?: string },
    data: unknown,
  ) {
    this.#remember(meta);
    if (!PLUGIN_JOB_INSTANCE_ID.test(id))
      throw new Error(
        "A job id is a declared job's id, or <declared id>:<key> with a key of 1 to 64 letters, digits, and ._- characters.",
      );
    const base = id.split(":")[0] ?? id;
    const job = meta.jobs.find((declared) => declared.id === base);
    if (job === undefined)
      throw new Error(
        `The manifest declares no job ${base}; declare it in extensions["dev.dxcode"].jobs so people see it before they install.`,
      );
    const now = Date.now();
    const run = resolveScheduledRun(when, job.schedule, now);
    if (!run.ok) throw new Error(run.reason);
    const { schedule, next } = run;
    const dataJson = json(data);
    if (dataJson.length > 65_536)
      throw new Error("A job's data is at most 64 KB of JSON.");
    const exists =
      this.#sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM _dx_jobs WHERE id = ? AND status IN ('scheduled', 'running')",
          id,
        )
        .one().count > 0;
    const limit = this.#limits().jobs;
    if (!exists && this.#jobCount() >= limit)
      throw new Error(
        `The plugin already has ${limit} scheduled jobs, its tier's limit (quota). Cancel one first.`,
      );
    this.#sql.exec(
      `INSERT INTO _dx_jobs (id, title, schedule_json, data_json, status, declared, next_at)
       VALUES (?1, ?2, ?3, ?4, 'scheduled', ?5, ?6)
       ON CONFLICT (id) DO UPDATE SET schedule_json = excluded.schedule_json,
         data_json = excluded.data_json, next_at = excluded.next_at,
         status = CASE WHEN _dx_jobs.status = 'running' THEN 'running' ELSE 'scheduled' END`,
      id,
      id === base ? job.title : `${job.title} (${id.slice(base.length + 1)})`,
      json(schedule),
      dataJson,
      id === base ? 1 : 0,
      next,
    );
    await this.#afterJobsChanged();
  }

  async jobsCancel(meta: DurableMeta, id: string) {
    this.#remember(meta);
    this.#cancelJob(id);
    await this.#afterJobsChanged();
  }

  #cancelJob(id: string, byPerson = false) {
    // Declared jobs stay listed, stopped; instances go away. A person's Stop
    // holds across new versions until they start it again.
    this.#sql.exec(
      "UPDATE _dx_jobs SET status = 'stopped', next_at = NULL, last_outcome = CASE WHEN ? THEN 'stopped-by-person' ELSE last_outcome END WHERE id = ? AND declared = 1",
      byPerson ? 1 : 0,
      id,
    );
    this.#sql.exec("DELETE FROM _dx_jobs WHERE id = ? AND declared = 0", id);
  }

  async jobsList(meta: DurableMeta) {
    this.#remember(meta);
    return this.#sql
      .exec<{ id: string; next_at: number | null }>(
        "SELECT id, next_at FROM _dx_jobs WHERE status IN ('scheduled', 'running') ORDER BY id",
      )
      .toArray()
      .map(({ id, next_at }) =>
        next_at === null ? { id } : { id, next: next_at },
      );
  }

  #jobViews(): Array<DurableJobView> {
    return this.#sql
      .exec<JobRow>("SELECT * FROM _dx_jobs ORDER BY declared DESC, id")
      .toArray()
      .map((row) => ({
        id: row.id,
        title: row.title,
        schedule: parse(row.schedule_json) as DurableJobView["schedule"],
        status: row.status as DurableJobView["status"],
        ...(row.next_at === null ? {} : { nextRunAt: row.next_at }),
        ...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
        ...(row.last_outcome === null ? {} : { lastOutcome: row.last_outcome }),
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
        ...(row.last_ms === null ? {} : { lastMs: row.last_ms }),
        runs: row.runs,
        ...(this.#meta?.threadId === undefined
          ? {}
          : { threadId: this.#meta.threadId }),
      }));
  }

  /** Re-arms the alarm and tells the install's object what this Thread runs. */
  async #afterJobsChanged() {
    await this.#arm();
    const meta = this.#meta;
    if (meta?.threadId === undefined) return;
    const namespace = durableNamespace(this.env);
    if (namespace === undefined) return;
    const install = namespace.get(
      namespace.idFromName(durableObjectName(meta.installId, undefined)),
    );
    await install
      .reportThreadJobs(
        { ...meta, threadId: undefined } as DurableMeta,
        meta.threadId,
        this.#jobViews(),
      )
      .catch((error: unknown) =>
        logger.warn("A thread object could not report its jobs.", {
          event: "plugin_durable_report_failed",
          installId: meta.installId,
          threadId: meta.threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** The install's object keeps each Thread object's jobs for the Plugins page. */
  async reportThreadJobs(
    meta: DurableMeta,
    threadId: string,
    jobs: ReadonlyArray<DurableJobView>,
  ) {
    if (this.#meta === undefined) this.#remember(meta);
    else if (this.#meta.installId !== meta.installId)
      throw new Error("This Durable Object serves another install.");
    if (jobs.length === 0)
      this.#sql.exec(
        "DELETE FROM _dx_thread_jobs WHERE thread_id = ?",
        threadId,
      );
    else
      this.#sql.exec(
        `INSERT INTO _dx_thread_jobs (thread_id, jobs_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET jobs_json = excluded.jobs_json,
           updated_at = excluded.updated_at`,
        threadId,
        json(jobs),
        Date.now(),
      );
  }

  /**
   * The Plugins page's view: this object's jobs and, on the install's
   * object, every Thread object's last report. No D1 read.
   */
  async jobsView(meta: DurableMeta) {
    // Reading writes nothing once the object knows its install.
    if (this.#meta === undefined) this.#remember(meta);
    const threads = this.#sql
      .exec<{ jobs_json: string }>(
        "SELECT jobs_json FROM _dx_thread_jobs ORDER BY updated_at DESC LIMIT 100",
      )
      .toArray()
      .flatMap(
        ({ jobs_json }) => (parse(jobs_json) as Array<DurableJobView>) ?? [],
      );
    return {
      jobs: [...this.#jobViews(), ...threads],
      watches: [...this.#watches.values()].map((watch) => ({
        target: watch.target,
        connectedAt: watch.connectedAt,
        messages: watch.messages,
        dropped: watch.dropped,
      })),
      storage: {
        sqlBytes: this.#sql.databaseSize,
        blobBytes:
          this.#sql
            .exec<{ total: number | null }>(
              "SELECT SUM(bytes) AS total FROM _dx_blobs",
            )
            .one().total ?? 0,
      },
    };
  }

  /** Stop from the Plugins page: on a Thread's object when `threadId` names one. */
  async stopJob(meta: DurableMeta, id: string, threadId: string | undefined) {
    // A Thread's object keeps the owner and tier its Thread gave it.
    if (this.#meta === undefined) this.#remember(meta);
    if (threadId !== undefined && threadId !== meta.threadId) {
      const namespace = durableNamespace(this.env);
      // Only a Thread whose object reported jobs here: a made-up id must not
      // start an object.
      if (namespace === undefined || !this.#knowsThread(threadId)) return;
      await namespace
        .get(namespace.idFromName(durableObjectName(meta.installId, threadId)))
        .stopJob({ ...meta, threadId }, id, threadId);
      return;
    }
    this.#cancelJob(id, true);
    logger.info(`Plugin ${meta.pluginName}'s job ${id} was stopped.`, {
      event: "plugin_job_stopped",
      installId: meta.installId,
      threadId: meta.threadId,
      job: id,
    });
    await this.#afterJobsChanged();
  }

  #knowsThread(threadId: string) {
    return (
      this.#sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM _dx_thread_jobs WHERE thread_id = ?",
          threadId,
        )
        .one().count > 0
    );
  }

  /** Starts a stopped declared job again, from now. */
  async startJob(meta: DurableMeta, id: string, threadId: string | undefined) {
    // A Thread's object keeps the owner and tier its Thread gave it.
    if (this.#meta === undefined) this.#remember(meta);
    if (threadId !== undefined && threadId !== meta.threadId) {
      const namespace = durableNamespace(this.env);
      // Only a Thread whose object reported jobs here: a made-up id must not
      // start an object.
      if (namespace === undefined || !this.#knowsThread(threadId)) return;
      await namespace
        .get(namespace.idFromName(durableObjectName(meta.installId, threadId)))
        .startJob({ ...meta, threadId }, id, threadId);
      return;
    }
    const row = this.#sql
      .exec<JobRow>("SELECT * FROM _dx_jobs WHERE id = ?", id)
      .toArray()[0];
    if (row === undefined) return;
    const schedule = parse(row.schedule_json) as {
      every?: string;
      cron?: string;
    };
    const next = nextJobRun(schedule, Date.now());
    if (next === undefined) return;
    this.#sql.exec(
      "UPDATE _dx_jobs SET status = 'scheduled', next_at = ?, last_outcome = NULL WHERE id = ?",
      next,
      id,
    );
    await this.#afterJobsChanged();
  }

  /** Declared jobs start when a Thread first resolves the install. */
  async ensure(meta: DurableMeta) {
    this.#remember(meta);
    await this.#afterJobsChanged();
    return { jobs: this.#jobCount() };
  }

  // ─── Host calls ────────────────────────────────────────────────────────

  /** `ctx.host("durable").call(fn, args)` from another host. */
  async hostCall(
    meta: DurableMeta,
    fn: string,
    args: unknown,
    requestId: string,
    /** The caller runs for an archived Thread as `live`. */
    callerArchivedLive = false,
  ) {
    this.#remember(meta);
    const admitted = await this.#admit();
    if (!admitted.ok)
      throw new Error(
        `The durable host does not run this plugin now (${admitted.reason}).`,
      );
    return this.#timed(() =>
      callPluginWorkerHost(
        this.#dependencies(
          admitted.install,
          { kind: "host-call", fn, args },
          requestId,
          admitted.archivedLive || callerArchivedLive,
        ),
        fn,
        args,
        "worker",
      ),
    );
  }

  async #timed<T>(run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await run();
    } finally {
      this.#addUsage(Date.now() - started, 0);
    }
  }

  // ─── Alarm: jobs, watches, usage ───────────────────────────────────────

  #nextAlarm(): number | undefined {
    const job = this.#sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_at) AS next FROM _dx_jobs WHERE status = 'scheduled'",
      )
      .one().next;
    const times = [job ?? undefined];
    if (
      this.#watches.size > 0 ||
      (this.#watchRows().length > 0 && !this.#watchesHeld())
    )
      times.push(Date.now() + WATCH_CHECK_MS);
    const pending = this.#pendingUsage();
    if (pending.activeMs > 0 || pending.requests > 0)
      times.push(this.#usageDue());
    const due = times.filter((time): time is number => time !== undefined);
    return due.length === 0 ? undefined : Math.min(...due);
  }

  #usageDue() {
    const last = Number(
      this.#sql
        .exec<{ value: string }>(
          "SELECT value FROM _dx_meta WHERE key IN ('usage_at', 'started_at') ORDER BY key DESC LIMIT 1",
        )
        .toArray()[0]?.value ?? Date.now(),
    );
    return last + USAGE_FLUSH_MS;
  }

  async #arm() {
    const next = this.#nextAlarm();
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
  }

  async alarm() {
    const meta = this.#meta;
    if (meta === undefined) return;
    const now = Date.now();
    const due = this.#sql
      .exec<JobRow>(
        "SELECT * FROM _dx_jobs WHERE status = 'scheduled' AND next_at <= ? ORDER BY next_at LIMIT 20",
        now,
      )
      .toArray();
    if (due.length > 0) {
      const admitted = await this.#admit();
      if (!admitted.ok) this.#hold(due, admitted.reason);
      // Under the per-request Dynamic Worker limit of four at once.
      else
        await mapPluginsLimited(due, (row) =>
          this.#runJob(row, admitted.install, admitted.archivedLive),
        );
    }
    await this.#checkWatches();
    if (now >= this.#usageDue()) await this.#flushUsageLogged(now);
    await this.#arm();
    if (due.length > 0) await this.#afterJobsChanged();
  }

  /** Jobs that may not run: paused for an archive, stopped otherwise. */
  #hold(rows: ReadonlyArray<JobRow>, reason: string) {
    const meta = this.#meta as DurableMeta;
    // Paused jobs resume when the reason ends (restore, re-enable, trust);
    // a deleted Thread's stop for good.
    const status = reason === "deleted" ? "stopped" : "paused";
    for (const row of rows)
      this.#sql.exec(
        "UPDATE _dx_jobs SET status = ?, next_at = NULL, last_outcome = ? WHERE id = ?",
        status,
        reason,
        row.id,
      );
    logPluginHostCall({
      installId: meta.installId,
      host: "durable",
      tier: meta.tier,
      call: "job",
      outcome: reason,
      ms: 0,
      threadId: meta.threadId,
      detail: rows.map(({ id }) => id).join(", "),
    });
    this.#dropWatches(reason);
  }

  async #runJob(
    row: JobRow,
    install: PluginInstallRecord,
    archivedLive: boolean,
  ) {
    const meta = this.#meta as DurableMeta;
    const runId = `job_${crypto.randomUUID()}`;
    const data = parse(row.data_json);
    const started = Date.now();
    // A Stop or cancel since the alarm read the row wins.
    if (
      this.#sql.exec(
        "UPDATE _dx_jobs SET status = 'running' WHERE id = ? AND status = 'scheduled'",
        row.id,
      ).rowsWritten === 0
    )
      return;
    let outcome = "ok";
    let error: string | null = null;
    try {
      await this.#timed(() =>
        runPluginJob(
          this.#dependencies(
            install,
            { kind: "job", id: row.id, data },
            runId,
            archivedLive,
          ),
          row.id,
          runId,
          data,
          configuredTierLimits(this.env, meta.tier).callMs,
        ),
      );
    } catch (failure) {
      outcome = "failed";
      error = (
        failure instanceof Error ? failure.message : String(failure)
      ).slice(0, 500);
    }
    const ms = Date.now() - started;
    // What the code or a person changed while it ran wins: a cancel, a
    // pause, or a new schedule.
    const still = this.#sql
      .exec<{
        status: string;
        schedule_json: string;
        next_at: number | null;
        last_outcome: string | null;
      }>(
        "SELECT status, schedule_json, next_at, last_outcome FROM _dx_jobs WHERE id = ?",
        row.id,
      )
      .toArray()[0];
    if (still !== undefined) {
      const rescheduled =
        still.schedule_json !== row.schedule_json ||
        still.next_at !== row.next_at;
      const schedule = parse(still.schedule_json) as {
        every?: string;
        cron?: string;
        at?: number;
      };
      const next =
        still.status === "running" && !rescheduled
          ? schedule.every !== undefined
            ? nextJobRun(schedule, Date.now())
            : schedule.cron !== undefined
              ? nextCronTime(schedule.cron, Date.now())
              : undefined
          : (still.next_at ?? undefined);
      // A one-off that ran while its Thread was archived is done, not
      // paused: restoring must not run it again.
      const status =
        still.status === "paused" && typeof schedule.at === "number"
          ? "done"
          : still.status !== "running"
            ? still.status
            : next === undefined
              ? "done"
              : "scheduled";
      this.#sql.exec(
        `UPDATE _dx_jobs SET status = ?, next_at = ?, last_run_at = ?, last_outcome = ?,
           last_error = ?, last_ms = ?, runs = runs + 1 WHERE id = ?`,
        status,
        status === "scheduled" ? (next ?? null) : null,
        started,
        // A pause's reason and a person's Stop stay.
        status === "paused" || still.last_outcome === "stopped-by-person"
          ? still.last_outcome
          : outcome,
        error,
        ms,
        row.id,
      );
    }
    logPluginHostCall({
      requestId: runId,
      installId: meta.installId,
      host: "durable",
      tier: meta.tier,
      call: "job",
      outcome,
      ms,
      threadId: meta.threadId,
      detail: error === null ? row.id : `${row.id}: ${error}`,
    });
  }

  // ─── ctx.watch ─────────────────────────────────────────────────────────

  #watchRows() {
    return this.#sql
      .exec<{ target: string; opener_json: string }>(
        "SELECT target, opener_json FROM _dx_watches",
      )
      .toArray();
  }

  async watchOpen(meta: DurableMeta, target: string, opener: DurableOpener) {
    this.#remember(meta);
    const existing = this.#watches.get(target);
    if (existing !== undefined) {
      existing.opener = opener;
    } else {
      if (
        this.#watchRows().length >= 8 &&
        !this.#watchRows().some((row) => row.target === target)
      )
        throw new Error("A plugin keeps at most 8 watches open (quota).");
      this.#connect(target, opener);
    }
    this.#sql.exec(
      `INSERT INTO _dx_watches (target, opener_json, opened_at) VALUES (?, ?, ?)
       ON CONFLICT (target) DO UPDATE SET opener_json = excluded.opener_json`,
      target,
      json(opener),
      Date.now(),
    );
    await this.#arm();
  }

  async watchClose(meta: DurableMeta, target: string) {
    this.#remember(meta);
    this.#watches.get(target)?.close();
    this.#watches.delete(target);
    this.#sql.exec("DELETE FROM _dx_watches WHERE target = ?", target);
  }

  /** Closes the live connections, billing them; their rows stay. */
  #disconnectWatches() {
    for (const watch of this.#watches.values()) watch.close();
    this.#watches.clear();
  }

  #closeAllWatches() {
    this.#disconnectWatches();
    this.#sql.exec("DELETE FROM _dx_watches");
    this.#setWatchesHeld(false);
  }

  /**
   * Closes the watches for why the object may not run. An archived Thread
   * keeps their rows, so restoring it reconnects them; an uninstall,
   * a lower tier, or a deleted Thread ends them.
   */
  #dropWatches(reason: string) {
    if (reason !== "archived") {
      this.#closeAllWatches();
      return;
    }
    this.#disconnectWatches();
    this.#setWatchesHeld(true);
  }

  /** While held, the alarm does not check the watches every minute. */
  #setWatchesHeld(held: boolean) {
    if (held)
      this.#sql.exec(
        "INSERT INTO _dx_meta (key, value) VALUES ('watches_held', '1') ON CONFLICT (key) DO NOTHING",
      );
    else this.#sql.exec("DELETE FROM _dx_meta WHERE key = 'watches_held'");
  }

  #watchesHeld() {
    return (
      this.#sql
        .exec("SELECT 1 FROM _dx_meta WHERE key = 'watches_held'")
        .toArray().length > 0
    );
  }

  /** Reopens watches this object lost (eviction, a dropped connection). */
  async #checkWatches() {
    const rows = this.#watchRows();
    if (rows.length === 0) return;
    const admitted = await this.#admit();
    if (!admitted.ok) {
      this.#dropWatches(admitted.reason);
      return;
    }
    this.#setWatchesHeld(false);
    for (const row of rows)
      if (!this.#watches.has(row.target))
        this.#connect(row.target, parse(row.opener_json) as DurableOpener);
  }

  #connect(target: string, opener: DurableOpener) {
    const meta = this.#meta as DurableMeta;
    const controller = new AbortController();
    const watch: Watch = {
      target,
      opener,
      // The last stretch is billed before the connection goes.
      close: () => {
        if (!controller.signal.aborted)
          this.#addUsage(Date.now() - watch.billedFrom, 0);
        controller.abort();
      },
      queue: [],
      draining: false,
      dropped: 0,
      connectedAt: Date.now(),
      billedFrom: Date.now(),
      retryMs: this.#watches.get(target)?.retryMs ?? WATCH_RETRY_MS,
      messages: 0,
    };
    this.#watches.set(target, watch);
    const received = (message: unknown) => {
      watch.messages += 1;
      // A connection that stayed up a while starts its backoff over; one
      // that sends a message and drops keeps backing off.
      if (Date.now() - watch.connectedAt >= WATCH_STABLE_MS)
        watch.retryMs = WATCH_RETRY_MS;
      watch.queue.push(message);
      if (watch.queue.length > WATCH_QUEUE) {
        watch.queue.shift();
        watch.dropped += 1;
      }
      void this.#drain(watch);
    };
    const lost = (reason: string) => {
      if (controller.signal.aborted || this.#watches.get(target) !== watch)
        return;
      this.#addUsage(Date.now() - watch.billedFrom, 0);
      this.#watches.delete(target);
      logger.warn(
        `Plugin ${meta.pluginName}'s watch on ${target} closed: ${reason}.`,
        {
          event: "plugin_watch_closed",
          installId: meta.installId,
          threadId: meta.threadId,
          target,
          reason,
        },
      );
      // Reopened after a backoff, while its row says it is wanted.
      const retry = Math.min(60_000, watch.retryMs * 2);
      setTimeout(async () => {
        const row = this.#watchRows().find(
          (candidate) => candidate.target === target,
        );
        if (row === undefined || this.#watches.has(target)) return;
        // Archived: held until restore. Removed, disabled, or out of tier
        // since: closed for good.
        const admitted = await this.#admit();
        if (!admitted.ok) {
          this.#dropWatches(admitted.reason);
          return;
        }
        if (!this.#watches.has(target)) {
          this.#connect(target, parse(row.opener_json) as DurableOpener);
          const next = this.#watches.get(target);
          if (next !== undefined) next.retryMs = retry;
        }
      }, watch.retryMs);
    };
    void (async () => {
      try {
        const url = new URL(target);
        if (url.protocol === "wss:") {
          url.protocol = "https:";
          const response = await fetch(url, {
            headers: { Upgrade: "websocket", "user-agent": WATCH_USER_AGENT },
            signal: controller.signal,
            // A redirect could leave the hosts the manifest grants.
            redirect: "manual",
          });
          const socket = response.webSocket;
          if (socket === null) {
            lost(
              `the server answered HTTP ${response.status}, not a WebSocket`,
            );
            return;
          }
          socket.accept();
          controller.signal.addEventListener("abort", () =>
            socket.close(1000, "closed"),
          );
          socket.addEventListener("message", (event) =>
            received(
              typeof event.data === "string" ? tryJson(event.data) : event.data,
            ),
          );
          socket.addEventListener("close", (event) =>
            lost(`closed (${event.code})`),
          );
          socket.addEventListener("error", () => lost("error"));
          logger.info(`Plugin ${meta.pluginName} is watching ${target}.`, {
            event: "plugin_watch_opened",
            installId: meta.installId,
            threadId: meta.threadId,
            target,
            kind: "websocket",
          });
          return;
        }
        // https: a server-sent event stream.
        const response = await fetch(url, {
          headers: {
            accept: "text/event-stream",
            "user-agent": WATCH_USER_AGENT,
          },
          signal: controller.signal,
          redirect: "manual",
        });
        if (!response.ok || response.body === null) {
          lost(`the server answered HTTP ${response.status}`);
          return;
        }
        logger.info(`Plugin ${meta.pluginName} is watching ${target}.`, {
          event: "plugin_watch_opened",
          installId: meta.installId,
          threadId: meta.threadId,
          target,
          kind: "event-stream",
        });
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          for (
            let end = /\r?\n\r?\n/.exec(buffer);
            end !== null;
            end = /\r?\n\r?\n/.exec(buffer)
          ) {
            const block = buffer.slice(0, end.index);
            buffer = buffer.slice(end.index + end[0].length);
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data !== "") received(tryJson(data));
          }
          if (buffer.length > 1_048_576) buffer = "";
        }
        lost("the stream ended");
      } catch (error) {
        lost(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  /** Hands queued messages to the handler one at a time. */
  async #drain(watch: Watch) {
    if (watch.draining) return;
    watch.draining = true;
    try {
      while (
        watch.queue.length > 0 &&
        this.#watches.get(watch.target) === watch
      ) {
        const message = watch.queue.shift();
        await this.#deliver(watch, message);
      }
    } finally {
      watch.draining = false;
    }
  }

  async #deliver(watch: Watch, message: unknown) {
    const meta = this.#meta as DurableMeta;
    const admitted = await this.#admit();
    if (!admitted.ok) {
      this.#dropWatches(admitted.reason);
      return;
    }
    const requestId = `watch_${crypto.randomUUID()}`;
    const dependencies = this.#dependencies(
      admitted.install,
      watch.opener,
      requestId,
      admitted.archivedLive,
    );
    const started = Date.now();
    try {
      // Not timed: an open watch already bills its connected time, which
      // covers the handler's runs.
      let answer = await sendPluginWatchMessage(
        dependencies,
        watch.target,
        message,
      );
      if (answer.missing) {
        // The handler lived in an isolate that is gone: run what opened the
        // watch again so it registers the handler, then deliver once more.
        await this.#reopen(
          watch,
          admitted.install,
          admitted.archivedLive,
          requestId,
        );
        answer = await sendPluginWatchMessage(
          dependencies,
          watch.target,
          message,
        );
        if (answer.missing) {
          logger.warn(
            `Plugin ${meta.pluginName}'s watch on ${watch.target} has no handler; closing it.`,
            {
              event: "plugin_watch_orphaned",
              installId: meta.installId,
              target: watch.target,
            },
          );
          await this.watchClose(meta, watch.target);
          return;
        }
      }
      if (watch.messages % 50 === 1)
        logPluginHostCall({
          requestId,
          installId: meta.installId,
          host: "durable",
          tier: meta.tier,
          call: "watch",
          outcome: "ok",
          ms: Date.now() - started,
          threadId: meta.threadId,
          detail: `${watch.target} message ${watch.messages}`,
        });
    } catch (error) {
      logPluginHostCall({
        requestId,
        installId: meta.installId,
        host: "durable",
        tier: meta.tier,
        call: "watch",
        outcome: "failed",
        ms: Date.now() - started,
        threadId: meta.threadId,
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          300,
        ),
      });
    }
  }

  async #reopen(
    watch: Watch,
    install: PluginInstallRecord,
    archivedLive: boolean,
    requestId: string,
  ) {
    const meta = this.#meta as DurableMeta;
    const dependencies = this.#dependencies(
      install,
      watch.opener,
      requestId,
      archivedLive,
    );
    if (watch.opener.kind === "job")
      await runPluginJob(
        dependencies,
        watch.opener.id,
        `${requestId}:reopen`,
        watch.opener.data,
        configuredTierLimits(this.env, meta.tier).callMs,
      );
    else
      await callPluginWorkerHost(
        dependencies,
        watch.opener.fn,
        watch.opener.args,
        "worker",
      );
  }

  // ─── Lifecycle and usage ───────────────────────────────────────────────

  /** `PluginHostRuntime.status`. */
  async status() {
    const running =
      this.#watches.size > 0 ||
      this.#sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM _dx_jobs WHERE status IN ('scheduled', 'running')",
        )
        .one().count > 0;
    const since = Number(
      this.#sql
        .exec<{ value: string }>(
          "SELECT value FROM _dx_meta WHERE key = 'started_at'",
        )
        .toArray()[0]?.value ?? 0,
    );
    return { state: running ? ("running" as const) : ("cold" as const), since };
  }

  /**
   * `PluginHostRuntime.stop`: archived pauses the Thread's jobs; uninstalled,
   * idle, and limit stop them and close every watch. Storage stays until
   * the install is removed for good.
   */
  async stop(reason: "archived" | "uninstalled" | "idle" | "limit") {
    const meta = this.#meta;
    this.#sql.exec(
      "UPDATE _dx_jobs SET status = ?, next_at = NULL, last_outcome = ? WHERE status IN ('scheduled', 'running')",
      reason === "archived" ? "paused" : "stopped",
      reason,
    );
    this.#dropWatches(reason);
    await this.#flushUsageLogged(Date.now());
    // The install-wide object shows the Plugins page the pause too.
    await this.#afterJobsChanged();
    if (meta !== undefined)
      logPluginHostCall({
        installId: meta.installId,
        host: "durable",
        tier: meta.tier,
        call: "job",
        outcome: `stopped-${reason}`,
        ms: 0,
        threadId: meta.threadId,
      });
  }

  /**
   * The Thread was archived and the plugin stays live: forget the cached
   * install, whose Thread state says "not archived", so the next job run or
   * watch message reads it again and runs without posts or wakes.
   */
  async archivedLive() {
    this.#install = undefined;
  }

  /** Resumes jobs an archive paused, when the Thread is restored. */
  async resume(meta: DurableMeta) {
    // The cached install still says "archived"; read it again.
    this.#install = undefined;
    this.#remember(meta);
    this.#resumeHeld(["archived"]);
    // Watches an archive held reconnect from their rows.
    await this.#checkWatches();
    await this.#afterJobsChanged();
  }

  async #flushUsage(now: number) {
    const meta = this.#meta;
    const last = Number(
      this.#sql
        .exec<{ value: string }>(
          "SELECT value FROM _dx_meta WHERE key = 'usage_at'",
        )
        .toArray()[0]?.value ?? now,
    );
    // Watches bill while they are connected.
    for (const watch of this.#watches.values()) {
      this.#addUsage(now - watch.billedFrom, 0);
      watch.billedFrom = now;
    }
    const { activeMs, requests } = this.#pendingUsage();
    if (meta === undefined || (activeMs === 0 && requests === 0)) {
      this.#setUsageAt(now);
      return;
    }
    const storageBytes =
      this.#sql.databaseSize +
      (this.#sql
        .exec<{ total: number | null }>(
          "SELECT SUM(bytes) AS total FROM _dx_blobs",
        )
        .one().total ?? 0);
    // The counts leave only once D1 has the row: a failed write keeps them,
    // and the period's start, for the next flush.
    await recordDurableUsage(this.env.DB as D1Database, {
      meta,
      unitsMs: activeMs,
      requests,
      storageBytes,
      costMicroUsd: durableCostMicroUsd({
        activeMs,
        requests,
        storageBytes,
        periodMs: now - last,
      }),
      periodStart: last,
      periodEnd: now,
    });
    // What arrived while D1 wrote stays for the next flush.
    for (const [key, value] of [
      ["usage_ms", activeMs],
      ["usage_requests", requests],
    ] as const)
      this.#sql.exec(
        "UPDATE _dx_meta SET value = CAST(value AS INTEGER) - ? WHERE key = ?",
        value,
        key,
      );
    this.#sql.exec(
      "DELETE FROM _dx_meta WHERE key IN ('usage_ms', 'usage_requests') AND CAST(value AS INTEGER) <= 0",
    );
    this.#setUsageAt(now);
  }

  #setUsageAt(now: number) {
    this.#sql.exec(
      "INSERT INTO _dx_meta (key, value) VALUES ('usage_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(now),
    );
  }

  /** A flush whose failure is logged, not thrown: billing must not stop jobs. */
  async #flushUsageLogged(now: number) {
    try {
      await this.#flushUsage(now);
    } catch (error) {
      logger.error(
        "Durable host usage was not recorded; it is kept for the next flush.",
        {
          event: "plugin_host_usage_unwritten",
          installId: this.#meta?.installId,
          threadId: this.#meta?.threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
