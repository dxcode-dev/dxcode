import type { Sandbox } from "@flue/runtime";

const TIMED = [
  "exec",
  "readFile",
  "readFileBuffer",
  "writeFile",
  "stat",
  "readdir",
  "exists",
  "mkdir",
  "rm",
] as const;

/**
 * A summary goes out after this many operations, or once the sandbox has
 * been quiet this long: a turn's sandbox is dropped when the turn ends, so
 * its last operations would otherwise never be reported.
 */
const FLUSH_OPERATIONS = 50;
const FLUSH_QUIET_MS = 5_000;

export interface SandboxTimingSummary {
  readonly operations: Record<
    string,
    {
      readonly count: number;
      readonly failed: number;
      readonly p50Ms: number;
      readonly p95Ms: number;
      readonly maxMs: number;
    }
  >;
}

const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
  0;

/**
 * Times every operation of a sandbox and reports per-operation counts and
 * latencies in batches, so the dxd and provider routes compare on the same
 * numbers. `exec` times include the command's own run time.
 */
export const withSandboxTiming = (
  sandbox: Sandbox,
  report: (summary: SandboxTimingSummary) => void,
  now: () => number = Date.now,
): Sandbox => {
  let samples = new Map<string, { ms: Array<number>; failed: number }>();
  let pending = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(quiet);
    quiet = undefined;
    if (pending === 0) return;
    const operations: Record<
      string,
      SandboxTimingSummary["operations"][string]
    > = {};
    for (const [name, sample] of samples) {
      const sorted = [...sample.ms].sort((left, right) => left - right);
      operations[name] = {
        count: sorted.length,
        failed: sample.failed,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) ?? 0,
      };
    }
    samples = new Map();
    pending = 0;
    report({ operations });
  };
  const record = (name: string, ms: number, ok: boolean) => {
    const sample = samples.get(name) ?? { ms: [], failed: 0 };
    sample.ms.push(ms);
    if (!ok) sample.failed += 1;
    samples.set(name, sample);
    pending += 1;
    if (pending >= FLUSH_OPERATIONS) flush();
    else {
      clearTimeout(quiet);
      quiet = setTimeout(flush, FLUSH_QUIET_MS);
    }
  };
  const timed = { ...sandbox } as Record<string, unknown>;
  for (const name of TIMED) {
    const own = sandbox[name] as
      | ((...args: Array<unknown>) => Promise<unknown>)
      | undefined;
    if (own === undefined) continue;
    timed[name] = async (...args: Array<unknown>) => {
      const startedAt = now();
      let ok = false;
      try {
        const result = await own.apply(sandbox, args);
        ok = true;
        return result;
      } finally {
        record(name, now() - startedAt, ok);
      }
    };
  }
  return timed as unknown as Sandbox;
};
