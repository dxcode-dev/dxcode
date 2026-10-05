import { env } from "cloudflare:test";
import { E2B_ORB_PROFILES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  currentOrbTemplateRecipe,
  E2BKeyRejected,
  type E2BTeamApi,
  type ListedTeamTemplate,
  teamTemplateName,
} from "../../src/execution/e2b/team-templates.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  makePersonalOrbProviderRoutes,
  makeWorkspaceOrbProviderRoutes,
} from "../../src/plugins/execution/orb-provider-routes.js";
import {
  OrbUnavailable,
  resolveThreadExecutionPin,
} from "../../src/plugins/execution/orb-providers.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const owner = "orb-owner" as UserId;
const member = "orb-member" as UserId;
const solo = "orb-solo" as UserId;
const workspaceId = "orb-workspace";
const workspaceSlug = "orb-routes";
const personalProject = "prj_00000000-0000-4000-8000-0000000004b1";
const workspaceProject = "prj_00000000-0000-4000-8000-0000000004b2";
const timestamp = "2026-10-04T00:00:00.000Z";
const capabilities = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
] as const;

const deployed: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  E2B_API_KEY: "deployment-e2b-key",
  DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
    version: 1,
    defaultProfileId: "a1.medium",
    profiles: E2B_ORB_PROFILES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      adapter: "e2b",
      template: `deployment-${profile.templateSuffix}`,
      resources: profile.resources,
      isolation: "sandbox",
      availability: "available",
      capabilities,
    })),
  }),
};

/** One fake E2B team per key: "key-a*" keys are team-a, "key-b*" team-b. */
const teams = new Map<string, Array<ListedTeamTemplate>>();
const teamOfKey = (apiKey: string) => (apiKey.startsWith("key-b") ? "b" : "a");
let builds = 0;
const teamApi: E2BTeamApi = {
  listTemplates: async (apiKey) => {
    if (apiKey === "rejected") throw new E2BKeyRejected();
    return teams.get(teamOfKey(apiKey)) ?? [];
  },
  buildBase: async (apiKey, name) => start(apiKey, name),
  buildProfile: async (apiKey, name) => start(apiKey, name),
  // Every build finishes by the next poll.
  buildStatus: async () => "ready",
};
const start = (apiKey: string, name: string) => {
  builds += 1;
  const team = teamOfKey(apiKey);
  const listed = teams.get(team) ?? [];
  listed.push({
    templateID: `t${builds}`,
    buildID: `b${builds}`,
    buildStatus: "ready",
    names: [`team-${team}/${name}`],
    aliases: [name],
  });
  teams.set(team, listed);
  return { templateId: `t${builds}`, buildId: `b${builds}` };
};

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const app = (userId: UserId) => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  router.route(
    "/personal/orb-providers",
    makePersonalOrbProviderRoutes({ teamApi }),
  );
  router.route(
    "/workspaces/:workspaceSlug/orb-providers",
    makeWorkspaceOrbProviderRoutes({ teamApi }),
  );
  router.onError(errorHandler);
  return router;
};

const call = async (
  userId: UserId,
  path: string,
  method: "GET" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  bindings: Bindings = deployed,
) => {
  const response = await app(userId).request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
    body: (await response.json()) as any,
  };
};

const personal = "/personal/orb-providers";
const workspace = `/workspaces/${workspaceSlug}/orb-providers`;

/** Lets the next poll advance a build (the claim interval is 10 s). */
const age = () =>
  env.DB.prepare(
    "UPDATE execution_account_template SET updated_at = '2026-01-01T00:00:00.000Z'",
  ).run();

/** Polls the page until the key's templates are ready. */
const pollReady = async (userId: UserId, path: string) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await age();
    const listed = await call(userId, path);
    const e2b = listed.body.data.providers.find(
      ({ id }: { id: string }) => id === "e2b",
    );
    if (e2b.key?.template?.status === "ready") return listed;
  }
  throw new Error("Orb templates never became ready.");
};

