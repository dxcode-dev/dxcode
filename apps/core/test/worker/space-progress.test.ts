import { env } from "cloudflare:test";
import type { SpaceProgressDay } from "@dx/api";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverGitHubWebhook } from "../../src/automations/deliver.js";
import { createSubscription } from "../../src/automations/subscriptions.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { publishThreadChangesResidentCandidate } from "../../src/thread-changes/resident-publisher.js";
import { shareThreadReads } from "../../src/thread-sharing/middleware.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * A Space's progress in workerd with real D1 and R2: how a thread it
 * started comes to count as shipped or archived, and the 30-day chart's
 * days.
 *
 * Ways it could go wrong: a merged PR ships no thread, ships a thread not
 * linked to it, or a closed-unmerged PR ships one; archiving from the Ship
 * outcome counts as a plain archive, or a plain archive as shipped; a later
 * signal overwrites the first reason; restoring unships a thread; a capture
 * counts a pull of the default branch, or a reset to it that dropped the
 * thread's work, as shipping it; a day is bucketed in UTC instead of the
 * viewer's zone; the open line forgets threads started before the window,
 * keeps counting a thread after it closed, or counts one closed before the
 * window; someone who cannot see the Space reads its progress.
 */

// Thread creation runs for real; Flue's dispatch records nothing.
vi.mock("../../src/threads/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/threads/routes.js")>();
  return {
    ...actual,
    threadRoutes: actual.createThreadRoutes(
      async (request) =>
        ({
          submissionId: `sub_${(request as { id: string }).id}`,
        }) as never,
      async () => undefined,
      async () => null,
    ),
  };
});

const owner = "progress-owner" as UserId;
const member = "progress-member" as UserId;
const outsider = "progress-outsider" as UserId;
const workspaceId = "progress-workspace";
const REPO = "acme/checkout";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000a153",
  owner,
  "checkout",
);
const ownerProject = {
  ...fixtureProject,
  configuration: {
    ...fixtureProject.configuration,
    runnerProfileId: "a1.medium",
  },
} as typeof fixtureProject;

const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const appFor = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/v1/spaces", spaceRoutes);
  app.use("/v1/threads/:threadId", shareThreadReads);
  app.route("/v1/threads", threadRoutes);
  app.onError(errorHandler);
  return app;
};

const send = async (
  userId: UserId,
  path: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await appFor(userId).request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON.
    body: (await response.json().catch(() => undefined)) as any,
  };
};

const createSpace = async (sharing: "workspace" | "private" = "workspace") =>
  (
    await send(owner, "/v1/spaces", "POST", {
      projectId: ownerProject.id,
      name: "Checkout v2",
      sharing,
    })
  ).body.data.space.threadId as ThreadId;

let children = 0;
/** A thread the Space's agent starts, through its create_thread tool. */
const startChild = async (spaceId: ThreadId, title: string) => {
  children += 1;
  const tools = createThreadTools(
    spaceId,
    () => ({ db: env.DB, bindings }),
    `sub_progress_${children}`,
    false,
    owner,
  );
  const tool = tools.find(({ name }) => name === "create_thread");
  if (tool === undefined) throw new Error("No create_thread tool.");
  const started = (await tool.run({
    data: { prompt: title, title },
    toolCallId: `call_${children}`,
  } as never)) as { output: { threadId: string } };
  return started.output.threadId as ThreadId;
};

const shipState = (threadId: ThreadId) =>
  env.DB.prepare(
    "SELECT shipped_at, ship_reason, archived_at, lifecycle_state FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      shipped_at: number | null;
      ship_reason: string | null;
      archived_at: number | null;
      lifecycle_state: string;
    }>();

const progress = async (
  spaceId: ThreadId,
  query = "",
  userId: UserId = owner,
) => send(userId, `/v1/spaces/${spaceId}/progress${query}`);

