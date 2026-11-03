import { env } from "cloudflare:test";
import { formatMessageAttachments } from "@dx/api";
import {
  AgentInstanceExistsError,
  FlueError,
  InputTooLargeError,
  SubmissionConflictError,
} from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { DxAgentInitialDataSchema } from "../../src/agents/dx-agent-initial-data.js";
import { errorHandler } from "../../src/http/http-errors.js";
import type { AppEnv } from "../../src/http/types.js";
import {
  agentPluginHostContext,
  resolveAgentPluginTools,
} from "../../src/plugins/agent-context.js";
import { firstPartyPluginTools } from "../../src/plugins/tools.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import {
  INITIAL_DISPATCH_SWEEP_AFTER_MS,
  initialSubmissionId,
  MAX_INITIAL_DISPATCH_ATTEMPTS,
  sweepInitialDispatches,
} from "../../src/threads/initial-dispatch.js";
import { createThreadRoutes } from "../../src/threads/routes.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  jsonHeaders,
  otherPrincipal,
  owner,
  principal,
} from "./product-route-fixture.js";

/**
 * POST /v1/threads with a first message, through the real gates and D1, with
 * Flue's dispatch and instance lookup replaced.
 *
 * A first message without inline images is written with the Thread, and
 * the route answers before the agent admits it (#1590). Ways that could
 * fail: the receipt names a submission Flue never makes; the message is
 * lost when the request ends before the agent starts; a retry admits it
 * twice; a refusal leaves a Thread that waits forever without saying why;
 * the Orb started for a refused message keeps running.
 *
 * A first message with inline images is admitted before the response, as
 * before: creation refuses a permanent failure before the Thread exists,
 * and never leaves an empty Thread behind once Flue holds nothing for it.
 */

type Dispatch = NonNullable<Parameters<typeof createThreadRoutes>[0]>;
type InstanceLookup = NonNullable<Parameters<typeof createThreadRoutes>[2]>;
type InitialOrb = NonNullable<Parameters<typeof createThreadRoutes>[3]>;

/** Flue validates `initialData` against the agent's schema at admission. */
const flueValidatedDispatch =
  (dispatched: Array<Parameters<Dispatch>[0]>): Dispatch =>
  async (request) => {
    dispatched.push(request);
    const result = v.safeParse(DxAgentInitialDataSchema, request.initialData);
    if (!result.success)
      throw new FlueError({
        type: "invalid_request",
        message: "Request is malformed.",
        details: "initialData does not match the agent's schema.",
        dev: "",
      });
    return {
      submissionId: await initialSubmissionId(request.id as never),
    } as Awaited<ReturnType<Dispatch>>;
  };

/** A first message with an inline image: too large to hold in D1. */
const inlineImageMessage = {
  body: "Fix the flaky login test",
  attachments: [
    {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    },
  ],
};

const harness = (
  dispatch: Dispatch,
  lookup: InstanceLookup = async () => null,
  routeBindings = bindings,
  initialOrb?: InitialOrb,
  /** False answers without waiting for work the route left running. */
  settle = true,
  requestPrincipal = principal,
) => {
  const persisted: Array<Promise<boolean>> = [];
  const titleAgent = vi.fn(
    async (_bindings: unknown, job: { persisted: Promise<boolean> }) => {
      persisted.push(job.persisted);
    },
  );
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "thread-creation-admission");
    context.set("principal", requestPrincipal);
    await next();
  });
  app.route(
    "/threads",
    createThreadRoutes(dispatch, titleAgent, lookup, initialOrb),
  );
  app.onError(errorHandler);
  const pending: Array<Promise<unknown>> = [];
  const routeEnv = {
    ...routeBindings,
    BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
  };
  const execution = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  };
  /** The Thread's detail, as the Thread page reads it. */
  const read = async (threadId: string) =>
    (await (
      await app.request(`/threads/${threadId}`, {}, routeEnv, execution)
    ).json()) as { data: { initialDispatch?: unknown } };
  const create = async (body: Record<string, unknown>) => {
    const response = await app.request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          title: "Fix the flaky login test",
          initialMessage: { body: "Fix the flaky login test", attachments: [] },
          ...body,
        }),
      },
      routeEnv,
      execution,
    );
    if (settle) await Promise.allSettled(pending);
    return response;
  };
  const settled = () => Promise.allSettled(pending);
  /** The owner's Retry on a first message that failed to start. */
  const retry = async (threadId: string) => {
    const response = await app.request(
      `/threads/${threadId}/initial-dispatch/retry`,
      { method: "POST" },
      routeEnv,
      execution,
    );
    await Promise.allSettled(pending);
    return response;
  };
  return { create, read, retry, settled, persisted, titleAgent };
};

