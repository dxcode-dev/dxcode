import { env } from "cloudflare:test";
import { E2B_ORB_PROFILES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeE2BConnector } from "../../src/execution/e2b/connector.js";
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
import type { OrbConnectionKey } from "../../src/plugins/execution/connections-d1.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import {
  makePersonalOrbProviderRoutes,
  makeWorkspaceOrbProviderRoutes,
} from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import { encryptPluginCredential } from "../../src/plugins/settings-store-d1.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
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

/** A deployment that offers E2B on its own account. */
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

/** A deployment installed with no Orb provider at all. */
const providerless: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

/** One fake E2B team per key: "key-a*" keys are team-a, "key-b*" team-b. */
const teams = new Map<string, Array<ListedTeamTemplate>>();
const teamOfKey = (apiKey: string) => (apiKey.startsWith("key-b") ? "b" : "a");
let builds = 0;
/** Keys E2B stops accepting after they were saved. */
const revoked = new Set<string>();
const teamApi: E2BTeamApi = {
  listTemplates: async (apiKey) => {
    if (apiKey === "rejected" || revoked.has(apiKey))
      throw new E2BKeyRejected();
    return teams.get(teamOfKey(apiKey)) ?? [];
  },
  buildBase: async (apiKey, name) => start(apiKey, name),
  buildProfile: async (apiKey, name) => start(apiKey, name),
  // Every build finishes by the next step.
  buildStatus: async (apiKey) => {
    if (revoked.has(apiKey)) throw new E2BKeyRejected();
    return "ready";
  },
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
/** The recipe this "build" prepares for; a test moves it like a deploy. */
let recipeOverride: string | undefined;
const e2bConnector = makeE2BConnector(teamApi);
const connectors: OrbProviderConnectors = {
  e2b: {
    ...e2bConnector,
    recipe: async () => recipeOverride ?? (await e2bConnector.recipe()),
  },
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
    makePersonalOrbProviderRoutes({ connectors }),
  );
  router.route(
    "/workspaces/:workspaceSlug/orb-providers",
    makeWorkspaceOrbProviderRoutes({ connectors }),
  );
  router.onError(errorHandler);
  return router;
};

const call = async (
  userId: UserId,
  path: string,
  method: "GET" | "PUT" | "POST" | "DELETE" = "GET",
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

const connect = (
  userId: UserId,
  base: string,
  apiKey: string,
  bindings: Bindings = deployed,
) =>
  call(
    userId,
    `${base}/e2b/connection`,
    "PUT",
    { credentials: { apiKey } },
    bindings,
  );

const e2bOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "e2b") as any;

/**
 * Runs the connection's preparation object's steps until it stops, as its
 * alarms do, with the fake E2B team.
 */