const spaceThreadState = async (spaceId: ThreadId, threadId: ThreadId) =>
  (
    (await send(owner, `/v1/spaces/${spaceId}/threads`)).body.data
      .items as Array<{ id: string; state: string }>
  ).find(({ id }) => id === threadId)?.state;

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const mergedPull = (number: number, mergedAt: string) => ({
  repository: { full_name: REPO },
  sender: { login: "alice" },
  pull_request: {
    number,
    title: "Fix coupon rounding",
    body: "",
    state: "closed",
    merged: true,
    merged_at: mergedAt,
    closed_at: mergedAt,
    merge_commit_sha: "c".repeat(40),
    updated_at: mergedAt,
    user: { login: "alice" },
  },
});

beforeEach(async () => {
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Progress', 'progress', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('pr-owner', ?1, ?2, 'owner', 1), ('pr-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
    }),
  );
});

beforeEach(() => seedSpaceUsers([owner, member, outsider]));

/**
 * A member's browser with the Space open: its realtime socket in the
 * workspace's hub, present on the Space's topic only, collecting the Space's
 * own thread events.
 */
const watchSpaceAs = async (userId: UserId, spaceId: ThreadId) => {
  const audience = `workspace:${workspaceId}`;
  const response = await env.REALTIME_HUB.getByName(audience).fetch(
    "https://realtime.internal/subscribe",
    {
      headers: {
        upgrade: "websocket",
        "x-dx-realtime-audience": audience,
        "x-dx-realtime-participant": userId,
        "x-dx-realtime-client": crypto.randomUUID(),
      },
    },
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected realtime WebSocket.");
  const frames: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string));
  });
  socket.accept();
  socket.send(
    JSON.stringify({ type: "presence.join", topic: `thread:${spaceId}` }),
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  await settle();
  frames.splice(0);
  return {
    /** How many times the Space was announced since the last call. */
    spaceAnnouncements: async () => {
      await settle();
      return frames
        .splice(0)
        .filter(
          (frame) =>
            frame.type === "thread.invalidated" && frame.threadId === spaceId,
        ).length;
    },
    close: () => socket.close(),
  };
};

