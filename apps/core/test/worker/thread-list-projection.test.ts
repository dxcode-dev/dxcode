import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
} from "./product-route-fixture.js";

const list = async () => {
  const response = await createProductApp().request("/threads", {}, bindings);
  expect(response.status).toBe(200);
  return response.json<{
    data: {
      items: Array<{
        id: string;
        mode: string;
        changes?: { additions: number; deletions: number; files: number };
      }>;
    };
  }>();
};

describe("Thread list projections", () => {
  it("returns only complete D1-owned Changes totals and the snapshotted mode", async () => {
    const project = await createProjectViaApi("thread-list-summary");
    const thread = await createThreadViaApi(project.data.id);
    const now = "2026-09-17T12:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO thread_changes_state (
         thread_id, mutation_generation, latest_capture_id,
         latest_capture_generation, latest_fingerprint, latest_captured_at,
         dirty_since, updated_at, summary_additions, summary_deletions,
         summary_files
       ) VALUES (?, 1, ?, 1, ?, ?, NULL, ?, 34, 5, 3)`,
    )
      .bind(thread.data.id, "chg_projection", "a".repeat(64), now, now)
      .run();

    const complete = await list();
    expect(complete.data.items).toEqual([
      expect.objectContaining({
        id: thread.data.id,
        mode: "medium",
        changes: { additions: 34, deletions: 5, files: 3 },
      }),
    ]);

    await env.DB.prepare(
      "UPDATE thread_changes_state SET dirty_since = ?, updated_at = ? WHERE thread_id = ?",
    )
      .bind(now, now, thread.data.id)
      .run();
    const stale = await list();
    expect(stale.data.items[0]).not.toHaveProperty("changes");
  });
});