const initialDispatchRow = (threadId: string) =>
  env.DB.prepare(
    `SELECT state, failure_code AS failureCode, attempts
       FROM thread_initial_dispatch WHERE thread_id = ?`,
  )
    .bind(threadId)
    .first<{ state: string; failureCode: string | null; attempts: number }>();

/** The cron's pass, as of a minute from now, with `dispatch` as Flue. */
const sweep = (dispatch: Dispatch) =>
  sweepInitialDispatches(
    {
      db: env.DB,
      dispatch,
      linkAttachments: async () => undefined,
      invalidate: async () => undefined,
    },
    Date.now() + INITIAL_DISPATCH_SWEEP_AFTER_MS + 60_000,
  );

const threadRow = (threadId: string) =>
  env.DB.prepare("SELECT id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: string }>();

const newThreadId = () => `thr_${crypto.randomUUID()}`;

describe("Thread creation admission in workerd with real D1", () => {
  it("refuses a Thread whose runner profile is in maintenance before persisting it", async () => {
    const catalog = JSON.parse(TEST_RUNNER_PROFILE_CATALOG) as {
      profiles: Array<{ id: string; availability: string }>;
    };
    for (const profile of catalog.profiles)
      if (profile.id === "a1.large") profile.availability = "maintenance";
    const project = await createProjectViaApi("runner-in-maintenance");
    await env.DB.prepare(
      "UPDATE projects SET runner_profile_id = 'a1.large' WHERE id = ?",
    )
      .bind(project.data.id)
      .run();
    const dispatched: Array<Parameters<Dispatch>[0]> = [];
    const { create, persisted } = harness(
      flueValidatedDispatch(dispatched),
      async () => null,
      { ...bindings, DX_RUNNER_PROFILE_CATALOG: JSON.stringify(catalog) },
    );

    const threadId = newThreadId();
    const response = await create({ projectId: project.data.id, threadId });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "RUNNER_PROFILE_UNAVAILABLE" },
    });
    expect(dispatched).toEqual([]);
    await expect(threadRow(threadId)).resolves.toBeNull();
    await expect(persisted[0]).resolves.toBe(false);
  });

  it("admits a first message when the owner has more than twenty MCP connections", async () => {
    const project = await createProjectViaApi("many-mcp-connections");
    const workspaceId = "workspace-many-mcp";
    const timestamp = "2026-10-17T00:00:00.000Z";
    const hash = "a".repeat(64);
    const servers = Array.from({ length: 21 }, (_, index) => ({
      id: `mcp_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      scope: index < 20 ? "personal" : "workspace",
      targetId: index < 20 ? owner : workspaceId,
    }));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Many MCP', 'many-mcp', 1)",
      ).bind(workspaceId),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-many-mcp', ?, ?, 'owner', 1)",
      ).bind(workspaceId, owner),
      ...servers.flatMap(({ id, scope, targetId }) => [
        env.DB.prepare(
          `INSERT INTO mcp_server (
             id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
             project_ids_json, roles_json, health_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'https://93.184.216.34/mcp', 'streamable-http',
                     10000, 1, '[]', '["owner","admin","member"]', 'healthy', ?, ?)`,
        ).bind(
          id,
          scope,
          targetId,
          `Tools ${id.slice(-2)}`,
          timestamp,
          timestamp,
        ),
        env.DB.prepare(
          `INSERT INTO mcp_tool (
             server_id, name, description, input_schema_json, schema_hash,
             approved_schema_hash, discovered_at, reviewed_at, reviewed_by
           ) VALUES (?, 'read_status', 'Read status', '{}', ?, ?, ?, ?, ?)`,
        ).bind(id, hash, hash, timestamp, timestamp, owner),
      ]),
    ]);
    const dispatched: Array<Parameters<Dispatch>[0]> = [];
    const { create } = harness(flueValidatedDispatch(dispatched));

    const threadId = newThreadId();
    const response = await create({ projectId: project.data.id, threadId });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      initialSubmission: {
        submissionId: await initialSubmissionId(threadId as never),
      },
    });
    const initialData = dispatched[0]?.initialData as
      | { readonly mcpConnections: ReadonlyArray<unknown> }
      | undefined;
    expect(initialData?.mcpConnections).toHaveLength(21);
  });

  it("offers an MCP server connected after the Thread started on its next submission", async () => {
    const project = await createProjectViaApi("mcp-connected-later");
    const dispatched: Array<Parameters<Dispatch>[0]> = [];
    const { create } = harness(flueValidatedDispatch(dispatched));
    const threadId = newThreadId();
    expect(
      (await create({ projectId: project.data.id, threadId })).status,
    ).toBe(201);
    // Flue keeps this creation data for the agent's lifetime.
    const created = dispatched[0]?.initialData as {
      readonly mcpConnections: ReadonlyArray<unknown>;
    };
    expect(created.mcpConnections).toEqual([]);

    const serverId = `mcp_${crypto.randomUUID()}`;
    const timestamp = "2026-10-28T14:27:41.000Z";
    const hash = "b".repeat(64);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mcp_server (
           id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
           project_ids_json, roles_json, health_status, created_at, updated_at
         ) VALUES (?, 'personal', ?, 'Atlassian', 'https://93.184.216.34/mcp',
                   'streamable-http', 10000, 1, '[]', '["owner","admin","member"]',
                   'healthy', ?, ?)`,
      ).bind(serverId, owner, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO mcp_tool (
           server_id, name, description, input_schema_json, schema_hash,
           approved_schema_hash, discovered_at, reviewed_at, reviewed_by
         ) VALUES (?, 'searchJiraIssuesUsingJql', 'Search Jira issues', '{}',
                   ?, ?, ?, ?, ?)`,
      ).bind(serverId, hash, hash, timestamp, timestamp, owner),
    ]);

    const next = await resolveAgentPluginTools(threadId, "second-submission");
    expect(next.mcpConnections).toEqual([
      expect.objectContaining({
        id: serverId,
        moduleId: "atlassian",
        tools: ["searchJiraIssuesUsingJql"],
      }),
    ]);
    const search = firstPartyPluginTools(
      { threadId, submissionId: next.submissionId },
      next.tools,
      agentPluginHostContext,
      next.mcpConnections,
    ).find((tool) => tool.name === "tool_search");
    if (search === undefined) throw new Error("tool_search must mount");
    expect(await search.run({ data: { query: "" } } as never)).toContain(
      'import { searchJiraIssuesUsingJql } from "atlassian"',
    );
  });

  it("answers a permanent Flue rejection of inline images with its own code and removes the empty Thread", async () => {
    const project = await createProjectViaApi("permanent-flue-rejection");
    const rejections = [
      {
        error: new FlueError({
          type: "invalid_request",
          message: "Request is malformed.",
          details: "rejected",
          dev: "",
        }),
        status: 422,
        code: "INITIAL_MESSAGE_REJECTED",
      },
      {
        error: new InputTooLargeError(),
        status: 413,
        code: "INITIAL_MESSAGE_TOO_LARGE",
      },
    ];
    for (const rejection of rejections) {
      let reject = true;
      const { create, persisted } = harness(async () => {
        if (reject) throw rejection.error;
        return { submissionId: "after-rejection" } as Awaited<
          ReturnType<Dispatch>
        >;
      });
      const threadId = newThreadId();
      const request = {
        projectId: project.data.id,
        threadId,
        initialMessage: inlineImageMessage,
      };

      const response = await create(request);

      expect(response.status).toBe(rejection.status);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: rejection.code },
      });
      await expect(threadRow(threadId)).resolves.toBeNull();
      await expect(persisted[0]).resolves.toBe(false);

      // The same request, once accepted, creates the Thread.
      reject = false;
      const retried = await create(request);
      expect(retried.status).toBe(201);
      await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
    }
  });

  it("stops the Orb it started beside a refused inline-image dispatch before it removes the Thread", async () => {
    // Ways this could fail: the Orb keeps running after its Thread is gone;
    // it is stopped after the row is deleted, so nothing can name it; an Orb
    // that never started is stopped; a Thread whose agent holds a run loses
    // its Orb; a failed stop deletes the only row that names the Orb.
    const project = await createProjectViaApi("orb-beside-dispatch");
    const refused = async () => {
      throw new FlueError({
        type: "invalid_request",
        message: "Request is malformed.",
        details: "rejected",
        dev: "",
      });
    };
    const orb = (started: boolean, stop?: () => Promise<void>) => {
      const rowsAtStop: Array<{ id: string } | null> = [];
      const initialOrb = {
        start: vi.fn(async () => started),
        stop: vi.fn(async (threadId: string) => {
          rowsAtStop.push(await threadRow(threadId));
          await stop?.();
        }),
      };
      return { initialOrb, rowsAtStop };
    };

    const startedThenRefused = orb(true);
    const first = newThreadId();
    const refusedResponse = await harness(
      refused,
      async () => null,
      bindings,
      startedThenRefused.initialOrb,
    ).create({
      projectId: project.data.id,
      threadId: first,
      initialMessage: inlineImageMessage,
    });
    expect(refusedResponse.status).toBe(422);
    expect(startedThenRefused.initialOrb.start).toHaveBeenCalledWith(first);
    expect(startedThenRefused.initialOrb.stop).toHaveBeenCalledWith(first);
    expect(startedThenRefused.rowsAtStop).toEqual([{ id: first }]);
    await expect(threadRow(first)).resolves.toBeNull();

    const neverStarted = orb(false);
    const second = newThreadId();
    await harness(
      refused,
      async () => null,
      bindings,
      neverStarted.initialOrb,
    ).create({
      projectId: project.data.id,
      threadId: second,
      initialMessage: inlineImageMessage,
    });
    expect(neverStarted.initialOrb.stop).not.toHaveBeenCalled();
    await expect(threadRow(second)).resolves.toBeNull();

    const held = orb(true);
    const third = newThreadId();
    await harness(
      async () => {
        throw new SubmissionConflictError({ submissionId: "existing" });
      },
      async () => ({ id: third, uid: "uid-1" }),
      bindings,
      held.initialOrb,
    ).create({
      projectId: project.data.id,
      threadId: third,
      initialMessage: inlineImageMessage,
    });
    expect(held.initialOrb.stop).not.toHaveBeenCalled();
    await expect(threadRow(third)).resolves.toEqual({ id: third });

    const stopFails = orb(true, async () => {
      throw new Error("provider unavailable");
    });
    const fourth = newThreadId();
    await harness(
      refused,
      async () => null,
      bindings,
      stopFails.initialOrb,
    ).create({
      projectId: project.data.id,
      threadId: fourth,
      initialMessage: inlineImageMessage,
    });
    await expect(threadRow(fourth)).resolves.toEqual({ id: fourth });

    const accepted = orb(true);
    const fifth = newThreadId();
    const acceptedResponse = await harness(
      async () =>
        ({ submissionId: "accepted" }) as Awaited<ReturnType<Dispatch>>,
      async () => null,
      bindings,
      accepted.initialOrb,
    ).create({
      projectId: project.data.id,
      threadId: fifth,
      initialMessage: inlineImageMessage,
    });
    expect(acceptedResponse.status).toBe(201);
    expect(accepted.initialOrb.start).toHaveBeenCalledOnce();
    expect(accepted.initialOrb.stop).not.toHaveBeenCalled();
  });

  it("keeps a Thread whose agent already holds a submission and names the conflict for inline images", async () => {
    const project = await createProjectViaApi("flue-conflicts");
    const conflicts = [
      {
        error: new SubmissionConflictError({ submissionId: "existing" }),
        code: "INITIAL_SUBMISSION_CONFLICT",
      },
      {
        error: new AgentInstanceExistsError({ id: "thr", uid: "uid-1" }),
        code: "THREAD_ALREADY_STARTED",
      },
    ];
    for (const conflict of conflicts) {
      const threadId = newThreadId();
      const { create } = harness(
        async () => {
          throw conflict.error;
        },
        async () => ({ id: threadId, uid: "uid-1" }),
      );

      const response = await create({
        projectId: project.data.id,
        threadId,
        initialMessage: inlineImageMessage,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: conflict.code },
      });
      await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
    }
  });

  it("removes an inline-image Thread after a dispatch failure only when Flue holds nothing for it", async () => {
    const project = await createProjectViaApi("ambiguous-dispatch");
    let fail = true;
    let instance: { id: string } | null = null;
    const dispatch: Dispatch = async () => {
      if (fail) throw new Error("Durable Object reset.");
      return { submissionId: "after-retry" } as Awaited<ReturnType<Dispatch>>;
    };

    // Nothing was admitted: the Thread goes, and a retry creates it again.
    const empty = harness(dispatch, async () => instance);
    const emptyId = newThreadId();
    const failed = await empty.create({
      projectId: project.data.id,
      threadId: emptyId,
      initialMessage: inlineImageMessage,
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      data: { code: "INITIAL_ADMISSION_UNAVAILABLE" },
    });
    await expect(threadRow(emptyId)).resolves.toBeNull();
    await expect(empty.persisted[0]).resolves.toBe(false);
    fail = false;
    const recreated = await empty.create({
      projectId: project.data.id,
      threadId: emptyId,
      initialMessage: inlineImageMessage,
    });
    expect(recreated.status).toBe(201);
    await expect(recreated.json()).resolves.toMatchObject({
      data: { id: emptyId },
      initialSubmission: { submissionId: "after-retry" },
    });

    // A Thread that froze a source intent goes with it.
    fail = true;
    const sourced = await createProductApp().request(
      "/projects",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "ambiguous-dispatch-source",
          source: {
            kind: "github-url",
            url: "https://github.com/example-org/example-repo",
          },
        }),
      },
      bindings,
    );
    const sourcedProject = (await sourced.json()) as { data: { id: string } };
    const sourcedId = newThreadId();
    expect(
      (
        await empty.create({
          projectId: sourcedProject.data.id,
          threadId: sourcedId,
          initialMessage: inlineImageMessage,
        })
      ).status,
    ).toBe(503);
    await expect(threadRow(sourcedId)).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT thread_id FROM thread_source_intent WHERE thread_id = ?",
      )
        .bind(sourcedId)
        .first(),
    ).resolves.toBeNull();

    // Flue may hold the message: the Thread stays, and a retry reuses it
    // and its title job.
    fail = true;
    const held = harness(dispatch, async () => instance);
    const heldId = newThreadId();
    instance = { id: heldId };
    expect(
      (
        await held.create({
          projectId: project.data.id,
          threadId: heldId,
          initialMessage: inlineImageMessage,
        })
      ).status,
    ).toBe(503);
    await expect(threadRow(heldId)).resolves.toEqual({ id: heldId });
    await expect(held.persisted[0]).resolves.toBe(true);
    fail = false;
    const reused = await held.create({
      projectId: project.data.id,
      threadId: heldId,
      initialMessage: inlineImageMessage,
    });
    expect(reused.status).toBe(201);
    expect(held.titleAgent).toHaveBeenCalledOnce();
  });
  it("links the first message's files to the Thread only once Flue admits it", async () => {
    const project = await createProjectViaApi("first-message-files");
    const attachmentId = "att_fedcba9876543210fedcba9876543210";
    await env.DB.prepare(
      `INSERT INTO attachments
         (id, uploader_user_id, object_key, filename, mime_type, size, state, created_at)
       VALUES (?1, ?2, 'attachments/' || ?2 || '/' || ?1, 'trace.log', 'text/plain', 42, 'ready', ?3)`,
    )
      .bind(attachmentId, owner, Date.now())
      .run();
    const initialMessage = {
      body: `Look at this\n\n${formatMessageAttachments([
        {
          id: attachmentId,
          name: "client-claimed.exe",
          mimeType: "text/html",
          size: 1,
          url: "https://evil.example/",
        },
      ])}`,
      attachments: [],
    };
    const linked = (threadId: string) =>
      env.DB.prepare(
        "SELECT thread_id FROM attachment_threads WHERE attachment_id = ? AND thread_id = ?",
      )
        .bind(attachmentId, threadId)
        .all()
        .then(({ results }) => results);

    // Flue refuses the message: the Thread stays, says why, and holds no file.
    const refusedId = newThreadId();
    const refused = harness(async () => {
      throw new SubmissionConflictError({ submissionId: "existing" });
    });
    expect(
      (
        await refused.create({
          projectId: project.data.id,
          threadId: refusedId,
          initialMessage,
        })
      ).status,
    ).toBe(201);
    await expect(threadRow(refusedId)).resolves.toEqual({ id: refusedId });
    await expect(initialDispatchRow(refusedId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "INITIAL_SUBMISSION_CONFLICT",
    });
    await expect(linked(refusedId)).resolves.toEqual([]);

    const dispatched: Array<Parameters<Dispatch>[0]> = [];
    const admittedId = newThreadId();
    const admitted = harness(flueValidatedDispatch(dispatched));
    expect(
      (
        await admitted.create({
          projectId: project.data.id,
          threadId: admittedId,
          initialMessage,
        })
      ).status,
    ).toBe(201);
    await expect(linked(admittedId)).resolves.toEqual([
      { thread_id: admittedId },
    ]);
    // The agent sees Core's record of the file, not the client's claim.
    expect(dispatched[0]?.message.body).toContain("trace.log");
    expect(dispatched[0]?.message.body).not.toContain("client-claimed.exe");
  });

  it("answers with the first message's receipt before the agent starts, then admits it", async () => {
    const project = await createProjectViaApi("deferred-first-message");
    const dispatched: Array<Parameters<Dispatch>[0]> = [];
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { create, read, settled } = harness(
      async (request) => {
        // The agent's Durable Object is still starting.
        await started;
        return flueValidatedDispatch(dispatched)(request);
      },
      async () => null,
      bindings,
      undefined,
      false,
    );
    const threadId = newThreadId();

    const response = await create({ projectId: project.data.id, threadId });

    // Answered while the agent has not admitted anything.
    expect(dispatched).toEqual([]);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { initialDispatch?: unknown };
      initialSubmission?: { submissionId: string };
    };
    expect(body.data.initialDispatch).toEqual({ state: "pending" });
    expect(body.initialSubmission?.submissionId).toBe(
      await initialSubmissionId(threadId as never),
    );
    // The Thread and its first message are both stored.
    await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
    await expect(initialDispatchRow(threadId)).resolves.toMatchObject({
      state: "pending",
    });
    await expect(read(threadId)).resolves.toMatchObject({
      data: { initialDispatch: { state: "pending" } },
    });

    release();
    await settled();
    // Flue gave the receipt the response promised, for the stored message.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      id: threadId,
      uid: null,
      idempotencyKey: "initial",
    });
    expect(dispatched[0]?.message.body).toContain("Fix the flaky login test");
    await expect(initialDispatchRow(threadId)).resolves.toBeNull();
    const detail = await read(threadId);
    expect(detail.data.initialDispatch).toBeUndefined();
  });

  it("delivers a first message the request left undelivered once, under one key", async () => {
    const calls: Array<Parameters<Dispatch>[0]> = [];
    let available = false;
    let agentUid: string | undefined;
    const flue: Dispatch = async (request) => {
      calls.push(request);
      if (!available) throw new Error("Durable Object reset.");
      // Something else (a follow-up from the page) started the agent.
      if (request.uid === null && agentUid !== undefined)
        throw new AgentInstanceExistsError({ id: request.id, uid: agentUid });
      return {
        submissionId: await initialSubmissionId(request.id as never),
      } as Awaited<ReturnType<Dispatch>>;
    };
    const project = await createProjectViaApi("undelivered-first-message");
    const { create, read } = harness(flue);
    const threadId = newThreadId();

    // Every attempt the request makes fails: the message waits, stored.
    const response = await create({ projectId: project.data.id, threadId });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(3);
    await expect(initialDispatchRow(threadId)).resolves.toMatchObject({
      state: "pending",
      attempts: 3,
    });
    await expect(read(threadId)).resolves.toMatchObject({
      data: { initialDispatch: { state: "pending" } },
    });

    // The sweep delivers it, to the agent that already exists, by its uid.
    available = true;
    agentUid = "uid-started-by-follow-up";
    const outcomes = await sweep(flue);
    expect(outcomes).toContainEqual(
      expect.objectContaining({ kind: "admitted" }),
    );
    const last = calls.at(-1);
    expect(last).toMatchObject({
      id: threadId,
      uid: agentUid,
      idempotencyKey: "initial",
    });
    expect(last?.initialData).toBeUndefined();
    await expect(initialDispatchRow(threadId)).resolves.toBeNull();

    // Nothing delivers it again: not the sweep, not a resend of the request.
    const callsAfterAdmission = calls.length;
    await sweep(flue);
    expect(calls).toHaveLength(callsAfterAdmission);
    agentUid = undefined;
    const resent = await create({ projectId: project.data.id, threadId });
    expect(resent.status).toBe(201);
    // The resend reaches Flue under the same key too. Every delivery
    // carried the same message under one key, which Flue admits once.
    expect(new Set(calls.map((call) => call.idempotencyKey))).toEqual(
      new Set(["initial"]),
    );
    expect(
      new Set(calls.map((call) => JSON.stringify(call.message))).size,
    ).toBe(1);
  });

  it("retries a first message that failed to start when its owner asks, once", async () => {
    // Ways this could fail: Retry admits nothing; a second press admits the
    // message again; someone else's Thread can be retried; a refused retry
    // leaves the Thread pending with no reason.
    const project = await createProjectViaApi("retried-first-message");
    const calls: Array<Parameters<Dispatch>[0]> = [];
    let accept = false;
    const flue: Dispatch = async (request) => {
      calls.push(request);
      if (!accept) throw new InputTooLargeError();
      return {
        submissionId: await initialSubmissionId(request.id as never),
      } as Awaited<ReturnType<Dispatch>>;
    };
    const { create, read, retry } = harness(flue);
    const threadId = newThreadId();
    expect(
      (await create({ projectId: project.data.id, threadId })).status,
    ).toBe(201);
    await expect(initialDispatchRow(threadId)).resolves.toMatchObject({
      state: "failed",
    });

    // Refused again: the Thread says so again, with the reason.
    const refused = await retry(threadId);
    expect(refused.status).toBe(200);
    await expect(refused.json()).resolves.toEqual({
      status: "success",
      data: { state: "failed", failureCode: "INITIAL_MESSAGE_TOO_LARGE" },
    });

    accept = true;
    const admitted = await retry(threadId);
    await expect(admitted.json()).resolves.toEqual({
      status: "success",
      data: { state: "admitted" },
    });
    await expect(initialDispatchRow(threadId)).resolves.toBeNull();
    await expect(read(threadId)).resolves.not.toHaveProperty(
      "data.initialDispatch",
    );
    // The same stored message every time, under the one key.
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.idempotencyKey))).toEqual(
      new Set(["initial"]),
    );
    expect(
      new Set(calls.map((call) => JSON.stringify(call.message))).size,
    ).toBe(1);

    // Pressed again: nothing left to retry, nothing delivered.
    const again = await retry(threadId);
    await expect(again.json()).resolves.toEqual({
      status: "success",
      data: { state: "admitted" },
    });
    expect(calls).toHaveLength(3);

    // Only the owner retries.
    await env.DB.prepare(
      `INSERT INTO thread_initial_dispatch
         (thread_id, request_json, sender_user_id, state, failure_code, created_at)
       VALUES (?, '{}', ?, 'failed', 'INITIAL_MESSAGE_REJECTED', ?)`,
    )
      .bind(threadId, owner, Date.now())
      .run();
    const stranger = await harness(
      flue,
      async () => null,
      bindings,
      undefined,
      true,
      otherPrincipal,
    ).retry(threadId);
    expect(stranger.status).toBe(404);
    await expect(initialDispatchRow(threadId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(calls).toHaveLength(3);
  });

  it("keeps a Thread whose first message failed to start and says why, without retrying it", async () => {
    // Ways this could fail: the Thread waits forever with no error; the
    // error never reaches the detail the page reads; the sweep retries a
    // refused message; the Orb started for it keeps running.
    const project = await createProjectViaApi("failed-first-message");
    const refusals = [
      {
        error: new FlueError({
          type: "invalid_request",
          message: "Request is malformed.",
          details: "rejected",
          dev: "",
        }),
        code: "INITIAL_MESSAGE_REJECTED",
      },
      { error: new InputTooLargeError(), code: "INITIAL_MESSAGE_TOO_LARGE" },
      {
        error: new SubmissionConflictError({ submissionId: "existing" }),
        code: "INITIAL_SUBMISSION_CONFLICT",
      },
    ];
    for (const refusal of refusals) {
      const calls: string[] = [];
      const refuse: Dispatch = async (request) => {
        calls.push(request.id);
        throw refusal.error;
      };
      const initialOrb = {
        start: vi.fn(async () => true),
        stop: vi.fn(async () => undefined),
      };
      const { create, read, persisted } = harness(
        refuse,
        async () => null,
        bindings,
        initialOrb,
      );
      const threadId = newThreadId();

      const response = await create({ projectId: project.data.id, threadId });

      expect(response.status).toBe(201);
      expect(calls).toEqual([threadId]);
      await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
      await expect(persisted[0]).resolves.toBe(true);
      await expect(read(threadId)).resolves.toMatchObject({
        data: {
          initialDispatch: { state: "failed", failureCode: refusal.code },
        },
      });
      expect(initialOrb.stop).toHaveBeenCalledWith(threadId);
      await sweep(refuse);
      expect(calls).toEqual([threadId]);
    }

    // A Flue that stays unavailable fails the message once its attempts
    // run out, rather than leaving it pending.
    const unavailable: Dispatch = async () => {
      throw new Error("Durable Object reset.");
    };
    const { create, read } = harness(unavailable);
    const threadId = newThreadId();
    expect(
      (await create({ projectId: project.data.id, threadId })).status,
    ).toBe(201);
    for (
      let attempt = 0;
      attempt < MAX_INITIAL_DISPATCH_ATTEMPTS &&
      (await initialDispatchRow(threadId))?.state === "pending";
      attempt++
    )
      await sweep(unavailable);
    await expect(initialDispatchRow(threadId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "INITIAL_ADMISSION_UNAVAILABLE",
      attempts: MAX_INITIAL_DISPATCH_ATTEMPTS,
    });
    await expect(read(threadId)).resolves.toMatchObject({
      data: {
        initialDispatch: {
          state: "failed",
          failureCode: "INITIAL_ADMISSION_UNAVAILABLE",
        },
      },
    });
  });
});
