import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import "../../../logging.js";
import { type PluginHostUsage, recordPluginHostUsage } from "../usage.js";
import {
  PLUGIN_CONTAINER_APT,
  PLUGIN_CONTAINER_INSTANCE,
  PLUGIN_CONTAINER_MAX_RUNNING,
  type PluginContainerCaps,
  pluginContainerCostMicroUsd,
} from "./limits.js";

/**
 * One plugin install's container: the `container` plugin host. It runs in
 * the Orb Worker beside the Orb and executor container objects, bound to its
 * own container application with the `plugin` image
 * (deploy/plugin-container). Core addresses it by install ID and calls
 * {@link PluginContainerObject.invoke} once per plugin call.
 *
 * - **Isolation:** the container starts with no internet. Plugin code
 *   reaches dx, and the hosts its manifest grants, only through the
 *   `PluginHost` capability object Core passes with each call, the same one
 *   the Worker host gets; each `ctx` call crosses back over RPC.
 * - **Code:** the install's modules are written once per integrity, read
 *   through Core's `loadCode` callback only when the container lacks them.
 * - **Binaries:** `apt` entries are baked into the image; `url` entries are
 *   downloaded here (never by the container), checked against `sha256`.
 * - **Caps:** wall time per call, calls at once, and container time per
 *   UTC day and month, counted in this object's own storage, so no call
 *   reads D1 to check them.
 * - **Billing:** container time and calls add up in this object's storage,
 *   per caller and outcome, and are written to `plugin_host_usage` (bound
 *   as `DB`) at most once a minute and when the container stops, so no
 *   call writes D1 on its own path. The idle minute before a stop is billed
 *   to whoever called last.
 */

const logger = getLogger(["dx", "plugins", "hosts", "container"]);

const CODE_ROOT = "/srv/plugin";
const BIN_ROOT = "/srv/bin";
const READY_MS = 90_000;
const HEARTBEAT_MS = 10_000;
const STDERR_BYTES = 64 * 1024;
const RUNNER = "/opt/dx/runner.mjs";

/** The methods of the capability object the runner may call. */
const HOST_METHODS = new Set([
  "log",
  "storageGet",
  "storageSet",
  "storageDelete",
  "storageList",
  "settings",
  "threadInfo",
  "threadMessages",
  "threadPost",
  "createThread",
  "fetch",
  "secret",
  "generate",
]);

interface Process {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

interface Runtime {
  readonly running: boolean;
  readonly images?: Readonly<Record<string, string>>;
  start(options: {
    readonly image?: string;
    readonly instance: string;
    readonly enableInternet: boolean;
  }): void;
  exec(
    command: string[],
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: ReadableStream;
      readonly stdout?: "pipe";
      readonly stderr?: "pipe";
    },
  ): Promise<Process>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

/** A `binaries` entry, as the manifest declares it. */
export interface PluginContainerBinary {
  readonly name: string;
  readonly apt?: string;
  readonly url?: string;
  readonly sha256?: string;
  /** With `url`: the file inside the downloaded archive. */
  readonly path?: string;
}

/** What Core sends with each call. */
export interface PluginContainerRequest {
  readonly requestId: string;
  readonly installId: string;
  readonly integrity: string;
  /** The container module's path among the install's modules. */
  readonly entry: string;
  readonly call: {
    readonly kind: string;
    readonly fn?: string;
    readonly args?: unknown;
  };
  /** The call's `PluginCallInfo` plus its tier, as the runner's ctx sees it. */
  readonly info: unknown;
  readonly binaries: ReadonlyArray<PluginContainerBinary>;
  readonly caps: PluginContainerCaps;
  readonly billing: PluginContainerBilling;
}

/** Who a call's container time is charged to. */
export type PluginContainerBilling = Pick<
  PluginHostUsage,
  | "pluginId"
  | "pluginName"
  | "scope"
  | "workspaceId"
  | "ownerUserId"
  | "threadId"
>;

interface PendingUsage {
  readonly billing: PluginContainerBilling;
  readonly outcome: PluginHostUsage["outcome"];
  unitsMs: number;
  requests: number;
  periodStart: number;
  periodEnd: number;
}

/** The capability object's methods, as an RPC stub. */
type HostStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

export type PluginContainerOutcome =
  | "success"
  | "error"
  | "timeout"
  | "over-cap"
  | "unavailable";

export interface PluginContainerResult {
  readonly outcome: PluginContainerOutcome;
  readonly value?: unknown;
  readonly error?: string;
  /** Container time this call is charged, idle time before it included. */
  readonly billedMs: number;
  /** Whether this call started the container. */
  readonly cold: boolean;
  readonly startMs?: number;
  /** Container time this install used today and this month, after the call. */
  readonly usedTodayMs: number;
  readonly usedMonthMs: number;
  /** Time this install's calls ran today and this month, after the call. */
  readonly ranTodayMs: number;
  readonly ranMonthMs: number;
  /** How long this call's code ran. */
  readonly runMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (bytes: ArrayBuffer | Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

const dayKey = (ms: number) =>
  `used:day:${new Date(ms).toISOString().slice(0, 10)}`;
const ranDayKey = (ms: number) =>
  `ran:day:${new Date(ms).toISOString().slice(0, 10)}`;
const ranMonthKey = (ms: number) =>
  `ran:month:${new Date(ms).toISOString().slice(0, 7)}`;
const monthKey = (ms: number) =>
  `used:month:${new Date(ms).toISOString().slice(0, 7)}`;
const PENDING = "pending-usage";
const LAST_BILLING = "last-billing";
const LAST_FLUSH = "last-flush";
const LAST_USE = "last-use";
const FLUSH_MS = 60_000;

const usageOutcome = (
  outcome: PluginContainerOutcome,
): PluginHostUsage["outcome"] =>
  outcome === "success"
    ? "success"
    : outcome === "over-cap"
      ? "blocked"
      : "error";

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

/** Splits a byte stream into lines. */
async function* linesOf(stream: ReadableStream<Uint8Array>) {
  const reader = stream
    .pipeThrough(
      new TextDecoderStream() as unknown as ReadableWritablePair<
        string,
        Uint8Array
      >,
    )
    .getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer !== "") yield buffer;
}

const tail = async (stream: ReadableStream<Uint8Array> | null) => {
  if (stream === null) return "";
  let text = "";
  for await (const line of linesOf(stream)) {
    text += `${line}\n`;
    if (text.length > STDERR_BYTES) text = text.slice(-STDERR_BYTES);
  }
  return text;
};

export class PluginContainerObject extends DurableObject {
  readonly #container: Runtime;
  #ready: Promise<{ cold: boolean; startMs?: number }> | undefined;
  /** When container time was last added to the payer's ledger; 0 stopped. */
  #ledgerAt = 0;
  /** When container time was last reported, or 0 while stopped. */
  #accountedAt = 0;
  #startedAt = 0;
  #lastUse = 0;
  #running = 0;
  readonly #queue: Array<(granted: boolean) => void> = [];
  /** When each call running now started its code. */
  readonly #runningSince = new Set<number>();
  /** Set while the container stops, so no call starts on a dying one. */
  #stopping: Promise<void> | undefined;
  /** Integrities whose code (and binaries) the running container holds. */
  readonly #installed = new Map<string, Promise<void>>();

