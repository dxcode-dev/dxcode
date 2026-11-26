import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import type { Bindings } from "../../src/http/types.js";
import {
  pluginAppPortal,
  pluginAppUrl,
} from "../../src/plugins/services/app.js";
import { callService } from "../../src/plugins/services/host.js";
import { loadServiceInstall } from "../../src/plugins/services/installs.js";
import { sweepPluginServices } from "../../src/plugins/services/lifecycle.js";
import { resolveExecutionOwner } from "../../src/plugins/services/orb-owner.js";
import { ensureInstallPluginOrb } from "../../src/plugins/services/plugin-orbs.js";
import { handleServiceRequest } from "../../src/plugins/services/requests.js";
import { evaluatePortalAccess } from "../../src/portals/access.js";
import {
  createTestBindings,
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { direct as r2Transfer } from "./r2-harness.js";

/**
 * Plugin services' Core half over real D1: where an install's service
 * runs, and what its requests to dx may do. dxd is not here; the Orb's
 * daemon side is proven in apps/dxd/tests and on the preview.
 *
 * Ways it could fail, each covered below:
 * - a service starts on an Orb nobody chose, or the refusal does not say
 *   where to choose one;
 * - the wrong person pays: not the installer, or a workspace's installs by
 *   two people share one Orb's minutes;
 * - a second start makes a second Orb;
 * - the plugin Orb is not pinned like a Thread's Orb, so activation cannot
 *   resolve it, or it resolves as a Thread;
 * - a service reads or writes state of an install that is not on its Orb,
 *   or of another workspace's install;
 * - state written by a service is lost or over its limits;
 * - a Thread route accepts a plugin Orb's ID;
 * - a call that woke the Orb succeeds but the row still says `starting`,
 *   so its page's Portal and `keepRunning` never see it run;
 * - a plugin's page opened on a cold Orb gets a URL the Portal then
 *   refuses, because the row is not yet `running` on that port.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  BETTER_AUTH_SECRET: "plugin-services-secret-0000000000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};
/** A deployed runtime with its own E2B account, so a size pins as a Thread's would. */
const deployed: Bindings = { ...createTestBindings(), DB: env.DB };
const now = "2026-11-25T10:00:00.000Z";

const signup = async (email: string, index: number) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${index}`,
      },
      body: JSON.stringify({
        name: email.split("@")[0],
        email,
        password: "plugin-services-password-1234",
      }),
    },
    bindings,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (user === null) throw new Error("Expected user row.");
  return { cookie, userId: user.id };
};

const call = async (
  path: string,
  cookie: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  const text = await response.text();
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: shapes are asserted below.
    body: (text === "" ? undefined : JSON.parse(text)) as any,
  };
};

/** Installs a plugin whose code is a service, as its installer. */
const installService = async (input: {
  readonly scope: "personal" | "workspace";
  readonly targetId: string;
  readonly installer: string;
  readonly orb?: "shared" | "own";
  readonly app?: { readonly path: string };
  readonly keepRunning?: boolean;
}) => {
  const pluginId = `plg_${crypto.randomUUID()}`;
  const name = `com.example.watch-${crypto.randomUUID().slice(0, 8)}`;
  const version = "1.0.0";
  const manifest = {
    format: "agent-plugins",
    name,
    displayName: "Log watch",
    description: "Checks logs.",
    skills: [],
    mcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      modules: [],
      permissions: {
        events: [],
        network: [],
        secrets: [],
        tools: [],
        ai: false,
        threads: ["create", "post"],
      },
      settings: [],
      service: {
        run: "node service.js",
        orb: input.orb ?? "shared",
        keepRunning: input.keepRunning ?? false,
        ...(input.app === undefined ? {} : { app: input.app }),
      },
      schedules: [{ name: "check", every: "15m" }],
    },
    skipped: [],
    package: { sha256: "a".repeat(64), size: 10 },
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trusted_plugin (
         id, scope, target_id, name, enabled, active_version, health_status,
         created_at, updated_at, kind
       ) VALUES (?, ?, ?, ?, 1, ?, 'unchecked', ?, ?, 'bundle')`,
    ).bind(pluginId, input.scope, input.targetId, name, version, now, now),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (
         plugin_id, version, manifest_json, grants_json, source_json,
         integrity, trusted, trusted_at, trusted_by_user_id
       ) VALUES (?, ?, ?, '{}', '{"type":"zip","label":"test.zip"}', ?, 1, ?, ?)`,
    ).bind(
      pluginId,
      version,
      JSON.stringify(manifest),
      "b".repeat(64),
      now,
      input.installer,
    ),
  ]);
  const install = await loadServiceInstall(env.DB, pluginId);
  if (install === undefined) throw new Error("Expected a service install.");
  return install;
};

const workspace = async (slug: string, admin: string, member: string) => {
  const id = `wks-${slug}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(id, slug, slug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', 1), (?, ?, ?, 'member', 1)`,
    ).bind(`mem-${slug}-a`, id, admin, `mem-${slug}-m`, id, member),
  ]);
  return id;
};

