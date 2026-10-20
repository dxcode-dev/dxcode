import { env } from "cloudflare:test";
import { ProjectRepository, ThreadId, ThreadRepository } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { project, thread } from "./fixtures.js";
import { bindings, createProductApp, owner } from "./product-route-fixture.js";
import { runRepositories } from "./runtime.js";

/**
 * Byte budget for the sidebar's first request: the active roots list
 * (`limit=100&lifecycleState=active&roots=true`) of an owner with 100 root
 * Threads, a third with Changes totals and a tenth with a child Thread.
 * Measures the raw JSON body only: not compressed size, not D1 time, and
 * not the per-root children lists the sidebar fetches when expanded.
 */
const LIST_BYTES = 50_224;

const id = (n: number) =>
  Schema.decodeUnknownSync(ThreadId)(
    `thr_00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
  );
const titles = [
  "Fix flaky checkout test on Safari",
  "Bound the first history page by bytes",
  "Migrate billing webhooks to the queue",
  "Why does the sidebar re-render on focus?",
  "Add a dark palette to the terminal",
];

describe("Thread list payload budget", () => {
  it("keeps the 100-root sidebar list within its byte budget", async () => {
    const seeded = project(
      "prj_00000000-0000-4000-8000-0000000000c1",
      owner,
      "Storefront",
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(seeded);
        for (let n = 1; n <= 100; n += 1) {
          const at = new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();
          yield* threads.insert({
            ...thread(id(n), seeded.id, owner, at),
            title: `${titles[n % titles.length]} (${n})`,
          });
          if (n % 10 === 0)
            yield* threads.insert({
              ...thread(id(1_000 + n), seeded.id, owner, at),
              title: `Child of ${n}`,
              parentThreadId: id(n),
            });
        }
      }),
    );
    const now = "2026-10-01T12:00:00.000Z";
    await env.DB.batch(
      Array.from({ length: 33 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO thread_changes_state (
             thread_id, mutation_generation, latest_capture_id,
             latest_capture_generation, latest_fingerprint, latest_captured_at,
             dirty_since, updated_at, summary_additions, summary_deletions,
             summary_files
           ) VALUES (?, 1, ?, 1, ?, ?, NULL, ?, ?, ?, ?)`,
        ).bind(
          id(index * 3 + 1),
          `chg_capture_${index}`,
          "a".repeat(64),
          now,
          now,
          120 + index,
          40 + index,
          3 + (index % 7),
        ),
      ),
    );

    const response = await createProductApp().request(
      "/threads?limit=100&lifecycleState=active&roots=true",
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    const list = JSON.parse(body) as {
      data: { items: Array<{ id: string }>; nextCursor?: string };
    };
    expect(list.data.items).toHaveLength(100);
    const bytes = new TextEncoder().encode(body).byteLength;
    const detail = await createProductApp().request(
      `/threads/${id(100)}`,
      {},
      bindings,
    );
    expect(detail.status).toBe(200);
    const detailBytes = new TextEncoder().encode(
      await detail.text(),
    ).byteLength;

    // Pinned exactly: a change to the list item shape must update this
    // number on purpose.
    expect(bytes).toBe(LIST_BYTES);
    // Ceiling: 100 rows stay under 56 KiB of JSON.
    expect(bytes).toBeLessThanOrEqual(56 * 1024);
    // Ratio: a list row stays thinner than the Thread's detail (0.64 today).
    expect(bytes / 100 / detailBytes).toBeLessThanOrEqual(0.7);
  });
});
