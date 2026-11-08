import type { OrbContainerRuntime } from "./orb-container.js";

/**
 * Branch previews only (#1956): makes one Thread's Orb container behave the
 * way Cloudflare's slow snapshot restores did on production, so the wake
 * path can be proven against them on demand.
 *
 * Production showed two things at once. A restore's readiness probe (and
 * every other command) did not answer for tens of seconds to minutes, and
 * `destroy()` on a container that was still starting did not settle while
 * it still read `running`. The plan reproduces both for each start until it
 * ends; with no plan the container is used as it is.
 *
 * Core sets a plan through `POST /v1/threads/:threadId/orb/fault`, which
 * answers only on a branch preview (`orb-fault-route.ts`).
 */
export interface OrbFaultPlan {
  /** After each start, commands reach the container only this much later. */
  readonly startDelayMs: number;
  /** While a start is delayed, `destroy()` never settles. */
  readonly destroyHangs: boolean;
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
  // When the latest start's commands may reach the container.
  let readyAt = 0;
  const active = () => {
    const current = plan();
    return current !== undefined && now() < current.until ? current : undefined;
  };
  return {
    get running() {
      return container.running;
    },
    start(options) {
      const current = active();
      readyAt = current === undefined ? 0 : now() + current.startDelayMs;
      container.start(options);
    },
    async exec(command, options) {
      const wait = readyAt - now();
      if (wait > 0) await sleep(wait);
      return container.exec(command, options);
    },
    snapshotContainer: (options) => container.snapshotContainer(options),
    destroy(reason) {
      if (now() < readyAt && active()?.destroyHangs)
        return new Promise<void>(() => {});
      return container.destroy(reason);
    },
    setInactivityTimeout: (durationMs) =>
      container.setInactivityTimeout(durationMs),
    interceptOutboundHttp: (address, binding) =>
      container.interceptOutboundHttp(address, binding),
  };
};