  readonly #db: D1Database | undefined;
  readonly #namespace:
    | DurableObjectNamespace<PluginContainerObject>
    | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const bindings = env as
      | {
          readonly DB?: D1Database;
          readonly PLUGIN_CONTAINER?: DurableObjectNamespace<PluginContainerObject>;
        }
      | undefined;
    this.#db = bindings?.DB;
    this.#namespace = bindings?.PLUGIN_CONTAINER;
    const container = ctx.container as unknown as Runtime | undefined;
    if (container === undefined)
      throw new Error("The plugin container object has no container binding.");
    this.#container = container;
  }

  async status(): Promise<{
    state: "cold" | "starting" | "running" | "stopped";
    since: number;
  }> {
    if (this.#container.running)
      return this.#ready === undefined || this.#startedAt === 0
        ? { state: "starting", since: Date.now() }
        : { state: "running", since: this.#startedAt };
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE)) ?? 0;
    return lastUse === 0
      ? { state: "cold", since: 0 }
      : { state: "stopped", since: lastUse };
  }

  async stop(reason: "archived" | "uninstalled" | "idle" | "limit") {
    await this.#halt(reason);
    if (reason === "uninstalled") await this.ctx.storage.deleteAll();
  }

  async invoke(
    request: PluginContainerRequest,
    host: HostStub,
    loadCode: () => Promise<Record<string, string>>,
  ): Promise<PluginContainerResult> {
    const refused = await this.#refusal(request);
    if (refused !== undefined) return refused;
    if (!(await this.#acquire(request.caps))) {
      await this.#charge(request.billing, "blocked", 0, 1, Date.now());
      this.ctx.waitUntil(this.#flushIfDue());
      const used = await this.#used(Date.now());
      return {
        outcome: "over-cap",
        error: `This plugin's container is busy with ${request.caps.concurrentCalls} calls and a full queue.`,
        billedMs: 0,
        cold: false,
        usedTodayMs: used.today,
        usedMonthMs: used.month,
        ranTodayMs: used.ranToday,
        ranMonthMs: used.ranMonth,
      };
    }
    // Calls that waited in the queue are checked again, with the time the
    // calls ahead of them are using now.
    const late = await this.#refusal(request);
    if (late !== undefined) {
      this.#release();
      return late;
    }
    // A container that is not running needs one of the deployment's slots.
    if (!this.#container.running && !(await this.#slot())) {
      this.#release();
      await this.#charge(request.billing, "blocked", 0, 1, Date.now());
      this.ctx.waitUntil(this.#flushIfDue());
      const used = await this.#used(Date.now());
      return {
        outcome: "over-cap",
        error: `dx is running its most plugin containers (${PLUGIN_CONTAINER_MAX_RUNNING}) right now; try again shortly.`,
        billedMs: 0,
        cold: false,
        usedTodayMs: used.today,
        usedMonthMs: used.month,
        ranTodayMs: used.ranToday,
        ranMonthMs: used.ranMonth,
      };
    }
    let outcome: PluginContainerOutcome = "error";
    let value: unknown;
    let error: string | undefined;
    let start: { cold: boolean; startMs?: number } = { cold: false };
    let runMs = 0;
    let ended = 0;
    let billed: { ms: number; today: number; month: number };
    let ranCalls: { today: number; month: number };
    try {
      try {
        this.#lastUse = Date.now();
        start = await this.#use(request.caps);
        await this.#install(request, loadCode);
        const ran = await this.#run(request, host);
        outcome = ran.outcome;
        value = ran.value;
        error = ran.error;
        runMs = ran.runMs;
      } catch (caught) {
        outcome = "unavailable";
        error = errorText(caught);
      }
      ended = Date.now();
      this.#lastUse = ended;
      billed = await this.#account(ended);
      ranCalls = await this.#addRun(ended, runMs);
      await this.#ledgerSync(request.billing, ended);
    } finally {
      // Only once this call's time is saved: a queued call checks the caps
      // as it takes the slot, and must see it.
      this.#release();
    }
    await this.#charge(
      request.billing,
      usageOutcome(outcome),
      billed.ms,
      1,
      ended - billed.ms,
    );
    this.ctx.waitUntil(this.#flushIfDue());
    return {
      outcome,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
      billedMs: billed.ms,
      cold: start.cold,
      ...(start.startMs === undefined ? {} : { startMs: start.startMs }),
      usedTodayMs: billed.today,
      usedMonthMs: billed.month,
      ranTodayMs: ranCalls.today,
      ranMonthMs: ranCalls.month,
      runMs,
    };
  }

  /** Adds a call's run time to today's and this month's call time. */
  async #addRun(now: number, runMs: number) {
    const used = await this.#used(now);
    const today = used.ranToday + runMs;
    const month = used.ranMonth + runMs;
    await this.ctx.storage.put({
      [ranDayKey(now)]: today,
      [ranMonthKey(now)]: month,
    });
    return { today, month };
  }

  /**
   * An over-cap answer when today's or this month's call time is used up,
   * or the container-time backstop is reached.
   */
  async #refusal(
    request: PluginContainerRequest,
  ): Promise<PluginContainerResult | undefined> {
    const now = Date.now();
    const used = await this.#used(now);
    // Time the running container has used since it was last accounted, and
    // time the calls running now have run so far.
    const inFlight =
      this.#container.running && this.#accountedAt !== 0
        ? Math.max(0, now - this.#accountedAt)
        : 0;
    let running = 0;
    for (const started of this.#runningSince) running += now - started;
    const caps = request.caps;
    const multiple = Math.max(1, caps.containerTimeMultiple);
    const limits = [
      [
        used.ranToday + running >= caps.dailyMs,
        "call time for the day",
        caps.dailyMs,
      ],
      [
        used.ranMonth + running >= caps.monthlyMs,
        "call time for the month",
        caps.monthlyMs,
      ],
      [
        used.today + inFlight >= caps.dailyMs * multiple,
        "container time for the day",
        caps.dailyMs * multiple,
      ],
      [
        used.month + inFlight >= caps.monthlyMs * multiple,
        "container time for the month",
        caps.monthlyMs * multiple,
      ],
    ] as const;
    let reached: readonly [boolean, string, number] | undefined = limits.find(
      ([over]) => over,
    );
    if (reached === undefined) {
      // All of the payer workspace's installs together, with this
      // container's time not yet added to the ledger.
      const workspaceUsed = await this.#ledger(request.billing)
        ?.ledgerUsed(now)
        .catch(() => 0);
      if (
        workspaceUsed !== undefined &&
        workspaceUsed +
          (this.#container.running && this.#ledgerAt !== 0
            ? Math.max(0, now - this.#ledgerAt)
            : 0) >=
          caps.workspaceDailyMs
      )
        reached = [
          true,
          "workspace's container time for the day",
          caps.workspaceDailyMs,
        ];
    }
    if (reached === undefined) return undefined;
    await this.#charge(request.billing, "blocked", 0, 1, now);
    this.ctx.waitUntil(this.#flushIfDue());
    return {
      outcome: "over-cap",
      error: reached[1].startsWith("workspace")
        ? `This workspace's plugins used their container time for the day (${Math.round(reached[2] / 60_000)} minutes).`
        : `This plugin used its ${reached[1]} (${Math.round(reached[2] / 60_000)} minutes).`,
      billedMs: 0,
      cold: false,
      usedTodayMs: used.today + inFlight,
      usedMonthMs: used.month + inFlight,
      ranTodayMs: used.ranToday + running,
      ranMonthMs: used.ranMonth + running,
    };
  }

  /**
   * The workspace ledger: one instance of this class per payer workspace
   * (`ledger:<workspace>`, or `ledger:user:<id>` for a person in no
   * workspace) that never starts a container. Each install's object asks it
   * before a call and adds its container time after, so the day's total
   * across all of a workspace's installs needs no D1 read.
   */
  async ledgerUsed(now: number): Promise<number> {
    return (await this.ctx.storage.get<number>(dayKey(now))) ?? 0;
  }

  async ledgerAdd(now: number, ms: number): Promise<number> {
    const total = (await this.ledgerUsed(now)) + Math.max(0, ms);
    await this.ctx.storage.put(dayKey(now), total);
    return total;
  }

  /**
   * The deployment's running-container slots (on `ledger:deployment`): an
   * install's container holds one from its start, refreshed by each
   * heartbeat, until it stops. A slot not refreshed for a minute (a
   * container that died unseen) is free again.
   */
  async ledgerSlot(holder: string, now: number, max: number) {
    const slots =
      (await this.ctx.storage.get<Record<string, number>>("slots")) ?? {};
    for (const [key, seen] of Object.entries(slots))
      if (now - seen > 60_000) delete slots[key];
    const granted = holder in slots || Object.keys(slots).length < max;
    if (granted) slots[holder] = now;
    await this.ctx.storage.put("slots", slots);
    return { granted, running: Object.keys(slots).length };
  }

  async ledgerSlotRelease(holder: string) {
    const slots =
      (await this.ctx.storage.get<Record<string, number>>("slots")) ?? {};
    delete slots[holder];
    await this.ctx.storage.put("slots", slots);
  }

  #deploymentLedger() {
    const namespace = this.#namespace;
    return namespace?.get(namespace.idFromName("ledger:deployment"));
  }

  /** Takes or refreshes this container's slot; fails open if unreachable. */
  async #slot() {
    const ledger = this.#deploymentLedger();
    if (ledger === undefined) return true;
    return ledger
      .ledgerSlot(
        this.ctx.id.toString(),
        Date.now(),
        PLUGIN_CONTAINER_MAX_RUNNING,
      )
      .then((slot) => slot.granted)
      .catch(() => true);
  }

  #ledger(billing: PluginContainerBilling) {
    const namespace = this.#namespace;
    if (namespace === undefined) return undefined;
    const key =
      billing.workspaceId === undefined
        ? `ledger:user:${billing.ownerUserId}`
        : `ledger:${billing.workspaceId}`;
    return namespace.get(namespace.idFromName(key));
  }

  /** Adds container time to the payer's ledger; never fails the call. */
  /**
   * Adds the container time since the last sync to the payer's ledger: after
   * each call, on every heartbeat while running, and at the stop, so other
   * installs see this one's running time within a heartbeat.
   */
  async #ledgerSync(billing: PluginContainerBilling, now: number) {
    if (this.#ledgerAt === 0) return;
    const ms = now - this.#ledgerAt;
    this.#ledgerAt = now;
    await this.#ledgerAdd(billing, now, ms);
  }

  async #ledgerAdd(billing: PluginContainerBilling, now: number, ms: number) {
    if (ms <= 0) return;
    await this.#ledger(billing)
      ?.ledgerAdd(now, ms)
      .catch((error: unknown) =>
        logger.warn("The workspace container ledger was not updated.", {
          event: "plugin_container_ledger_failed",
          error: errorText(error),
        }),
      );
  }

  /**
   * A call Core refused before it reached the container (the tier): counted
   * with the install's other usage, written with the next flush.
   */
  async recordBlocked(billing: PluginContainerBilling) {
    await this.#charge(billing, "blocked", 0, 1, Date.now());
    await this.#flushIfDue();
  }

  override async alarm() {
    if (!this.#container.running) {
      // It stopped on its own (a crash, or the backstop timeout): bill the
      // time since the last account to the last caller, then flush.
      await this.#halt("exited");
      return;
    }
    await this.#flushIfDue();
    await this.#slot();
    const last =
      await this.ctx.storage.get<PluginContainerBilling>(LAST_BILLING);
    if (last !== undefined) await this.#ledgerSync(last, Date.now());
    const idleMs = (await this.ctx.storage.get<number>("idle-ms")) ?? 60_000;
    if (this.#running === 0 && Date.now() - this.#lastUse >= idleMs) {
      await this.#halt("idle");
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  /** Container time and call time this install used today and this month. */
  async #used(now: number) {
    const [today, month, ranToday, ranMonth] = await Promise.all([
      this.ctx.storage.get<number>(dayKey(now)),
      this.ctx.storage.get<number>(monthKey(now)),
      this.ctx.storage.get<number>(ranDayKey(now)),
      this.ctx.storage.get<number>(ranMonthKey(now)),
    ]);
    return {
      today: today ?? 0,
      month: month ?? 0,
      ranToday: ranToday ?? 0,
      ranMonth: ranMonth ?? 0,
    };
  }

  /**
   * Container time since the last account, added to today's and this
   * month's totals; the caller charges it.
   */
  async #account(now: number) {
    const from = this.#accountedAt === 0 ? now : this.#accountedAt;
    const ms = Math.max(0, now - from);
    this.#accountedAt = this.#container.running ? now : 0;
    const used = await this.#used(now);
    const today = used.today + ms;
    const month = used.month + ms;
    await this.ctx.storage.put({
      [dayKey(now)]: today,
      [monthKey(now)]: month,
      [LAST_USE]: now,
    });
    return { ms, today, month };
  }

  /** Adds usage to the pending batch, per caller and outcome. */
  async #charge(
    billing: PluginContainerBilling,
    outcome: PluginHostUsage["outcome"],
    unitsMs: number,
    requests: number,
    periodStart: number,
  ) {
    const pending =
      (await this.ctx.storage.get<Record<string, PendingUsage>>(PENDING)) ?? {};
    const key = `${billing.ownerUserId}|${billing.threadId ?? ""}|${outcome}`;
    const now = Date.now();
    const entry = pending[key] ?? {
      billing,
      outcome,
      unitsMs: 0,
      requests: 0,
      periodStart,
      periodEnd: now,
    };
    entry.unitsMs += unitsMs;
    entry.requests += requests;
    entry.periodStart = Math.min(entry.periodStart, periodStart);
    entry.periodEnd = Math.max(entry.periodEnd, now);
    pending[key] = entry;
    await this.ctx.storage.put({ [PENDING]: pending, [LAST_BILLING]: billing });
  }

