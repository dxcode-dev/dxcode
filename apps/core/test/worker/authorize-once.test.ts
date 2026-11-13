import { env } from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginId,
  type PluginTarget,
  type ProjectId,
  ProjectRepository,
  StoredPluginBundle,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { authenticate } from "../../src/auth/authenticate.js";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * `authorizeThread` runs once per request. A route guarded at both
 * `/:threadId/x` and `/:threadId/x/*` (plugin UI, huddle) matched both for
 * `/:threadId/x`. The first run impersonated the owner for a workspace
 * member, so the second found the Thread "owned" and granted the member
 * owner access. Already on main; fixed for the rich-plugins merge.
 *
 * Ways this could still fail, each checked:
 * - a View member's `GET /plugin-ui` gets the owner's commands (owner access);
 * - a View member reaches a `plugin-ui/*` sub-route meant for writers;
 * - the huddle pair grants owner access the same way;
 * - the owner's own access changes.
 */

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "authorize-once-secret-000000000000000",
} as unknown as Bindings;

/** A plugin with one palette command: only owners and contributors see it. */
const files = [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.ops",
      displayName: "Ops",
      version: "1.0.0",
      description: "Test plugin.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { events: [] },
        },
      },
    }),
  },
  {
    name: "dev.dxcode/index.js",
    content: `export default function (dx) {
      dx.registerCommand({ id: "restart", title: "Restart service", run: async () => {} });
    }`,
  },
];

const installFor = async (userId: UserId) => {
  const bundle = await Effect.runPromise(
    readZipArchive(await buildZip(files), {
      maxArchiveBytes: 16 * 1024 * 1024,
      maxEntries: 1_000,
    }).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "fixture" }),
      ),
    ),
  );
  const now = "2026-11-12T12:00:00.000Z";
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* PluginBundleRepository).insert(
        Schema.decodeUnknownSync(StoredPluginBundle)({
          id: `plg_00000000-0000-4000-8000-${String(2_200 + signups).padStart(12, "0")}` as PluginId,
          target: { scope: "personal", id: userId } as PluginTarget,
          name: bundle.manifest.name,
          enabled: true,
          version: bundle.version,
          manifest: bundle.manifest,
          source: { type: "zip", label: "fixture.zip" },
          integrity: bundle.integrity,
          installedAt: now,
          installedByUserId: userId,
          updatedAt: now,
        }),
        bundle.codeModules,
      );
    }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
  );
};

let signups = 0;
const signUp = async () => {
  signups += 1;
  const email = `authorize-once-${signups}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `192.0.2.${signups + 60}`,
      },
      body: JSON.stringify({
        name: "Authorize Once",
        email,
        password: "authorize-once-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  return { cookie, userId };
};

/** An owner's Thread shared View with their workspace, and a member. */
const sharedThread = async () => {
  const owner = await signUp();
  const member = await signUp();
  const n = String(2_210 + signups).padStart(12, "0");
  const projectId = `prj_00000000-0000-4000-8000-${n}` as ProjectId;
  const threadId = `thr_00000000-0000-4000-9000-${n}`;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner.userId, "Ops"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner.userId),
      );
    }),
  );
  const workspaceId = `org_authorize_once_${signups}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
    ).bind(workspaceId, `acme-authorize-once-${signups}`),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
    ).bind(`${workspaceId}-1`, workspaceId, owner.userId),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
    ).bind(`${workspaceId}-2`, workspaceId, member.userId),
    env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
      workspaceId,
      projectId,
    ),
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, threadId),
  ]);
  await installFor(owner.userId);
  const as =
    (cookie: string) =>
    (path: string, init: RequestInit = {}) =>
      app.request(
        `/v1/threads/${threadId}${path}`,
        {
          ...init,
          headers: {
            cookie,
            origin,
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
        },
        bindings,
      );
  return {
    threadId,
    cookies: { owner: owner.cookie, member: member.cookie },
    owner: as(owner.cookie),
    member: as(member.cookie),
  };
};

const commandsOf = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: { commands: unknown[] } }).data
    .commands;
};

describe("authorizeThread runs once per request", () => {
  it("keeps a View member's plugin UI read-only, on /plugin-ui and its sub-routes", async () => {
    const { owner, member } = await sharedThread();
    // The owner sees the plugin's palette command.
    expect(await commandsOf(await owner("/plugin-ui"))).toHaveLength(1);
    // A View member does not: before the fix, the second authorization saw
    // the owner impersonation and returned the owner's commands.
    expect(await commandsOf(await member("/plugin-ui"))).toEqual([]);
    // A writer-only sub-route refuses the member.
    const ran = await member("/plugin-ui/commands", {
      method: "POST",
      body: JSON.stringify({ command: "x:restart" }),
    });
    expect(ran.status).toBe(403);
    // Authorization itself refuses a View member's write.
    expect(await ran.json()).toMatchObject({
      data: { code: "THREAD_READ_ONLY" },
    });
  });

  it("keeps a View member's access on a route guarded as /huddle and /huddle/*", async () => {
    const { threadId, cookies } = await sharedThread();
    // The huddle routes' own guard pair, with a probe reporting the access
    // authorization settled on (the huddle feature itself needs RealtimeKit).
    const probe = new Hono<AppEnv>();
    probe.use("*", requestId);
    probe.use("/v1/*", authenticate);
    probe.use("/v1/threads/:threadId/huddle", authorizeThread);
    probe.use("/v1/threads/:threadId/huddle/*", authorizeThread);
    probe.get("/v1/threads/:threadId/huddle", (context) =>
      context.json({ access: context.get("threadAccess") }),
    );
    const accessOf = async (cookie: string) =>
      (
        (await (
          await probe.request(
            `/v1/threads/${threadId}/huddle`,
            { headers: { cookie, origin } },
            bindings,
          )
        ).json()) as { access: string }
      ).access;
    expect(await accessOf(cookies.owner)).toBe("owner");
    expect(await accessOf(cookies.member)).toBe("view");
  });
});
