import type { PluginServiceSchedule } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { pluginCallLimitMs } from "../limits.js";
import { dispatchPluginEvent } from "../worker-host/worker.js";
import { callService } from "./host.js";
import {
  actingUserOf,
  loadRunningInstall,
  type ServiceInstall,
} from "./installs.js";
import { pluginServiceLogger } from "./log.js";
import { installRecord } from "./requests.js";
import { everyMs, nextCronTime } from "./schedule-spec.js";

/**
 * Plugin schedules (wiki/plugin-platform-direction.md "Schedules and
 * listeners"), one scheduler for both runtimes. Each declared schedule has
 * a row with its next run; the Worker's minute cron claims due rows and
 * runs each: `POST /jobs/<name>` to the service when the plugin has one
 * (waking its plugin Orb), else a `job.run` event to its function code,
 * with no Orb. No model runs.
 */

/** How many due schedules one tick claims. */
const DUE_PER_TICK = 25;
/** How long one scheduled call may run. */
const JOB_TIMEOUT_MS = 5 * 60_000;

const specOf = (schedule: PluginServiceSchedule) =>
  "every" in schedule ? `every:${schedule.every}` : `cron:${schedule.cron}`;

/** The next run after `after` (epoch ms), or undefined for a bad spec. */
export const nextScheduleRun = (spec: string, after: number) => {
  if (spec.startsWith("every:")) {
    const ms = everyMs(spec.slice("every:".length));
    return ms === undefined ? undefined : after + ms;
  }
  if (spec.startsWith("cron:"))
    return nextCronTime(spec.slice("cron:".length), after);
  return undefined;
};

/**
 * Makes the install's schedule rows match its manifest: new schedules start
 * counting from now, changed ones restart, removed ones go. Unchanged rows
 * keep their next run.
 */
export const syncServiceSchedules = async (
  db: D1Database,
  install: ServiceInstall,
  now = Date.now(),
) => {
  const declared = install.code.schedules ?? [];
  const nowIso = new Date(now).toISOString();
  const statements = [
    db
      .prepare(
        `DELETE FROM plugin_service_schedule
          WHERE plugin_id = ?1
            AND name NOT IN (SELECT value FROM json_each(?2))`,
      )
      .bind(install.pluginId, JSON.stringify(declared.map(({ name }) => name))),
    ...declared.flatMap((schedule) => {
      const spec = specOf(schedule);
      const next = nextScheduleRun(spec, now);
      if (next === undefined) return [];
      return [
        db
          .prepare(
            `INSERT INTO plugin_service_schedule
               (plugin_id, name, spec, next_run_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (plugin_id, name) DO UPDATE SET
               spec = excluded.spec, next_run_at = excluded.next_run_at,
               updated_at = excluded.updated_at
             WHERE plugin_service_schedule.spec <> excluded.spec`,
          )
          .bind(
            install.pluginId,
            schedule.name,
            spec,
            new Date(next).toISOString(),
            nowIso,
          ),
      ];
    }),
  ];
  await db.batch(statements);
};

interface DueRow {
  readonly plugin_id: string;
  readonly name: string;
  readonly spec: string;
  readonly next_run_at: string;
}

const record = (
  db: D1Database,
  row: DueRow,
  status: "ok" | "failed" | "refused",
  message: string | null,
) =>
  db
    .prepare(
      `UPDATE plugin_service_schedule
          SET last_run_at = ?, last_status = ?, last_message = ?, updated_at = ?
        WHERE plugin_id = ? AND name = ?`,
    )
    .bind(
      row.next_run_at,
      status,
      message?.slice(0, 500) ?? null,
      new Date().toISOString(),
      row.plugin_id,
      row.name,
    )
    .run()
    .catch(() => undefined);