  async #hasPending() {
    const pending =
      await this.ctx.storage.get<Record<string, PendingUsage>>(PENDING);
    return pending !== undefined && Object.keys(pending).length > 0;
  }

  async #flushIfDue() {
    const last = (await this.ctx.storage.get<number>(LAST_FLUSH)) ?? 0;
    if (Date.now() - last >= FLUSH_MS) {
      await this.#flush();
      return;
    }
    // Not due yet, and no running container's heartbeat will come back to
    // it: wake when it is due, so the batch is never left behind.
    if (!this.#container.running && (await this.#hasPending()))
      await this.ctx.storage.setAlarm(last + FLUSH_MS);
  }

  /** Writes the pending batch to `plugin_host_usage`: one row per bucket. */
  async #flush() {
    const pending =
      await this.ctx.storage.get<Record<string, PendingUsage>>(PENDING);
    await this.ctx.storage.put(LAST_FLUSH, Date.now());
    if (pending === undefined || Object.keys(pending).length === 0) return;
    // Taken out of storage while it is written; put back if the write fails.
    await this.ctx.storage.delete(PENDING);
    const db = this.#db;
    if (db === undefined) {
      logger.warn("Plugin container usage has no database to go to.", {
        event: "plugin_container_usage_unrecorded",
        buckets: Object.keys(pending).length,
      });
      return;
    }
    const rows = Object.values(pending);
    const written = await Promise.allSettled(
      rows.map((entry) =>
        recordPluginHostUsage(db, {
          ...entry.billing,
          host: "container",
          instance: PLUGIN_CONTAINER_INSTANCE,
          unitsMs: entry.unitsMs,
          requests: entry.requests,
          costMicroUsd: pluginContainerCostMicroUsd(entry.unitsMs),
          outcome: entry.outcome,
          periodStart: entry.periodStart,
          periodEnd: entry.periodEnd,
        }),
      ),
    );
    const failed = rows.filter(
      (_, index) => written[index]?.status === "rejected",
    );
    if (failed.length > 0) {
      for (const entry of failed)
        await this.#charge(
          entry.billing,
          entry.outcome,
          entry.unitsMs,
          entry.requests,
          entry.periodStart,
        );
      logger.warn(
        "Plugin container usage was not written; kept for the next flush.",
        {
          event: "plugin_container_usage_retry",
          installId: rows[0]?.billing.pluginId,
          rows: failed.length,
        },
      );
      if (!this.#container.running)
        await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
      return;
    }
    logger.info("Plugin container usage flushed.", {
      event: "plugin_container_usage_flushed",
      installId: rows[0]?.billing.pluginId,
      rows: rows.length,
      unitsMs: rows.reduce((sum, entry) => sum + entry.unitsMs, 0),
      requests: rows.reduce((sum, entry) => sum + entry.requests, 0),
    });
  }

  /**
   * A slot among the calls that run at once. At most four times as many
   * wait, each at most a call's time; false when the queue is full or the
   * wait ran out.
   */
  async #acquire(caps: PluginContainerCaps): Promise<boolean> {
    const limit = Math.max(1, caps.concurrentCalls);
    if (this.#running < limit && this.#queue.length === 0) {
      this.#running += 1;
      return true;
    }
    if (this.#queue.length >= limit * 4) return false;
    return new Promise<boolean>((resolve) => {
      const waiter = (granted: boolean) => {
        clearTimeout(timer);
        resolve(granted);
      };
      const timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        resolve(false);
      }, caps.callMs);
      this.#queue.push(waiter);
    });
  }

  /** Hands the slot straight to the next waiting call, or frees it. */
  #release() {
    const next = this.#queue.shift();
    if (next === undefined) this.#running -= 1;
    else next(true);
  }

  /** Starts the container if it is down; `cold` only for the call that started it. */
  async #use(caps: PluginContainerCaps) {
    if (this.#stopping !== undefined) await this.#stopping;
    if (this.#ready !== undefined && this.#container.running) {
      await this.#ready;
      return { cold: false };
    }
    this.#installed.clear();
    // A running container this object lost track of (a restart) is warm;
    // its time is billed from now.
    if (this.#container.running) {
      const now = Date.now();
      this.#startedAt = now;
      this.#accountedAt = now;
      this.#ledgerAt = now;
    }
    this.#ready = this.#container.running
      ? this.ctx.storage
          .setAlarm(Date.now() + HEARTBEAT_MS)
          .then(() => ({ cold: false }))
      : this.#start(caps);
    this.#ready.catch(() => {
      this.#ready = undefined;
    });
    return this.#ready;
  }

  async #start(caps: PluginContainerCaps) {
    const started = Date.now();
    const image = this.#container.images?.plugin;
    this.#container.start({
      ...(image === undefined ? {} : { image }),
      instance: PLUGIN_CONTAINER_INSTANCE,
      enableInternet: false,
    });
    let lastError: unknown;
    for (;;) {
      if (Date.now() - started > READY_MS)
        throw new Error(
          `The plugin container did not start: ${errorText(lastError)}`,
        );
      try {
        const probe = await this.#container.exec(["/bin/true"]);
        if ((await probe.exitCode) === 0) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    this.#startedAt = started;
    this.#accountedAt = started;
    this.#ledgerAt = started;
    // A backstop: this object stops the container itself after idleMs.
    await this.#container.setInactivityTimeout(caps.idleMs + 5 * 60_000);
    await this.ctx.storage.put("idle-ms", caps.idleMs);
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const startMs = Date.now() - started;
    logger.info("Plugin container started.", {
      event: "plugin_container_started",
      instance: PLUGIN_CONTAINER_INSTANCE,
      startMs,
    });
    return { cold: true, startMs };
  }

  /** Stops the container, one stop at a time; calls wait for it. */
  #halt(reason: string) {
    this.#stopping ??= this.#haltNow(reason).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #haltNow(reason: string) {
    this.#ready = undefined;
    this.#installed.clear();
    await this.#deploymentLedger()
      ?.ledgerSlotRelease(this.ctx.id.toString())
      .catch(() => undefined);
    const running = this.#container.running;
    {
      const now = Date.now();
      if (this.#accountedAt !== 0) {
        // The idle time before the stop, charged to the last caller.
        const tailMs = now - this.#accountedAt;
        const used = await this.#used(now);
        await this.ctx.storage.put({
          [dayKey(now)]: used.today + tailMs,
          [monthKey(now)]: used.month + tailMs,
        });
        const last =
          await this.ctx.storage.get<PluginContainerBilling>(LAST_BILLING);
        if (last !== undefined) {
          await this.#charge(last, "success", tailMs, 0, this.#accountedAt);
          await this.#ledgerSync(last, now);
        }
      }
      if (running) await this.#container.destroy().catch(() => undefined);
      if (running || this.#startedAt !== 0)
        logger.info("Plugin container stopped.", {
          event: "plugin_container_stopped",
          reason,
          ranMs: this.#startedAt === 0 ? undefined : now - this.#startedAt,
        });
    }
    this.#accountedAt = 0;
    this.#ledgerAt = 0;
    this.#startedAt = 0;
    await this.ctx.storage.deleteAlarm();
    await this.#flush();
  }

  async #exec(
    command: string[],
    stdin?: Uint8Array,
  ): Promise<{ exitCode: number; stderr: string }> {
    const process = await this.#container.exec(command, {
      // The container's exec takes stdin only as a stream.
      ...(stdin === undefined ? {} : { stdin: streamOf(stdin) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, , stderr] = await Promise.all([
      process.exitCode,
      process.stdout?.cancel(),
      tail(process.stderr),
    ]);
    return { exitCode, stderr };
  }

  async #writeFile(path: string, content: Uint8Array, mode = "0644") {
    const result = await this.#exec(
      [
        "/bin/sh",
        "-c",
        'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && chmod "$2" "$1"',
        "sh",
        path,
        mode,
      ],
      content,
    );
    if (result.exitCode !== 0)
      throw new Error(`Writing ${path} failed: ${result.stderr.trim()}`);
  }

  /** The install's code and binaries, once per integrity per container. */
  #install(
    request: PluginContainerRequest,
    loadCode: () => Promise<Record<string, string>>,
  ) {
    let installing = this.#installed.get(request.integrity);
    if (installing === undefined) {
      installing = this.#installNow(request, loadCode);
      this.#installed.set(request.integrity, installing);
      installing.catch(() => this.#installed.delete(request.integrity));
    }
    return installing;
  }

  async #installNow(
    request: PluginContainerRequest,
    loadCode: () => Promise<Record<string, string>>,
  ) {
    const root = await this.#root(request.integrity);
    const marker = `${root}/.dx-ready`;
    const present = await this.#exec(["/usr/bin/test", "-f", marker]);
    if (present.exitCode !== 0) {
      const files = await loadCode();
      for (const [path, source] of Object.entries(files)) {
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw new Error(`The module path ${path} is not allowed.`);
        await this.#writeFile(`${root}/${path}`, encoder.encode(source));
      }
      await this.#writeFile(
        `${root}/package.json`,
        encoder.encode('{"type":"module"}\n'),
      );
      await this.#writeFile(marker, new Uint8Array());
    }
    for (const binary of request.binaries)
      await this.#binary(binary, request.caps);
  }

  async #root(integrity: string) {
    return `${CODE_ROOT}/${(await sha256Hex(encoder.encode(integrity))).slice(0, 32)}`;
  }

  async #binary(binary: PluginContainerBinary, caps: PluginContainerCaps) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(binary.name))
      throw new Error(`The binary name ${binary.name} is not allowed.`);
    if (binary.url === undefined) {
      if (binary.path !== undefined)
        throw new Error(
          `The binary ${binary.name} is a file in the plugin; the container host runs apt and url binaries only.`,
        );
      if (binary.apt !== undefined && !PLUGIN_CONTAINER_APT.has(binary.apt))
        throw new Error(
          `The apt package ${binary.apt} is not in the plugin container image.`,
        );
      const found = await this.#exec([
        "/bin/sh",
        "-c",
        'command -v -- "$1" > /dev/null',
        "sh",
        binary.name,
      ]);
      if (found.exitCode !== 0)
        throw new Error(
          `The binary ${binary.name} is not in the plugin container image.`,
        );
      return;
    }
    const target = `${BIN_ROOT}/${binary.name}`;
    if (binary.sha256 === undefined || !/^[0-9a-f]{64}$/.test(binary.sha256))
      throw new Error(`The binary ${binary.name} needs a sha256 to download.`);
    // Kept by the archive's or file's sha256, so an update that changes it
    // downloads again.
    const marker = `${BIN_ROOT}/.${binary.name}.sha256`;
    const current = await this.#exec([
      "/bin/sh",
      "-c",
      '[ -x "$1" ] && [ "$(cat -- "$2" 2>/dev/null)" = "$3" ]',
      "sh",
      target,
      marker,
      binary.sha256,
    ]);
    if (current.exitCode === 0) return;
    const url = new URL(binary.url);
    if (url.protocol !== "https:")
      throw new Error(`The binary ${binary.name} downloads over https only.`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || response.body === null)
      throw new Error(
        `Downloading the binary ${binary.name} failed: HTTP ${response.status}.`,
      );
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > caps.binaryBytes)
      throw new Error(`The binary ${binary.name} is larger than its limit.`);
    // Read with a byte limit, so a response with no length cannot fill memory.
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > caps.binaryBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`The binary ${binary.name} is larger than its limit.`);
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    if ((await sha256Hex(bytes)) !== binary.sha256)
      throw new Error(`The binary ${binary.name} does not match its sha256.`);
    if (binary.path === undefined) {
      await this.#writeFile(target, bytes, "0755");
      await this.#writeFile(marker, encoder.encode(binary.sha256));
      return;
    }
    // An archive (.tar.*, .tgz, or .zip): unpack it in the container, which
    // has tar, xz, and unzip, and keep only the named file.
    const inside = binary.path.replace(/^\.?\/+/, "");
    if (inside === "" || inside.split("/").includes(".."))
      throw new Error(`The binary ${binary.name}'s path is not allowed.`);
    const archive = `/srv/work/.dx-${binary.sha256}`;
    await this.#writeFile(archive, bytes);
    const unpacked = await this.#exec([
      "/bin/sh",
      "-c",
      [
        'set -e; dir="$1.d"; rm -rf "$dir"; mkdir -p "$dir"',
        'if unzip -tq "$1" > /dev/null 2>&1; then unzip -q "$1" -d "$dir"; else tar -xf "$1" -C "$dir"; fi',
        'install -m 0755 "$dir/$2" "$3"',
        'rm -rf "$dir" "$1"',
      ].join("\n"),
      "sh",
      archive,
      inside,
      target,
    ]);
    if (unpacked.exitCode !== 0)
      throw new Error(
        `Unpacking the binary ${binary.name} failed: ${unpacked.stderr.trim().slice(-500)}`,
      );
    await this.#writeFile(marker, encoder.encode(binary.sha256));
  }

  async #run(
    request: PluginContainerRequest,
    host: HostStub,
  ): Promise<{
    outcome: PluginContainerOutcome;
    value?: unknown;
    error?: string;
    runMs: number;
  }> {
    const ran = Date.now();
    // A distinct key per call, so two calls started in the same
    // millisecond are both counted.
    let since = ran;
    while (this.#runningSince.has(since)) since += 0.001;
    this.#runningSince.add(since);
    try {
      const result = await this.#runCode(request, host);
      return { ...result, runMs: Date.now() - ran };
    } catch (caught) {
      // A run that failed to start or broke still ran this long.
      return {
        outcome: "unavailable",
        error: errorText(caught),
        runMs: Date.now() - ran,
      };
    } finally {
      this.#runningSince.delete(since);
    }
  }

  async #runCode(
    request: PluginContainerRequest,
    host: HostStub,
  ): Promise<{
    outcome: PluginContainerOutcome;
    value?: unknown;
    error?: string;
  }> {
    const root = await this.#root(request.integrity);
    const nonce = `#dx${crypto.randomUUID().replaceAll("-", "")}#`;
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const writer = input.writable.getWriter();
    const send = (message: unknown) =>
      writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    // Its own session, so the call's whole process group (ffmpeg and any
    // other child) can be killed when the call ends, however it ends.
    const process = await this.#container.exec(
      ["/usr/bin/setsid", "-w", "/usr/bin/node", RUNNER],
      {
        stdin: input.readable,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let group: number | undefined;
    const stderr = tail(process.stderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), request.caps.callMs);
    });
    await send({
      t: "invoke",
      nonce,
      entry: `${root}/${request.entry}`,
      call: request.call,
      info: request.info,
    });
    const result = (async () => {
      if (process.stdout === null) throw new Error("The runner has no output.");
      let bytes = 0;
      for await (const line of linesOf(process.stdout)) {
        if (!line.startsWith(nonce)) continue;
        bytes += line.length;
        if (bytes > request.caps.payloadBytes * 2)
          throw new Error("The call sent more than its payload limit.");
        const message = JSON.parse(line.slice(nonce.length)) as {
          t: string;
          id?: number;
          m?: string;
          a?: unknown[];
          ok?: boolean;
          v?: unknown;
          e?: string;
          pid?: number;
        };
        if (message.t === "pid" && typeof message.pid === "number") {
          group = message.pid;
          continue;
        }
        if (message.t === "done") {
          if (message.ok === true) {
            if (
              JSON.stringify(message.v ?? null).length >
              request.caps.payloadBytes
            )
              return {
                outcome: "error" as const,
                error: "The result is larger than its limit.",
              };
            return { outcome: "success" as const, value: message.v ?? null };
          }
          return { outcome: "error" as const, error: String(message.e) };
        }
        if (message.t === "rpc" && typeof message.id === "number") {
          const id = message.id;
          const method = String(message.m);
          const args = (message.a ?? []).map((arg) =>
            arg === null ? undefined : arg,
          );
          if (!HOST_METHODS.has(method) || typeof host[method] !== "function") {
            void send({ t: "ret", id, ok: false, e: `ctx has no ${method}.` });
            continue;
          }
          // Each ctx call runs on its own, so a slow one blocks no other.
          void host[method](...args).then(
            (value) => send({ t: "ret", id, ok: true, v: value ?? null }),
            (error: unknown) =>
              send({ t: "ret", id, ok: false, e: errorText(error) }),
          );
        }
      }
      return {
        outcome: "error" as const,
        error: `The runner ended without a result (exit ${await process.exitCode}): ${(await stderr).trim().slice(-2_000)}`,
      };
    })();
    try {
      const ended = await Promise.race([
        result.catch((error: unknown) => ({
          outcome: "error" as const,
          error: errorText(error),
        })),
        timedOut,
      ]);
      if (ended === "timeout")
        return {
          outcome: "timeout",
          error: `The call took longer than ${request.caps.callMs / 1_000} seconds.`,
        };
      return ended;
    } finally {
      clearTimeout(timer);
      await writer.close().catch(() => undefined);
      // However the call ended, nothing it started keeps running.
      if (group !== undefined)
        await this.#exec(["/bin/kill", "-KILL", "--", `-${group}`]).catch(
          () => undefined,
        );
      try {
        process.kill(9);
      } catch {}
    }
  }
}
