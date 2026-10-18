import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@flue/runtime", () => ({
  defineTool: (tool: unknown) => tool,
}));

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly principal: unknown;
  readonly body: unknown;
}

const routes = vi.hoisted(() => ({
  requests: [] as RecordedRequest[],
  status: { create: 201, send: 202 },
}));

vi.mock("./routes.js", async () => {
  const { Hono } = await import("hono");
  const threadRoutes = new Hono();
  threadRoutes.all("*", async (context) => {
    const body =
      context.req.method === "GET" ? undefined : await context.req.json();
    routes.requests.push({
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      principal: (context as never as { get: (key: string) => unknown }).get(
        "principal",
      ),
      body,
    });
    if (context.req.method === "POST")
      return context.json(
        {
          status: "success",
          data: {
            id: (body as { threadId: string }).threadId,
            projectId: (body as { projectId?: string }).projectId ?? "prj_none",
          },
          initialSubmission: { submissionId: "sub_child" },
        },
        routes.status.create as 201,
      );
    return context.json({ status: "success", data: {} });
  });
  return { threadRoutes };
});

vi.mock("../agents/routes.js", async () => {
  const { Hono } = await import("hono");
  const dxAgentRoutes = new Hono();
  dxAgentRoutes.all("*", async (context) => {
    const body =
      context.req.method === "GET" ? undefined : await context.req.json();
    routes.requests.push({
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      principal: undefined,
      body,
    });
    if (context.req.method === "GET")
      return context.json({
        messages: [
          {
            role: "assistant",
            purpose: "assistant",
            parts: [{ type: "text", text: "Done: 3 files changed." }],
          },
        ],
      });
    return context.json(
      { submissionId: "sub_sent" },
      routes.status.send as 202,
    );
  });
  return { dxAgentRoutes };
});

const realtime = vi.hoisted(() => ({
  published: [] as string[],
}));

vi.mock("../realtime/publication.js", () => ({
  publishRealtimeInvalidation: async (_bindings: unknown, threadId: string) => {
    realtime.published.push(threadId);
  },
}));

vi.mock("../settings/routes.js", async () => {
  const { Hono } = await import("hono");
  const settingsRoutes = new Hono();
  settingsRoutes.get("/personal/orb-providers", (context) => {
    routes.requests.push({
      method: "GET",
      path: `/v1/settings/personal/orb-providers${new URL(context.req.url).search}`,
      principal: undefined,
      body: undefined,
    });
    return context.json({
      status: "success",
      data: {
        resolved: [{ providerId: "e2b", scope: "deployment", status: "ready" }],
      },
    });
  });
  settingsRoutes.get("/personal/projects", (context) =>
    context.json({
      status: "success",
      data: {
        catalog: {
          defaultProfileId: "a1.medium",
          providers: [
            { adapter: "e2b", displayName: "E2B" },
            { adapter: "cloudflare", displayName: "Cloudflare Containers" },
          ],
          profiles: [
            {
              id: "a1.tiny",
              adapter: "e2b",
              availability: "available",
              resources: { cpuCores: 1, memoryMb: 2048, diskGb: 20 },
            },
            {
              id: "a1.medium",
              adapter: "e2b",
              availability: "available",
              resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
            },
            {
              id: "a1.huge",
              adapter: "e2b",
              availability: "maintenance",
              resources: { cpuCores: 16, memoryMb: 65536, diskGb: 20 },
            },
            {
              id: "cf.standard-2",
              adapter: "cloudflare",
              availability: "available",
              resources: { cpuCores: 1, memoryMb: 6144, diskGb: 20 },
            },
          ],
        },
        restrictions: { allowedRunnerProfileIds: null },
        resolved: { runnerProfileId: { value: "a1.medium" } },
      },
    }),
  );
  settingsRoutes.get("/personal/model-routing/choices", (context) =>
    context.json({
      status: "success",
      data: {
        modes: [
          {
            mode: "low",
            config: { model: "openai/gpt-mini", thinking: "low" },
            served: true,
            servingConnectionName: "OpenAI",
          },
          {
            mode: "high",
            config: { model: "anthropic/claude-opus", thinking: "high" },
            served: false,
            servingConnectionName: null,
          },
        ],
        models: [],
      },
    }),
  );
  return { settingsRoutes };
});

