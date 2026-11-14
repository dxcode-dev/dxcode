import { env } from "cloudflare:test";
import {
  Principal,
  ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  personalPluginBundleRoutes,
  workspacePluginBundleRoutes,
} from "../../src/settings/plugins/bundles/routes.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
import { createSkillTools } from "../../src/settings/skills/agent-tools.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import {
  listArtifacts,
  readArtifact,
} from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { network } from "./network-boundary.js";
import { runRepositories } from "./runtime.js";

/**
 * Agent plugin management (plugin plan M5): `manage_skills` proposes
 * installing or updating a plugin, and only a person's approval on the
 * Plugins page takes effect.
 *
 * Ways it could fail, each covered below:
 * - a proposal installs or updates something before a person approves it;
 * - the agent proposes where its person could not install themselves: a
 *   workspace plugin while they are a plain member;
 * - someone who could not install the plugin approves it: a member;
 * - approval installs other content than was reviewed: the source moved on,
 *   or the reviewed hash doesn't match;
 * - an update proposal hides wider permissions from the reviewer;
 * - a decided proposal is decided again, or a rejected one changes plugins;
 * - the proposal writes an ask into an artifact, or the agent's Thread
 *   never hears the outcome.
 */

// Flue's run is stood in for: the agent route only records the message it
// admits, so a test sees what woke the Thread.
const delivered = vi.hoisted(() => ({
  messages: [] as Array<{ threadId: string; body: string }>,
}));

vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  const { useAgentAdmission } = await import("../../src/agents/admission.js");
  const routes = useAgentAdmission(new Hono());
  routes.post("/:threadId", async (context) => {
    const body = (await context.req.json()) as {
      body: string;
      idempotencyKey: string;
    };
    delivered.messages.push({
      threadId: context.req.param("threadId"),
      body: body.body,
    });
    return context.json({ submissionId: `sub_${body.idempotencyKey}` }, 202);
  });
  return { dxAgentRoutes: routes };
});

const owner = Schema.decodeSync(UserId)("plugin-proposal-owner");
const member = Schema.decodeSync(UserId)("plugin-proposal-member");
const workspaceId = "plugin-proposal-workspace";
const workspaceSlug = "plugin-proposal-workspace";
const ORIGIN = "https://dx.test";
const projectId = Schema.decodeSync(ProjectId)(
  "prj_00000000-0000-4000-8000-00000000c901",
);
const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: ORIGIN,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
let sequence = 0;

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

type Body = {
  status: string;
  data: Record<string, unknown> & {
    items?: Array<Record<string, unknown>>;
    proposals?: Array<Record<string, unknown>>;
  };
};

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  routes.route(
    "/v1/settings/personal/plugin-bundles",
    personalPluginBundleRoutes,
  );
  routes.route(
    "/v1/settings/workspaces/:workspaceSlug/plugin-bundles",
    workspacePluginBundleRoutes,
  );
  return async (path: string, method = "GET", body?: unknown) => {
    const response = await routes.request(
      `${ORIGIN}${path}`,
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
    return { status: response.status, body: (await response.json()) as Body };
  };
};

const personal = "/v1/settings/personal/plugin-bundles";
const workspace = `/v1/settings/workspaces/${workspaceSlug}/plugin-bundles`;

