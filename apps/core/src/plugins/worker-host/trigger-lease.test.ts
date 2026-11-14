import { describe, expect, it } from "vitest";
import { MAX_TRIGGER_LEASE_MS, triggerLeaseMs } from "./trigger-lease.js";

/**
 * How a webhook delivery's lease can go wrong, written before the code:
 *
 * 1. A tier whose configured call time is raised (`DX_PLUGIN_TIER_LIMITS`)
 *    makes the lease longer than a Durable Object alarm may run (15
 *    minutes): the alarm is killed and the delivery runs again.
 * 2. The cap is applied but the default container lease (5-minute calls:
 *    11.5 minutes) shrinks, cutting off calls the tier allows.
 * 3. An install without a container host loses its plain 30-second lease.
 * 4. The handler's own timeout (the lease less 5 s) is not inside the
 *    lease, or is not positive.
 */
describe("a webhook delivery's lease", () => {
  it("never exceeds what an alarm may run, however long the tier's calls", () => {
    for (const callMs of [405_000, 600_000, 3_600_000]) {
      const lease = triggerLeaseMs({ container: true, callMs });
      expect(lease).toBe(MAX_TRIGGER_LEASE_MS);
      expect(lease).toBeLessThan(15 * 60_000);
    }
  });

  it("keeps the default container lease whole", () => {
    expect(triggerLeaseMs({ container: true, callMs: 300_000 })).toBe(
      300_000 * 2 + 90_000,
    );
  });

  it("keeps the plain lease for an install with no container host", () => {
    expect(
      triggerLeaseMs({ container: false, callMs: 600_000, defaultMs: 30_000 }),
    ).toBe(30_000);
  });

  it("leaves the handler a positive timeout inside the lease", () => {
    for (const callMs of [1_000, 300_000, 3_600_000]) {
      const lease = triggerLeaseMs({ container: true, callMs });
      expect(lease - 5_000).toBeGreaterThan(0);
      expect(lease - 5_000).toBeLessThan(lease);
    }
  });
});
