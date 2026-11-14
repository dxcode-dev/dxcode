import { env } from "cloudflare:test";
import {
  Principal,
  ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { SettingsAudit } from "../../src/settings/audit.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import { createSkillTools } from "../../src/settings/skills/agent-tools.js";
import { SkillRepositoryD1 } from "../../src/settings/skills/repository-d1.js";
import {
  personalSkillRoutes,
  workspaceSkillRoutes,
} from "../../src/settings/skills/routes.js";
import { SkillService } from "../../src/settings/skills/service.js";
import {
  listArtifacts,
  readArtifact,
} from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Agent skill management (plugin plan M5) in workerd with real D1 and R2:
 * the `manage_skills` tool files proposals, and only a person's approval on
 * the Skills settings page saves them.
 *
 * Ways it could fail, each covered below:
 * - a proposal takes effect before a person approves it: a skill row is
 *   written, or a new Thread of the person resolves it;
 * - the agent proposes where the person could not save a skill themselves:
 *   a workspace skill while they are a plain member;
 * - content the import would refuse becomes a proposal (bad name, a file
 *   outside resources/, a skill a plugin owns);
 * - someone who could not save the skill approves it: a workspace member,
 *   or another person through their own personal page;
 * - approval saves different content than was reviewed, leaves a new skill
 *   switched off, or ignores a pinned version;
 * - an update proposal makes a second skill of the same name instead of a
 *   new version;
 * - a decided proposal is decided again, or a rejected one changes skills;
 * - two pending proposals from one Thread for one skill both await review;
 * - the proposal writes an ask into an artifact, the agent is not given the
 *   review link to share, or its Thread never hears the outcome.
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

const owner = Schema.decodeSync(UserId)("proposal-owner");
const member = Schema.decodeSync(UserId)("proposal-member");
const workspaceId = "proposal-workspace";
const workspaceSlug = "proposal-workspace";
const ORIGIN = "https://dx.test";
const projectId = Schema.decodeSync(ProjectId)(
  "prj_00000000-0000-4000-8000-00000000b901",
);
const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: ORIGIN,
};
let sequence = 0;

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  routes.route("/v1/settings/personal/skills", personalSkillRoutes);
  routes.route(
    "/v1/settings/workspaces/:workspaceSlug/skills",
    workspaceSkillRoutes,
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
    return {
      status: response.status,
      body: (await response.json()) as {
        status: string;
        data: Record<string, unknown> & {
          items?: Array<Record<string, unknown>>;
          proposals?: Array<Record<string, unknown>>;
        };
      },
    };
  };
};

const personal = "/v1/settings/personal/skills";
const workspace = `/v1/settings/workspaces/${workspaceSlug}/skills`;

