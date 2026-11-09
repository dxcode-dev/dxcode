import type { OrbContainerRuntime } from "./orb-container.js";

/**
 * Branch previews only (#1956): makes one Thread's Orb container behave the
 * way Cloudflare's stalled snapshot restores did on production, so the wake
 * path can be proven against them on demand.
 *
 * On production (thr_edc0a58e, 7–8 Nov), a wake's `start()` returned and
 * `running` read true, but Cloudflare placed no container at all: its
 * instance list showed none, every command hung, and `destroy()` never
 * settled. After 7 to 10 minutes Cloudflare dropped the start; a new start
 * of the same snapshot then answered in 2 to 4 s. A plan reproduces that
 * for each start until it ends:
 *
 * - the real `start()` happens only `startDelayMs` later (a slow start that
 *   does come up), or never, when `dropAfterMs` passes first (a stall that
 *   Cloudflare drops: `running` then reads false);
 * - until the real start, commands wait, and with `destroyHangs` neither a
 *   stop nor a network intercept ever settles (on production, a stalled
 *   container answered neither, thr_edc0a58e).
 *
 * With no plan the container is used as it is. Core sets a plan through
 * `POST /v1/threads/:threadId/orb/fault`, which answers only on a branch
 * preview (`orb-fault-route.ts`).
 */
export interface OrbFaultPlan {
  /** Each start reaches Cloudflare only this much later. */
  readonly startDelayMs: number;
  /** While a start waits, `destroy()` never settles. */
  readonly destroyHangs: boolean;
  /** A start still waiting this long is dropped and never runs. */
  readonly dropAfterMs?: number;
  /**
   * Only this many starts of the object are held back; later ones run at
   * once, as a restore after Cloudflare dropped a stalled one did.
   */
  readonly starts?: number;
  /** The plan ends at this time (epoch ms). */
  readonly until: number;
}

/** The object's storage key for its plan. */
export const ORB_FAULT_KEY = "orb-fault";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const faultyContainer = (
  container: OrbContainerRuntime,
  plan: () => OrbFaultPlan | undefined,
  now: () => number = Date.now,
): OrbContainerRuntime => {
  /** Starts the plan has held back so far. */
  let heldStarts = 0;
  /** A start held back by the plan: nothing runs yet. */
  let held:
    | {
        readonly start: ReturnType<typeof setTimeout>;
        readonly drop?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const release = () => {
    if (held === undefined) return;
    clearTimeout(held.start);
    if (held.drop !== undefined) clearTimeout(held.drop);
    held = undefined;
  };
  const active = () => {
    const current = plan();
    return current !== undefined && now() < current.until ? current : undefined;
  };
  /** A call a held start never answers, or undefined to make it. */
  const stalled = () =>
    held !== undefined && active()?.destroyHangs
      ? new Promise<void>(() => {})
      : undefined;
  return {
    get running() {
      return held !== undefined || container.running;
    },
    start(options) {
      const current = active();
      if (
        current === undefined ||
        (current.starts !== undefined && heldStarts >= current.starts)
      ) {
        container.start(options);
        return;
      }
      heldStarts += 1;
      held = {
        start: setTimeout(() => {
          release();
          container.start(options);
        }, current.startDelayMs),
        ...(current.dropAfterMs === undefined
          ? {}
          : { drop: setTimeout(release, current.dropAfterMs) }),
      };
    },
    async exec(command, options) {
      while (held !== undefined) await sleep(250);
      return container.exec(command, options);
    },
    snapshotContainer: (options) => container.snapshotContainer(options),
    destroy(reason) {
      if (held !== undefined) {
        if (active()?.destroyHangs) return new Promise<void>(() => {});
        release();
        return Promise.resolve();
      }
      return container.destroy(reason);
    },
    setInactivityTimeout: (durationMs) =>
      container.setInactivityTimeout(durationMs),
    interceptOutboundHttp: (address, binding) =>
      stalled() ?? container.interceptOutboundHttp(address, binding),
    interceptOutboundHttps: (address, binding) =>
      stalled() ?? container.interceptOutboundHttps(address, binding),
    interceptAllOutboundHttp: (binding) =>
      stalled() ?? container.interceptAllOutboundHttp(binding),
  };
};