const place = (pluginId: string, orbId: string) =>
  env.DB.prepare(
    `INSERT INTO plugin_service (plugin_id, orb_id, status, updated_at)
     VALUES (?, ?, 'running', ?)`,
  )
    .bind(pluginId, orbId, now)
    .run();

/**
 * dxd on a plugin Orb, behind a fake execution object: each
 * `service.ensure` answers the next of `states` (then the last) with port
 * 41007, and `service.call` answers 200. Package URLs presign against the
 * R2 test endpoint, as a deployed stage's would.
 */
const wokenDxd = (states: ReadonlyArray<string>) => {
  const operations: string[] = [];
  let ensures = 0;
  const execution = {
    pluginService: async (
      _orbId: string,
      operation: { readonly operation: string },
    ) => {
      operations.push(operation.operation);
      if (operation.operation !== "service.ensure")
        return {
          kind: "result",
          value: { kind: "response", status: 200, body: { ok: true } },
        };
      const state = states[Math.min(ensures, states.length - 1)];
      ensures += 1;
      return {
        kind: "result",
        value: { kind: "status", state, port: 41007 },
      };
    },
    keepPluginOrbAwake: async () => true,
  };
  return {
    operations,
    bindings: {
      ...deployed,
      ...r2Transfer,
      THREAD_EXECUTION: {
        idFromName: (name: string) => name,
        get: () => execution,
      } as unknown as Bindings["THREAD_EXECUTION"],
    } satisfies Bindings,
  };
};

