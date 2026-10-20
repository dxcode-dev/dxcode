import { env } from "cloudflare:test";
import type { ThreadId, UserId } from "@dx/domain";
import type { FlueObservation, ToolDefinition } from "@flue/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { publishChangesInvalidation } from "../../src/realtime/publication.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { publishThreadChangesResidentCandidate } from "../../src/thread-changes/resident-publisher.js";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";

// Flue's history route needs a Flue-built server entry; these Threads have no
// conversation, which that route reports as 404.
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  return {
    dxAgentRoutes: new Hono().all("*", (context) => context.notFound()),
  };
});

const owner = "usr_00000000-0000-4000-8000-000000000a01" as UserId;
const projectId = "prj_00000000-0000-4000-8000-000000000a01";
const caller = "thr_00000000-0000-4000-8000-000000000a01" as ThreadId;
const child = "thr_00000000-0000-4000-8000-000000000a02" as ThreadId;
const sibling = "thr_00000000-0000-4000-8000-000000000a03" as ThreadId;
const changed = "thr_00000000-0000-4000-8000-000000000a04" as ThreadId;
const audience = `user:${owner}`;

/** Every D1 statement a caller prepares, so a test can count them. */
const countingDb = () => {
  const counted = { statements: 0 };
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          counted.statements += 1;
          return target.prepare(query);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, counted };
};

/** The owner's hub frames, as their browser receives them. */
const subscribe = async () => {
  const response = await env.REALTIME_HUB.getByName(audience).fetch(
    "https://realtime.internal/subscribe",
    {
      headers: {
        upgrade: "websocket",
        "x-dx-realtime-audience": audience,
        "x-dx-realtime-participant": owner,
        "x-dx-realtime-client": crypto.randomUUID(),
      },
    },
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected realtime WebSocket.");
  const frames: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string);
    if (frame.type !== "ready") frames.push(frame);
  });
  socket.accept();
  return {
    frames,
    /** Lets frames already sent arrive, then hands them over. */
    drain: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return frames.splice(0);
    },
    close: () => socket.close(),
  };
};

const observe = (
  db: D1Database,
  type: string,
  threadId: ThreadId,
  submissionId: string,
  timestamp: string,
) =>
  recordFlueThreadActivity(
    {
      type,
      instanceId: threadId,
      submissionId,
      timestamp,
    } as unknown as FlueObservation,
    {
      id: "fixture",
      agentName: "dx",
      env: { DB: db, REALTIME_HUB: env.REALTIME_HUB },
    } as never,
  );