const newThread = async (ownerUserId: UserId = owner) => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xb90000 + sequence).toString(16).padStart(12, "0")}`,
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

const releaseNotes = (
  instructions = "Write release notes from merged PRs.",
) => ({
  action: "propose",
  scope: "personal",
  name: "release-notes",
  description: "Writes release notes. Use when asked for release notes.",
  instructions,
  resources: [{ path: "resources/template.md", content: "# Release\n" }],
  note: "You asked for this workflow in every Project.",
});

/** Skill IDs a new Thread of the owner loads. */
const resolved = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SkillService;
      return yield* service.resolveForThread(principal(owner), projectId);
    }).pipe(
      Effect.provide(
        SkillService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              SkillRepositoryD1(env.DB),
              McpServerRepositoryD1(env.DB),
              SettingsAudit.layer,
            ),
          ),
        ),
      ),
    ),
  );

const skillRows = async () =>
  (
    await env.DB.prepare(
      "SELECT name, scope, enabled, active_version FROM skill WHERE removed_at IS NULL ORDER BY name",
    ).all<{
      name: string;
      scope: string;
      enabled: number;
      active_version: number;
    }>()
  ).results;

const planMarkdown = async (threadId: string) => {
  const plan = (await listArtifacts(bindings, threadId, { folder: "" })).find(
    ({ title }) => title === "Plan",
  );
  if (plan === undefined) return undefined;
  return (await readArtifact(bindings, threadId, plan.id))?.markdown;
};

beforeEach(async () => {
  delivered.messages.length = 0;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Proposal Owner", "proposal-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(member, "Proposal Member", "proposal-member@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Proposal Workspace", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("proposal-owner-membership", workspaceId, owner, "admin", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("proposal-member-membership", workspaceId, member, "member", 1),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "Proposals"),
      );
    }),
  );
});

describe("manage_skills proposals", () => {
  it("saves nothing until the owner approves, then loads the skill in new Threads", async () => {
    const threadId = await newThread();
    const manage = tool(threadId);

    const listed = await manage({ action: "list" });
    expect(listed.scopes).toEqual([
      expect.objectContaining({ scope: "personal", can_propose: true }),
      expect.objectContaining({ scope: "workspace", can_propose: true }),
    ]);

    const proposed = await manage(releaseNotes());
    expect(proposed).toMatchObject({ status: "pending", change: "new" });
    const proposalId = proposed.proposal_id as string;
    expect(proposalId).toMatch(/^apr_/);
    expect(proposed.review_url).toBe(
      `${ORIGIN}/settings/skills?proposal=${proposalId}`,
    );

    // Nothing took effect.
    expect(await skillRows()).toEqual([]);
    expect(await resolved()).toEqual([]);

    // No artifact: the agent shares the review link in its reply.
    expect(await planMarkdown(threadId)).toBeUndefined();
    expect(await listArtifacts(bindings, threadId)).toEqual([]);
    expect(proposed.note).toContain(proposed.review_url as string);

    // The Skills page lists it for review, with what it would save.
    const page = await app(owner)(personal);
    expect(page.body.data.proposals).toEqual([
      expect.objectContaining({
        id: proposalId,
        change: "new",
        name: "release-notes",
        threadId,
        note: "You asked for this workflow in every Project.",
        instructions: "Write release notes from merged PRs.",
        resources: [
          expect.objectContaining({
            path: "resources/template.md",
            content: "# Release\n",
          }),
        ],
      }),
    ]);

    const approved = await app(owner)(
      `${personal}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: page.body.data.proposals?.[0]?.integrity },
    );
    expect(approved.status).toBe(200);
    expect(await skillRows()).toEqual([
      {
        name: "release-notes",
        scope: "personal",
        enabled: 1,
        active_version: 1,
      },
    ]);
    expect((await resolved()).map(({ name }) => name)).toEqual([
      "release-notes",
    ]);

    // The decision wakes the agent's Thread with the outcome.
    expect(delivered.messages).toEqual([
      {
        threadId,
        body: expect.stringContaining(`skill proposal ${proposalId}`),
      },
    ]);
    expect(delivered.messages[0]?.body).toContain("Approved");

    // Decided once only, and the agent sees the outcome.
    const again = await app(owner)(
      `${personal}/proposals/${proposalId}/approve`,
      "POST",
      { reviewedIntegrity: page.body.data.proposals?.[0]?.integrity },
    );
    expect(again.status).toBe(409);
    const status = await manage({ action: "list" });
    expect(status.proposals).toEqual([
      expect.objectContaining({ proposal_id: proposalId, status: "approved" }),
    ]);
    expect((await app(owner)(personal)).body.data.proposals).toEqual([]);
  });

  it("publishes an update as a new version, keeping a pinned version active", async () => {
    const threadId = await newThread();
    const manage = tool(threadId);
    const first = await manage(releaseNotes());
    const firstPage = await app(owner)(personal);
    await app(owner)(
      `${personal}/proposals/${first.proposal_id}/approve`,
      "POST",
      {
        reviewedIntegrity: firstPage.body.data.proposals?.[0]?.integrity,
      },
    );

    const read = await manage({
      action: "read",
      scope: "personal",
      name: "release-notes",
    });
    expect(read).toMatchObject({
      version: 1,
      instructions: "Write release notes from merged PRs.",
      resources: [{ path: "resources/template.md", content: "# Release\n" }],
    });

    const update = await manage(releaseNotes("Group the notes by area."));
    expect(update).toMatchObject({ change: "update", current_version: 1 });
    const page = await app(owner)(personal);
    expect(page.body.data.proposals?.[0]).toMatchObject({
      change: "update",
      currentVersion: 1,
    });
    await app(owner)(
      `${personal}/proposals/${update.proposal_id}/approve`,
      "POST",
      {
        reviewedIntegrity: page.body.data.proposals?.[0]?.integrity,
      },
    );
    expect(await skillRows()).toEqual([
      {
        name: "release-notes",
        scope: "personal",
        enabled: 1,
        active_version: 2,
      },
    ]);

    // A pinned skill gets the version published but not activated.
    const skillId = (await app(owner)(personal)).body.data.items?.[0]?.id;
    await app(owner)(`${personal}/${skillId}`, "PATCH", { pinned: true });
    const pinned = await manage(releaseNotes("Add a security section."));
    const pinnedPage = await app(owner)(personal);
    await app(owner)(
      `${personal}/proposals/${pinned.proposal_id}/approve`,
      "POST",
      {
        reviewedIntegrity: pinnedPage.body.data.proposals?.[0]?.integrity,
      },
    );
    const rows = await skillRows();
    expect(rows).toEqual([
      {
        name: "release-notes",
        scope: "personal",
        enabled: 1,
        active_version: 2,
      },
    ]);
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM skill_version",
    ).first<{ n: number }>();
    expect(versions?.n).toBe(3);
  });

  it("refuses scopes and content the person could not save themselves", async () => {
    const memberThread = await newThread(member);
    const asMember = tool(memberThread);
    const scopes = await asMember({ action: "list" });
    expect(scopes.scopes).toEqual([
      expect.objectContaining({ scope: "personal", can_propose: true }),
      expect.objectContaining({ scope: "workspace", can_propose: false }),
    ]);
    await expect(
      asMember({ ...releaseNotes(), scope: "workspace" }),
    ).rejects.toThrow(/admin/i);

    const manage = tool(await newThread());
    await expect(
      manage({ ...releaseNotes(), name: "Release Notes" }),
    ).rejects.toThrow(/name/i);
    await expect(
      manage({
        ...releaseNotes(),
        resources: [{ path: "scripts/run.sh", content: "echo hi" }],
      }),
    ).rejects.toThrow(/resources\//);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_proposal").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  it("lets only someone who could save the skill decide, and a rejection changes nothing", async () => {
    const threadId = await newThread();
    const manage = tool(threadId);
    const proposed = await manage({ ...releaseNotes(), scope: "workspace" });
    expect(proposed.review_url).toBe(
      `${ORIGIN}/workspaces/${workspaceSlug}/skills?proposal=${proposed.proposal_id}`,
    );

    // A member sees no proposals and cannot decide one.
    const memberPage = await app(member)(workspace);
    expect(memberPage.body.data.proposals).toEqual([]);
    const memberApprove = await app(member)(
      `${workspace}/proposals/${proposed.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: "a".repeat(64) },
    );
    expect(memberApprove.status).toBe(403);
    // Nor through their personal page.
    const crossScope = await app(member)(
      `${personal}/proposals/${proposed.proposal_id}/reject`,
      "POST",
      {},
    );
    expect(crossScope.status).toBe(404);

    // Content that differs from what was reviewed is refused.
    const page = await app(owner)(workspace);
    const stale = await app(owner)(
      `${workspace}/proposals/${proposed.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: "b".repeat(64) },
    );
    expect(stale.status).toBe(409);
    expect(page.body.data.proposals).toHaveLength(1);

    const rejected = await app(owner)(
      `${workspace}/proposals/${proposed.proposal_id}/reject`,
      "POST",
      {},
    );
    expect(rejected.status).toBe(200);
    expect(await skillRows()).toEqual([]);
    expect(delivered.messages).toEqual([
      {
        threadId,
        body: expect.stringContaining("Rejected."),
      },
    ]);
    const status = await manage({ action: "list" });
    expect(status.proposals).toEqual([
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  it("keeps one pending proposal per skill from a Thread", async () => {
    const threadId = await newThread();
    const manage = tool(threadId);
    const first = await manage(releaseNotes());
    const second = await manage(releaseNotes("A better draft."));
    const page = await app(owner)(personal);
    expect(page.body.data.proposals).toEqual([
      expect.objectContaining({
        id: second.proposal_id,
        instructions: "A better draft.",
      }),
    ]);
    const status = await manage({ action: "list" });
    expect(status.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposal_id: first.proposal_id,
          status: "superseded",
        }),
        expect.objectContaining({
          proposal_id: second.proposal_id,
          status: "pending",
        }),
      ]),
    );
    const firstApprove = await app(owner)(
      `${personal}/proposals/${first.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: page.body.data.proposals?.[0]?.integrity },
    );
    expect(firstApprove.status).toBe(409);
  });

  it("refuses to update a skill a plugin installed", async () => {
    const pluginId = "plg_00000000-0000-4000-8000-00000000b901";
    const timestamp = "2026-11-10T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trusted_plugin (
           id, scope, target_id, name, enabled, active_version, health_status,
           kind, created_at, updated_at
         ) VALUES (?, 'personal', ?, 'release-kit', 1, '1.0.0', 'unchecked', 'bundle', ?, ?)`,
      ).bind(pluginId, owner, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO skill (id, scope, target_id, name, enabled, active_version, pinned, plugin_id, created_at, updated_at)
         VALUES (?, 'personal', ?, 'release-notes', 1, 1, 0, ?, ?, ?)`,
      ).bind(
        "skl_00000000-0000-4000-8000-00000000b901",
        owner,
        pluginId,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO skill_version (skill_id, version, description, instructions, manifest_json, mcp_server_ids_json, source_type, source_label, integrity, created_at, created_by_user_id)
         VALUES (?, 1, 'd', 'i', ?, '[]', 'browser-files', 'Plugin', ?, ?, ?)`,
      ).bind(
        "skl_00000000-0000-4000-8000-00000000b901",
        JSON.stringify({
          schemaVersion: 1,
          name: "release-notes",
          description: "d",
        }),
        "c".repeat(64),
        timestamp,
        owner,
      ),
    ]);
    const manage = tool(await newThread());
    await expect(manage(releaseNotes())).rejects.toThrow(/plugin/i);
  });

  it("hands a proposal back for review when saving it fails", async () => {
    const manage = tool(await newThread());
    const proposed = await manage(releaseNotes());
    const page = await app(owner)(personal);
    // The scope fills up after the proposal, so saving it fails.
    const timestamp = "2026-11-10T00:00:00.000Z";
    await env.DB.batch(
      Array.from({ length: 20 }, (_, index) => {
        const id = `skl_00000000-0000-4000-8000-${(0xc00000 + index).toString(16).padStart(12, "0")}`;
        return [
          env.DB.prepare(
            `INSERT INTO skill (id, scope, target_id, name, enabled, active_version, pinned, created_at, updated_at)
             VALUES (?, 'personal', ?, ?, 1, 1, 0, ?, ?)`,
          ).bind(id, owner, `filler-${index}`, timestamp, timestamp),
          env.DB.prepare(
            `INSERT INTO skill_version (skill_id, version, description, instructions, manifest_json, mcp_server_ids_json, source_type, source_label, integrity, created_at, created_by_user_id)
             VALUES (?, 1, 'd', 'i', ?, '[]', 'browser-files', 'Filler', ?, ?, ?)`,
          ).bind(
            id,
            JSON.stringify({
              schemaVersion: 1,
              name: `filler-${index}`,
              description: "d",
            }),
            "d".repeat(64),
            timestamp,
            owner,
          ),
        ];
      }).flat(),
    );
    const failed = await app(owner)(
      `${personal}/proposals/${proposed.proposal_id}/approve`,
      "POST",
      { reviewedIntegrity: page.body.data.proposals?.[0]?.integrity },
    );
    expect(failed.status).toBe(409);
    expect((await app(owner)(personal)).body.data.proposals).toEqual([
      expect.objectContaining({ id: proposed.proposal_id }),
    ]);
    const status = await manage({ action: "list" });
    expect(status.proposals).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
  });
});