import { createThreadTools } from "./agent-tools.js";

interface Row {
  id: string;
  owner_user_id: string;
  project_id: string;
  model_selection: string;
  title: string;
  title_pending_until: string | null;
  parent_thread_id: string | null;
  color: string | null;
  lifecycle_state: string;
  activity_status: "idle" | "working";
  last_activity_at: string | null;
  created_at: string;
  conversation_mode: string;
  workspace_access: string;
}

const OWNER = "usr_owner";
const CALLER = "thr_11111111-1111-4111-8111-111111111111";
const OTHER = "thr_22222222-2222-4222-8222-222222222222";
const FOREIGN = "thr_33333333-3333-4333-8333-333333333333";

const row = (id: string, values: Partial<Row> = {}): Row => ({
  id,
  owner_user_id: OWNER,
  project_id: "prj_app",
  model_selection: JSON.stringify({
    kind: "mode",
    profileId: "default",
    mode: "high",
  }),
  title: "Thread",
  title_pending_until: null,
  parent_thread_id: null,
  color: null,
  lifecycle_state: "active",
  activity_status: "idle",
  last_activity_at: "2026-10-10T10:00:00.000Z",
  created_at: "2026-10-10T09:00:00.000Z",
  conversation_mode: "agent",
  workspace_access: "none",
  ...values,
});

/** Statements the tools wrote through `batch`, as SQL and bindings. */
const written: Array<{ sql: string; args: unknown[] }> = [];

/** A D1 stand-in that answers the statements the tools issue. */
const fakeDb = (
  threads: Map<string, Row>,
  projects: Record<
    string,
    { name: string; owner_user_id: string; runner_profile_id?: string }
  > = {},
) =>
  ({
    batch: async (
      statements: ReadonlyArray<{ sql: string; args: unknown[] }>,
    ) => {
      written.push(...statements);
      return [];
    },
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        run: async () => {
          written.push({ sql, args });
          return { meta: { changes: 1 } };
        },
        first: async (column?: string) => {
          if (sql.includes("FROM thread_activity_submission"))
            return { seen: 1 };
          if (sql.includes("FROM projects")) {
            const project = projects[args[0] as string];
            if (project === undefined) return null;
            return column === undefined
              ? project
              : (project[column as keyof typeof project] ?? null);
          }
          return threads.get(args[0] as string) ?? null;
        },
        all: async () => {
          // Owner, the IN list, then a shared caller's family root twice.
          const listed =
            (/IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").split("?").length - 1;
          const [owner, ...rest] = args as string[];
          const ids = rest.slice(0, listed);
          const familyRoot = rest[listed];
          return {
            results: ids.flatMap((id) => {
              const thread = threads.get(id);
              return thread !== undefined &&
                thread.owner_user_id === owner &&
                (familyRoot === undefined ||
                  thread.id === familyRoot ||
                  thread.parent_thread_id === familyRoot)
                ? [thread]
                : [];
            }),
          };
        },
      }),
    }),
  }) as unknown as D1Database;

const toolsFor = (db: D1Database, submissionId = "sub_turn_1") =>
  Object.fromEntries(
    createThreadTools(
      CALLER,
      () => ({ db, bindings: { DB: db } }),
      submissionId,
    ).map((tool) => [
      tool.name,
      tool as unknown as {
        run: (input: {
          data: Record<string, unknown>;
          toolCallId: string;
          signal?: AbortSignal;
        }) => Promise<{ output: Record<string, unknown> }>;
      },
    ]),
  );

