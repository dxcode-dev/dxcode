import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeD1ExecutionWorkspaceCoordinator } from "../../src/execution/e2b/resolver.js";

describe("E2B resolution coordination", () => {
  it("serializes independent resolver leases through D1", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const coordinator = makeD1ExecutionWorkspaceCoordinator(env.DB);
    const first = await coordinator.acquire(key);
    const secondPromise = coordinator.acquire(key);

    await first.release();
    const second = await secondPromise;
    await second.release();

    const row = await env.DB.prepare(
      "SELECT lock_key FROM execution_workspace_resolution_lock WHERE lock_key = ?",
    )
      .bind(key)
      .first();
    expect(row).toBeNull();
  });
});
