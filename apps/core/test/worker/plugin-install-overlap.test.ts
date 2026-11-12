import { env } from "cloudflare:test";
import {
  McpServerRepository,
  type ProjectId,
  SkillRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { listThreadCodePluginInstalls } from "../../src/plugins/worker-host/resolve.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { SkillRepositoryD1 } from "../../src/settings/skills/repository-d1.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * The same plugin installed by a workspace and personally by one of its
 * members never runs twice (plugin plan §7, owner decision 2026-11-10),
 * across everything a plugin brings: skills, MCP servers, and code. What can
 * go wrong, and where each case is checked:
 *
 * - both copies run, or neither, for one member;
 * - a member installs a personal copy their workspace already provides;
 * - a paused personal copy is lost instead of coming back when the
 *   workspace removes its copy;
 * - "allow personal plugin overrides" lets the member's copy run beside
 *   the workspace's instead of in its place, or leaks to other members;
 * - a workspace `disabled` is bypassed by a personal copy;
 * - a member who is not an admin turns the policy on.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-overlap-route-secret-0000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
const personal = "/v1/settings/personal/plugin-bundles";
const workspaceSlug = "overlap-acme";
const shared = `/v1/settings/workspaces/${workspaceSlug}/plugin-bundles`;
const workspaceId = "org_plugin_overlap";
const projectId = "prj_00000000-0000-4000-8000-0000000000a1" as ProjectId;

let signups = 120;
const signup = async (email: string) => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups}`,
      },
      body: JSON.stringify({
        name: email,
        email,
        password: "plugin-overlap-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const { user } = await response.json<{ user: { id: string } }>();
  return { cookie, userId: user.id as UserId };
};

const call = (
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; zip?: Uint8Array } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? ((init.json ?? init.zip) ? "POST" : "GET"),
      headers: {
        cookie,
        origin,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.zip === undefined
          ? {}
          : { "content-type": "application/zip" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.zip === undefined ? {} : { body: init.zip.slice() }),
    },
    bindings,
  );

/** One plugin with a skill, a remote MCP server, and code. */
const releaseHelper = (version: string): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.release-helper",
      displayName: "Release Helper",
      version,
      description: "Release notes.",
      extensions: {
        "dev.dxcode": { apiVersion: 1, entry: "dev.dxcode/index.js" },
      },
    }),
  },
  {
    name: "skills/release-notes/SKILL.md",
    content: `---\nname: release-notes\ndescription: Write release notes (${version}).\n---\n\nWrite them.\n`,
  },
  {
    name: "mcp.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
      mcpServers: {
        releases: {
          type: "streamable-http",
          url: "https://releases.example.com/mcp",
        },
      },
    }),
  },
  {
    name: "dev.dxcode/index.js",
    content: `export default (dx) => dx.registerTool({ name: "release_${version.replaceAll(".", "_")}", description: "Release.", execute: () => "ok" });`,
  },
];

interface PreviewBody {
  readonly data: {
    readonly integrity: string;
    readonly conflicts: ReadonlyArray<string>;
  };
}

interface ListBody {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly overlap?: { kind: string; workspaceName: string };
    }>;
    readonly personalOverridesAllowed?: boolean;
  };
}

const install = async (base: string, cookie: string, version: string) => {
  const archive = await buildZip(releaseHelper(version));
  const preview = await call(`${base}/preview?name=helper.zip`, cookie, {
    zip: archive,
  });
  expect(preview.status).toBe(200);
  const reviewed = await preview.json<PreviewBody>();
  expect(reviewed.data.conflicts).toEqual([]);
  const installed = await call(
    `${base}?name=helper.zip&integrity=${reviewed.data.integrity}`,
    cookie,
    { zip: archive },
  );
  expect(installed.status).toBe(201);
  return (await installed.json<{ data: { id: string } }>()).data.id;
};

/** Which install's skill, MCP server, and code a member's Thread gets. */
const running = (userId: UserId, threadId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const skills = yield* (yield* SkillRepository).listThreadCandidates(
        userId,
      );
      const servers = yield* (yield* McpServerRepository).listForExecution(
        userId,
        projectId,
      );
      const code = yield* Effect.promise(() =>
        listThreadCodePluginInstalls(env.DB, threadId),
      );
      return {
        skills: skills.map(({ skill }) => skill.pluginId),
        mcp: servers.map(({ server }) => server.pluginId),
        code: code.map(({ pluginId }) => pluginId),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SkillRepositoryD1(env.DB),
          McpServerRepositoryD1(env.DB),
        ),
      ),
    ),
  );

const everywhere = (pluginId: string) => ({
  skills: [pluginId],
  mcp: [pluginId],
  code: [pluginId],
});

describe("a plugin installed by a workspace and personally", () => {
  it("runs one copy: the personal copy pauses, and the override policy swaps it in for that member only", async () => {
    const admin = await signup("overlap-admin@example.com");
    const member = await signup("overlap-member@example.com");
    const newcomer = await signup("overlap-newcomer@example.com");
    const memberThread = "thr_00000000-0000-4000-8000-0000000000a1";
    const newcomerThread = "thr_00000000-0000-4000-8000-0000000000a2";
    const now = "2026-11-10T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
      ).bind(workspaceId, workspaceSlug),
      ...[
        [admin.userId, "owner"],
        [member.userId, "member"],
        [newcomer.userId, "member"],
      ].map(([userId, role], index) =>
        env.DB.prepare(
          "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 1)",
        ).bind(`overlap-member-${index}`, workspaceId, userId, role),
      ),
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Acme', ?, ?)",
      ).bind(projectId, admin.userId, workspaceId, now, now),
      ...[
        [memberThread, member.userId],
        [newcomerThread, newcomer.userId],
      ].map(([threadId, userId]) =>
        env.DB.prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(threadId, projectId, userId, now, now),
      ),
    ]);

    // Before the workspace has it, the member's own copy runs.
    const own = await install(personal, member.cookie, "1.1.0");
    expect(await running(member.userId, memberThread)).toEqual(everywhere(own));

    // The workspace installs it: the personal copy pauses but stays saved.
    const workspaceCopy = await install(shared, admin.cookie, "1.0.0");
    expect(await running(member.userId, memberThread)).toEqual(
      everywhere(workspaceCopy),
    );
    const paused = await (await call(personal, member.cookie)).json<ListBody>();
    expect(paused.data.items).toEqual([
      expect.objectContaining({
        id: own,
        overlap: { kind: "paused", workspaceName: "Acme" },
      }),
    ]);

    // A member without a copy can't install one personally.
    const blocked = await call(
      `${personal}/preview?name=helper.zip`,
      newcomer.cookie,
      {
        zip: await buildZip(releaseHelper("1.1.0")),
      },
    );
    expect((await blocked.json<PreviewBody>()).data.conflicts).toEqual([
      "Your workspace already provides Release Helper.",
    ]);

    // Only an admin turns on "allow personal plugin overrides".
    const refused = await call(`${shared}/policy`, member.cookie, {
      method: "PUT",
      json: { allowPersonalOverrides: true },
    });
    expect(refused.status).toBe(403);
    const allowed = await call(`${shared}/policy`, admin.cookie, {
      method: "PUT",
      json: { allowPersonalOverrides: true },
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json<ListBody>()).data.personalOverridesAllowed).toBe(
      true,
    );

    // The member's copy now replaces the workspace's, for them only.
    expect(await running(member.userId, memberThread)).toEqual(everywhere(own));
    expect(await running(newcomer.userId, newcomerThread)).toEqual(
      everywhere(workspaceCopy),
    );
    const replacing = await (
      await call(personal, member.cookie)
    ).json<ListBody>();
    expect(replacing.data.items[0]?.overlap).toEqual({
      kind: "replacing",
      workspaceName: "Acme",
    });
    const open = await call(
      `${personal}/preview?name=helper.zip`,
      newcomer.cookie,
      {
        zip: await buildZip(releaseHelper("1.1.0")),
      },
    );
    expect((await open.json<PreviewBody>()).data.conflicts).toEqual([]);

    // Turning their own copy off hands the member back the workspace's.
    await call(`${personal}/${own}`, member.cookie, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(await running(member.userId, memberThread)).toEqual(
      everywhere(workspaceCopy),
    );
    await call(`${personal}/${own}`, member.cookie, {
      method: "PATCH",
      json: { enabled: true },
    });

    // A workspace `disabled` stays absolute, even with overrides allowed.
    await call(`${shared}/${workspaceCopy}`, admin.cookie, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(await running(member.userId, memberThread)).toEqual({
      skills: [],
      mcp: [],
      code: [],
    });

    // With overrides off again, removing the workspace copy brings the
    // paused personal copy back.
    await call(`${shared}/policy`, admin.cookie, {
      method: "PUT",
      json: { allowPersonalOverrides: false },
    });
    await call(`${shared}/${workspaceCopy}`, admin.cookie, {
      method: "PATCH",
      json: { enabled: true },
    });
    expect(await running(member.userId, memberThread)).toEqual(
      everywhere(workspaceCopy),
    );
    const removed = await call(`${shared}/${workspaceCopy}`, admin.cookie, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await running(member.userId, memberThread)).toEqual(everywhere(own));
    const back = await (await call(personal, member.cookie)).json<ListBody>();
    expect(back.data.items[0]?.overlap).toBeUndefined();
  });
});
