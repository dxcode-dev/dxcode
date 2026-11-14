/**
 * The longest a webhook delivery's lease may be: a Durable Object alarm runs
 * at most 15 minutes, and an alarm killed mid-delivery runs it again. Kept a
 * minute under, for the delivery's own bookkeeping.
 */
export const MAX_TRIGGER_LEASE_MS = 14 * 60_000;

/**
 * How long a delivery's lease lasts: the plain lease, or for an install
 * whose code hands work to its container host, twice the tier's call time
 * (a queued call and its own) plus 90 s for a cold start, capped at
 * {@link MAX_TRIGGER_LEASE_MS}.
 */
export const triggerLeaseMs = (input: {
  readonly container: boolean;
  readonly callMs: number;
  readonly defaultMs?: number;
}) =>
  input.container
    ? Math.min(input.callMs * 2 + 90_000, MAX_TRIGGER_LEASE_MS)
    : (input.defaultMs ?? 30_000);
