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
import { createThreadRoutes } from "../../src/threads/routes.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  jsonHeaders,
  owner,
  principal,
} from "./product-route-fixture.js";

/**
 * POST /v1/threads with a first message, through the real gates and D1, with
 * Flue's dispatch and instance lookup replaced. Creation must refuse a
 * permanent failure before the Thread exists, and must never leave an empty
 * Thread behind once Flue holds nothing for it.
 */

type Dispatch = NonNullable<Parameters<typeof createThreadRoutes>[0]>;
type InstanceLookup = NonNullable<Parameters<typeof createThreadRoutes>[2]>;

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
    return { submissionId: "initial-submission" } as Awaited<
      ReturnType<Dispatch>
    >;
  };

const harness = (
  dispatch: Dispatch,
  lookup: InstanceLookup = async () => null,
  routeBindings = bindings,
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
    context.set("principal", principal);
    await next();
  });
  app.route("/threads", createThreadRoutes(dispatch, titleAgent, lookup));
  app.onError(errorHandler);
  const pending: Array<Promise<unknown>> = [];
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
      {
        ...routeBindings,
        BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
      },
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );
    await Promise.allSettled(pending);
    return response;
  };
  return { create, persisted, titleAgent };
};

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

    const response = await create({
      projectId: project.data.id,
      threadId: newThreadId(),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      initialSubmission: { submissionId: "initial-submission" },
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

  it("answers a permanent Flue rejection with its own code and removes the empty Thread", async () => {
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

      const response = await create({ projectId: project.data.id, threadId });

      expect(response.status).toBe(rejection.status);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: rejection.code },
      });
      await expect(threadRow(threadId)).resolves.toBeNull();
      await expect(persisted[0]).resolves.toBe(false);

      // The same request, once accepted, creates the Thread.
      reject = false;
      const retried = await create({ projectId: project.data.id, threadId });
      expect(retried.status).toBe(201);
      await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
    }
  });

  it("keeps a Thread whose agent already holds a submission and names the conflict", async () => {
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

      const response = await create({ projectId: project.data.id, threadId });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: conflict.code },
      });
      await expect(threadRow(threadId)).resolves.toEqual({ id: threadId });
    }
  });

  it("removes the Thread after a dispatch failure only when Flue holds nothing for it", async () => {
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
      (await held.create({ projectId: project.data.id, threadId: heldId }))
        .status,
    ).toBe(503);
    await expect(threadRow(heldId)).resolves.toEqual({ id: heldId });
    await expect(held.persisted[0]).resolves.toBe(true);
    fail = false;
    const reused = await held.create({
      projectId: project.data.id,
      threadId: heldId,
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

    // Flue refuses the message but holds the agent, so the Thread stays.
    const refusedId = newThreadId();
    const refused = harness(
      async () => {
        throw new SubmissionConflictError({ submissionId: "existing" });
      },
      async () => ({ id: refusedId, uid: "uid-1" }),
    );
    expect(
      (
        await refused.create({
          projectId: project.data.id,
          threadId: refusedId,
          initialMessage,
        })
      ).status,
    ).toBe(409);
    await expect(threadRow(refusedId)).resolves.toEqual({ id: refusedId });
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
});
