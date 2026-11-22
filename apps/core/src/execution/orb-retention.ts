import type { Bindings } from "../http/types.js";

/**
 * Removes Orbs left unused past the deployment's retention, and archives
 * their Threads for good. The minute cron runs it; it decides itself how
 * often to act. Returns how many Orbs it removed.
 */
export type OrbRetentionSweep = (
  bindings: Bindings,
  options: {
    /** The cron's scheduled time, epoch ms. */
    readonly now: number;
    /** Keeps work the archive starts running after the sweep returns. */
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
) => Promise<number>;

/** Public dx keeps every Orb until its Thread is deleted. */
export const noOrbRetention: OrbRetentionSweep = async () => 0;
