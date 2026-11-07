/**
 * When a Thread's Orb ran, as its execution object saw the Orb's daemon
 * register and drop. Kept in that object's own storage: no D1 and no
 * provider call. Runs older than a day are dropped, and at most
 * `MAX_ORB_RUNS` are kept, so the record stays small however often an Orb
 * wakes.
 */

export const ORB_RUNS_STORAGE_KEY = "orb-runs";
export const ORB_USAGE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_ORB_RUNS = 96;

export interface OrbRuns {
  /** The open run's start (epoch ms), while the daemon is connected. */
  readonly since?: number;
  /** Closed runs as [start, end] epoch ms, oldest first. */
  readonly runs: ReadonlyArray<readonly [number, number]>;
  /** When the last run ended, kept after that run ages out of `runs`. */
  readonly pausedAt?: number;
}

export const NO_ORB_RUNS: OrbRuns = { runs: [] };

const recent = (
  runs: OrbRuns["runs"],
  now: number,
): ReadonlyArray<readonly [number, number]> =>
  runs
    .filter(([, end]) => end > now - ORB_USAGE_WINDOW_MS)
    .slice(-MAX_ORB_RUNS);

/**
 * The daemon registered: a run starts unless one is already open. The new
 * state drops `pausedAt`, since the Orb is running again.
 */
export const orbRunStarted = (state: OrbRuns, now: number): OrbRuns =>
  state.since === undefined
    ? { since: now, runs: recent(state.runs, now) }
    : state;

/** The daemon dropped at `at`: the open run, if any, closes there. */
export const orbRunEnded = (
  state: OrbRuns,
  at: number,
  now: number,
): OrbRuns =>
  state.since === undefined
    ? state
    : {
        runs: recent(
          [...state.runs, [state.since, Math.max(state.since, at)]],
          now,
        ),
        pausedAt: Math.max(state.since, at),
      };

export interface OrbRunSummary {
  readonly running: boolean;
  /** When the open run started; null while paused. */
  readonly runningSince: number | null;
  /** When the last run ended; null while running or when none is recorded. */
  readonly pausedAt: number | null;
  /** Time the Orb ran in the last 24 hours, in milliseconds. */
  readonly last24hMs: number;
  /** Whether this object has seen the Orb run at all. */
  readonly recorded: boolean;
}

/**
 * The Orb's state now. `live` is whether the daemon is connected; when it is
 * not but a run is still open (the object restarted before it saw the drop),
 * that run ends at `lastSeen`, the daemon's last stored heartbeat.
 */
export const summarizeOrbRuns = (
  state: OrbRuns,
  now: number,
  live: boolean,
  lastSeen: number | undefined,
): OrbRunSummary => {
  const settled =
    !live && state.since !== undefined
      ? orbRunEnded(state, lastSeen ?? state.since, now)
      : state;
  const windowStart = now - ORB_USAGE_WINDOW_MS;
  const intervals: ReadonlyArray<readonly [number, number]> = [
    ...settled.runs,
    ...(live && settled.since !== undefined
      ? [[settled.since, now] as const]
      : []),
  ];
  const last24hMs = intervals.reduce(
    (total, [start, end]) =>
      total + Math.max(0, Math.min(end, now) - Math.max(start, windowStart)),
    0,
  );
  return {
    running: live,
    runningSince: live ? (settled.since ?? now) : null,
    pausedAt: live ? null : (settled.pausedAt ?? null),
    last24hMs,
    recorded: live || settled.runs.length > 0 || settled.pausedAt !== undefined,
  };
};