describe("plugin services", () => {
  it("refuses with no Orb chosen, then runs on the chosen size, once, as the installer's", async () => {
    const person = await signup("svc-person@example.com", 1);
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
    });

    const refused = await ensureInstallPluginOrb(deployed, install);
    expect(refused).toMatchObject({ ok: false, reason: "no-orb-chosen" });
    expect(!refused.ok && refused.message).toContain(
      "Settings → Orb Providers → Plugins",
    );
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM plugin_orb").first("n"),
    ).toBe(0);

    const saved = await call(
      "/v1/settings/personal/plugin-orb",
      person.cookie,
      "PUT",
      { runnerProfileId: "a1.medium" },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.effective).toEqual({
      kind: "orb",
      runnerProfileId: "a1.medium",
      source: "personal",
    });

    const first = await ensureInstallPluginOrb(deployed, install);
    if (!first.ok) throw new Error(first.message);
    expect(first.created).toBe(true);
    expect(first.orb).toMatchObject({
      scope: "personal",
      targetId: person.userId,
      payerUserId: person.userId,
      runnerProfileId: "a1.medium",
    });
    const again = await ensureInstallPluginOrb(deployed, install);
    expect(again).toMatchObject({ ok: true, created: false });
    if (again.ok) expect(again.orb.id).toBe(first.orb.id);

    // Pinned like a Thread's Orb, so activation resolves it.
    const pin = await env.DB.prepare(
      "SELECT provider, runner_profile_id, account_scope, state FROM execution_workspace WHERE thread_id = ?",
    )
      .bind(first.orb.id)
      .first();
    expect(pin).toEqual({
      provider: "e2b",
      runner_profile_id: "a1.medium",
      account_scope: "deployment",
      state: "uninitialized",
    });
    const target = await Effect.runPromise(
      resolveExecutionTarget(deployed, first.orb.id, { admission: false }),
    );
    expect(target.profile.id).toBe("a1.medium");
    expect(await resolveExecutionOwner(env.DB, first.orb.id)).toMatchObject({
      kind: "plugin-orb",
    });
    // No Thread has its ID.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM threads WHERE id = ?")
        .bind(first.orb.id)
        .first("n"),
    ).toBe(0);

    // Thread routes refuse it.
    for (const [method, path] of [
      ["GET", `/v1/threads/${first.orb.id}`],
      ["GET", `/v1/threads/${first.orb.id}/files`],
      ["POST", `/v1/threads/${first.orb.id}/archive`],
      ["DELETE", `/v1/threads/${first.orb.id}`],
      ["POST", `/v1/agents/dx/${first.orb.id}`],
    ] as const) {
      const response = await call(
        path,
        person.cookie,
        method,
        method === "GET" || method === "DELETE"
          ? undefined
          : { kind: "user", body: "hi" },
      );
      expect(
        [403, 404, 405, 409].includes(response.status),
        `${method} ${path} answered ${response.status}`,
      ).toBe(true);
    }
  });

  it("gives a plugin that asks for an Orb of its own one Orb, apart from the shared one", async () => {
    const person = await signup("svc-own@example.com", 14);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const own = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
      orb: "own",
    });
    const shared = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
    });

    const first = await ensureInstallPluginOrb(deployed, own);
    if (!first.ok) throw new Error(first.message);
    expect(first.created).toBe(true);
    expect(first.orb.pluginId).toBe(own.pluginId);
    const again = await ensureInstallPluginOrb(deployed, own);
    expect(again).toMatchObject({ ok: true, created: false });
    if (again.ok) expect(again.orb.id).toBe(first.orb.id);
    const other = await ensureInstallPluginOrb(deployed, shared);
    if (!other.ok) throw new Error(other.message);
    expect(other.orb.id).not.toBe(first.orb.id);
    expect(other.orb.pluginId).toBeUndefined();
  });

  it("gives each workspace installer their own Orb, paid by them", async () => {
    const admin = await signup("svc-admin@example.com", 2);
    const member = await signup("svc-member@example.com", 3);
    const workspaceId = await workspace(
      "svc-team",
      admin.userId,
      member.userId,
    );
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('workspace', ?, 'a1.medium', ?, ?)`,
    )
      .bind(workspaceId, admin.userId, now)
      .run();
    const byMember = await installService({
      scope: "workspace",
      targetId: workspaceId,
      installer: member.userId,
    });
    const byAdmin = await installService({
      scope: "workspace",
      targetId: workspaceId,
      installer: admin.userId,
    });
    const memberOrb = await ensureInstallPluginOrb(deployed, byMember);
    const adminOrb = await ensureInstallPluginOrb(deployed, byAdmin);
    if (!memberOrb.ok || !adminOrb.ok) throw new Error("Expected Orbs.");
    expect(memberOrb.orb.payerUserId).toBe(member.userId);
    expect(adminOrb.orb.payerUserId).toBe(admin.userId);
    expect(memberOrb.orb.id).not.toBe(adminOrb.orb.id);
    expect(memberOrb.orb.workspaceId).toBe(workspaceId);
  });

  it("acts only for an install placed on the Orb, and keeps its state in dx", async () => {
    const person = await signup("svc-state@example.com", 4);
    const other = await signup("svc-other@example.com", 5);
    await env.DB.batch(
      [person.userId, other.userId].map((userId) =>
        env.DB.prepare(
          `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
           VALUES ('personal', ?, 'a1.medium', ?, ?)`,
        ).bind(userId, userId, now),
      ),
    );
    const mine = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
    });
    const theirs = await installService({
      scope: "personal",
      targetId: other.userId,
      installer: other.userId,
    });
    const orb = await ensureInstallPluginOrb(deployed, mine);
    const otherOrb = await ensureInstallPluginOrb(deployed, theirs);
    if (!orb.ok || !otherOrb.ok) throw new Error("Expected Orbs.");
    await place(mine.pluginId, orb.orb.id);
    await place(theirs.pluginId, otherOrb.orb.id);

    const request = (
      installId: string,
      method: string,
      path: string,
      body?: unknown,
      orbId = orb.orb.id,
    ) =>
      handleServiceRequest(bindings, { orbId, installId, method, path, body });

    expect(
      await request(mine.pluginId, "PUT", "/state/counts", {
        value: { hour: 3 },
      }),
    ).toEqual({ status: 200, body: {} });
    expect(await request(mine.pluginId, "GET", "/state/counts")).toEqual({
      status: 200,
      body: { value: { hour: 3 } },
    });
    expect(await request(mine.pluginId, "GET", "/state?prefix=co")).toEqual({
      status: 200,
      body: { keys: ["counts"] },
    });
    expect((await request(mine.pluginId, "GET", "/state/none")).status).toBe(
      404,
    );
    const large = await request(mine.pluginId, "PUT", "/state/big", {
      value: "x".repeat(70_000),
    });
    expect(large.status).toBe(413);

    // Another person's install, asked for through this Orb: refused, and
    // its state is untouched.
    await request(
      theirs.pluginId,
      "PUT",
      "/state/counts",
      { value: 1 },
      otherOrb.orb.id,
    );
    const crossed = await request(theirs.pluginId, "GET", "/state/counts");
    expect(crossed.status).toBe(403);
    expect(
      (
        await request(
          mine.pluginId,
          "GET",
          "/state/counts",
          undefined,
          otherOrb.orb.id,
        )
      ).status,
    ).toBe(403);
    expect(
      await request(
        theirs.pluginId,
        "GET",
        "/state/counts",
        undefined,
        otherOrb.orb.id,
      ),
    ).toEqual({ status: 200, body: { value: 1 } });

    // Turned off: its service may no longer act.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(mine.pluginId)
      .run();
    expect((await request(mine.pluginId, "GET", "/state/counts")).status).toBe(
      403,
    );
    // The state is still dx's: on again, a new Orb reads it.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 1 WHERE id = ?")
      .bind(mine.pluginId)
      .run();
    expect(await request(mine.pluginId, "GET", "/state/counts")).toEqual({
      status: 200,
      body: { value: { hour: 3 } },
    });
  });

  it("keeps a workspace's plugin to its own workspace, names its install in tokens, and stops minting when it is off or its installer left", async () => {
    const admin = await signup("svc-ws-admin@example.com", 6);
    const member = await signup("svc-ws-member@example.com", 7);
    const outsider = await signup("svc-ws-outsider@example.com", 8);
    const ours = await workspace("svc-ours", admin.userId, member.userId);
    const outsiderTeammate = await signup("svc-ws-teammate@example.com", 10);
    const theirs = await workspace(
      "svc-theirs",
      outsider.userId,
      outsiderTeammate.userId,
    );
    const theirProject = "prj_00000000-0000-4000-8000-0000000000c2";
    await env.DB.batch([
      ...[ours, theirs].map((workspaceId) =>
        env.DB.prepare(
          `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
           VALUES ('workspace', ?, 'a1.medium', ?, ?)`,
        ).bind(workspaceId, admin.userId, now),
      ),
      env.DB.prepare(
        `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
         VALUES (?, ?, ?, 'Theirs', 'a1.medium', ?, ?)`,
      ).bind(theirProject, outsider.userId, theirs, now, now),
    ]);
    const mine = await installService({
      scope: "workspace",
      targetId: ours,
      installer: member.userId,
    });
    const other = await installService({
      scope: "workspace",
      targetId: theirs,
      installer: outsider.userId,
    });
    const orb = await ensureInstallPluginOrb(deployed, mine);
    const otherOrb = await ensureInstallPluginOrb(deployed, other);
    if (!orb.ok || !otherOrb.ok) throw new Error("Expected Orbs.");
    await place(mine.pluginId, orb.orb.id);
    await place(other.pluginId, otherOrb.orb.id);
    const request = (
      installId: string,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      handleServiceRequest(deployed, {
        orbId: orb.orb.id,
        installId,
        method,
        path,
        body,
      });

    // Another workspace's install, through this workspace's Orb: refused.
    await handleServiceRequest(deployed, {
      orbId: otherOrb.orb.id,
      installId: other.pluginId,
      method: "PUT",
      path: "/state/secret",
      body: { value: "theirs" },
    });
    expect((await request(other.pluginId, "GET", "/state/secret")).status).toBe(
      403,
    );
    // A Thread in the other workspace's Project: refused, nothing opened.
    const opened = await request(mine.pluginId, "POST", "/threads", {
      key: "cross",
      prompt: "Look at their logs.",
      projectId: theirProject,
    });
    expect(opened.status).toBeGreaterThanOrEqual(400);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_thread_key WHERE plugin_id = ?",
      )
        .bind(mine.pluginId)
        .first("n"),
    ).toBe(0);

    // The token names the install and the workspace, not a person or a Thread.
    const minted = await request(mine.pluginId, "POST", "/id-token", {
      audience: "https://logs.example.test",
    });
    expect(minted.status).toBe(200);
    const token = (minted.body as { token: string }).token;
    const claims = JSON.parse(
      atob(token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? ""),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      plugin_install_id: mine.pluginId,
      plugin_runtime: "service",
      runtime_assurance: "dx_dxd_channel_v1",
      workspace_id: ours,
      aud: "https://logs.example.test",
    });
    expect(claims).not.toHaveProperty("user_id");
    expect(claims).not.toHaveProperty("thread_id");
    expect(String(claims.sub)).toMatch(/^dx:wid:v1:w:[^:]+:i:[^:]+$/);

    // Turned off: no token.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(mine.pluginId)
      .run();
    expect(
      (
        await request(mine.pluginId, "POST", "/id-token", {
          audience: "https://logs.example.test",
        })
      ).status,
    ).toBe(403);
    // On again, but its installer (and the Orb's payer) left: no token.
    await env.DB.batch([
      env.DB.prepare("UPDATE trusted_plugin SET enabled = 1 WHERE id = ?").bind(
        mine.pluginId,
      ),
      env.DB.prepare(
        "DELETE FROM member WHERE organizationId = ? AND userId = ?",
      ).bind(ours, member.userId),
    ]);
    expect(
      (
        await request(mine.pluginId, "POST", "/id-token", {
          audience: "https://logs.example.test",
        })
      ).status,
    ).toBe(403);
  });

  it("records a plugin Orb's minutes as the plugin's, not a Thread's", async () => {
    const person = await signup("svc-usage@example.com", 9);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
    });
    const orb = await ensureInstallPluginOrb(deployed, install);
    if (!orb.ok) throw new Error(orb.message);
    await place(install.pluginId, orb.orb.id);
    const startedAt = Date.now() - 30 * 60_000;
    await env.DB.prepare(
      `INSERT INTO thread_orb_session
         (thread_id, started_at, ended_at, provider, runner_profile_id, billing, cost_micros)
       VALUES (?, ?, ?, 'e2b', 'a1.medium', 'personal', 40000)`,
    )
      .bind(orb.orb.id, startedAt, startedAt + 12 * 60_000)
      .run();
    expect(
      await env.DB.prepare(
        "SELECT owner_kind FROM thread_orb_session WHERE thread_id = ?",
      )
        .bind(orb.orb.id)
        .first("owner_kind"),
    ).toBe("plugin-orb");
    const shown = await call(
      `/v1/settings/plugin-orb/plugins/${install.pluginId}`,
      person.cookie,
    );
    expect(shown.body.data.orb).toMatchObject({
      payer: { userId: person.userId },
      month: { minutes: 12, costMicros: 40000 },
    });
    // The person's Orb usage by Thread does not list it.
    const threads = await call(
      "/v1/settings/personal/orb-usage",
      person.cookie,
    );
    expect(JSON.stringify(threads.body)).not.toContain(orb.orb.id);
  });

  it("asks a keepRunning service that is still starting again each minute until dxd says it runs", async () => {
    const person = await signup("svc-keep@example.com", 14);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
      keepRunning: true,
    });
    // A cold start: the first ensure says "starting"; nothing calls the
    // service; a minute later dxd says it runs.
    const { bindings: woken, operations } = wokenDxd(["starting", "running"]);
    const row = () =>
      env.DB.prepare(
        "SELECT status, port FROM plugin_service WHERE plugin_id = ?",
      )
        .bind(install.pluginId)
        .first();
    const sweep = async (at: number) => {
      const work: Array<Promise<unknown>> = [];
      await sweepPluginServices(woken, new Date(at), (promise) =>
        work.push(promise),
      );
      await Promise.allSettled(work);
    };

    const start = Date.now();
    await sweep(start);
    expect(await row()).toEqual({ status: "starting", port: 41007 });
    // Within the minute it is not asked again.
    await sweep(start + 30_000);
    expect(operations).toEqual(["service.ensure"]);
    await sweep(start + 90_000);
    expect(operations).toEqual(["service.ensure", "service.ensure"]);
    expect(await row()).toEqual({ status: "running", port: 41007 });
  });

  it("opens a plugin's page on a cold Orb only once its program runs, so the Portal lets it in", async () => {
    const person = await signup("svc-app-cold@example.com", 15);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
      app: { path: "/app/" },
    });
    // The Orb was asleep: dxd starts the program, which listens a moment
    // later.
    const { bindings: woken } = wokenDxd(["starting", "starting", "running"]);
    const opened = await pluginAppUrl(
      { ...woken, DX_PORTAL_DOMAIN: "dxportal.test" },
      {
        install: {
          pluginId: install.pluginId,
          scope: "personal",
          targetId: person.userId,
          displayName: "Log watch",
        },
        viewerUserId: person.userId,
      },
    );
    if (!("url" in opened)) throw new Error(opened.error.message);
    expect(opened.url).toMatch(/-p41007\.dxportal\.test\/app\/$/);
    const orbId = await env.DB.prepare(
      "SELECT orb_id FROM plugin_service WHERE plugin_id = ?",
    )
      .bind(install.pluginId)
      .first<string>("orb_id");
    // The Portal the URL names lets the person in.
    expect(
      await pluginAppPortal(env.DB, person.userId, orbId as string, 41007),
    ).toEqual({ path: "/app/" });
  });

  it("records a service as running, with its port, once a call that woke its Orb is answered", async () => {
    const person = await signup("svc-cold@example.com", 13);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
      app: { path: "/app/" },
    });
    // dxd on an Orb that just woke: `service.ensure` starts the program and
    // says "starting"; `service.call` waits for it and returns its answer.
    const { bindings: cold, operations } = wokenDxd(["starting"]);
    const loaded = await loadServiceInstall(env.DB, install.pluginId);
    if (loaded === undefined) throw new Error("install not found");

    const answered = await callService(cold, loaded, {
      path: "/jobs/check",
      body: {},
      timeoutMs: 30_000,
    });

    expect(answered).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true } },
    });
    expect(operations).toEqual(["service.ensure", "service.call"]);
    expect(
      await env.DB.prepare(
        "SELECT status, port FROM plugin_service WHERE plugin_id = ?",
      )
        .bind(install.pluginId)
        .first(),
    ).toEqual({ status: "running", port: 41007 });
  });

  it("opens a plugin's own page through its Orb's Portal only for its people, its port, and while it runs", async () => {
    const person = await signup("svc-app@example.com", 11);
    const stranger = await signup("svc-app-stranger@example.com", 12);
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(person.userId, person.userId, now)
      .run();
    const install = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
      app: { path: "/app/" },
    });
    const plain = await installService({
      scope: "personal",
      targetId: person.userId,
      installer: person.userId,
    });
    const orb = await ensureInstallPluginOrb(deployed, install);
    if (!orb.ok) throw new Error(orb.message);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO plugin_service (plugin_id, orb_id, status, port, updated_at)
         VALUES (?, ?, 'running', 41001, ?), (?, ?, 'running', 41002, ?)`,
      ).bind(
        install.pluginId,
        orb.orb.id,
        now,
        plain.pluginId,
        orb.orb.id,
        now,
      ),
    ]);
    const access = (userId: string, port: number) =>
      evaluatePortalAccess(env.DB, userId, orb.orb.id as never, port);
    expect(
      await pluginAppPortal(env.DB, person.userId, orb.orb.id, 41001),
    ).toEqual({
      path: "/app/",
    });
    expect(await access(person.userId, 41001)).toBe("allowed");
    // Another person; the shared Orb's other program; no port: refused.
    expect(await access(stranger.userId, 41001)).toBe("not-found");
    expect(await access(person.userId, 41002)).toBe("not-found");
    expect(
      await evaluatePortalAccess(env.DB, person.userId, orb.orb.id as never),
    ).toBe("not-found");
    // Turned off: refused.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(install.pluginId)
      .run();
    expect(await access(person.userId, 41001)).toBe("not-found");
  });
});
