import { env } from "cloudflare:test";
import {
  claudePlanLimitText,
  Principal,
  ProjectRepository,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverGitHubWebhook } from "../../src/automations/deliver.js";
import { createSubscription } from "../../src/automations/subscriptions.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { observeFlueEvent } from "../../src/observability/flue.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { shareThreadReads } from "../../src/thread-sharing/middleware.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * How a Space's coordinator hears about its children, end to end in workerd
 * with real D1: each way a child's state changes, driven through the entry
 * point production calls (Flue's settled observation through the whole
 * observer, GitHub's webhook, the archive route), and what reaches the
 * coordinator's agent.
 *
 * Ways it could go wrong, each covered below:
 * - A child's turn fails and the coordinator is never told, so it waits
 *   for a report that never comes.
 * - A child stops on its Claude plan's limit, and the coordinator is not
 *   told it resumes by itself, or hears it again each time the child is
 *   woken during the wait.
 * - A turn ends with a tool call and no text, and is never reported.
 * - The child's history is busy at the moment its turn settles, and the
 *   report is dropped for good.
 * - A message reaches the child right after its turn ends, and the finished
 *   turn is no longer the last one, so it is never reported.
 * - A child that reported itself, including a Claude Code child whose tool
 *   names carry an `mcp__dx__` prefix, is reported twice.
 * - A child's pull request merges, or a person ships and archives it, with
 *   no turn of the child's, and the coordinator never hears it shipped; or
 *   a child woken by its own PR subscription is reported shipped twice.
 * - The same event seen twice (a redelivered webhook, a settled
 *   observation replayed) reaches the coordinator twice.
 * - A stopped turn, or a Thread no Space started, reaches a coordinator.
 *
 * The repeatable artifact: this suite prints the reports the coordinator
 * received, in order, under `[space-report]`.
 */

/**
 * A stand-in for Flue: messages dx posted to an agent as another Thread,
 * and each Thread's history as Flue serves it. A history is a queue of
 * answers, its last one kept: a number answers with that status, as Flue
 * does while busy (503).
 */
const flue = vi.hoisted(() => ({
  posts: [] as Array<{
    readonly threadId: string;
    readonly sourceThreadId: string | undefined;
    readonly body: Record<string, unknown>;
  }>,
  history: new Map<string, Array<number | Record<string, unknown>>>(),
}));
const agentPosts = flue.posts;

// No Flue agent runs here: a message posted to one is recorded, and each
// Thread's history is what the test set.
vi.mock("../../src/agents/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/routes.js")>();
  const { Hono } = await import("hono");
  const routes = new Hono<import("../../src/http/types.js").AppEnv>();
  routes.get("/:threadId", (context) => {
    const queue = flue.history.get(context.req.param("threadId")) ?? [404];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return typeof answer === "number"
      ? new Response(null, { status: answer })
      : Response.json(answer);
  });
  routes.post("/:threadId", async (context) => {
    flue.posts.push({
      threadId: context.req.param("threadId"),
      sourceThreadId: context.get("messageSourceThreadId"),
      body: await context.req.json(),
    });
    return context.json(
      { submissionId: `sub_report_${flue.posts.length}` },
      202,
    );
  });
  routes.all("*", (context) => context.json({}, 200));
  return { ...actual, dxAgentRoutes: routes };
});

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

const owner = "reports-owner" as UserId;
const workspaceId = "reports-workspace";
const REPO = "acme/checkout";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000e157",
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
  AI: { run: async () => ({ response: "" }) } as unknown as Ai,
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

const send = async (path: string, method = "GET", body?: unknown) => {
  const response = await appFor(owner).request(
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

const newSpace = async () =>
  (
    await send("/v1/spaces", "POST", {
      projectId: ownerProject.id,
      name: "dx plugin",
      sharing: "workspace",
    })
  ).body.data.space.threadId as ThreadId;

let started = 0;
/** The Space's agent starts a child, as in a real turn. */
const startChild = async (spaceId: ThreadId, title: string) => {
  started += 1;
  const tools = createThreadTools(
    spaceId,
    () => ({ db: env.DB, bindings }),
    `sub_start_${started}`,
    false,
    owner,
  );
  const tool = tools.find(({ name }) => name === "create_thread");
  if (tool === undefined) throw new Error("No create_thread tool.");
  const childId = (
    (await tool.run({
      data: { prompt: title, title },
      toolCallId: `call_${started}`,
    } as never)) as { output: { threadId: ThreadId } }
  ).output.threadId;
  await vi.waitFor(async () =>
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM thread_initial_dispatch WHERE thread_id = ?",
      )
        .bind(childId)
        .first(),
    ).toBeNull(),
  );
  return childId;
};