describe("Thread tools", () => {
  beforeEach(() => {
    routes.requests.length = 0;
    realtime.published.length = 0;
    written.length = 0;
    routes.status = { create: 201, send: 202 };
  });

  it("offers create, send, status, wait, Orb and mode lookups, update, find, and read", () => {
    expect(Object.keys(toolsFor(fakeDb(new Map())))).toEqual([
      "create_thread",
      "send_thread_message",
      "get_thread_status",
      "wait_for_threads",
      "list_orbs",
      "list_agent_modes",
      "update_thread",
      "find_thread",
      "read_thread",
    ]);
  });

  it("lists the Orbs the owner can start, with sizes and the project default", async () => {
    const tools = toolsFor(
      fakeDb(new Map([[CALLER, row(CALLER)]]), {
        prj_app: {
          name: "App",
          owner_user_id: OWNER,
          runner_profile_id: "a1.tiny",
        },
      }),
    );
    const listed = await tools.list_orbs?.run({ data: {}, toolCallId: "o1" });
    expect(routes.requests[0]?.path).toBe(
      "/v1/settings/personal/orb-providers?projectId=prj_app",
    );
    expect(listed?.output).toEqual({
      projectId: "prj_app",
      defaultSize: "a1.tiny",
      providers: [
        {
          provider: "e2b",
          name: "E2B",
          status: "ready",
          paidBy: "deployment",
          sizes: [
            { size: "a1.tiny", cpu: 1, memoryGb: 2, diskGb: 20 },
            { size: "a1.medium", cpu: 4, memoryGb: 8, diskGb: 20 },
          ],
        },
        {
          provider: "cloudflare",
          name: "Cloudflare Containers",
          status: "unavailable",
          sizes: [{ size: "cf.standard-2", cpu: 1, memoryGb: 6, diskGb: 20 }],
        },
      ],
    });
  });

  it("lists the agent modes with the model each runs for the owner", async () => {
    const tools = toolsFor(fakeDb(new Map([[CALLER, row(CALLER)]])));
    const listed = await tools.list_agent_modes?.run({
      data: {},
      toolCallId: "m1",
    });
    expect(listed?.output).toEqual({
      currentMode: "high",
      modes: [
        {
          mode: "low",
          model: "openai/gpt-mini",
          thinking: "low",
          served: true,
          connection: "OpenAI",
        },
        {
          mode: "high",
          model: "anthropic/claude-opus",
          thinking: "high",
          served: false,
        },
      ],
    });
  });

  it("creates a child as the owner in the calling Thread's project and mode, with a stable ID per tool call", async () => {
    const tools = toolsFor(fakeDb(new Map([[CALLER, row(CALLER)]])));
    const first = await tools.create_thread?.run({
      data: { prompt: "Add tests for the parser.", title: "Parser tests" },
      toolCallId: "call_1",
    });
    const retried = await tools.create_thread?.run({
      data: { prompt: "Add tests for the parser.", title: "Parser tests" },
      toolCallId: "call_1",
    });
    expect(first?.output.threadId).toMatch(/^thr_[0-9a-f-]{36}$/);
    expect(retried?.output.threadId).toBe(first?.output.threadId);
    expect(routes.requests[0]).toEqual({
      method: "POST",
      path: "/v1/threads",
      principal: { userId: OWNER, credentialScopes: ["personal", "workspace"] },
      body: {
        threadId: first?.output.threadId,
        parentThreadId: CALLER,
        projectId: "prj_app",
        title: "Parser tests",
        generateTitle: false,
        selection: { kind: "mode", profileId: "default", mode: "high" },
        initialMessage: { body: "Add tests for the parser.", attachments: [] },
      },
    });
  });

  it("leaves a projectless caller's child projectless and applies a named mode", async () => {
    const tools = toolsFor(
      fakeDb(new Map([[CALLER, row(CALLER, { project_id: "prj_none" })]]), {
        prj_none: { name: "No Project", owner_user_id: OWNER },
      }),
    );
    await tools.create_thread?.run({
      data: { prompt: "Summarize the logs.", agent_mode: "low" },
      toolCallId: "call_2",
    });
    const body = routes.requests[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("title");
    expect(body.selection).toEqual({
      kind: "mode",
      profileId: "default",
      mode: "low",
    });
    await expect(
      tools.create_thread?.run({
        data: { prompt: "x", agent_mode: "turbo" },
        toolCallId: "call_3",
      }),
    ).rejects.toThrow("agent_mode must be one of low, medium, high, ultra.");
  });

  it("reaches only the owner's Threads", async () => {
    const tools = toolsFor(
      fakeDb(
        new Map([
          [CALLER, row(CALLER)],
          [FOREIGN, row(FOREIGN, { owner_user_id: "usr_member" })],
        ]),
      ),
    );
    for (const call of [
      () =>
        tools.send_thread_message?.run({
          data: { thread: FOREIGN, message: "hi" },
          toolCallId: "call_4",
        }),
      () =>
        tools.get_thread_status?.run({
          data: { thread: FOREIGN },
          toolCallId: "call_5",
        }),
      () =>
        tools.update_thread?.run({
          data: { thread: FOREIGN, pinned: true },
          toolCallId: "call_6",
        }),
    ])
      await expect(call()).rejects.toThrow(
        `Thread ${FOREIGN} was not found among this Thread owner's Threads.`,
      );
    expect(routes.requests).toEqual([]);
  });

  it("steers a working Thread and marks the submission's source for its clients until it joins", async () => {
    const threads = new Map([
      [CALLER, row(CALLER)],
      [OTHER, row(OTHER, { activity_status: "working" })],
    ]);
    const tools = toolsFor(fakeDb(threads));
    await expect(
      tools.send_thread_message?.run({
        data: { thread: CALLER, message: "Loop" },
        toolCallId: "call_8",
      }),
    ).rejects.toThrow("A Thread cannot send a message to itself.");

    const steered = await tools.send_thread_message?.run({
      data: { thread: OTHER, message: "Also update the docs." },
      toolCallId: "call_9",
    });
    expect(steered?.output).toEqual({
      threadId: OTHER,
      submissionId: "sub_sent",
      steered: true,
    });
    expect(routes.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/agents/dx/${OTHER}`,
      body: { kind: "user", body: "Also update the docs." },
    });
    expect(written.at(-1)).toEqual({
      sql: expect.stringContaining(
        "UPDATE thread_activity_submission SET source_thread_id = ?",
      ),
      args: [CALLER, OTHER, "sub_sent"],
    });
    expect(realtime.published).toEqual([OTHER]);

    // An idle Thread starts a turn at once; nothing waits to join.
    written.length = 0;
    threads.set(OTHER, row(OTHER));
    await tools.send_thread_message?.run({
      data: { thread: OTHER, message: "Next task." },
      toolCallId: "call_9b",
    });
    expect(written).toEqual([]);
    routes.requests.length = 1;

    threads.set(
      OTHER,
      row(OTHER, { workspace_access: "contribute", conversation_mode: "chat" }),
    );
    await tools.send_thread_message?.run({
      data: { thread: OTHER, message: "Rebase on main." },
      toolCallId: "call_10",
    });
    // attributeSubmission delivers it to the agent; no `@dx` tag needed.
    expect(routes.requests[1]?.body).toMatchObject({
      body: "Rebase on main.",
    });
  });

  it("reports status with the latest agent message and waits until every Thread is idle", async () => {
    const tools = toolsFor(
      fakeDb(
        new Map([
          [CALLER, row(CALLER)],
          [OTHER, row(OTHER, { parent_thread_id: CALLER, title: "Child" })],
        ]),
      ),
    );
    const status = await tools.get_thread_status?.run({
      data: { thread: OTHER },
      toolCallId: "call_11",
    });
    expect(status?.output).toMatchObject({
      threadId: OTHER,
      title: "Child",
      parentThreadId: CALLER,
      state: "idle",
      archived: false,
      lastMessage: "Done: 3 files changed.",
    });

    const waited = await tools.wait_for_threads?.run({
      data: { threads: [OTHER, FOREIGN], timeout_seconds: 1 },
      toolCallId: "call_12",
    });
    expect(waited?.output).toMatchObject({
      settled: true,
      threads: [
        { threadId: OTHER, state: "idle" },
        { threadId: FOREIGN, state: "not-found" },
      ],
    });
  });

  it("updates a Thread through the owner's routes and never archives the calling Thread", async () => {
    const tools = toolsFor(
      fakeDb(
        new Map([
          [CALLER, row(CALLER)],
          [OTHER, row(OTHER)],
        ]),
      ),
    );
    await expect(
      tools.update_thread?.run({
        data: { archived: true },
        toolCallId: "call_13",
      }),
    ).rejects.toThrow("This Thread cannot archive itself.");
    await expect(
      tools.update_thread?.run({ data: {}, toolCallId: "call_14" }),
    ).rejects.toThrow(
      "Name at least one of title, color, pinned, or archived.",
    );

    await tools.update_thread?.run({
      data: { title: "Renamed", color: "green" },
      toolCallId: "call_15",
    });
    await tools.update_thread?.run({
      data: { thread: OTHER, color: "auto" },
      toolCallId: "call_15b",
    });
    await tools.update_thread?.run({
      data: { thread: OTHER, pinned: false, archived: true },
      toolCallId: "call_16",
    });
    expect(
      routes.requests.map(({ method, path, body }) => [method, path, body]),
    ).toEqual([
      ["PATCH", `/v1/threads/${CALLER}`, { title: "Renamed", color: "green" }],
      ["PATCH", `/v1/threads/${OTHER}`, { color: null }],
      ["PATCH", `/v1/threads/${OTHER}/pin`, { pinned: false }],
      ["PATCH", `/v1/threads/${OTHER}/archive`, { archived: true }],
    ]);
  });

  it("reports a refused creation with the route's error code", async () => {
    routes.status.create = 400;
    const tools = toolsFor(fakeDb(new Map([[CALLER, row(CALLER)]])));
    await expect(
      tools.create_thread?.run({
        data: { prompt: "Do it." },
        toolCallId: "call_17",
      }),
    ).rejects.toThrow("create_thread failed");
  });

  it("derives a child's ID from the submission and the call, so a reused or missing call ID never returns another call's Thread", async () => {
    const db = fakeDb(new Map([[CALLER, row(CALLER)]]));
    const create = async (submissionId: string, toolCallId: string) =>
      (
        await toolsFor(db, submissionId).create_thread?.run({
          data: { prompt: "Do it." },
          toolCallId,
        })
      )?.output.threadId;
    const retried = [
      await create("sub_a", "call_0"),
      await create("sub_a", "call_0"),
    ];
    expect(retried[0]).toBe(retried[1]);
    expect(await create("sub_b", "call_0")).not.toBe(retried[0]);
    expect(await create("sub_a", "")).not.toBe(await create("sub_a", ""));
  });

  it("from a shared Thread, reaches only its own family", async () => {
    const SIBLING = "thr_44444444-4444-4444-8444-444444444444";
    const tools = toolsFor(
      fakeDb(
        new Map([
          [CALLER, row(CALLER, { workspace_access: "contribute" })],
          [OTHER, row(OTHER, { parent_thread_id: CALLER })],
          [SIBLING, row(SIBLING)],
        ]),
      ),
    );
    await expect(
      tools.get_thread_status?.run({
        data: { thread: OTHER },
        toolCallId: "f1",
      }),
    ).resolves.toMatchObject({ output: { threadId: OTHER } });
    await expect(
      tools.get_thread_status?.run({
        data: { thread: SIBLING },
        toolCallId: "f2",
      }),
    ).rejects.toThrow(
      `Thread ${SIBLING} is not reachable from this shared Thread`,
    );
    await expect(
      tools.update_thread?.run({
        data: { thread: SIBLING, archived: true },
        toolCallId: "f3",
      }),
    ).rejects.toThrow("is not reachable from this shared Thread");
  });
});