describe("a Space's members see its threads change live", () => {
  it("announces the Space when one of its threads is archived, restored, ship-archived, or ships by a merge", async () => {
    const spaceId = await createSpace();
    const research = await startChild(spaceId, "Survey providers");
    const fixer = await startChild(spaceId, "Fix coupon rounding");
    const viewer = await watchSpaceAs(member, spaceId);

    // The owner archives a child; the member, who has only the Space open,
    // hears about it.
    expect(
      (
        await send(owner, `/v1/threads/${research}/archive`, "PATCH", {
          archived: true,
        })
      ).status,
    ).toBe(200);
    expect(await viewer.spaceAnnouncements()).toBeGreaterThan(0);

    expect(
      (
        await send(owner, `/v1/threads/${research}/archive`, "PATCH", {
          archived: false,
        })
      ).status,
    ).toBe(200);
    expect(await viewer.spaceAnnouncements()).toBeGreaterThan(0);

    expect(
      (
        await send(owner, `/v1/threads/${research}/archive`, "PATCH", {
          archived: true,
          reason: "ship",
        })
      ).status,
    ).toBe(200);
    expect(await viewer.spaceAnnouncements()).toBeGreaterThan(0);

    // A merged pull request ships its linked thread.
    await createSubscription(env.DB, owner, {
      title: "PR #21 comments and reviews",
      repository: REPO,
      kind: "pr-comments",
      filter: { prNumber: 21 },
      destination: "this-thread",
      threadId: fixer,
      projectId: null,
      agentMode: null,
      instructions: null,
      automatic: true,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await viewer.spaceAnnouncements();
    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(21, new Date().toISOString()),
    );
    expect((await shipState(fixer))?.ship_reason).toBe("pull_request_merged");
    expect(await viewer.spaceAnnouncements()).toBeGreaterThan(0);
    viewer.close();
    // Four lifecycle changes in one test: past the 5 s default under load.
  }, 15_000);
});

describe("how a Space's thread ships", () => {
  it("ships the threads linked to a pull request when it merges, and only then", async () => {
    const spaceId = await createSpace();
    const fixer = await startChild(spaceId, "Fix coupon rounding");
    const bystander = await startChild(spaceId, "Write checkout tests");
    // Both finished their turns; a thread that runs again is open, not shipped.
    await env.DB.prepare(
      "UPDATE threads SET activity_status = 'idle' WHERE parent_thread_id = ?",
    )
      .bind(spaceId)
      .run();
    // The agent subscribes to the PR it opened, which links the thread.
    for (const [threadId, number] of [
      [fixer, 12],
      [bystander, 13],
    ] as const)
      await createSubscription(env.DB, owner, {
        title: `PR #${number} comments and reviews`,
        repository: REPO,
        kind: "pr-comments",
        filter: { prNumber: number },
        destination: "this-thread",
        threadId,
        projectId: null,
        agentMode: null,
        instructions: null,
        automatic: true,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    // Closing PR #13 without merging ships nothing; neither does another
    // repository's PR #12.
    await deliverGitHubWebhook(bindings, "pull_request", "closed", {
      ...mergedPull(13, new Date().toISOString()),
      pull_request: {
        ...mergedPull(13, new Date().toISOString()).pull_request,
        merged: false,
        merged_at: null,
      },
    });
    await deliverGitHubWebhook(bindings, "pull_request", "closed", {
      ...mergedPull(12, new Date().toISOString()),
      repository: { full_name: "acme/elsewhere" },
    });
    expect((await shipState(fixer))?.shipped_at).toBeNull();
    expect((await shipState(bystander))?.shipped_at).toBeNull();

    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(12, mergedAt),
    );
    expect(await shipState(fixer)).toMatchObject({
      shipped_at: Date.parse(mergedAt),
      ship_reason: "pull_request_merged",
      lifecycle_state: "active",
    });
    expect((await shipState(bystander))?.shipped_at).toBeNull();
    expect(await spaceThreadState(spaceId, fixer)).toBe("shipped");

    // The first reason stays: archiving from the Ship outcome later, and
    // restoring, keep it shipped by its merge.
    expect(
      (
        await send(owner, `/v1/threads/${fixer}/archive`, "PATCH", {
          archived: true,
          reason: "ship",
        })
      ).status,
    ).toBe(200);
    await send(owner, `/v1/threads/${fixer}/archive`, "PATCH", {
      archived: false,
    });
    expect(await shipState(fixer)).toMatchObject({
      shipped_at: Date.parse(mergedAt),
      ship_reason: "pull_request_merged",
      archived_at: null,
      lifecycle_state: "active",
    });

    const today = (await progress(spaceId)).body.data;
    expect(today.totals).toEqual({ shipped: 1, archived: 0, open: 1 });
  });

  it("links the PR a Space's thread opened while the Space works too, and ships it on merge", async () => {
    const spaceId = await createSpace();
    const fixer = await startChild(spaceId, "Fix coupon rounding");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO project_repository (project_id, provider,
           binding_revision, full_name, web_url, clone_url, created_at, updated_at)
         VALUES (?, 'github', 1, ?, 'https://github.com/acme/checkout',
           'https://github.com/acme/checkout.git', ?, ?)`,
      ).bind(ownerProject.id, REPO, now, now),
      env.DB.prepare(
        `INSERT OR REPLACE INTO github_user_authorization (id, user_id,
           provider_account_id, provider_account_login, status, created_at, updated_at)
         VALUES ('gua_progress_owner', ?, '41', 'alice', 'active', ?, ?)`,
      ).bind(owner, now, now),
      // The Space's agent is mid-turn while its thread opens the PR.
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'working', last_activity_at = ?1 WHERE id IN (?2, ?3)",
      ).bind(now, spaceId, fixer),
    ]);
    await deliverGitHubWebhook(bindings, "pull_request", "opened", {
      repository: { full_name: REPO },
      sender: { login: "alice" },
      pull_request: {
        number: 31,
        user: { login: "alice" },
        head: { sha: "d".repeat(40), ref: "fix/coupon-rounding" },
        html_url: `https://github.com/${REPO}/pull/31`,
        title: "Fix coupon rounding",
        body: "",
        state: "open",
        created_at: now,
      },
    });
    const links = await env.DB.prepare(
      "SELECT thread_id FROM thread_github_link WHERE number = 31",
    ).all<{ thread_id: string }>();
    expect(links.results.map(({ thread_id }) => thread_id)).toEqual([fixer]);

    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(31, new Date().toISOString()),
    );
    expect(await shipState(fixer)).toMatchObject({
      ship_reason: "pull_request_merged",
    });
    expect((await shipState(spaceId))?.shipped_at).toBeNull();
  });

  it("counts an archive from the Ship outcome as shipped and any other archive as archived", async () => {
    const spaceId = await createSpace();
    const shipped = await startChild(spaceId, "Add Apple Pay");
    const research = await startChild(spaceId, "Survey payment providers");

    const ship = await send(owner, `/v1/threads/${shipped}/archive`, "PATCH", {
      archived: true,
      reason: "ship",
    });
    expect(ship.status).toBe(200);
    const shippedState = await shipState(shipped);
    expect(shippedState).toMatchObject({
      ship_reason: "ship_archived",
      lifecycle_state: "archived",
    });
    expect(typeof shippedState?.shipped_at).toBe("number");

    const plain = await send(
      owner,
      `/v1/threads/${research}/archive`,
      "PATCH",
      {
        archived: true,
      },
    );
    expect(plain.status).toBe(200);
    expect(await shipState(research)).toMatchObject({
      shipped_at: null,
      ship_reason: null,
      lifecycle_state: "archived",
    });
    expect(await spaceThreadState(spaceId, shipped)).toBe("shipped");
    expect(await spaceThreadState(spaceId, research)).toBe("archived");

    // Only an archive comes from a Ship outcome.
    const refused = await send(
      owner,
      `/v1/threads/${research}/archive`,
      "PATCH",
      {
        archived: false,
        reason: "ship",
      },
    );
    expect(refused.status).toBe(400);
    expect((await shipState(research))?.lifecycle_state).toBe("archived");

    // Restoring the shipped thread keeps its work shipped; restoring the
    // research reopens it.
    await send(owner, `/v1/threads/${shipped}/archive`, "PATCH", {
      archived: false,
    });
    await send(owner, `/v1/threads/${research}/archive`, "PATCH", {
      archived: false,
    });
    expect(await shipState(shipped)).toMatchObject({
      ship_reason: "ship_archived",
      archived_at: null,
    });
    const data = (await progress(spaceId)).body.data;
    expect(data.totals).toEqual({ shipped: 1, archived: 0, open: 1 });
    const day = (data.days as SpaceProgressDay[]).at(-1);
    expect(day).toMatchObject({ created: 2, shipped: 1, archived: 0 });
  });
});