const newThread = async (ownerUserId: UserId = owner) => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xc90000 + sequence).toString(16).padStart(12, "0")}`,
    projectId,
    ownerUserId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(entity);
    }),
  );
  return entity.id as ThreadId;
};

const tool = (threadId: string) => {
  const [manage] = createSkillTools(threadId, () => ({
    db: env.DB,
    bindings,
  }));
  if (manage === undefined) throw new Error("Expected manage_skills.");
  return async (data: Record<string, unknown>) =>
    (
      (await manage.run({
        data,
        toolCallId: "call",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never)) as { output: Record<string, unknown> }
    ).output;
};

const failure = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the tool to refuse.");
};

const commits = {
  first: "7777777777777777777777777777777777777777",
  second: "8888888888888888888888888888888888888888",
  third: "9999999999999999999999999999999999999999",
};

const archive = (sha: string, network: ReadonlyArray<string>) =>
  buildZip(
    [
      {
        name: "kit-main/plugins/notes/plugin.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
          name: "com.acme.notes",
          displayName: "Notes",
          version:
            sha === commits.first
              ? "1.0.0"
              : sha === commits.second
                ? "1.1.0"
                : "1.2.0",
          description: "Takes notes.",
          extensions: {
            "dev.dxcode": {
              apiVersion: 1,
              entry: "dev.dxcode/index.js",
              permissions: { events: ["agent.end"], network },
            },
          },
        }),
      },
      {
        name: "kit-main/plugins/notes/dev.dxcode/index.js",
        content: "export default () => {};",
      },
      {
        name: "kit-main/plugins/notes/skills/take-notes/SKILL.md",
        content:
          "---\nname: take-notes\ndescription: Use to take notes.\n---\n\nTake notes.\n",
      },
    ],
    sha,
  );

/** GitHub serves `main` at `head`, and each commit by its SHA. */
let head = commits.first;
const serveGitHub = async () => {
  const archives = new Map([
    [commits.first, await archive(commits.first, ["api.example.com"])],
    [
      commits.second,
      await archive(commits.second, ["api.example.com", "api.other.com"]),
    ],
    [commits.third, await archive(commits.third, [])],
  ]);
  network.use(
    http.get("https://codeload.github.com/acme/kit/zip/:ref", ({ params }) => {
      const sha =
        params.ref === "main" ? head : String(params.ref ?? "").slice(0, 40);
      const bytes = archives.get(sha);
      return bytes === undefined
        ? new HttpResponse(null, { status: 404 })
        : new HttpResponse(bytes.slice(), {
            headers: { "content-type": "application/zip" },
          });
    }),
  );
};

const url = "https://github.com/acme/kit/tree/main/plugins/notes";

const pluginRows = async () =>
  (
    await env.DB.prepare(
      `SELECT plugin.scope, plugin.name, plugin.enabled, version.manifest_json
         FROM trusted_plugin plugin
         JOIN trusted_plugin_version version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE plugin.removed_at IS NULL AND plugin.name = 'com.acme.notes'`,
    ).all<{
      scope: string;
      name: string;
      enabled: number;
      manifest_json: string;
    }>()
  ).results.map(({ manifest_json, ...row }) => ({
    ...row,
    version: (JSON.parse(manifest_json) as { version?: string }).version,
  }));

const planMarkdown = async (threadId: string) => {
  const plan = (await listArtifacts(bindings, threadId, { folder: "" })).find(
    ({ title }) => title === "Plan",
  );
  if (plan === undefined) return undefined;
  return (await readArtifact(bindings, threadId, plan.id))?.markdown;
};

beforeEach(async () => {
  head = commits.first;
  delivered.messages.length = 0;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Plugin Owner", "plugin-proposal-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(member, "Plugin Member", "plugin-proposal-member@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Plugin Workspace", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("plugin-proposal-owner-membership", workspaceId, owner, "admin", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "plugin-proposal-member-membership",
      workspaceId,
      member,
      "member",
      1,
    ),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "Plugin proposals"),
      );
    }),
  );
  await serveGitHub();
});

describe("manage_skills plugin proposals", () => {
  it("installs a proposed plugin only when an admin approves the reviewed commit", async () => {
    const threadId = await newThread();
    const manage = tool(threadId);

    const proposed = await manage({
      action: "propose_plugin",
      scope: "workspace",
      url,
      note: "The team asked for a notes plugin.",
    });
    expect(proposed).toMatchObject({
      status: "pending",
      change: "new",
      name: "com.acme.notes",
      scope: "workspace",
    });
    const proposalId = proposed.proposal_id as string;
    expect(proposed.review_url).toBe(
      `${ORIGIN}/workspaces/${workspaceSlug}/plugins?proposal=${proposalId}`,
    );

    // Nothing took effect, and no artifact: the agent shares the review link.
    expect(await pluginRows()).toEqual([]);
    expect(await planMarkdown(threadId)).toBeUndefined();
    expect(proposed.note).toContain(proposed.review_url as string);

    // The Plugins page lists it with what it would install and reach.
    const page = await app(owner)(workspace);
    expect(page.body.data.proposals).toEqual([
      expect.objectContaining({
        id: proposalId,
        change: "new",
        name: "com.acme.notes",
        note: "The team asked for a notes plugin.",
        source: expect.objectContaining({
          type: "github",
          repository: "acme/kit",
          commit: commits.first,
        }),
        manifest: expect.objectContaining({
          displayName: "Notes",
          code: expect.objectContaining({
            permissions: expect.objectContaining({
              network: ["api.example.com"],
            }),
          }),
        }),
      }),
    ]);
    const reviewed = page.body.data.proposals?.[0]?.integrity;

    // A member neither sees nor decides it.
    expect((await app(member)(workspace)).body.data.proposals).toEqual([]);
    const byMember = await app(member)(
      `${workspace}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: reviewed },
    );
    expect(byMember.status).toBe(403);

    // Approving another hash changes nothing.
    const wrong = await app(owner)(
      `${workspace}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: "0".repeat(64) },
    );
    expect(wrong.status).toBe(409);
    expect(await pluginRows()).toEqual([]);

    // GitHub's main moving on doesn't change what is installed.
    head = commits.second;
    const approved = await app(owner)(
      `${workspace}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: reviewed },
    );
    expect(approved.status).toBe(200);
    expect(await pluginRows()).toEqual([
      {
        scope: "workspace",
        name: "com.acme.notes",
        enabled: 1,
        version: "1.0.0",
      },
    ]);
    // The decision wakes the agent's Thread with the outcome.
    expect(delivered.messages).toEqual([
      {
        threadId,
        body: expect.stringContaining(`plugin proposal ${proposalId}`),
      },
    ]);
    expect(delivered.messages[0]?.body).toContain("Approved");

    const again = await app(owner)(
      `${workspace}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: reviewed },
    );
    expect(again.status).toBe(409);
    const listed = await manage({ action: "list" });
    expect(listed.plugins).toEqual([
      expect.objectContaining({
        scope: "workspace",
        name: "com.acme.notes",
        version: "1.0.0",
      }),
    ]);
    expect(listed.proposals).toEqual([
      expect.objectContaining({
        proposal_id: proposalId,
        kind: "plugin",
        status: "approved",
      }),
    ]);
  });

  it("refuses to propose a workspace plugin for a member", async () => {
    const manage = tool(await newThread(member));
    expect(
      await failure(
        manage({ action: "propose_plugin", scope: "workspace", url }),
      ),
    ).toMatch(/workspace admins/);
    expect(await pluginRows()).toEqual([]);
  });

  it("shows an update's wider permissions to the reviewer, and a rejection changes nothing", async () => {
    const manage = tool(await newThread());
    const first = await manage({
      action: "propose_plugin",
      scope: "personal",
      url,
    });
    const firstPage = await app(owner)(personal);
    expect(
      (
        await app(owner)(
          `${personal}/proposals/${first.proposal_id}/approve`,
          "POST",
          {
            reviewedIntegrity: firstPage.body.data.proposals?.[0]?.integrity,
          },
        )
      ).status,
    ).toBe(200);

    // Nothing new at the source yet.
    expect(
      await failure(
        manage({
          action: "propose_plugin",
          scope: "personal",
          name: "com.acme.notes",
        }),
      ),
    ).toMatch(/already up to date/);

    head = commits.second;
    const update = await manage({
      action: "propose_plugin",
      scope: "personal",
      name: "com.acme.notes",
      note: "1.1.0 adds a second API.",
    });
    expect(update).toMatchObject({ status: "pending", change: "update" });
    const page = await app(owner)(personal);
    const [proposal] = page.body.data.proposals ?? [];
    expect(proposal).toMatchObject({
      change: "update",
      permissions: {
        widens: true,
        changes: [
          { permission: "network", added: ["api.other.com"], removed: [] },
        ],
      },
    });

    const rejected = await app(owner)(
      `${personal}/proposals/${update.proposal_id}/reject`,
      "POST",
    );
    expect(rejected.status).toBe(200);
    expect(await pluginRows()).toEqual([
      {
        scope: "personal",
        name: "com.acme.notes",
        enabled: 1,
        version: "1.0.0",
      },
    ]);

    const again = await manage({
      action: "propose_plugin",
      scope: "personal",
      name: "com.acme.notes",
    });
    const reviewed = (await app(owner)(personal)).body.data.proposals?.[0];
    expect(
      (
        await app(owner)(
          `${personal}/proposals/${again.proposal_id}/approve`,
          "POST",
          {
            reviewedIntegrity: reviewed?.integrity,
          },
        )
      ).status,
    ).toBe(200);
    expect(await pluginRows()).toEqual([
      {
        scope: "personal",
        name: "com.acme.notes",
        enabled: 1,
        version: "1.1.0",
      },
    ]);
  });

  it("refuses an update proposal once the installed plugin changed since the review", async () => {
    const manage = tool(await newThread());
    const first = await manage({
      action: "propose_plugin",
      scope: "personal",
      url,
    });
    const firstPage = await app(owner)(personal);
    await app(owner)(
      `${personal}/proposals/${first.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: firstPage.body.data.proposals?.[0]?.integrity },
    );

    // dx proposes 1.1.0, reviewed against 1.0.0.
    head = commits.second;
    const update = await manage({
      action: "propose_plugin",
      scope: "personal",
      name: "com.acme.notes",
    });
    const reviewed = (await app(owner)(personal)).body.data.proposals?.[0];

    // Meanwhile the person updates to 1.2.0 themselves, which drops the
    // network grant that 1.1.0 would bring back.
    head = commits.third;
    const pluginId = (await app(owner)(personal)).body.data.items?.[0]?.id;
    const preview = await app(owner)(
      `${personal}/${pluginId}/update/preview`,
      "POST",
      {},
    );
    expect(
      (
        await app(owner)(`${personal}/${pluginId}/update`, "POST", {
          source: preview.body.data.source,
          reviewedIntegrity: preview.body.data.integrity,
        })
      ).status,
    ).toBe(200);

    const stale = await app(owner)(
      `${personal}/proposals/${update.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: reviewed?.integrity },
    );
    expect(stale.status).toBe(400);
    expect(String(stale.body.data.message)).toMatch(
      /changed since dx proposed/,
    );
    expect(await pluginRows()).toEqual([
      {
        scope: "personal",
        name: "com.acme.notes",
        enabled: 1,
        version: "1.2.0",
      },
    ]);
  });
});