const insertThread = (id: ThreadId, parent: ThreadId | null) =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, parent_thread_id,
       title, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, 'Hint fixture', ?, ?, ?)`,
  ).bind(
    id,
    projectId,
    owner,
    parent,
    "2026-10-19T09:00:00.000Z",
    "2026-10-19T09:00:00.000Z",
    "2026-10-19T09:00:00.000Z",
  );

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(owner, "Hint Owner", "hints@example.test"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Hints', ?, ?)",
    ).bind(projectId, owner, "2026-10-19", "2026-10-19"),
    insertThread(caller, null),
    insertThread(child, caller),
    insertThread(sibling, caller),
    insertThread(changed, null),
  ]);
});

describe("Realtime hints", () => {
  it("publishes a Thread invalidation only when its status or last activity moves", async () => {
    const hub = await subscribe();
    const { db, counted } = countingDb();
    const step = async (
      type: string,
      submissionId: string,
      timestamp: string,
    ) => {
      counted.statements = 0;
      await observe(db, type, child, submissionId, timestamp);
      return {
        type,
        submissionId,
        d1Statements: counted.statements,
        hubPublishes: (await hub.drain()).length,
      };
    };

    const turn = [
      await step("submission_queued", "sub-1", "2026-10-19T09:01:00.000Z"),
      await step("submission_running", "sub-1", "2026-10-19T09:01:01.000Z"),
      await step("submission_settled", "sub-1", "2026-10-19T09:02:00.000Z"),
    ];
    const replays = [
      // Flue redelivers an observation, or one arrives after settlement.
      await step("submission_settled", "sub-1", "2026-10-19T09:02:00.000Z"),
      await step("submission_running", "sub-1", "2026-10-19T09:02:01.000Z"),
    ];
    // A real transition after the replays still reaches the browser.
    const next = await step(
      "submission_queued",
      "sub-2",
      "2026-10-19T09:03:00.000Z",
    );

    expect(turn.map(({ hubPublishes }) => hubPublishes)).toEqual([1, 0, 1]);
    expect(replays.map(({ hubPublishes }) => hubPublishes)).toEqual([0, 0]);
    expect(next.hubPublishes).toBe(1);
    const status = await env.DB.prepare(
      "SELECT activity_status, last_activity_at FROM threads WHERE id = ?",
    )
      .bind(child)
      .first();
    expect(status).toEqual({
      activity_status: "working",
      last_activity_at: "2026-10-19T09:03:00.000Z",
    });
    await observe(
      env.DB,
      "submission_settled",
      child,
      "sub-2",
      "2026-10-19T09:04:00.000Z",
    );
    hub.close();

    const total = (key: "d1Statements" | "hubPublishes") =>
      turn.reduce((sum, entry) => sum + entry[key], 0);
    await expect(
      `${JSON.stringify(
        {
          scenario:
            "One Flue turn (queued, running, settled), then two replayed observations",
          turn,
          replays,
          perTurn: {
            d1Statements: total("d1Statements"),
            hubPublishes: total("hubPublishes"),
          },
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot("../../../../artifacts/realtime-hints/turn.json");
  });

  it("flags only Changes commits whose list totals moved", async () => {
    const now = "2026-10-19T09:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO thread_source_snapshot (
         thread_id, project_id, binding_revision, provider,
         repository_full_name, clone_url, default_branch,
         initial_ref, initial_commit_sha, created_at
       ) VALUES (?, ?, 1, 'github', 'example-org/example-repo',
         'https://github.com/example-org/example-repo.git', 'main', ?, ?, ?)`,
    )
      .bind(changed, projectId, "a".repeat(40), "a".repeat(40), now)
      .run();
    const repository = makeThreadChangesRepository(env.DB);
    const hub = await subscribe();
    const commit = async (
      outcome:
        | { readonly kind: "unchanged"; readonly fingerprint: string }
        | {
            readonly kind: "complete";
            readonly fingerprint: string;
            readonly additions: number;
          },
    ) => {
      // The execution object publishes without waiting; the test waits for
      // that publish, so a slow D1 audience lookup cannot outlast the drain.
      let publishing: Promise<unknown> | undefined;
      const mutation = await repository.beginMutation(changed, 60_000);
      await mutation.release();
      const published = await publishThreadChangesResidentCandidate({
        db: env.DB,
        bucket: env.DX_STORAGE,
        threadId: changed,
        candidate: {
          type: "changes-candidate",
          token: mutation.refreshToken,
          outcome:
            outcome.kind === "unchanged"
              ? outcome
              : {
                  kind: "complete",
                  capture: {
                    fingerprint: outcome.fingerprint,
                    baseline: "a".repeat(40),
                    head: "a".repeat(40),
                    branch: "main",
                    upstreamLabel: null,
                    ahead: 0,
                    commits: [],
                    ranges: [
                      {
                        range: { kind: "all" },
                        truncated: false,
                        summary: {
                          additions: outcome.additions,
                          deletions: 0,
                          files: 1,
                        },
                        files: [],
                      },
                    ],
                  },
                },
        },
        // As the Thread's execution object wires it.
        onCommitted: (_fingerprint, summaryChanged) => {
          publishing = publishChangesInvalidation(env, changed, summaryChanged);
        },
      });
      await publishing;
      const frames = await hub.drain();
      return { published, frames };
    };

    const first = await commit({
      kind: "complete",
      fingerprint: "1".repeat(64),
      additions: 3,
    });
    const unchanged = await commit({
      kind: "unchanged",
      fingerprint: "1".repeat(64),
    });
    const sameTotals = await commit({
      kind: "complete",
      fingerprint: "2".repeat(64),
      additions: 3,
    });
    const moved = await commit({
      kind: "complete",
      fingerprint: "3".repeat(64),
      additions: 4,
    });
    hub.close();

    expect(
      [first, unchanged, sameTotals, moved].map(({ published }) => published),
    ).toEqual(["published", "unchanged", "published", "published"]);
    const frame = (summaryChanged?: true) => [
      {
        type: "changes.invalidated",
        threadId: changed,
        ...(summaryChanged ? { summaryChanged } : {}),
        revision: expect.any(Number),
      },
    ];
    expect(first.frames).toEqual(frame(true));
    expect(unchanged.frames).toEqual(frame());
    expect(sameTotals.frames).toEqual(frame());
    expect(moved.frames).toEqual(frame(true));
  });

  describe("wait_for_threads", () => {
    const tools = () =>
      Object.fromEntries(
        createThreadTools(caller, () => ({
          db: env.DB,
          bindings: env as unknown as Bindings,
        })).map((tool: ToolDefinition) => [
          tool.name,
          tool as unknown as {
            run: (input: {
              data: Record<string, unknown>;
              toolCallId: string;
            }) => Promise<{
              output: {
                settled: boolean;
                threads: Array<{ threadId: string; state: string }>;
              };
            }>;
          },
        ]),
      );
    const wait = (threads: ThreadId[], timeoutSeconds: number) => {
      const startedAt = Date.now();
      return tools()
        .wait_for_threads?.run({
          data: { threads, timeout_seconds: timeoutSeconds },
          toolCallId: `wait-${crypto.randomUUID()}`,
        })
        .then((result) => ({ ...result?.output, ms: Date.now() - startedAt }));
    };

    it("returns at once when every Thread is already idle", async () => {
      const result = await wait([sibling], 30);
      expect(result).toMatchObject({
        settled: true,
        threads: [{ threadId: sibling, state: "idle" }],
      });
      // Far short of the 30 s timeout; the first call also loads the
      // owner routes that read each Thread's latest message.
      expect(result.ms).toBeLessThan(5_000);
    });

    it("returns as soon as the Thread settles, and not on another Thread's change", async () => {
      await observe(
        env.DB,
        "submission_queued",
        child,
        "sub-wait",
        "2026-10-19T10:00:00.000Z",
      );
      await observe(
        env.DB,
        "submission_queued",
        sibling,
        "sub-other",
        "2026-10-19T10:00:00.000Z",
      );
      const waiting = wait([child], 30);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A hint for a Thread the wait does not watch.
      await observe(
        env.DB,
        "submission_settled",
        sibling,
        "sub-other",
        "2026-10-19T10:00:01.000Z",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settledAt = Date.now();
      await observe(
        env.DB,
        "submission_settled",
        child,
        "sub-wait",
        "2026-10-19T10:00:02.000Z",
      );
      const result = await waiting;
      expect(result).toMatchObject({
        settled: true,
        threads: [{ threadId: child, state: "idle" }],
      });
      // Well under the 2 s poll it replaces.
      expect(Date.now() - settledAt).toBeLessThan(1_000);
    });

    it("still times out while the Thread keeps working", async () => {
      await observe(
        env.DB,
        "submission_queued",
        child,
        "sub-slow",
        "2026-10-19T11:00:00.000Z",
      );
      const result = await wait([child], 1);
      expect(result).toMatchObject({
        settled: false,
        threads: [{ threadId: child, state: "working" }],
      });
      expect(result.ms).toBeGreaterThanOrEqual(1_000);
      expect(result.ms).toBeLessThan(2_500);
      await observe(
        env.DB,
        "submission_settled",
        child,
        "sub-slow",
        "2026-10-19T11:00:01.000Z",
      );
    });
  });
});