describe("a thread whose commits reach the default branch", () => {
  const projectId = "prj_00000000-0000-4000-8000-00000000a154" as ProjectId;
  const baseline = "a".repeat(40);
  let sequence = 0;

  /** A thread with an Orb checkout of `main`, as the daemon reports it. */
  const seedThread = async () => {
    sequence += 1;
    const threadId =
      `thr_00000000-0000-4000-8000-0000000a15${String(sequence).padStart(2, "0")}` as ThreadId;
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects
          .insert(project(projectId, owner, "Orb checkout"))
          .pipe(Effect.ignore);
        yield* (yield* ThreadRepository).insert(
          thread(threadId, projectId, owner),
        );
      }),
    );
    await env.DB.prepare(
      `INSERT INTO thread_source_snapshot (
         thread_id, project_id, binding_revision, provider,
         repository_full_name, clone_url, default_branch, initial_ref,
         initial_commit_sha, created_at
       ) VALUES (?, ?, 1, 'github', ?, 'https://github.com/acme/checkout.git',
         'main', 'refs/heads/main', ?, ?)`,
    )
      .bind(threadId, projectId, REPO, baseline, new Date().toISOString())
      .run();
    return threadId;
  };

  const commit = (sha: string, subject: string) => ({
    sha: sha.repeat(40),
    shortSha: sha.repeat(7),
    subject,
  });
  const file = (path: string, status = "modified") => ({
    path,
    status,
    additions: 1,
    deletions: 0,
    binary: false,
    truncated: false,
    patch: "@@ -1 +1,2 @@\n line\n+added\n",
  });
  const range = (
    kind: { kind: "all" | "uncommitted" } | { kind: "commit"; sha: string },
    files: ReadonlyArray<ReturnType<typeof file>>,
  ) => ({
    range: kind,
    truncated: false,
    summary: { additions: files.length, deletions: 0, files: files.length },
    files,
  });

  let fingerprints = 0;
  /** One capture from the thread's daemon, published as Core publishes it. */
  const capture = async (
    threadId: ThreadId,
    state: {
      readonly upstreamLabel: string | null;
      readonly ahead: number;
      readonly commits: ReadonlyArray<ReturnType<typeof commit>>;
      readonly ranges: ReadonlyArray<ReturnType<typeof range>>;
    },
  ) => {
    fingerprints += 1;
    const repository = makeThreadChangesRepository(env.DB);
    const mutation = await repository.beginMutation(threadId, 60_000);
    await mutation.release();
    let shipped = false;
    const outcome = await publishThreadChangesResidentCandidate({
      db: env.DB,
      bucket: env.DX_STORAGE,
      threadId,
      candidate: {
        type: "changes-candidate",
        token: mutation.refreshToken,
        outcome: {
          kind: "complete",
          capture: {
            fingerprint: fingerprints.toString(16).padStart(64, "0"),
            baseline,
            head: state.commits[0]?.sha ?? baseline,
            branch: "main",
            ...state,
          },
        },
      },
      onShipped: () => {
        shipped = true;
      },
    });
    expect(outcome).toBe("published");
    return shipped;
  };

  it("ships when the thread's unpushed commits land on origin's default branch", async () => {
    const threadId = await seedThread();
    const work = [commit("2", "Round coupon totals"), commit("1", "Add test")];
    expect(
      await capture(threadId, {
        upstreamLabel: "origin/main",
        ahead: 2,
        commits: work,
        ranges: [range({ kind: "all" }, [file("cart.ts")])],
      }),
    ).toBe(false);
    expect((await shipState(threadId))?.shipped_at).toBeNull();
    // Ship rebased onto origin/main and pushed: new SHAs, same commits.
    const rebased = [
      commit("4", "Round coupon totals"),
      commit("3", "Add test"),
      commit("9", "Someone else's fix"),
    ];
    expect(
      await capture(threadId, {
        upstreamLabel: "origin/main",
        ahead: 0,
        commits: rebased,
        ranges: [range({ kind: "all" }, [file("cart.ts")])],
      }),
    ).toBe(true);
    expect(await shipState(threadId)).toMatchObject({
      ship_reason: "default_branch",
    });
  });

  it("ships when uncommitted work is committed and pushed in one go", async () => {
    const threadId = await seedThread();
    await capture(threadId, {
      upstreamLabel: "origin/main",
      ahead: 0,
      commits: [],
      ranges: [
        range({ kind: "all" }, [
          file("cart.ts"),
          file("notes.md", "untracked"),
        ]),
        range({ kind: "uncommitted" }, [
          file("cart.ts"),
          file("notes.md", "untracked"),
        ]),
      ],
    });
    expect(
      await capture(threadId, {
        upstreamLabel: "origin/main",
        ahead: 0,
        commits: [commit("5", "Round coupon totals")],
        ranges: [
          range({ kind: "all" }, [file("cart.ts")]),
          range({ kind: "commit", sha: "5".repeat(40) }, [file("cart.ts")]),
        ],
      }),
    ).toBe(true);
    expect((await shipState(threadId))?.ship_reason).toBe("default_branch");
  });

  it("does not ship a pull of the default branch, a reset that dropped the work, or a pushed feature branch", async () => {
    // Pulled main with nothing of its own.
    const puller = await seedThread();
    await capture(puller, {
      upstreamLabel: "origin/main",
      ahead: 0,
      commits: [],
      ranges: [range({ kind: "all" }, [])],
    });
    expect(
      await capture(puller, {
        upstreamLabel: "origin/main",
        ahead: 0,
        commits: [commit("9", "Someone else's fix")],
        ranges: [range({ kind: "all" }, [file("other.ts")])],
      }),
    ).toBe(false);

    // Reset to origin/main, dropping its own commit.
    const resetter = await seedThread();
    await capture(resetter, {
      upstreamLabel: "origin/main",
      ahead: 1,
      commits: [commit("6", "Experiment")],
      ranges: [range({ kind: "all" }, [file("cart.ts")])],
    });
    expect(
      await capture(resetter, {
        upstreamLabel: "origin/main",
        ahead: 0,
        commits: [commit("9", "Someone else's fix")],
        ranges: [range({ kind: "all" }, [file("other.ts")])],
      }),
    ).toBe(false);

    // Pushed to a feature branch for a pull request.
    const pusher = await seedThread();
    await capture(pusher, {
      upstreamLabel: "origin/main",
      ahead: 1,
      commits: [commit("7", "Round coupon totals")],
      ranges: [range({ kind: "all" }, [file("cart.ts")])],
    });
    expect(
      await capture(pusher, {
        upstreamLabel: "origin/fix-rounding",
        ahead: 0,
        commits: [commit("7", "Round coupon totals")],
        ranges: [range({ kind: "all" }, [file("cart.ts")])],
      }),
    ).toBe(false);
    for (const threadId of [puller, resetter, pusher])
      expect((await shipState(threadId))?.shipped_at).toBeNull();
  });
});