const observation = (event: Record<string, unknown>) =>
  ({
    timestamp: new Date().toISOString(),
    agentName: "dx",
    ...event,
  }) as unknown as FlueObservation;

const text = (value: string) => ({ type: "text", text: value });
const toolCall = (toolName: string, input: unknown) => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: `call_${toolName}_${Math.random()}`,
  state: "output-available",
  input,
});

/** A history as Flue serves it: turns, each a prompt and its answer. */
const page = (
  turns: ReadonlyArray<{
    readonly submissionId: string;
    readonly parts?: ReadonlyArray<unknown>;
    readonly outcome?: "completed" | "failed" | "aborted";
  }>,
) => ({
  messages: turns.flatMap(({ submissionId, parts }) => [
    {
      id: `msg_user_${submissionId}`,
      role: "user",
      purpose: "user",
      submissionId,
      parts: [text("Go on.")],
    },
    ...(parts === undefined
      ? []
      : [
          {
            id: `msg_reply_${submissionId}`,
            role: "assistant",
            purpose: "assistant",
            submissionId,
            parts,
          },
        ]),
  ]),
  settlements: turns.flatMap(({ submissionId, outcome }) =>
    outcome === undefined ? [] : [{ submissionId, outcome }],
  ),
});

/**
 * Flue settles one of the child's submissions: the observation production
 * receives, through the whole observer (activity, status line, reports,
 * notifications), with the child's history as Flue then serves it.
 */
const settle = (
  threadId: ThreadId,
  submissionId: string,
  history: Record<string, unknown> | Array<number | Record<string, unknown>>,
  outcome: "completed" | "failed" | "aborted" = "completed",
  error?: { readonly message: string; readonly type?: string },
) => {
  flue.history.set(threadId, Array.isArray(history) ? [...history] : [history]);
  return observeFlueEvent(
    observation({
      v: 1,
      type: "submission_settled",
      instanceId: threadId,
      submissionId,
      outcome,
      eventIndex: 1,
      ...(error === undefined ? {} : { error }),
    }),
    { env: bindings } as unknown as FlueEventContext,
  );
};

/** What the coordinator was sent, as distinct deliveries Flue admits. */
const reportsTo = (spaceId: ThreadId) => {
  const seen = new Set<unknown>();
  return agentPosts.filter(({ threadId, sourceThreadId, body }) => {
    if (threadId !== spaceId || sourceThreadId === undefined) return false;
    if (seen.has(body.idempotencyKey)) return false;
    seen.add(body.idempotencyKey);
    return true;
  });
};

const bodies = (spaceId: ThreadId) =>
  reportsTo(spaceId).map(({ body }) => String(body.body));

const evidence = (label: string, spaceId: ThreadId) =>
  console.log(
    `[space-report] ${label}: ${JSON.stringify(
      reportsTo(spaceId).map(({ sourceThreadId, body }) => ({
        from: sourceThreadId,
        body: body.body,
      })),
    )}`,
  );

const mergedPull = (number: number) => ({
  repository: { full_name: REPO },
  sender: { login: "alice" },
  pull_request: {
    number,
    title: "Fix the plugin's hook",
    body: "",
    state: "closed",
    merged: true,
    merged_at: new Date().toISOString(),
    closed_at: new Date().toISOString(),
    merge_commit_sha: "c".repeat(40),
    updated_at: new Date().toISOString(),
    user: { login: "alice" },
    html_url: `https://github.com/${REPO}/pull/${number}`,
  },
});

