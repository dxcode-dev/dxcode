import { env } from "cloudflare:test";
import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  ThreadSourceAuthority,
  ThreadSourceSnapshot,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import { FlueError, type Sandbox } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import { makeExecutionActivation } from "../../src/execution/activation.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionActivation,
} from "../../src/plugins/execution/provider.js";
import {
  SourceAuthorityRepository,
  SourceAuthorityRepositoryD1,
} from "../../src/source-control/runtime-authority.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Before a message is durable, only authentication, Thread access,
 * lifecycle, and malformed input may refuse it. Source authority and
 * workspace policy are checked when the run uses them, so a failure there
 * becomes a run error and the message is kept.
 */

const now = "2026-10-17T12:00:00.000Z";
const owner = Schema.decodeUnknownSync(UserId)("admission-owner");
const workspaceId = "admission-workspace";
const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-000000000f01", owner, "Admission"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const sourceThread = thread(
  "thr_00000000-0000-4000-8000-000000000f01",
  workspaceProject.id,
  owner,
  now,
);

const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_RUNTIME_MODE: "deployed",
  E2B_API_KEY: "deployment-key",
};

/** What reached Flue's router behind the admission stack. */
const forwarded: string[] = [];

const app = () => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  // Flue's router stands behind the real admission stack.
  const flue = new Hono<AppEnv>();
  flue.all("/:threadId/:subpath{.+}", (context) => {
    forwarded.push(`${context.req.method} ${context.req.param("subpath")}`);
    return context.json({ ok: true }, 200);
  });
  flue.get("/:threadId", (context) => {
    forwarded.push("GET history");
    return context.json({ entries: [] }, 200);
  });
  flue.post("/:threadId", (context) => {
    forwarded.push("POST message");
    return context.json({ submissionId: "sub-1" }, 202);
  });
  routes.route(
    "/v1/agents/dx",
    useAgentAdmission(new Hono<AppEnv>()).route("/", flue),
  );
  routes.onError(errorHandler);
  return routes;
};