describe("a Space's progress by day", () => {
  const DAY = 86_400_000;
  /** Noon UTC, `daysAgo` days before today (UTC). */
  const noon = (daysAgo: number) => {
    const today = new Date().toISOString().slice(0, 10);
    return Date.parse(`${today}T12:00:00Z`) - daysAgo * DAY;
  };
  const dateOf = (instant: number) =>
    new Date(instant).toISOString().slice(0, 10);

  const setTimes = (
    threadId: ThreadId,
    times: {
      readonly created: number;
      readonly shipped?: number;
      readonly archived?: number;
    },
  ) =>
    env.DB.prepare(
      `UPDATE threads SET created_at = ?2, shipped_at = ?3,
              ship_reason = CASE WHEN ?3 IS NULL THEN NULL ELSE 'pull_request_merged' END,
              archived_at = ?4,
              lifecycle_state = CASE WHEN ?4 IS NULL THEN 'active' ELSE 'archived' END
        WHERE id = ?1`,
    )
      .bind(
        threadId,
        new Date(times.created).toISOString(),
        times.shipped ?? null,
        times.archived ?? null,
      )
      .run();

  it("counts each day's created, shipped, and archived threads and how many were open when it ended", async () => {
    const spaceId = await createSpace();
    const archivedThread = await startChild(spaceId, "Survey providers");
    const oldOpen = await startChild(spaceId, "Long-running migration");
    const shippedThread = await startChild(spaceId, "Fix coupon rounding");
    const longGone = await startChild(spaceId, "Closed long ago");
    await setTimes(archivedThread, {
      created: noon(5),
      archived: noon(2),
    });
    // Started before the window and still open: the line counts it.
    await setTimes(oldOpen, { created: noon(10) });
    await setTimes(shippedThread, { created: noon(3), shipped: noon(1) });
    // Closed before the window: it counts nowhere.
    await setTimes(longGone, { created: noon(20), archived: noon(15) });

    const response = await progress(spaceId, "?days=7&tz=UTC");
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.timeZone).toBe("UTC");
    const days = data.days as SpaceProgressDay[];
    expect(days.map(({ date }) => date)).toEqual(
      [6, 5, 4, 3, 2, 1, 0].map((ago) => dateOf(noon(ago))),
    );
    expect(
      days.map(({ created, shipped, archived, openAtEnd }) => [
        created,
        shipped,
        archived,
        openAtEnd,
      ]),
    ).toEqual([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
      [0, 0, 0, 2],
      [1, 0, 0, 3],
      [0, 0, 1, 2],
      [0, 1, 0, 1],
      [0, 0, 0, 1],
    ]);
    expect(days[1]?.threadIds).toEqual([archivedThread]);
    expect(days[3]?.threadIds).toEqual([shippedThread]);
    expect(days[4]?.threadIds).toEqual([archivedThread]);
    expect(days[5]?.threadIds).toEqual([shippedThread]);
    expect(data.totals).toEqual({ shipped: 1, archived: 1, open: 1 });
    expect(
      (data.threads as Array<{ id: string; outcome: string; title: string }>)
        .map(({ id, outcome, title }) => ({ id, outcome, title }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    ).toEqual([
      {
        id: shippedThread,
        outcome: "shipped",
        title: "Fix coupon rounding",
      },
      { id: archivedThread, outcome: "archived", title: "Survey providers" },
    ]);

    // Thirty days by default, today last.
    const month = (await progress(spaceId)).body.data
      .days as SpaceProgressDay[];
    expect(month).toHaveLength(30);
    expect(month.at(-1)?.date).toBe(dateOf(Date.now()));
  });

  it("puts a thread on the day it happened in the viewer's time zone", async () => {
    const spaceId = await createSpace();
    const child = await startChild(spaceId, "Late-night fix");
    // 03:00 UTC two days ago: the evening before in Los Angeles, midday in
    // Tokyo.
    const today = new Date().toISOString().slice(0, 10);
    const at = Date.parse(`${today}T03:00:00Z`) - 2 * DAY;
    await setTimes(child, { created: at });
    const utcDay = dateOf(at);
    const dayBefore = dateOf(at - DAY);

    const tokyo = (await progress(spaceId, "?days=7&tz=Asia%2FTokyo")).body.data
      .days as SpaceProgressDay[];
    const losAngeles = (
      await progress(spaceId, "?days=7&tz=America%2FLos_Angeles")
    ).body.data.days as SpaceProgressDay[];
    expect(tokyo.find(({ created }) => created > 0)?.date).toBe(utcDay);
    expect(losAngeles.find(({ created }) => created > 0)?.date).toBe(dayBefore);
    // Open from that day on, in each zone.
    const openFrom = (days: SpaceProgressDay[], date: string) =>
      days.map(({ date: day, openAtEnd }) => [day >= date, openAtEnd === 1]);
    expect(
      openFrom(tokyo, utcDay).every(([inWindow, open]) => inWindow === open),
    ).toBe(true);
    expect(
      openFrom(losAngeles, dayBefore).every(
        ([inWindow, open]) => inWindow === open,
      ),
    ).toBe(true);
  });

  it("shows an empty Space as thirty flat days", async () => {
    const spaceId = await createSpace("private");
    const data = (await progress(spaceId, "?tz=Europe%2FBerlin")).body.data;
    expect(data.days).toHaveLength(30);
    expect(
      (data.days as SpaceProgressDay[]).every(
        (day) =>
          day.created === 0 &&
          day.shipped === 0 &&
          day.archived === 0 &&
          day.openAtEnd === 0 &&
          day.threadIds.length === 0,
      ),
    ).toBe(true);
    expect(data.totals).toEqual({ shipped: 0, archived: 0, open: 0 });
    expect(data.threads).toEqual([]);
  });

  it("shows progress only to those who can see the Space, and refuses a bad window", async () => {
    const shared = await createSpace("workspace");
    const secret = await createSpace("private");
    expect((await progress(shared, "", member)).status).toBe(200);
    expect((await progress(shared, "", outsider)).status).toBe(404);
    expect((await progress(secret, "", member)).status).toBe(404);
    // A plain thread is no Space.
    const child = await startChild(shared, "Not a Space");
    expect((await progress(child)).status).toBe(404);
    for (const query of [
      "?tz=Mars%2FOlympus",
      "?days=0",
      "?days=91",
      "?days=ten",
    ])
      expect((await progress(shared, query)).status).toBe(400);
  });
});