const prepare = async (key: OrbConnectionKey, bindings = deployed) => {
  for (let step = 0; step < 12; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    if (outcome.nextStepInMs === undefined) return;
  }
  throw new Error("Preparation never finished.");
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
  bindings: Bindings = deployed,
) => {
  const resolved = await resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId,
    projectId,
    runnerProfileId: undefined,
    connectors,
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

const apiKeyOf = (
  credential: Awaited<ReturnType<typeof target>>["credential"],
) => {
  if (credential.scope !== "personal" && credential.scope !== "workspace")
    throw new Error(`no connection: ${credential.scope}`);
  return Redacted.value(credential.credentials).apiKey;
};

beforeEach(async () => {
  recipeOverride = undefined;
  teams.clear();
  revoked.clear();
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

describe("Orb provider connections in workerd with real D1", () => {
  it("runs with no deployment provider: E2B is connectable and nothing can start yet", async () => {
    const listed = await call(solo, personal, "GET", undefined, providerless);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toMatchObject({
      scope: "personal",
      canUpdate: true,
      localRuntime: false,
      resolved: [],
    });
    expect(e2bOf(listed.body.data)).toMatchObject({
      id: "e2b",
      displayName: "E2B",
      fields: [{ id: "apiKey", label: "E2B API key", secret: true }],
      deployment: false,
      connection: null,
      workspaceConnection: null,
    });
    expect(
      e2bOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(E2B_ORB_PROFILES.map(({ id }) => id));
    // Thread creation says why instead of creating a Thread that cannot run.
    await expect(
      pin(
        await thread(
          "thr_00000000-0000-4000-8000-0000000004a0",
          personalProject,
          solo,
        ),
        solo,
        personalProject,
        providerless,
      ),
    ).rejects.toMatchObject({ _tag: "OrbUnavailable", reason: "no-provider" });

    // Connecting their own team is all a person needs.
    await connect(solo, personal, "key-a-1", providerless);
    await prepare(
      { scope: "personal", targetId: solo, providerId: "e2b" },
      providerless,
    );
    const ready = await call(solo, personal, "GET", undefined, providerless);
    expect(ready.body.data.resolved).toEqual([
      {
        providerId: "e2b",
        scope: "personal",
        account: "team-a",
        status: "ready",
      },
    ]);
    const threadId = await thread(
      "thr_00000000-0000-4000-8000-0000000004a1",
      personalProject,
      solo,
    );
    expect(
      await pin(threadId, solo, personalProject, providerless),
    ).toMatchObject({
      credentialScope: "personal",
      credentialAccount: "team-a",
    });
    expect(apiKeyOf((await target(threadId, providerless)).credential)).toBe(
      "key-a-1",
    );
  });

  it("prepares a personal connection, pins a Thread to its account, and fails closed when it goes", async () => {
    const rejected = await connect(solo, personal, "rejected");
    expect(rejected.status).toBe(400);
    expect(rejected.body.data).toMatchObject({
      code: "ORB_PROVIDER_CREDENTIALS_REJECTED",
      detail: "E2B rejected this API key.",
    });
    // Only the provider's own fields are accepted.
    expect(
      (
        await call(solo, `${personal}/e2b/connection`, "PUT", {
          credentials: { apiKey: "key-a-1", extra: "x" },
        })
      ).status,
    ).toBe(400);
    const saved = await connect(solo, personal, "key-a-1");
    expect(saved.status).toBe(200);
    expect(e2bOf(saved.body.data).connection).toMatchObject({
      account: "team-a",
      status: "preparing",
      progress: { done: 0, total: E2B_ORB_PROFILES.length + 1 },
      error: null,
    });
    // A Thread cannot start on the connection until it is ready, and never
    // falls back to the deployment's account meanwhile.
    expect(saved.body.data.resolved[0]).toMatchObject({
      scope: "personal",
      status: "preparing",
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
    ).rejects.toMatchObject({ _tag: "OrbUnavailable", reason: "preparing" });

    await prepare({ scope: "personal", targetId: solo, providerId: "e2b" });
    const ready = await call(solo, personal);
    expect(e2bOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      progress: null,
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
    expect(apiKeyOf(resolved.credential)).toBe("key-a-1");
    // The pin is immutable once written.
    await expect(
      env.DB.prepare(
        "UPDATE execution_workspace SET account_scope = 'deployment', account_owner_id = NULL, provider_account = NULL, provider_template = NULL WHERE thread_id = ?",
      )
        .bind(byok)
        .run(),
    ).rejects.toThrow();

    // A key rotated within team-a is used for the next operation, and the
    // team's templates are reused at once.
    const rotated = await connect(solo, personal, "key-a-2");
    expect(e2bOf(rotated.body.data).connection.status).toBe("ready");
    expect(apiKeyOf((await target(byok)).credential)).toBe("key-a-2");

    // A key for another team does not reach the pinned sandbox.
    await connect(solo, personal, "key-b-1");
    expect((await target(byok)).credential).toEqual({
      scope: "unavailable",
      reason: "account-changed",
    });

    // Removed: fails closed, and releasing knows to skip the provider.
    await call(solo, `${personal}/e2b/connection`, "DELETE");
    expect((await target(byok)).credential).toEqual({
      scope: "unavailable",
      reason: "removed",
    });

    // A Thread pinned to the deployment's account is unaffected throughout.
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
    // The local runtime never uses a person's connection.
    expect(
      (await target(byok, { ...deployed, DX_RUNTIME_MODE: "local" }))
        .credential,
    ).toEqual({ scope: "unavailable", reason: "local-runtime" });
  });

  it("keeps new Threads on the ready version while a new recipe prepares", async () => {
    await connect(solo, personal, "key-a-1");
    const key = {
      scope: "personal",
      targetId: solo,
      providerId: "e2b",
    } as const;
    await prepare(key);
    const before = await currentOrbTemplateRecipe();
    const oldTemplate = teamTemplateName(before, E2B_ORB_PROFILES[2]);

    // A deploy ships a new Orb recipe: the connection prepares again, and
    // new Threads keep starting on the templates already in the team.
    recipeOverride = "fedcba9876543210";
    const updating = (await call(solo, personal)).body.data;
    expect(e2bOf(updating).connection).toMatchObject({
      status: "preparing",
      updating: true,
    });
    expect(updating.resolved).toEqual([
      expect.objectContaining({ scope: "personal", status: "ready" }),
    ]);
    const pinNew = async (id: string) =>
      pin(await thread(id, personalProject, solo), solo, personalProject);
    expect(
      (await pinNew("thr_00000000-0000-4000-8000-0000000004f0"))
        .providerTemplate,
    ).toBe(oldTemplate);
    // The first step starts the new build; the old version still serves.
    await advanceConnection(deployed, env.DB, key, connectors);
    expect(
      (await pinNew("thr_00000000-0000-4000-8000-0000000004f1"))
        .providerTemplate,
    ).toBe(oldTemplate);
    expect(
      e2bOf((await call(solo, personal)).body.data).connection,
    ).toMatchObject({
      status: "preparing",
      updating: true,
      progress: { done: 0 },
    });

    // Ready: new Threads move to the new recipe's templates.
    await prepare(key);
    expect(
      e2bOf((await call(solo, personal)).body.data).connection,
    ).toMatchObject({ status: "ready", updating: false });
    expect(
      (await pinNew("thr_00000000-0000-4000-8000-0000000004f2"))
        .providerTemplate,
    ).toBe(teamTemplateName("fedcba9876543210", E2B_ORB_PROFILES[2]));
  });

  it("fails a connection the provider stops accepting, and retries it", async () => {
    await connect(solo, personal, "key-a-1");
    revoked.add("key-a-1");
    const key = {
      scope: "personal",
      targetId: solo,
      providerId: "e2b",
    } as const;
    await prepare(key);
    const failed = await call(solo, personal);
    expect(e2bOf(failed.body.data).connection).toMatchObject({
      status: "failed",
      error: "E2B rejected this API key.",
    });
    expect(failed.body.data.resolved[0]).toMatchObject({ status: "failed" });

    revoked.clear();
    const retried = await call(
      solo,
      `${personal}/e2b/connection/retry`,
      "POST",
    );
    expect(retried.status).toBe(200);
    expect(e2bOf(retried.body.data).connection).toMatchObject({
      status: "preparing",
      error: null,
    });
    await prepare(key);
    expect(
      e2bOf((await call(solo, personal)).body.data).connection.status,
    ).toBe("ready");
  });

  it("moves an Orb key saved before connections into a ready connection", async () => {
    // An E2B key and its finished template builds, as 0.2 stored them.
    const recipe = await currentOrbTemplateRecipe();
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(deployed),
    );
    const envelope = await encryptPluginCredential(
      keyring,
      { scope: "personal", targetId: solo, pluginId: "execution" },
      "e2b",
      "key-a-legacy",
    );
    const builds = [null, ...E2B_ORB_PROFILES].map((profile, index) => ({
      profileId: profile?.id ?? null,
      name: teamTemplateName(recipe, profile ?? undefined),
      templateId: `legacy-t${index}`,
      buildId: `legacy-b${index}`,
      status: "ready",
    }));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO plugin_setting (
           scope, target_id, plugin_id, provider_id, envelope_version,
           key_version, value_nonce, ciphertext, wrapped_key_nonce,
           wrapped_key, configured_at, updated_at
         ) VALUES ('personal', ?, 'execution', 'e2b', 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        solo,
        envelope.keyVersion,
        envelope.valueNonce,
        envelope.ciphertext,
        envelope.wrappedKeyNonce,
        envelope.wrappedKey,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO execution_account_template (
           scope, target_id, provider_id, configured_at, recipe, account,
           state, builds_json, error, revision, updated_at
         ) VALUES ('personal', ?, 'e2b', ?, ?, 'team-a', 'ready', ?, NULL, 0, ?)`,
      ).bind(solo, timestamp, recipe, JSON.stringify(builds), timestamp),
    ]);
    // Migration 0084's copy, as it runs on a deployment's D1.
    const migration = env.TEST_MIGRATIONS.find(
      ({ name }) => name === "0084_orb_provider_connections.sql",
    );
    const copy = migration?.queries.find((query) =>
      query.trimStart().startsWith("INSERT INTO orb_connection"),
    );
    if (copy === undefined) throw new Error("migration copy not found");
    await env.DB.prepare(copy).run();

    expect(e2bOf((await call(solo, personal)).body.data).connection).toEqual({
      configuredAt: timestamp,
      account: "team-a",
      status: "ready",
      progress: null,
      error: null,
      updating: false,
    });
    const threadId = await thread(
      "thr_00000000-0000-4000-8000-0000000004e0",
      personalProject,
      solo,
    );
    expect(await pin(threadId, solo, personalProject)).toMatchObject({
      credentialScope: "personal",
      providerTemplate: teamTemplateName(recipe, E2B_ORB_PROFILES[2]),
    });
    // The bare key it always held still decrypts.
    expect(apiKeyOf((await target(threadId)).credential)).toBe("key-a-legacy");
  });

  it("ignores a member's personal connection on workspace projects until the admin opts in", async () => {
    await connect(member, personal, "key-a-1");
    await prepare({ scope: "personal", targetId: member, providerId: "e2b" });
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

  it("lets only workspace admins connect the workspace's account, which members then use", async () => {
    expect((await connect(member, workspace, "key-a-1")).status).toBe(403);
    expect((await connect(owner, workspace, "key-a-1")).status).toBe(200);
    await prepare({
      scope: "workspace",
      targetId: workspaceId,
      providerId: "e2b",
    });
    const memberView = (await call(member, personal)).body.data;
    expect(e2bOf(memberView)).toMatchObject({
      connection: null,
      workspaceConnection: { account: "team-a", status: "ready" },
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
    // A member who leaves the workspace no longer runs on its account.
    await env.DB.prepare(
      "DELETE FROM member WHERE id = 'orb-member-member'",
    ).run();
    expect((await target(threadId)).credential).toEqual({
      scope: "unavailable",
      reason: "not-a-member",
    });
  });

  it("keeps the connection but never reaches E2B in the local runtime", async () => {
    const local = { ...deployed, DX_RUNTIME_MODE: "local" };
    const saved = await connect(solo, personal, "rejected", local);
    expect(saved.status).toBe(200);
    expect(saved.body.data.localRuntime).toBe(true);
    expect(e2bOf(saved.body.data).connection).toMatchObject({
      account: null,
      status: null,
    });
    expect(builds).toBe(0);
  });
});
