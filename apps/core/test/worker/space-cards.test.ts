import { env } from "cloudflare:test";
import {
  parseMessageAuthor,
  type SpaceCatchUp,
  type SpaceThreadItem,
} from "@dx/api";
import {
  claudePlanLimitText,
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import type { FlueObservation } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { recordSpaceStatusLine } from "../../src/spaces/status-line.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { createArtifactTools } from "../../src/thread-artifacts/agent-tools.js";
import { artifactSaved } from "../../src/thread-artifacts/ask-effects.js";
import { saveArtifact } from "../../src/thread-artifacts/store.js";
import type {
  HistoryMessage,
  HistoryRead,
} from "../../src/thread-search/history.js";
import {
  reconcileStaleThreadActivity,
  recordFlueThreadActivity,
} from "../../src/threads/activity.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * A Space's thread cards and catch-up card, end to end in workerd with real
 * D1: the status line each child's activity writes, the state its card
 * shows, one card's read, and "Since you've been gone".
 *
 * Ways it could go wrong: a status line is written for a Thread no Space
 * started; a running turn keeps the last turn's past-tense line, or a
 * finished turn keeps "Counting…"; a slow finished-turn line lands after a
 * new turn started; Workers AI's answer is stored unchecked (prose, Markdown,
 * too long); an open ask, an open pull request, uncommitted changes, a
 * failed turn, shipping, or archiving shows the wrong state; ticking the ask
 * keeps Needs You; one card's read reaches a thread of another Space; the
 * catch-up card shows on a first visit, after a short absence, or with
 * nothing changed; it links threads outside the Space; it is written again
 * on every read; a dismissed card returns.
 */

/** Each first message dx handed Flue, as the child's agent reads it. */
const dispatched = vi.hoisted(
  () => [] as Array<{ readonly id: string; readonly body: string }>,
);

/** Messages dx posted to an agent as another Thread, as Flue receives them. */
const agentPosts = vi.hoisted(
  () =>
    [] as Array<{
      readonly path: string;
      readonly sourceThreadId: string | undefined;
      readonly body: Record<string, unknown>;
    }>,
);

/** Submissions each agent's Flue history says settled, and how. */
const agentSettlements = vi.hoisted(
  () =>
    new Map<
      string,
      Array<{ readonly submissionId: string; readonly outcome: string }>
    >(),
);

// No Flue agent runs here: a message posted to one is recorded.
vi.mock("../../src/agents/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/routes.js")>();
  const { Hono } = await import("hono");
  const routes = new Hono<import("../../src/http/types.js").AppEnv>();
  // Flue's history read: what each agent says it settled.
  routes.get("/:threadId", (context) => {
    const settlements = agentSettlements.get(context.req.param("threadId"));
    return settlements === undefined
      ? context.json({ error: "not found" }, 404)
      : context.json({ messages: [], settlements });
  });
  routes.post("/:threadId", async (context) => {
    agentPosts.push({
      path: `/v1/agents/dx/${context.req.param("threadId")}`,
      sourceThreadId: context.get("messageSourceThreadId"),
      body: await context.req.json(),
    });
    return context.json(
      { submissionId: `sub_report_${agentPosts.length}` },
      202,
    );
  });
  return { ...actual, dxAgentRoutes: routes };
});

vi.mock("../../src/threads/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/threads/routes.js")>();
  return {
    ...actual,
    threadRoutes: actual.createThreadRoutes(
      async (request) => {
        const { id, message } = request as {
          readonly id: string;
          readonly message: { readonly body: string };
        };
        dispatched.push({ id, body: message.body });
        return { submissionId: `sub_${id}` } as never;
      },
      async () => undefined,
      async () => null,
    ),
  };
});

const owner = "cards-owner" as UserId;
const member = "cards-member" as UserId;
const workspaceId = "cards-workspace";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000c154",
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

const model = vi.hoisted(() => ({
  calls: [] as Array<{ readonly model: string; readonly input: unknown }>,
  answer: "" as string,
}));

const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  AI: {
    run: async (name: string, input: unknown) => {
      model.calls.push({ model: name, input });
      return { response: model.answer };
    },
  } as unknown as Ai,
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

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const newSpace = async (name = "Checkout v2") =>
  (
    await send(owner, "/v1/spaces", "POST", {
      projectId: ownerProject.id,
      name,
      sharing: "workspace",
    })
  ).body.data.space.threadId as ThreadId;