/** Runs one occurrence in the install's function code, as its person. */
const runInFunction = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
  row: DueRow,
): Promise<{ readonly ok: boolean; readonly message: string | null }> => {
  const owner = actingUserOf(install);
  if (owner === undefined)
    return { ok: false, message: "No person installed this plugin." };
  const ms = pluginCallLimitMs(install.scope);
  try {
    await dispatchPluginEvent(
      {
        db,
        bindings,
        install: installRecord(install),
        ownerUserId: owner,
        requestId: `job_${crypto.randomUUID()}`,
        ...(install.scope === "workspace"
          ? { workspaceId: install.targetId }
          : {}),
      },
      "job.run",
      { name: row.name, scheduledAt: row.next_run_at },
      ms + 5_000,
    );
    return { ok: true, message: null };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

const runSchedule = async (bindings: Bindings, db: D1Database, row: DueRow) => {
  const install = await loadRunningInstall(db, row.plugin_id);
  if (
    install === undefined ||
    !(install.code.schedules ?? []).some(({ name }) => name === row.name)
  ) {
    // Off, removed, or no longer declared: its row goes until it is back.
    await db
      .prepare(
        "DELETE FROM plugin_service_schedule WHERE plugin_id = ? AND name = ?",
      )
      .bind(row.plugin_id, row.name)
      .run();
    return;
  }
  const started = Date.now();
  if (install.code.service === undefined) {
    const ran = await runInFunction(bindings, db, install, row);
    await record(db, row, ran.ok ? "ok" : "failed", ran.message);
    pluginServiceLogger.info("Plugin schedule ran.", {
      event: "plugin_schedule",
      installId: install.pluginId,
      plugin: install.name,
      schedule: row.name,
      runtime: "function",
      outcome: ran.ok ? "ok" : "failed",
      ...(ran.message === null ? {} : { detail: ran.message.slice(0, 300) }),
      ms: Date.now() - started,
    });
    return;
  }
  const outcome = await callService(bindings, install, {
    path: `/jobs/${encodeURIComponent(row.name)}`,
    body: { scheduledAt: row.next_run_at },
    timeoutMs: JOB_TIMEOUT_MS,
  });
  const ok = outcome.ok && outcome.value.status < 400;
  const message = outcome.ok
    ? ok
      ? null
      : `The service answered ${outcome.value.status}.`
    : outcome.message;
  await record(
    db,
    row,
    outcome.ok ? (ok ? "ok" : "failed") : "refused",
    message,
  );
  pluginServiceLogger.info("Plugin schedule ran.", {
    event: "plugin_schedule",
    installId: install.pluginId,
    plugin: install.name,
    schedule: row.name,
    runtime: "service",
    outcome: outcome.ok ? (ok ? "ok" : "failed") : outcome.reason,
    ms: Date.now() - started,
  });
};

/**
 * The minute cron: claims each due schedule by its next run (compare and
 * set, so two ticks never run one occurrence twice), moves it to its next
 * run, and runs it. A missed occurrence runs once, not once per missed
 * tick.
 */
export const sweepServiceSchedules = async (
  bindings: Bindings,
  now: Date,
  waitUntil: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  const { results } = await db
    .prepare(
      `SELECT plugin_id, name, spec, next_run_at FROM plugin_service_schedule
        WHERE next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
    )
    .bind(now.toISOString(), DUE_PER_TICK)
    .all<DueRow>();
  for (const row of results) {
    const next = nextScheduleRun(row.spec, now.getTime());
    const claimed = await db
      .prepare(
        `UPDATE plugin_service_schedule SET next_run_at = ?
          WHERE plugin_id = ? AND name = ? AND next_run_at = ?`,
      )
      .bind(
        new Date(next ?? now.getTime() + 86_400_000).toISOString(),
        row.plugin_id,
        row.name,
        row.next_run_at,
      )
      .run();
    if (claimed.meta.changes === 0) continue;
    waitUntil(
      runSchedule(bindings, db, row).catch((cause: unknown) =>
        pluginServiceLogger.error("Plugin service schedule failed.", {
          event: "plugin_service_schedule",
          installId: row.plugin_id,
          schedule: row.name,
          outcome: "error",
          cause,
        }),
      ),
    );
  }
};
