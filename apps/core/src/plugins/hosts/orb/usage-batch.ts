import { getLogger } from "@logtape/logtape";
import { type PluginHostUsage, recordPluginHostUsage } from "../usage.js";

/**
 * The Orb host's usage, batched in the Thread's execution object (decision
 * D4; no D1 on the call path). Each finished call adds its time to a bucket
 * per install and outcome, kept in the object's own storage; at most once a
 * minute, and when a process is stopped, each bucket becomes one
 * `plugin_host_usage` row. A burst of calls is one row, not one per call.
 *
 * The Orb's time is already metered as the Thread's Orb, so a row costs
 * nothing more: it attributes that time to the plugin for its line on the
 * Plugins page.
 */

const logger = getLogger(["dx", "plugins", "hosts", "orb"]);

export const ORB_USAGE_FLUSH_MS = 60_000;
const PENDING = "orb-plugin-usage";

/** Who an install's usage is charged to; sent with each call. */
export interface OrbUsageBilling {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly scope: "personal" | "workspace" | "repository";
  readonly workspaceId?: string;
  readonly ownerUserId: string;
  /** The Thread whose Orb ran the call. */
  readonly threadId?: string;
}

interface Bucket {
  readonly billing: OrbUsageBilling;
  readonly outcome: PluginHostUsage["outcome"];
  unitsMs: number;
  requests: number;
  periodStart: number;
  periodEnd: number;
}

export class OrbUsageBatch {
  readonly #storage: DurableObjectStorage;
  readonly #db: () => D1Database | undefined;
  readonly #waitUntil: (promise: Promise<unknown>) => void;
  #pending: Record<string, Bucket> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(input: {
    readonly storage: DurableObjectStorage;
    readonly db: () => D1Database | undefined;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  }) {
    this.#storage = input.storage;
    this.#db = input.db;
    this.#waitUntil = input.waitUntil;
  }

  /**
   * Every record and flush runs here one at a time, so none reads the
   * batch, awaits, and writes back over what another added meanwhile.
   */
  #queue: Promise<unknown> = Promise.resolve();

  #serially<A>(work: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #load() {
    this.#pending ??=
      (await this.#storage.get<Record<string, Bucket>>(PENDING)) ?? {};
    return this.#pending;
  }

  /** Adds a bucket's counts into the batch under its key. */
  static #merge(into: Record<string, Bucket>, key: string, bucket: Bucket) {
    const current = into[key];
    if (current === undefined) {
      into[key] = { ...bucket };
      return;
    }
    current.unitsMs += bucket.unitsMs;
    current.requests += bucket.requests;
    current.periodStart = Math.min(current.periodStart, bucket.periodStart);
    current.periodEnd = Math.max(current.periodEnd, bucket.periodEnd);
  }

  /** Adds one finished call; never throws, never touches D1. */
  record(
    billing: OrbUsageBilling,
    outcome: PluginHostUsage["outcome"],
    started: number,
    ended: number,
  ) {
    this.#waitUntil(
      this.#serially(async () => {
        const pending = await this.#load();
        OrbUsageBatch.#merge(pending, `${billing.pluginId}:${outcome}`, {
          billing,
          outcome,
          unitsMs: Math.max(0, ended - started),
          requests: 1,
          periodStart: started,
          periodEnd: ended,
        });
        await this.#storage.put(PENDING, pending);
        // A batch whose timer was lost (the object slept) goes out now.
        if (
          Object.values(pending).some(
            ({ periodStart }) => ended - periodStart >= ORB_USAGE_FLUSH_MS,
          )
        ) {
          clearTimeout(this.#timer);
          this.#timer = undefined;
          await this.#flushNow("minute");
          return;
        }
        // The first call of a batch starts its minute.
        this.#timer ??= setTimeout(() => {
          this.#timer = undefined;
          this.#waitUntil(this.flush("minute"));
        }, ORB_USAGE_FLUSH_MS);
      }).catch(() => undefined),
    );
  }

  /** Writes every bucket as one row each; a failed row stays for the next. */
  flush(reason: "minute" | "stopped") {
    return this.#serially(() => this.#flushNow(reason));
  }

  async #flushNow(reason: "minute" | "stopped") {
    const pending = await this.#load();
    const buckets = Object.entries(pending);
    if (buckets.length === 0) return;
    const db = this.#db();
    if (db === undefined) return;
    this.#pending = {};
    await this.#storage.put(PENDING, this.#pending);
    const written = await Promise.allSettled(
      buckets.map(([, bucket]) =>
        recordPluginHostUsage(db, {
          ...bucket.billing,
          host: "orb",
          unitsMs: bucket.unitsMs,
          requests: bucket.requests,
          costMicroUsd: 0,
          outcome: bucket.outcome,
          periodStart: bucket.periodStart,
          periodEnd: bucket.periodEnd,
        }),
      ),
    );
    const failed = buckets.filter(
      (_, index) => written[index]?.status === "rejected",
    );
    if (failed.length > 0) {
      // Merged into the batch as it is now, never written over it.
      const current = await this.#load();
      for (const [key, bucket] of failed)
        OrbUsageBatch.#merge(current, key, bucket);
      await this.#storage.put(PENDING, current);
    }
    logger.info("Orb plugin usage flushed.", {
      event: "plugin_orb_usage_flushed",
      reason,
      rows: buckets.length - failed.length,
      failedRows: failed.length,
      requests: buckets.reduce((sum, [, bucket]) => sum + bucket.requests, 0),
      unitsMs: buckets.reduce((sum, [, bucket]) => sum + bucket.unitsMs, 0),
      installIds: [...new Set(buckets.map(([, b]) => b.billing.pluginId))],
    });
  }
}