/** The Space's agent starts a child for the member, as in a real turn. */
const startChild = async (spaceId: ThreadId, title: string) => {
  const tools = createThreadTools(
    spaceId,
    () => ({ db: env.DB, bindings }),
    `sub_${title}`,
    false,
    member,
  );
  const createThread = tools.find(({ name }) => name === "create_thread");
  if (createThread === undefined) throw new Error("No create_thread tool.");
  const childId = (
    (await createThread.run({
      data: { prompt: `"${title}" — Ben`, title },
      toolCallId: `call_${title}`,
    } as never)) as { output: { threadId: ThreadId } }
  ).output.threadId;
  // Its first message's delivery can outlive the response; let it finish.
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

/** A standalone Thread of the owner, which no Space started. */
const startRootThread = async () => {
  const tools = createThreadTools(
    (await newSpace("Elsewhere")) as ThreadId,
    () => ({ db: env.DB, bindings }),
  );
  const createThread = tools.find(({ name }) => name === "create_thread");
  if (createThread === undefined) throw new Error("No create_thread tool.");
  const child = (
    (await createThread.run({
      data: { prompt: "Loose work", title: "Loose work" },
      toolCallId: "call_loose",
    } as never)) as { output: { threadId: ThreadId } }
  ).output.threadId;
  // Detach it: a Thread whose parent is no Space.
  await env.DB.prepare(
    "UPDATE threads SET parent_thread_id = NULL, started_by_thread_id = NULL WHERE id = ?",
  )
    .bind(child)
    .run();
  return child;
};

/** The child's first turn, which create_thread started, settles. */
const settleFirstTurn = (threadId: ThreadId) =>
  recordFlueThreadActivity(
    observation({
      type: "submission_settled",
      instanceId: threadId,
      submissionId: `sub_${threadId}`,
      outcome: "completed",
    }),
    { env: bindings } as never,
  );

const setActivity = (threadId: ThreadId, status: "working" | "idle") =>
  env.DB.prepare("UPDATE threads SET activity_status = ? WHERE id = ?")
    .bind(status, threadId)
    .run();

const statusLine = async (threadId: ThreadId) =>
  (
    await env.DB.prepare("SELECT status_line FROM threads WHERE id = ?")
      .bind(threadId)
      .first<{ status_line: string | null }>()
  )?.status_line ?? null;

const observation = (event: Record<string, unknown>) =>
  ({
    timestamp: new Date().toISOString(),
    agentName: "dx",
    ...event,
  }) as unknown as FlueObservation;

const finishedTurn = (
  threadId: ThreadId,
  submissionId: string,
  reply: string,
): HistoryRead => {
  const messages: HistoryMessage[] = [
    {
      id: "msg_user",
      role: "user",
      purpose: "user",
      submissionId,
      parts: [{ type: "text", text: "Count the .tsx files." }],
    } as HistoryMessage,
    {
      id: "msg_reply",
      role: "assistant",
      purpose: "assistant",
      submissionId,
      parts: [{ type: "text", text: reply }],
    } as HistoryMessage,
  ];
  void threadId;
  return {
    kind: "page",
    page: {
      messages,
      settled: new Map([[submissionId, "completed"]]),
      failures: new Map(),
      answeredBy: new Map(),
      hasOlder: false,
    },
  };
};

const card = async (spaceId: ThreadId, childId: ThreadId) => {
  const response = await send(
    member,
    `/v1/spaces/${spaceId}/threads/${childId}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.item as SpaceThreadItem;
};

const catchUp = async (spaceId: ThreadId, userId = member) => {
  const response = await send(userId, `/v1/spaces/${spaceId}/catch-up`);
  expect(response.status).toBe(200);
  return response.body.data.catchUp as SpaceCatchUp | null;
};

beforeEach(async () => {
  agentSettlements.clear();
  model.calls.length = 0;
  model.answer = "";
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(workspaceId, "Cards Team", "cards-team"),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('cards-owner-m', ?1, ?2, 'owner', 1),
         ('cards-member-m', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(ownerProject);
    }),
  );
});

beforeEach(() => seedSpaceUsers([owner, member]));

describe("Space thread cards in workerd with real D1", () => {
  it("keeps a Space child's status line current from its own activity", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "TSX file count");
    const history = vi.fn(async () =>
      finishedTurn(
        childId,
        "sub_2",
        "There are **453** `.tsx` files under `apps/web`. I didn't change any code.",
      ),
    );

    // A turn starting clears any line from before.
    await env.DB.prepare(
      "UPDATE threads SET status_line = 'Old line' WHERE id = ?",
    )
      .bind(childId)
      .run();
    await setActivity(childId, "working");
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "submission_running",
        instanceId: childId,
        submissionId: "sub_2",
      }),
    );
    expect(await statusLine(childId)).toBeNull();

    // While it works, the agent's stated next step names the line, with no
    // model call.
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "turn",
        instanceId: childId,
        submissionId: "sub_2",
        purpose: "agent",
        isError: false,
        response: {
          output: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I'll count the .tsx files under `apps/web` with rg.",
              },
              {
                type: "toolCall",
                id: "call_1",
                name: "shell_command",
                arguments: { command: "rg --files apps/web | grep -c tsx$" },
              },
            ],
          },
        },
      }),
    );
    expect(await statusLine(childId)).toBe(
      "Counting the .tsx files under apps/web with rg",
    );
    expect(model.calls).toEqual([]);

    // When the turn completes, one Workers AI call writes a past-tense line
    // from the agent's final message; only one plain line is kept.
    await setActivity(childId, "idle");
    model.answer = '"Counted 453 .tsx files in apps/web."\nExtra prose.';
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_2",
        outcome: "completed",
      }),
      undefined,
      history,
    );
    expect(await statusLine(childId)).toBe(
      "Counted 453 .tsx files in apps/web",
    );
    expect(model.calls).toHaveLength(1);
    expect(JSON.stringify(model.calls[0]?.input)).toContain(
      "There are **453**",
    );

    // An unusable answer falls back to the reply's first sentence.
    model.answer = "";
    await env.DB.prepare("UPDATE threads SET status_line = NULL WHERE id = ?")
      .bind(childId)
      .run();
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_2",
        outcome: "completed",
      }),
      undefined,
      history,
    );
    expect(await statusLine(childId)).toBe(
      "There are 453 .tsx files under apps/web",
    );

    // A finished line that arrives after a new turn started is dropped.
    await setActivity(childId, "working");
    await env.DB.prepare("UPDATE threads SET status_line = NULL WHERE id = ?")
      .bind(childId)
      .run();
    model.answer = "Counted 453 .tsx files in apps/web";
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_2",
        outcome: "completed",
      }),
      undefined,
      history,
    );
    expect(await statusLine(childId)).toBeNull();
    // Several observed turns in one test: past the 5 s default under load.
  }, 15_000);

  it("says in plain words what a working Space child does, never its raw command or paths", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Repo survey");
    await setActivity(childId, "working");
    // Lines change at most every few seconds; each turn here is later.
    let clock = Date.now();
    const frozen = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const lineFor = async (
      content: ReadonlyArray<Record<string, unknown>>,
    ): Promise<string | null> => {
      clock += 60_000;
      await recordSpaceStatusLine(
        bindings,
        observation({
          type: "turn",
          instanceId: childId,
          submissionId: "sub_survey",
          purpose: "agent",
          isError: false,
          response: { output: { role: "assistant", content } },
        }),
      );
      return statusLine(childId);
    };
    const shell = (command: string, extra: Record<string, unknown> = {}) => [
      {
        type: "toolCall",
        id: `call_${clock}`,
        name: "shell_command",
        arguments: { command, ...extra },
      },
    ];
    const cases: ReadonlyArray<
      readonly [ReadonlyArray<Record<string, unknown>>, string]
    > = [
      [
        shell("ls -la /home/user/workspace/repo && echo '---' && ls"),
        "Listing files in repo",
      ],
      [
        shell("rg --files -g '*.tsx' | wc -l; rg --files -g '*.ts' | wc -l"),
        "Counting .tsx files",
      ],
      [
        shell("cd /home/user/workspace/repo && rg --files apps/web | wc -l"),
        "Counting files in apps/web",
      ],
      [
        shell("sed -n '1,80p' /home/user/workspace/repo/src/index.ts"),
        "Reading index.ts",
      ],
      [shell("rg -n 'couponTotal' src"), "Searching for couponTotal"],
      [shell("pnpm --filter @dx/web test -- --run"), "Running the tests"],
      [shell("git status --short && git diff --stat"), "Checking Git status"],
      [shell("pnpm install --frozen-lockfile"), "Installing dependencies"],
      [shell("python3 -c 'import json; print(1)'"), "Running a script"],
      [shell("make -j4 > /tmp/build.log 2>&1"), "Building the project"],
      [shell("frobnicate --all /srv/data"), "Running a command"],
      // A tool's own description for people wins.
      [
        shell("find . -name '*.md' | xargs wc -w", {
          description: "Counting words in the docs",
        }),
        "Counting words in the docs",
      ],
      // A stated next step that is itself a raw command is not used.
      [
        [
          {
            type: "text",
            text: "I'll run `ls -la /home/user/workspace/repo`.",
          },
          ...shell("ls -la /home/user/workspace/repo"),
        ],
        "Listing files in repo",
      ],
      [
        [
          {
            type: "toolCall",
            id: "call_read",
            name: "read",
            arguments: { path: "/home/user/workspace/repo/README.md" },
          },
        ],
        "Reading README.md",
      ],
    ];
    for (const [content, expected] of cases) {
      const line = await lineFor(content);
      expect(line).toBe(expected);
      expect(line?.length ?? 0).toBeLessThanOrEqual(60);
      expect(line).not.toMatch(/\/home|&&|\||;|\s-{1,2}[a-z]/);
    }
    expect(model.calls).toEqual([]);
    frozen.mockRestore();
  });

  it("credits a child's first message to the person who asked the Space", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Folder overview");
    const first = dispatched.find(({ id }) => id === childId);
    expect(first).toBeDefined();
    const tag = parseMessageAuthor(first?.body ?? "");
    expect(tag.author).toMatchObject({
      role: "contributor",
      userId: member,
      name: "Ben Member",
    });
    // Still marked as the Space's, which the child reports back to.
    expect(tag.sourceThreadId).toBe(spaceId);
    expect(tag.text).toBe('"Folder overview" — Ben');
  });

  it("reports a child's finished turn to its Space once when the child did not", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Folder overview");
    await setActivity(childId, "idle");
    agentPosts.length = 0;
    const settle = (
      submissionId: string,
      history: HistoryRead,
      outcome = "completed",
      threadId = childId,
    ) =>
      recordSpaceStatusLine(
        bindings,
        observation({
          type: "submission_settled",
          instanceId: threadId,
          submissionId,
          outcome,
        }),
        undefined,
        async () => history,
      );
    const reply =
      "The repo has **5** top-level folders: `src/` (the extension), `test/`, `docs/`, `scripts/`, and `skills/`.";

    // The child answered in its own chat and never messaged the Space.
    await settle("sub_overview", finishedTurn(childId, "sub_overview", reply));
    expect(agentPosts).toHaveLength(1);
    expect(agentPosts[0]).toMatchObject({
      path: `/v1/agents/dx/${spaceId}`,
      sourceThreadId: childId,
      body: { kind: "user", body: reply },
    });
    // Seen again, the same turn's report carries the same key, which Flue
    // admits once.
    await settle("sub_overview", finishedTurn(childId, "sub_overview", reply));
    expect(
      new Set(agentPosts.map(({ body }) => body.idempotencyKey)).size,
    ).toBe(1);
    expect(agentPosts[1]?.body).toEqual(agentPosts[0]?.body);

    // A turn in which the child reported itself gets no second report.
    agentPosts.length = 0;
    const reported = finishedTurn(childId, "sub_reported", "Sent it over.");
    if (reported.kind !== "page") throw new Error("Expected a page.");
    const [prompt, answer] = reported.page.messages;
    await settle("sub_reported", {
      kind: "page",
      page: {
        ...reported.page,
        messages: [
          prompt as HistoryMessage,
          {
            id: "msg_tool",
            role: "assistant",
            purpose: "assistant",
            submissionId: "sub_reported",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "send_thread_message",
                toolCallId: "call_report",
                state: "output-available",
                input: { thread: spaceId, message: "5 folders." },
              },
            ],
          } as HistoryMessage,
          answer as HistoryMessage,
        ],
      },
    });
    expect(agentPosts).toEqual([]);

    // A long answer is shortened at a paragraph, and says so.
    const long = Array.from(
      { length: 12 },
      (_, index) =>
        `Folder ${index + 1} holds part of the extension and its tests, described at some length here.`,
    ).join("\n\n");
    await settle("sub_long", finishedTurn(childId, "sub_long", long));
    const shortened = String(agentPosts[0]?.body.body);
    expect(shortened.length).toBeLessThanOrEqual(900);
    expect(shortened.startsWith("Folder 1 holds part")).toBe(true);
    expect(shortened).toContain("The whole answer is in the thread.");

    // A failed turn, and a Thread no Space started, report nothing.
    agentPosts.length = 0;
    await settle(
      "sub_failed",
      finishedTurn(childId, "sub_failed", reply),
      "failed",
    );
    const loose = await startRootThread();
    await settle(
      "sub_loose",
      finishedTurn(loose, "sub_loose", reply),
      "completed",
      loose,
    );
    // Only a new Space's own setup message reached an agent; no report did.
    expect(
      agentPosts.filter(({ sourceThreadId }) => sourceThreadId !== undefined),
    ).toEqual([]);
    expect(
      model.calls.every(
        ({ input }) => !JSON.stringify(input).includes("report"),
      ),
    ).toBe(true);
  });

  it("writes no status line for a Thread no Space started", async () => {
    const loose = await startRootThread();
    await setActivity(loose, "working");
    await recordSpaceStatusLine(
      bindings,
      observation({
        type: "turn",
        instanceId: loose,
        submissionId: "sub_x",
        purpose: "agent",
        isError: false,
        response: {
          output: {
            role: "assistant",
            content: [{ type: "text", text: "I'll run the tests." }],
          },
        },
      }),
    );
    expect(await statusLine(loose)).toBeNull();
  });

  it("shows a child the Space just started as working until its first turn settles", async () => {
    const spaceId = await newSpace();
    // Its first message is admitted before create_thread returns.
    const childId = await startChild(spaceId, "Coupon rounding");
    expect((await card(spaceId, childId)).state).toBe("working");

    // Its first message stored but not admitted yet: also working.
    const waiting = await startChild(spaceId, "Refund totals");
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM thread_activity_submission WHERE thread_id = ?",
      ).bind(waiting),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle' WHERE id = ?",
      ).bind(waiting),
      env.DB.prepare(
        `INSERT INTO thread_initial_dispatch (
           thread_id, request_json, sender_user_id, created_at
         ) VALUES (?, '{}', ?, ?)`,
      ).bind(waiting, member, Date.now()),
    ]);
    expect((await card(spaceId, waiting)).state).toBe("working");
    const listed = await send(member, `/v1/spaces/${spaceId}/threads`);
    expect(
      (listed.body.data.items as SpaceThreadItem[]).map(({ id, state }) => [
        id,
        state,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [childId, "working"],
        [waiting, "working"],
      ]),
    );

    // Its first turn settles: idle.
    await settleFirstTurn(childId);
    expect((await card(spaceId, childId)).state).toBe("idle");
  });

  it("shows each card's state from the thread's own signals", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Coupon rounding");
    const otherSpace = await newSpace("Search relevance");
    const stranger = await startChild(otherSpace, "Ranking");
    await settleFirstTurn(childId);

    expect((await card(spaceId, childId)).state).toBe("idle");
    // One card reads only this Space's threads.
    expect(
      (await send(member, `/v1/spaces/${spaceId}/threads/${stranger}`)).status,
    ).toBe(404);

    await setActivity(childId, "working");
    expect(await card(spaceId, childId)).toMatchObject({
      state: "working",
      requestedBy: { userId: member, name: "Ben Member" },
    });
    await setActivity(childId, "idle");

    // The agent asks a person for something with a checklist item.
    const [artifactTool] = createArtifactTools(childId, () => ({
      db: env.DB,
      bindings,
    }));
    if (artifactTool === undefined) throw new Error("No artifact tool.");
    const plan = `- [ ] @[Ben Member](user:${member}) Which provider should refunds use?\n`;
    const artifactId = (
      (await artifactTool.run({
        data: { action: "create", title: "Plan", markdown: plan },
        toolCallId: "call_plan",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never)) as { output: { artifact_id: string } }
    ).output.artifact_id;
    expect((await card(spaceId, childId)).state).toBe("needs_you");

    // Ticking the ask answers it.
    const saved = await saveArtifact(bindings, {
      threadId: childId,
      artifactId,
      baseRevision: 1,
      markdown: plan.replace("- [ ]", "- [x]"),
      writer: { kind: "user", userId: member },
    });
    if (saved.kind !== "saved") throw new Error(`save: ${saved.kind}`);
    await artifactSaved(bindings, {
      threadId: childId,
      artifactId,
      title: "Plan",
      revision: saved.value.artifact.revision,
      before: saved.previous,
      after: saved.value.markdown,
      writer: { kind: "user", userId: member },
    });
    expect((await card(spaceId, childId)).state).toBe("idle");

    // An open pull request, or uncommitted changes, is ready to ship.
    await env.DB.prepare(
      `INSERT INTO thread_github_link (thread_id, repository, repository_key, number, kind, subject_json, created_at)
       VALUES (?1, 'acme/checkout', 'acme/checkout', 7, 'pull', ?2, ?3)`,
    )
      .bind(
        childId,
        JSON.stringify({ title: "Round coupons", summary: "", state: "open" }),
        new Date().toISOString(),
      )
      .run();
    expect((await card(spaceId, childId)).state).toBe("ready_to_ship");
    await env.DB.prepare(
      "UPDATE thread_github_link SET subject_json = json_set(subject_json, '$.state', 'merged') WHERE thread_id = ?",
    )
      .bind(childId)
      .run();
    expect((await card(spaceId, childId)).state).toBe("idle");

    // A failed turn shows Failed until a turn starts again.
    await env.DB.prepare("UPDATE threads SET turn_failed = 1 WHERE id = ?")
      .bind(childId)
      .run();
    expect((await card(spaceId, childId)).state).toBe("failed");

    // Archiving, then shipping, which wins.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', archived_at = ?2 WHERE id = ?1",
    )
      .bind(childId, Date.now())
      .run();
    expect((await card(spaceId, childId)).state).toBe("archived");
    await env.DB.prepare(
      "UPDATE threads SET shipped_at = ?2, ship_reason = 'pull_request_merged' WHERE id = ?1",
    )
      .bind(childId, Date.now())
      .run();
    expect((await card(spaceId, childId)).state).toBe("shipped");

    // The list carries the same state.
    const listed = (await send(member, `/v1/spaces/${spaceId}/threads`)).body
      .data.items as SpaceThreadItem[];
    expect(listed.find(({ id }) => id === childId)?.state).toBe("shipped");
  });

  it("moves a shipped thread back to open while it runs again, and back to Shipped once it rests", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Coupon rounding");
    await settleFirstTurn(childId);
    const shippedAt = Date.now() - 60_000;
    await env.DB.prepare(
      "UPDATE threads SET shipped_at = ?2, ship_reason = 'pull_request_merged' WHERE id = ?1",
    )
      .bind(childId, shippedAt)
      .run();
    expect((await card(spaceId, childId)).state).toBe("shipped");

    // Someone asks it for more after it shipped: it runs, so it is open.
    await recordFlueThreadActivity(
      observation({
        type: "submission_running",
        instanceId: childId,
        submissionId: "sub_after_ship",
      }),
      { env: bindings } as never,
    );
    const running = await card(spaceId, childId);
    expect(running.state).toBe("working");
    expect(running.shippedAt).not.toBeNull();
    const listed = (await send(member, `/v1/spaces/${spaceId}/threads`)).body
      .data.items as SpaceThreadItem[];
    expect(listed.find(({ id }) => id === childId)?.state).toBe("working");

    // It asks a person something: Needs You, not Shipped.
    await env.DB.prepare(
      "INSERT INTO thread_attention_request (thread_id, kind, requested_at) VALUES (?, 'question', ?)",
    )
      .bind(childId, new Date().toISOString())
      .run();
    await recordFlueThreadActivity(
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_after_ship",
        outcome: "completed",
      }),
      { env: bindings } as never,
    );
    expect((await card(spaceId, childId)).state).toBe("needs_you");
    await env.DB.prepare(
      "DELETE FROM thread_attention_request WHERE thread_id = ?",
    )
      .bind(childId)
      .run();

    // It rests with nothing new to ship: Shipped again.
    expect((await card(spaceId, childId)).state).toBe("shipped");

    // It opened a new pull request after shipping: Ready to Ship.
    await env.DB.prepare(
      `INSERT INTO thread_github_link (thread_id, repository, repository_key, number, kind, subject_json, created_at)
       VALUES (?1, 'acme/checkout', 'acme/checkout', 8, 'pull', ?2, ?3)`,
    )
      .bind(
        childId,
        JSON.stringify({ title: "Round taxes", summary: "", state: "open" }),
        new Date().toISOString(),
      )
      .run();
    expect((await card(spaceId, childId)).state).toBe("ready_to_ship");
    await env.DB.prepare("DELETE FROM thread_github_link WHERE thread_id = ?")
      .bind(childId)
      .run();

    // A turn after shipping failed: Failed, not Shipped.
    await recordFlueThreadActivity(
      observation({
        type: "submission_running",
        instanceId: childId,
        submissionId: "sub_fails_after_ship",
      }),
      { env: bindings } as never,
    );
    await recordFlueThreadActivity(
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_fails_after_ship",
        outcome: "failed",
      }),
      { env: bindings } as never,
    );
    expect((await card(spaceId, childId)).state).toBe("failed");

    // Shipped from its Ship outcome, archived, then restored and running.
    const restored = await startChild(spaceId, "Refund totals");
    await settleFirstTurn(restored);
    await env.DB.prepare(
      "UPDATE threads SET shipped_at = ?2, ship_reason = 'ship_archived', lifecycle_state = 'archived', archived_at = ?2 WHERE id = ?1",
    )
      .bind(restored, Date.now() - 60_000)
      .run();
    expect((await card(spaceId, restored)).state).toBe("shipped");
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active', restored_at = ?2 WHERE id = ?1",
    )
      .bind(restored, Date.now())
      .run();
    await recordFlueThreadActivity(
      observation({
        type: "submission_running",
        instanceId: restored,
        submissionId: "sub_restored",
      }),
      { env: bindings } as never,
    );
    expect((await card(spaceId, restored)).state).toBe("working");
  });

  it("shows a thread waiting for its Claude plan to reset as resting, not Failed", async () => {
    const spaceId = await newSpace();
    const childId = await startChild(spaceId, "Coupon rounding");
    await recordFlueThreadActivity(
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: `sub_${childId}`,
        outcome: "failed",
        error: {
          message: claudePlanLimitText({
            window: "five_hour",
            resetsAt: Math.floor(Date.now() / 1000) + 3_600,
            cause: "exhausted",
          }),
        },
      }),
      { env: bindings } as never,
    );
    // The limit text started a wait for the plan's reset.
    expect(
      await env.DB.prepare("SELECT 1 FROM thread_plan_wait WHERE thread_id = ?")
        .bind(childId)
        .first(),
    ).not.toBeNull();
    expect((await card(spaceId, childId)).state).toBe("idle");

    // The plan resets and the resumed turn runs: working.
    await recordFlueThreadActivity(
      observation({
        type: "submission_running",
        instanceId: childId,
        submissionId: "sub_resumed",
      }),
      { env: bindings } as never,
    );
    expect((await card(spaceId, childId)).state).toBe("working");

    // A failure that is not a plan limit still shows Failed.
    await recordFlueThreadActivity(
      observation({
        type: "submission_settled",
        instanceId: childId,
        submissionId: "sub_resumed",
        outcome: "failed",
        error: { message: "The model provider refused the request." },
      }),
      { env: bindings } as never,
    );
    expect((await card(spaceId, childId)).state).toBe("failed");
  });

  it("settles a turn whose settlement dx missed, so a thread that stopped stops showing as running", async () => {
    const spaceId = await newSpace();
    const lost = await startChild(spaceId, "Coupon rounding");
    const failed = await startChild(spaceId, "Refund totals");
    const running = await startChild(spaceId, "Tax rounding");
    const orphan = await startChild(spaceId, "Search relevance");
    // Each first turn started ten minutes ago; dx never heard any settle.
    await env.DB.prepare(
      "UPDATE thread_activity_submission SET observed_at = ?2 WHERE thread_id IN (SELECT id FROM threads WHERE parent_thread_id = ?1)",
    )
      .bind(spaceId, new Date(Date.now() - 10 * 60_000).toISOString())
      .run();
    for (const id of [lost, failed, running, orphan])
      expect((await card(spaceId, id)).state).toBe("working");
    // Flue settled two of them; the third still runs.
    agentSettlements.set(lost, [
      { submissionId: `sub_${lost}`, outcome: "completed" },
    ]);
    agentSettlements.set(failed, [
      { submissionId: `sub_${failed}`, outcome: "failed" },
    ]);
    agentSettlements.set(running, []);
    // The fourth's agent has no conversation at all: nothing can be running.

    await reconcileStaleThreadActivity(bindings, Date.now());

    expect((await card(spaceId, lost)).state).toBe("idle");
    expect((await card(spaceId, failed)).state).toBe("failed");
    expect((await card(spaceId, running)).state).toBe("working");
    expect((await card(spaceId, orphan)).state).toBe("idle");
    const statuses = (
      await env.DB.prepare(
        "SELECT id, activity_status FROM threads WHERE parent_thread_id = ?",
      )
        .bind(spaceId)
        .all<{ id: string; activity_status: string }>()
    ).results;
    expect(
      Object.fromEntries(statuses.map((r) => [r.id, r.activity_status])),
    ).toEqual({
      [lost]: "idle",
      [failed]: "idle",
      [running]: "working",
      [orphan]: "idle",
    });
  });

  it("catches a returning person up once, with links only to the Space's threads", async () => {
    const spaceId = await newSpace();
    const finished = await startChild(spaceId, "Fix coupon rounding");
    const working = await startChild(spaceId, "Rebuild the payment step");
    const stillWorking = await startChild(spaceId, "Checkout Playwright tests");
    // Everything so far happened before the visit.
    const fiveHoursAgo = Date.now() - 5 * 3_600_000;
    await env.DB.prepare(
      "UPDATE threads SET created_at = ?1 WHERE parent_thread_id = ?2",
    )
      .bind(new Date(fiveHoursAgo - 60_000).toISOString(), spaceId)
      .run();

    // A first visit has nothing to catch up on, and records the visit.
    expect(await catchUp(spaceId)).toBeNull();
    // A short absence does not count as away.
    expect(await catchUp(spaceId)).toBeNull();

    await env.DB.prepare(
      "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
    )
      .bind(fiveHoursAgo, spaceId, member)
      .run();
    // Away, but nothing changed: no card.
    expect(await catchUp(spaceId)).toBeNull();
    expect(model.calls).toEqual([]);

    // While Ben is away, one thread finishes; two keep working.
    await env.DB.prepare(
      "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
    )
      .bind(fiveHoursAgo, spaceId, member)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle', status_line = 'Fixed the coupon rounding', turn_settled_at = ?2 WHERE id = ?1",
      ).bind(finished, new Date().toISOString()),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'working', status_line = 'Adding test IDs to the card form' WHERE id IN (?1, ?2)",
      ).bind(working, stillWorking),
    ]);

    // A model answer that links outside the Space is not used.
    model.answer = `In the last 5 hours, [Fix coupon rounding](/threads/${finished}) finished; see [elsewhere](https://evil.example/x).`;
    const written = await catchUp(spaceId);
    expect(model.calls).toHaveLength(1);
    expect(written?.body).toBe(
      `In the last 5 hours, [Fix coupon rounding](/threads/${finished}) finished: fixed the coupon rounding.\n\nThe other two threads are still working.`,
    );
    expect(Date.parse(String(written?.since))).toBe(fiveHoursAgo);

    // Reading again during the same visit shows the same card, unwritten.
    expect((await catchUp(spaceId))?.body).toBe(written?.body);
    expect(model.calls).toHaveLength(1);
    // The card is only Ben's.
    expect(await catchUp(spaceId, owner)).toBeNull();

    // Dismissed, it stays gone.
    expect(
      (await send(member, `/v1/spaces/${spaceId}/catch-up/dismiss`, "POST"))
        .status,
    ).toBe(200);
    expect(await catchUp(spaceId)).toBeNull();

    // The next return writes a new card, and a usable model answer is kept.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
      ).bind(Date.now() - 2 * 3_600_000, spaceId, member),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle', turn_settled_at = ?2, status_line = 'Added the test IDs' WHERE id = ?1",
      ).bind(working, new Date().toISOString()),
    ]);
    model.answer = `In the last 2 hours, [Rebuild the payment step](/threads/${working}) finished: it **added the test IDs** that [Checkout Playwright tests](/threads/${stillWorking}) relies on.`;
    expect((await catchUp(spaceId))?.body).toBe(model.answer);

    // Someone outside the Space reads nothing.
    expect(
      (await send("cards-stranger" as UserId, `/v1/spaces/${spaceId}/catch-up`))
        .status,
    ).toBe(404);
  });

  it("says a thread was archived or shipped while the person was away, whatever the model wrote", async () => {
    const spaceId = await newSpace();
    const finished = await startChild(spaceId, "Walk the tools folder");
    const archived = await startChild(spaceId, "Survey the test suite");
    const shipped = await startChild(spaceId, "Fix coupon rounding");
    // It finished its turn before it shipped; a running one would be open.
    await settleFirstTurn(shipped);
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    await env.DB.prepare(
      "UPDATE threads SET created_at = ?1 WHERE parent_thread_id = ?2",
    )
      .bind(new Date(twoHoursAgo - 60_000).toISOString(), spaceId)
      .run();
    expect(await catchUp(spaceId)).toBeNull();
    // While Ben is away: one finishes, one is archived after it finished,
    // one ships.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
      ).bind(twoHoursAgo, spaceId, member),
      env.DB.prepare(
        "UPDATE threads SET status_line = 'Found 5 memory tools', turn_settled_at = ?2 WHERE id = ?1",
      ).bind(finished, new Date().toISOString()),
      env.DB.prepare(
        "UPDATE threads SET status_line = 'Surveyed test suite, found 80 passing tests', turn_settled_at = ?2, lifecycle_state = 'archived', archived_at = ?3 WHERE id = ?1",
      ).bind(archived, new Date().toISOString(), Date.now()),
      env.DB.prepare(
        "UPDATE threads SET status_line = 'Fixed the rounding', shipped_at = ?2 WHERE id = ?1",
      ).bind(shipped, Date.now()),
    ]);
    // The model retells the archived and shipped threads' last lines, as
    // the proof run's card did, and never says what became of them.
    model.answer = `In the last 2 hours, [Walk the tools folder](/threads/${finished}) found 5 memory tools. [Survey the test suite](/threads/${archived}) surveyed the test suite and found 80 passing tests, and [Fix coupon rounding](/threads/${shipped}) fixed the rounding.`;

    const body = (await catchUp(spaceId))?.body ?? "";
    expect(model.calls).toHaveLength(1);
    // The model was told what became of each.
    const input = JSON.stringify(model.calls[0]?.input);
    expect(input).toContain('\\"state\\":\\"archived\\"');
    expect(input).toContain('\\"state\\":\\"shipped\\"');
    expect(body).toContain(
      `[Survey the test suite](/threads/${archived}) was archived.`,
    );
    expect(body).toContain(
      `[Fix coupon rounding](/threads/${shipped}) shipped.`,
    );
    expect(body).toContain("found 5 memory tools");
  });

  it("tells the model only what changed since the person's last visit, and when, counting a restore", async () => {
    const spaceId = await newSpace();
    const shippedEarlier = await startChild(spaceId, "Shortest tool file");
    const restored = await startChild(spaceId, "Test suite pass counts");
    const finished = await startChild(spaceId, "Walk the tools folder");
    const working = await startChild(spaceId, "Rebuild the payment step");
    for (const child of [shippedEarlier, restored, finished])
      await settleFirstTurn(child);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE threads SET created_at = ?1 WHERE parent_thread_id = ?2",
    )
      .bind(new Date(now - 5 * 3_600_000).toISOString(), spaceId)
      .run();
    expect(await catchUp(spaceId)).toBeNull();
    const lifecycle = (state: "active" | "archived") =>
      runRepositories(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository;
          yield* threads.setLifecycleStateOwned(restored, owner, state);
        }),
      );
    // Archived before Ben left; one shipped 100 minutes ago, before he left.
    await lifecycle("archived");
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET archived_at = ?2, turn_settled_at = ?3, status_line = 'Ran 23 tests, 0 failures' WHERE id = ?1",
      ).bind(
        restored,
        now - 3 * 3_600_000,
        new Date(now - 3 * 3_600_000).toISOString(),
      ),
      env.DB.prepare(
        "UPDATE threads SET shipped_at = ?2, ship_reason = 'pull_request_merged', turn_settled_at = ?3 WHERE id = ?1",
      ).bind(
        shippedEarlier,
        now - 100 * 60_000,
        new Date(now - 100 * 60_000).toISOString(),
      ),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'working', status_line = 'Adding test IDs' WHERE id = ?1",
      ).bind(working),
      // Ben was last here 65 minutes ago.
      env.DB.prepare(
        "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
      ).bind(now - 65 * 60_000, spaceId, member),
    ]);
    // While he is away, the archived thread is restored and one finishes.
    await lifecycle("active");
    await env.DB.prepare(
      "UPDATE threads SET status_line = 'Found 5 memory tools', turn_settled_at = ?2 WHERE id = ?1",
    )
      .bind(finished, new Date(now - 10 * 60_000).toISOString())
      .run();
    model.answer = `In the last 1 hour, [Walk the tools folder](/threads/${finished}) found 5 memory tools and [Test suite pass counts](/threads/${restored}) was restored.`;

    const written = await catchUp(spaceId);
    expect(written?.body).toBe(model.answer);
    const input = String(
      (
        model.calls[0]?.input as { messages?: Array<{ content: string }> }
      )?.messages?.at(-1)?.content,
    );
    expect(input).toContain("away for 1 hour");
    // Only what changed while he was away, each with when it changed.
    expect(input).toContain("Walk the tools folder");
    expect(input).toMatch(/"change":"finished","when":"10 minutes ago"/);
    expect(input).toContain("Test suite pass counts");
    expect(input).toMatch(/"change":"restored","when":"(0|1) minutes? ago"/);
    expect(input).not.toContain("Shortest tool file");
    expect(input).not.toContain("Rebuild the payment step");
    expect(input).toContain('"otherThreadsWorking":1');

    // Without a usable answer, dx's own note says the same.
    await env.DB.prepare(
      "UPDATE space_visit SET seen_at = ?1, catch_up_body = NULL WHERE space_thread_id = ?2 AND user_id = ?3",
    )
      .bind(now - 65 * 60_000, spaceId, member)
      .run();
    model.answer = "";
    const fallback = (await catchUp(spaceId))?.body ?? "";
    expect(fallback).toContain(
      `[Test suite pass counts](/threads/${restored}) was restored`,
    );
    expect(fallback).toContain(`[Walk the tools folder](/threads/${finished})`);
    expect(fallback).not.toContain("Shortest tool file");
  });

  it("never tells a returning person a restored thread's old status line as news", async () => {
    const spaceId = await newSpace();
    const restored = await startChild(spaceId, "Inventory src/tools");
    const finished = await startChild(spaceId, "Walk the tools folder");
    await settleFirstTurn(restored);
    await settleFirstTurn(finished);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE threads SET created_at = ?1 WHERE parent_thread_id = ?2",
    )
      .bind(new Date(now - 5 * 3_600_000).toISOString(), spaceId)
      .run();
    expect(await catchUp(spaceId)).toBeNull();
    const lifecycle = (state: "active" | "archived") =>
      runRepositories(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository;
          yield* threads.setLifecycleStateOwned(restored, owner, state);
        }),
      );
    // It listed the files and was archived long before Ben left.
    await lifecycle("archived");
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET archived_at = ?2, turn_settled_at = ?3, status_line = 'Listed 5 TypeScript files totaling 782 lines' WHERE id = ?1",
      ).bind(
        restored,
        now - 3 * 3_600_000,
        new Date(now - 3 * 3_600_000).toISOString(),
      ),
      env.DB.prepare(
        "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
      ).bind(now - 65 * 60_000, spaceId, member),
    ]);
    // While he is away it is only restored; another thread finishes.
    await lifecycle("active");
    await env.DB.prepare(
      "UPDATE threads SET status_line = 'Found 5 memory tools', turn_settled_at = ?2 WHERE id = ?1",
    )
      .bind(finished, new Date(now - 10 * 60_000).toISOString())
      .run();
    // A model that retells the old line as if it happened while he was away.
    model.answer = `In the last 1 hour, [Walk the tools folder](/threads/${finished}) found 5 memory tools and [Inventory src/tools](/threads/${restored}) was restored and finished listing 5 TypeScript files totaling 782 lines.`;

    const written = (await catchUp(spaceId))?.body ?? "";
    const input = String(
      (
        model.calls[0]?.input as { messages?: Array<{ content: string }> }
      )?.messages?.at(-1)?.content,
    );
    // The model never reads the old line as something that just happened.
    expect(input).toContain("Inventory src/tools");
    expect(input).not.toContain("Listed 5 TypeScript files");
    expect(input).toContain("Found 5 memory tools");
    expect(written).toContain(
      `[Inventory src/tools](/threads/${restored}) was restored.`,
    );
    expect(written).toContain(`[Walk the tools folder](/threads/${finished})`);
    expect(written).toContain("found 5 memory tools");
    expect(written).not.toMatch(/listing|782|finished listing/);

    // dx's own note says only that it was restored.
    await env.DB.prepare(
      "UPDATE space_visit SET seen_at = ?1, catch_up_body = NULL WHERE space_thread_id = ?2 AND user_id = ?3",
    )
      .bind(now - 65 * 60_000, spaceId, member)
      .run();
    model.answer = "";
    const fallback = (await catchUp(spaceId))?.body ?? "";
    expect(fallback).toContain(
      `[Inventory src/tools](/threads/${restored}) was restored.`,
    );
    expect(fallback).not.toContain("782");
  });

  it("leaves out sentences that count no threads, whatever the model wrote", async () => {
    const spaceId = await newSpace();
    const finished = await startChild(spaceId, "Walk the tools folder");
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    await env.DB.prepare(
      "UPDATE threads SET created_at = ?1 WHERE parent_thread_id = ?2",
    )
      .bind(new Date(twoHoursAgo - 60_000).toISOString(), spaceId)
      .run();
    expect(await catchUp(spaceId)).toBeNull();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE space_visit SET seen_at = ?1 WHERE space_thread_id = ?2 AND user_id = ?3",
      ).bind(twoHoursAgo, spaceId, member),
      env.DB.prepare(
        "UPDATE threads SET status_line = 'Found 5 memory tools', turn_settled_at = ?2 WHERE id = ?1",
      ).bind(finished, new Date().toISOString()),
    ]);
    // As the proof run's card read.
    model.answer = `In the last 2 hours, [Walk the tools folder](/threads/${finished}) found 5 memory tools. No threads need you. 0 threads are still working.`;

    const body = (await catchUp(spaceId))?.body ?? "";
    expect(body).toBe(
      `In the last 2 hours, [Walk the tools folder](/threads/${finished}) found 5 memory tools.`,
    );
  });
});