beforeEach(async () => {
  agentPosts.length = 0;
  flue.history.clear();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(owner, "Ravi Owner", `${owner}@example.com`),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Reports', 'reports', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('reports-owner-m', ?1, ?2, 'owner', 1)`,
    ).bind(workspaceId, owner),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
    }),
  );
  seedSpaceUsers([owner]);
});

// Each case starts a Space and its children in workerd: past 5 s under load.
describe("a Space's coordinator hears each change of its children", {
  timeout: 30_000,
}, () => {
  it("hears a finished turn once, and not again when the child reported itself", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Survey plugin hooks");
    const answer = "The plugin has 4 hooks; 2 are unused.";

    await settle(
      child,
      "sub_a",
      page([
        { submissionId: "sub_a", parts: [text(answer)], outcome: "completed" },
      ]),
    );
    // The same settlement seen again carries the same key.
    await settle(
      child,
      "sub_a",
      page([
        { submissionId: "sub_a", parts: [text(answer)], outcome: "completed" },
      ]),
    );
    // A dx child and a Claude Code child that messaged the Space themselves.
    for (const [submissionId, tool] of [
      ["sub_b", "send_thread_message"],
      ["sub_c", "mcp__dx__send_thread_message"],
    ] as const)
      await settle(
        child,
        submissionId,
        page([
          {
            submissionId,
            parts: [
              toolCall(tool, { thread: spaceId, message: "Done." }),
              text("Reported."),
            ],
            outcome: "completed",
          },
        ]),
      );

    evidence("finished turn", spaceId);
    expect(bodies(spaceId)).toEqual([answer]);
    expect(reportsTo(spaceId)[0]?.sourceThreadId).toBe(child);
  });

  it("hears a finished turn even when a new message reached the child right after it", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Fix the plugin hook");
    // By the time dx reads the history, a person's next message is in it.
    await settle(
      child,
      "sub_done",
      page([
        {
          submissionId: "sub_done",
          parts: [text("Fixed the hook and opened PR #7.")],
          outcome: "completed",
        },
        { submissionId: "sub_next" },
      ]),
    );
    evidence("finished turn, next message queued", spaceId);
    expect(bodies(spaceId)).toEqual(["Fixed the hook and opened PR #7."]);
  });

  it("hears a finished turn when the child's history is busy at first", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Count plugin files");
    // Flue answers 503 while busy; the read after it serves the turn.
    await settle(child, "sub_busy", [
      503,
      page([
        {
          submissionId: "sub_busy",
          parts: [text("Counted 31 files.")],
          outcome: "completed",
        },
      ]),
    ]);
    evidence("finished turn, history busy once", spaceId);
    expect(bodies(spaceId)).toEqual(["Counted 31 files."]);
  });

  it("hears a turn that ended without a written answer", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Ask about the plugin name");
    await settle(
      child,
      "sub_silent",
      page([
        {
          submissionId: "sub_silent",
          parts: [
            text("I'll ask the owner."),
            toolCall("notify_user", {
              title: "Plugin name",
              body: "Which name should the plugin use?",
            }),
          ],
          outcome: "completed",
        },
      ]),
    );
    evidence("turn without an answer", spaceId);
    const [report] = bodies(spaceId);
    expect(bodies(spaceId)).toHaveLength(1);
    expect(report).toMatch(/without a written answer/);
  });

  it("hears a failed turn once, with its error (as main already did)", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Build the plugin");
    const failed = page([{ submissionId: "sub_fail", outcome: "failed" }]);
    const error = {
      type: "provider_error",
      message: "The model provider returned 529 Overloaded.",
    };
    await settle(child, "sub_fail", failed, "failed", error);
    await settle(child, "sub_fail", failed, "failed", error);
    evidence("failed turn", spaceId);
    expect(bodies(spaceId)).toHaveLength(1);
    expect(bodies(spaceId)[0]).toMatch(/failed its turn and could not reply/);
    expect(bodies(spaceId)[0]).toContain("529 Overloaded");
  });

  it("hears once that a Claude Code child waits for its plan to reset, however often it is woken meanwhile", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Refactor the plugin loader");
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const message = claudePlanLimitText({
      window: "five_hour",
      resetsAt,
      cause: "exhausted",
    });
    // Its turn hits the limit; the Space wakes it twice more while it
    // waits, the last time 40 minutes later, and each wake fails the same.
    const startedAt = Date.now();
    for (const [submissionId, minutes] of [
      ["sub_limit_1", 0],
      ["sub_limit_2", 5],
      ["sub_limit_3", 40],
    ] as const) {
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(startedAt + minutes * 60_000);
      await settle(
        child,
        submissionId,
        page([{ submissionId, outcome: "failed" }]),
        "failed",
        { message },
      );
      clock.mockRestore();
    }
    evidence("Claude plan wait", spaceId);
    expect(bodies(spaceId)).toHaveLength(1);
    const [report] = bodies(spaceId);
    expect(report).toMatch(/Claude plan limit reached/);
    expect(report).toContain(
      `runs it again by itself when the plan resets at ${new Date(
        resetsAt * 1000,
      )
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")} UTC`,
    );

    // The plan resets and the resumed turn finishes: that is reported too.
    await settle(
      child,
      "sub_resumed",
      page([
        {
          submissionId: "sub_resumed",
          parts: [text("Refactored the loader.")],
          outcome: "completed",
        },
      ]),
    );
    expect(bodies(spaceId)).toHaveLength(2);
    expect(bodies(spaceId)[1]).toBe("Refactored the loader.");
  });

  it("hears that a child shipped when its PR merges with no turn of its own, once", async () => {
    const spaceId = await newSpace();
    const linked = await startChild(spaceId, "Fix the plugin hook");
    const subscribed = await startChild(spaceId, "Add plugin docs");
    // One thread is only linked to its PR; the other also follows its
    // comments, so the merge wakes it and it reports itself.
    await env.DB.prepare(
      `INSERT INTO thread_github_link (thread_id, repository_key, repository,
         number, kind, created_at)
       VALUES (?1, lower(?2), ?2, 41, 'pull', ?3)`,
    )
      .bind(linked, REPO, new Date().toISOString())
      .run();
    await createSubscription(env.DB, owner, {
      title: "PR #42 comments and reviews",
      repository: REPO,
      kind: "pr-comments",
      filter: { prNumber: 42 },
      destination: "this-thread",
      threadId: subscribed,
      projectId: null,
      agentMode: null,
      instructions: null,
      automatic: true,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(41),
    );
    // GitHub redelivers the same webhook.
    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(41),
    );
    await deliverGitHubWebhook(
      bindings,
      "pull_request",
      "closed",
      mergedPull(42),
    );

    evidence("PR merged", spaceId);
    const reports = reportsTo(spaceId);
    expect(reports.map(({ sourceThreadId }) => sourceThreadId)).toEqual([
      linked,
    ]);
    expect(String(reports[0]?.body.body)).toMatch(/shipped/);
    expect(String(reports[0]?.body.body)).toContain(`${REPO}#41`);
  });

  it("hears that a person shipped and archived a child", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Release the plugin");
    const archived = await send(`/v1/threads/${child}/archive`, "PATCH", {
      archived: true,
      reason: "ship",
    });
    expect(archived.status).toBe(200);
    evidence("ship-archived", spaceId);
    expect(bodies(spaceId)).toHaveLength(1);
    expect(bodies(spaceId)[0]).toMatch(/shipped/);
  });

  it("hears nothing of a stopped turn, or of a Thread no Space started", async () => {
    const spaceId = await newSpace();
    const child = await startChild(spaceId, "Try a plugin idea");
    await settle(
      child,
      "sub_stop",
      page([{ submissionId: "sub_stop", outcome: "aborted" }]),
      "aborted",
    );
    const loose = await startChild(spaceId, "Loose work");
    await env.DB.prepare(
      "UPDATE threads SET parent_thread_id = NULL, started_by_thread_id = NULL WHERE id = ?",
    )
      .bind(loose)
      .run();
    await settle(
      loose,
      "sub_loose",
      page([{ submissionId: "sub_loose", outcome: "failed" }]),
      "failed",
      { message: "Boom." },
    );
    expect(reportsTo(spaceId)).toEqual([]);
  });
});