const request = (path: string, method = "GET", body?: unknown) =>
  app().request(
    `/v1/agents/dx/${sourceThread.id}${path}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );

const send = (body: string) =>
  request("", "POST", { kind: "user", body, idempotencyKey: body });

/** The agent route traffic a person makes while a run is refused. */
const conversationTraffic = async () => ({
  message: (await send("Run the tests")).status,
  stop: (await request("/abort", "POST")).status,
  history: (await request("")).status,
  stream: (await request("/stream")).status,
});

const admitted = { message: 202, stop: 200, history: 200, stream: 200 };

/** The run's credentialed source work asks the D1 authority first. */
const sourceAuthority = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SourceAuthorityRepository).resolve(
        sourceThread.id,
        owner,
        { operation: "fetch", invocationSource: "agent-command" },
      );
    }).pipe(Effect.provide(SourceAuthorityRepositoryD1(env.DB))),
  );

/** Flue's sandbox factory for the run, over a provider that records activation. */
const orbActivation = () => {
  const activate = vi.fn<ExecutionActivation["activate"]>(
    async () => ({}) as Sandbox,
  );
  const workspaces = composeExecutionWorkspaces(
    bindings,
    {
      e2b: {
        workspace: { create: vi.fn(), connect: vi.fn(), release: vi.fn() },
      },
    },
    () => ({
      activate,
      reconnect: vi.fn(),
      ensureDaemon: vi.fn(),
      recordResidentTerminalInput: vi.fn(),
      recordResidentTerminalHeartbeat: vi.fn(),
    }),
    [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
  );
  return {
    activate,
    run: () => workspaces.sandboxFactory.createSandbox({ id: sourceThread.id }),
  };
};

/**
 * The run's Orb start through Core's real activation pipeline, over a
 * provider whose create stands for the Orb waking.
 */
const orbStart = () => {
  const create = vi.fn(async () => {
    throw new Error("Orb started.");
  });
  const workspaces = composeExecutionWorkspaces(
    bindings,
    {
      e2b: {
        workspace: { create, connect: vi.fn(), release: vi.fn() },
      },
    },
    makeExecutionActivation(),
    [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
  );
  return {
    create,
    run: () => workspaces.sandboxFactory.createSandbox({ id: sourceThread.id }),
  };
};

/** Every outbound request a step makes to GitHub. */
const githubRequests = async (step: () => Promise<unknown>) => {
  const spy = vi.spyOn(globalThis, "fetch");
  try {
    await step();
    return spy.mock.calls.filter(([input]) =>
      new URL(
        input instanceof Request ? input.url : String(input),
      ).hostname.endsWith("github.com"),
    );
  } finally {
    spy.mockRestore();
  }
};

const sourceDenied = (reason: string) =>
  expect.objectContaining({
    type: "source_authorization_denied",
    meta: expect.objectContaining({
      code: "SOURCE_AUTHORIZATION_DENIED",
      reason,
    }),
  });

beforeEach(async () => {
  forwarded.length = 0;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Ada Owner", `${owner}@example.test`, now, now),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Admission Team', 'admission-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('adm-owner', ?, ?, 'owner', 1)",
    ).bind(workspaceId, owner),
    env.DB.prepare(`
      INSERT INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES ('9401', '12345', '8401', 'organization', 'team', 'selected', 'active', 1, ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-admission', 'personal', ?1, '9401', 'active', ?1, ?2, ?2)
    `).bind(owner, now),
    env.DB.prepare(`
      INSERT INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES ('9401', '7401', 'team/repository',
        'https://github.com/team/repository', 'private', 1, ?)
    `).bind(now),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(workspaceProject);
      yield* projects.rebindRepositoryOwned(
        workspaceProject.id,
        owner,
        0,
        {
          provider: "github",
          bindingRevision: 1,
          fullName: "team/repository",
          webUrl: "https://github.com/team/repository",
          cloneUrl: "https://github.com/team/repository.git",
        },
        {
          provider: "github",
          ownerScope: "personal",
          ownerId: owner,
          grantId: "grant-admission",
          installationId: "9401",
          providerRepositoryId: "7401",
          bindingRevision: 1,
          provenance: "live-grant",
          defaultBranch: "main",
          health: { state: "available" },
          authorizationEpoch: 1,
          installationEpoch: 1,
          policyRevision: 0,
        },
      );
      yield* (yield* ThreadRepository).insert(sourceThread, {
        kind: "finalized",
        snapshot: Schema.decodeUnknownSync(ThreadSourceSnapshot)({
          version: 2,
          threadId: sourceThread.id,
          projectId: workspaceProject.id,
          bindingRevision: 1,
          provider: "github",
          repositoryName: "team/repository",
          cloneUrl: "https://github.com/team/repository.git",
          defaultBranch: "main",
          initialRef: "refs/heads/main",
          sourceRevision: "b".repeat(40),
          capturedAt: now,
        }),
        authority: Schema.decodeUnknownSync(ThreadSourceAuthority)({
          threadId: sourceThread.id,
          grantId: "grant-admission",
          installationId: "9401",
          providerRepositoryId: "7401",
          authorizationEpoch: 1,
          installationEpoch: 1,
          policyRevision: 0,
          privateSubmoduleRepositoryIds: [],
        }),
      });
    }),
  );
  // The fixture names a profile outside the test catalog.
  await env.DB.prepare(
    "UPDATE projects SET runner_profile_id = 'a1.medium' WHERE id = ?",
  )
    .bind(workspaceProject.id)
    .run();
});

describe("Agent admission, in workerd with real D1", () => {
  it("admits messages and Stop while GitHub is unreachable or the source grant is revoked; the run's source work is refused", async () => {
    // Every GitHub request fails: the test network blocks external hosts.
    await expect(sourceAuthority()).resolves.toMatchObject({
      grantId: "grant-admission",
    });
    expect(await conversationTraffic()).toEqual(admitted);

    await env.DB.prepare(
      "UPDATE github_owner_grant SET status = 'disconnected' WHERE id = 'grant-admission'",
    ).run();
    expect(await conversationTraffic()).toEqual(admitted);
    expect(forwarded).toEqual(
      Array.from({ length: 2 }, () => [
        "POST message",
        "POST abort",
        "GET history",
        "GET stream",
      ]).flat(),
    );
    // Checkout, fetch, push, and gh all resolve this authority before a
    // credential is minted, so the run fails there and keeps the message.
    await expect(sourceAuthority()).rejects.toMatchObject({
      reason: "grant-disconnected",
    });
  });

  it("admits messages and serves reads while workspace policy refuses the runner; the run's Orb activation is refused", async () => {
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    expect(await conversationTraffic()).toEqual(admitted);

    const orb = orbActivation();
    await expect(orb.run()).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason: "remote-runner-disabled",
    });
    expect(orb.activate).not.toHaveBeenCalled();

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await orb.run();
    expect(orb.activate).toHaveBeenCalledOnce();
  });

  it("refuses messages and Stop to an archived Thread and keeps its history and stream readable", async () => {
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(sourceThread.id)
      .run();
    const refused = await send("Run the tests");
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      data: { code: "THREAD_ARCHIVED" },
    });
    expect((await request("/abort", "POST")).status).toBe(409);
    expect((await request("")).status).toBe(200);
    expect((await request("/stream")).status).toBe(200);
    expect(forwarded).toEqual(["GET history", "GET stream"]);
  });

  it("admits a follow-up after dx revokes or rebinds the source, then fails its run at Orb start without asking GitHub", async () => {
    // A live grant lets the run start its Orb.
    const live = orbStart();
    await expect(live.run()).rejects.toThrow("Orb started.");
    expect(live.create).toHaveBeenCalledOnce();

    await env.DB.prepare(
      "UPDATE github_owner_grant SET status = 'disconnected' WHERE id = 'grant-admission'",
    ).run();
    expect((await send("Run the tests")).status).toBe(202);
    expect(forwarded).toEqual(["POST message"]);
    const revoked = orbStart();
    let failure: unknown;
    expect(
      await githubRequests(() =>
        revoked.run().catch((cause) => {
          failure = cause;
        }),
      ),
    ).toEqual([]);
    // Flue settles the run with this error; a plain Error would lose it.
    expect(failure).toBeInstanceOf(FlueError);
    expect(failure).toEqual(sourceDenied("grant-disconnected"));
    expect(revoked.create).not.toHaveBeenCalled();

    // The Project is rebound after the Thread captured its source.
    await env.DB.prepare(
      "UPDATE github_owner_grant SET status = 'active' WHERE id = 'grant-admission'",
    ).run();
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).rebindRepositoryOwned(
          workspaceProject.id,
          owner,
          1,
          {
            provider: "github",
            bindingRevision: 2,
            fullName: "team/repository",
            webUrl: "https://github.com/team/repository",
            cloneUrl: "https://github.com/team/repository.git",
          },
          {
            provider: "github",
            ownerScope: "personal",
            ownerId: owner,
            grantId: "grant-admission",
            installationId: "9401",
            providerRepositoryId: "7401",
            bindingRevision: 2,
            provenance: "live-grant",
            defaultBranch: "main",
            health: { state: "available" },
            authorizationEpoch: 1,
            installationEpoch: 1,
            policyRevision: 0,
          },
        );
      }),
    );
    const rebound = orbStart();
    await expect(rebound.run()).rejects.toEqual(sourceDenied("stale-snapshot"));
    expect(rebound.create).not.toHaveBeenCalled();
  });
});
