import {
  THREAD_ORB_METRIC_SAMPLES,
  type ThreadOrbMetricSample,
  type ThreadOrbMetricsData,
} from "@dx/api";

/**
 * CPU, memory, and disk of a Thread's Orb over time, for its Cost & Usage
 * dialog. The daemon reports them in every heartbeat (every 2 s); this keeps
 * one sample per `SAMPLE_INTERVAL_MS` in the Thread execution object's own
 * SQLite, at most `THREAD_ORB_METRIC_SAMPLES` of them (newest kept), so a
 * read is one bounded local query: no D1 and no call to the Orb.
 */
export const SAMPLE_INTERVAL_MS = 10_000;
const PRUNE_EVERY = 60;

export interface OrbMetricReading {
  readonly cpu?: { readonly busyPercent: number };
  readonly memory?: { readonly usedBytes: number; readonly totalBytes: number };
  readonly disk?: { readonly usedBytes: number; readonly totalBytes: number };
}

interface SampleRow extends Record<string, SqlStorageValue> {
  at: number;
  cpu: number | null;
  memory_used: number | null;
  memory_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
}

const percent = (used: number | null, total: number | null) =>
  used === null || total === null || total <= 0
    ? null
    : Math.round((used / total) * 1_000) / 10;

/** The value at quantile `q` of ascending `sorted` (nearest rank). */
const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  ] ?? 0;

export class OrbMetricSamples {
  readonly #sql: SqlStorage;
  #ready = false;
  #lastAt = 0;
  #sincePrune = 0;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #ensure() {
    if (this.#ready) return;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS orb_metric_sample (
         at INTEGER PRIMARY KEY,
         cpu REAL,
         memory_used INTEGER,
         memory_total INTEGER,
         disk_used INTEGER,
         disk_total INTEGER
       )`,
    );
    this.#ready = true;
  }

  /** Keeps a heartbeat's reading when the last kept one is old enough. */
  observe(now: number, reading: OrbMetricReading) {
    if (now - this.#lastAt < SAMPLE_INTERVAL_MS) return;
    if (
      reading.cpu === undefined &&
      reading.memory === undefined &&
      reading.disk === undefined
    )
      return;
    this.#ensure();
    this.#sql.exec(
      `INSERT OR REPLACE INTO orb_metric_sample
         (at, cpu, memory_used, memory_total, disk_used, disk_total)
       VALUES (?, ?, ?, ?, ?, ?)`,
      now,
      reading.cpu?.busyPercent ?? null,
      reading.memory?.usedBytes ?? null,
      reading.memory?.totalBytes ?? null,
      reading.disk?.usedBytes ?? null,
      reading.disk?.totalBytes ?? null,
    );
    this.#lastAt = now;
    this.#sincePrune += 1;
    if (this.#sincePrune >= PRUNE_EVERY) {
      this.#sincePrune = 0;
      this.#sql.exec(
        `DELETE FROM orb_metric_sample WHERE at <= (
           SELECT at FROM orb_metric_sample ORDER BY at DESC LIMIT 1 OFFSET ?
         )`,
        THREAD_ORB_METRIC_SAMPLES,
      );
    }
  }

  /** The kept samples, oldest first, with memory percentiles over them. */
  read(): Omit<ThreadOrbMetricsData, "orbId"> {
    this.#ensure();
    const rows = this.#sql
      .exec<SampleRow>(
        `SELECT * FROM (
           SELECT at, cpu, memory_used, memory_total, disk_used, disk_total
           FROM orb_metric_sample ORDER BY at DESC LIMIT ?
         ) ORDER BY at`,
        THREAD_ORB_METRIC_SAMPLES,
      )
      .toArray();
    const samples: ThreadOrbMetricSample[] = rows.map((row) => ({
      at: row.at,
      cpuPercent: row.cpu === null ? null : Math.round(row.cpu * 10) / 10,
      memoryPercent: percent(row.memory_used, row.memory_total),
      diskPercent: percent(row.disk_used, row.disk_total),
    }));
    const memory = rows
      .filter((row) => row.memory_used !== null && row.memory_total !== null)
      .map((row) => ({
        used: row.memory_used as number,
        total: row.memory_total as number,
      }));
    const used = memory.map(({ used }) => used).sort((a, b) => a - b);
    return {
      samples,
      memory:
        used.length === 0
          ? null
          : {
              p50Bytes: quantile(used, 0.5),
              p99Bytes: quantile(used, 0.99),
              peakBytes: used[used.length - 1] ?? 0,
              totalBytes: memory[memory.length - 1]?.total ?? 0,
              samples: used.length,
            },
    };
  }
}