const thread = async (id: string, projectId: string, userId: UserId) => {
  await env.DB.prepare(
    "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, projectId, userId, timestamp, timestamp)
    .run();
  return id;
};

/** What the Thread repository writes beside a new Thread. */
const pin = async (
  threadId: string,
  userId: UserId,
  projectId: string | null,
) => {
  const resolved = await resolveThreadExecutionPin({
    db: env.DB,
    bindings: deployed,
    userId,
    projectId,
    runnerProfileId: undefined,
    recipe: await currentOrbTemplateRecipe(),
  });
  if (resolved === undefined) throw new Error("no pin");
  await env.DB.prepare(
    `UPDATE execution_workspace
        SET provider = ?, runner_profile_id = ?, account_scope = ?,
            account_owner_id = ?, provider_account = ?,
            provider_template = ?
      WHERE thread_id = ? AND state = 'uninitialized'
        AND account_scope IS NULL`,
  )
    .bind(
      resolved.provider,
      resolved.runnerProfileId,
      resolved.credentialScope,
      resolved.credentialOwnerId,
      resolved.credentialAccount,
      resolved.providerTemplate,
      threadId,
    )
    .run();
  return resolved;
};

const target = (threadId: string, bindings: Bindings = deployed) =>
  Effect.runPromise(
    resolveExecutionTarget(bindings, threadId, { admission: false }),
  );

beforeEach(async () => {
  teams.clear();
  builds = 0;
  await env.DB.batch([
    ...[owner, member, solo].map((id) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, id, `${id}@example.com`, 1, 1),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Orb Routes", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("orb-owner-member", workspaceId, owner, "owner", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("orb-member-member", workspaceId, member, "member", 1),
    ...[
      [personalProject, solo, null],
      [workspaceProject, member, workspaceId],
    ].map(([id, userId, workspace]) =>
      env.DB.prepare(
        `INSERT INTO projects (
           id, owner_user_id, workspace_id, name, runner_profile_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'a1.medium', ?, ?)`,
      ).bind(id, userId, workspace, `Project ${id}`, timestamp, timestamp),
    ),
  ]);
});

describe("Orb providers in workerd with real D1", () => {
  it("lists the deployment's E2B and an empty key slot", async () => {
    const listed = await call(solo, personal);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toMatchObject({
      scope: "personal",
      canUpdate: true,
      localRuntime: false,
      personalKeysOnWorkspaceProjects: null,
      providers: [
        {
          id: "e2b",
          displayName: "E2B",
          credentialLabel: "E2B API key",
          pauseResume: "processes",
          deployment: true,
          key: null,
          workspaceKey: null,
        },
      ],
      resolved: [{ providerId: "e2b", scope: "deployment", status: "ready" }],
    });
  });

  it("builds a personal key's templates, pins a Thread to its account, and fails closed when the key goes", async () => {
    expect(
      (
        await call(solo, `${personal}/e2b/key`, "PUT", {
          credential: "rejected",
        })
      ).status,
    ).toBe(400);
    const saved = await call(solo, `${personal}/e2b/key`, "PUT", {
      credential: "key-a-1",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.providers[0].key).toMatchObject({
      account: "team-a",
      template: { status: "building", error: null },
    });
    // A Thread cannot start on the key until its templates are ready.
    expect(saved.body.data.resolved[0]).toMatchObject({
      scope: "personal",
      status: "building",
    });
    await expect(
      pin(
        await thread(
          "thr_00000000-0000-4000-8000-0000000004c0",
          personalProject,
          solo,
        ),
        solo,
        personalProject,
      ),
    ).rejects.toBeInstanceOf(OrbUnavailable);

    const ready = await pollReady(solo, personal);
    expect(ready.body.data.resolved[0]).toMatchObject({
      providerId: "e2b",
      scope: "personal",
      account: "team-a",
      status: "ready",
    });
    const recipe = await currentOrbTemplateRecipe();
    expect(teams.get("a")?.map(({ aliases }) => aliases[0])).toEqual([
      teamTemplateName(recipe),
      ...E2B_ORB_PROFILES.map((profile) => teamTemplateName(recipe, profile)),
    ]);

    const byok = await thread(
      "thr_00000000-0000-4000-8000-0000000004c1",
      personalProject,
      solo,
    );
    expect(await pin(byok, solo, personalProject)).toEqual({
      provider: "e2b",
      runnerProfileId: "a1.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: "team-a",
      providerTemplate: teamTemplateName(recipe, E2B_ORB_PROFILES[2]),
    });
    const resolved = await target(byok);
    expect(resolved.profile).toMatchObject({
      id: "a1.medium",
      template: teamTemplateName(recipe, E2B_ORB_PROFILES[2]),
    });
    expect(resolved.credential).toMatchObject({
      scope: "personal",
      ownerId: solo,
      account: "team-a",
    });
    if (resolved.credential.scope !== "personal") throw new Error();
    expect(Redacted.value(resolved.credential.key)).toBe("key-a-1");
    // The pin is immutable once written.
    await expect(
      env.DB.prepare(
        "UPDATE execution_workspace SET account_scope = 'deployment', account_owner_id = NULL, provider_account = NULL, provider_template = NULL WHERE thread_id = ?",
      )
        .bind(byok)
        .run(),
    ).rejects.toThrow();

    // A key rotated within team-a is used for the next operation.
    await call(solo, `${personal}/e2b/key`, "PUT", { credential: "key-a-2" });
    const rotated = await target(byok);
    if (rotated.credential.scope !== "personal") throw new Error();
    expect(Redacted.value(rotated.credential.key)).toBe("key-a-2");

    // A key for another team does not reach the pinned sandbox.
    await call(solo, `${personal}/e2b/key`, "PUT", { credential: "key-b-1" });
    expect((await target(byok)).credential).toEqual({
      scope: "unavailable",
      reason: "account-changed",
    });

    // Removed: fails closed, and releasing knows to skip the provider.
    await call(solo, `${personal}/e2b/key`, "DELETE");
    expect((await target(byok)).credential).toEqual({
      scope: "unavailable",
      reason: "removed",
    });

    // A Thread pinned to the deployment key is unaffected throughout.
    const deploymentThread = await thread(
      "thr_00000000-0000-4000-8000-0000000004c2",
      personalProject,
      solo,
    );
    expect(
      (await pin(deploymentThread, solo, personalProject)).credentialScope,
    ).toBe("deployment");
    expect((await target(deploymentThread)).credential).toEqual({
      scope: "deployment",
    });
    // The local runtime never uses a person's key.
    expect(
      (await target(byok, { ...deployed, DX_RUNTIME_MODE: "local" }))
        .credential,
    ).toEqual({ scope: "unavailable", reason: "local-runtime" });
  });

  it("ignores a member's personal key on workspace projects until the admin opts in", async () => {
    await call(member, `${personal}/e2b/key`, "PUT", { credential: "key-a-1" });
    await pollReady(member, personal);
    const onWorkspaceProject = async () =>
      (await call(member, `${personal}?projectId=${workspaceProject}`)).body
        .data;
    // Default policy: the general plugin flag is on, the Orb opt-in is off.
    expect(await onWorkspaceProject()).toMatchObject({
      personalKeysOnWorkspaceProjects: {
        allowed: false,
        pluginOverridesAllowed: true,
        executionOverridesAllowed: false,
      },
      resolved: [{ scope: "deployment" }],
    });
    const before = await thread(
      "thr_00000000-0000-4000-8000-0000000004c3",
      workspaceProject,
      member,
    );
    expect((await pin(before, member, workspaceProject)).credentialScope).toBe(
      "deployment",
    );

    // Only an admin opts in.
    expect(
      (
        await call(member, `${workspace}/policy`, "PUT", {
          allowPersonalKeysOnWorkspaceProjects: true,
        })
      ).status,
    ).not.toBe(200);
    const optedIn = await call(owner, `${workspace}/policy`, "PUT", {
      allowPersonalKeysOnWorkspaceProjects: true,
    });
    expect(optedIn.status).toBe(200);
    expect(optedIn.body.data.personalKeysOnWorkspaceProjects.allowed).toBe(
      true,
    );
    expect((await onWorkspaceProject()).resolved).toMatchObject([
      { scope: "personal", account: "team-a" },
    ]);
    const after = await thread(
      "thr_00000000-0000-4000-8000-0000000004c4",
      workspaceProject,
      member,
    );
    expect((await pin(after, member, workspaceProject)).credentialScope).toBe(
      "personal",
    );
    expect((await target(after)).credential).toMatchObject({
      scope: "personal",
    });
    // Withdrawing the opt-in fails the pinned Thread closed.
    await call(owner, `${workspace}/policy`, "PUT", {
      allowPersonalKeysOnWorkspaceProjects: false,
    });
    expect((await target(after)).credential).toEqual({
      scope: "unavailable",
      reason: "policy-denied",
    });
  });

  it("lets only workspace admins set the workspace key, which members then use", async () => {
    expect(
      (
        await call(member, `${workspace}/e2b/key`, "PUT", {
          credential: "key-a-1",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(owner, `${workspace}/e2b/key`, "PUT", {
          credential: "key-a-1",
        })
      ).status,
    ).toBe(200);
    await pollReady(owner, workspace);
    const memberView = (await call(member, personal)).body.data;
    expect(memberView.providers[0]).toMatchObject({
      key: null,
      workspaceKey: { account: "team-a", template: { status: "ready" } },
    });
    expect(memberView.resolved).toMatchObject([
      { scope: "workspace", account: "team-a" },
    ]);
    const threadId = await thread(
      "thr_00000000-0000-4000-8000-0000000004c5",
      workspaceProject,
      member,
    );
    expect(await pin(threadId, member, workspaceProject)).toMatchObject({
      credentialScope: "workspace",
      credentialOwnerId: workspaceId,
    });
    expect((await target(threadId)).credential).toMatchObject({
      scope: "workspace",
      ownerId: workspaceId,
    });
    // A member who leaves the workspace no longer runs on its key.
    await env.DB.prepare(
      "DELETE FROM member WHERE id = 'orb-member-member'",
    ).run();
    expect((await target(threadId)).credential).toEqual({
      scope: "unavailable",
      reason: "not-a-member",
    });
  });

  it("keeps the key but never reaches E2B in the local runtime", async () => {
    const local = { ...deployed, DX_RUNTIME_MODE: "local" };
    const saved = await call(
      solo,
      `${personal}/e2b/key`,
      "PUT",
      { credential: "rejected" },
      local,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.localRuntime).toBe(true);
    expect(
      saved.body.data.providers.find(({ id }: { id: string }) => id === "e2b")
        .key,
    ).toMatchObject({ account: null, template: null });
    expect(builds).toBe(0);
  });
});
