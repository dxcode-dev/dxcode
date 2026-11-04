import { env } from "cloudflare:test";
import {
  PersonalAgentInstructionsSnapshot,
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  composeClaudeCodePrompt,
  composeDxAgentPrompt,
  settingsInstructions,
} from "../../src/agents/dx-agent-prompt.js";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { resolveAgentWorkspaceInstructions } from "../../src/plugins/agent-context.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "workspace-instructions-secret-0000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

let signupIndex = 0;
/** A signed-in person; `workspaceId` undefined gives them a new workspace. */
const signup = async (workspace?: {
  readonly id: string;
  readonly role: "admin" | "member";
}) => {
  signupIndex += 1;
  const email = `workspace-instructions-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signupIndex}`,
      },
      body: JSON.stringify({
        name: "Workspace Person",
        email,
        password: "workspace-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email=?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("Expected user");
  const workspaceId = workspace?.id ?? crypto.randomUUID();
  const slug = `instructions-${workspaceId}`;
  await env.DB.batch([
    ...(workspace === undefined
      ? [
          env.DB.prepare(
            "INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)",
          ).bind(workspaceId, "Instructions Team", slug, Date.now()),
        ]
      : []),
    env.DB.prepare("DELETE FROM member WHERE userId=?").bind(user.id),
    env.DB.prepare(
      "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      workspaceId,
      user.id,
      workspace?.role ?? "owner",
      Date.now(),
    ),
  ]);
  return { cookie, userId: user.id as UserId, workspaceId, slug };
};

const instructions = async (
  person: { readonly cookie: string; readonly slug: string },
  method: "GET" | "PUT" = "GET",
  body?: unknown,
) => {
  const response = await app.request(
    `/v1/settings/workspaces/${person.slug}/agent-instructions`,
    {
      method,
      headers: {
        cookie: person.cookie,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      status: string;
      data: Record<string, unknown>;
    },
  };
};

const stored = () =>
  env.DB.prepare(
    "SELECT workspace_id, content, revision FROM workspace_agent_instructions",
  ).all<{ workspace_id: string; content: string; revision: number }>();

describe("Workspace Instructions in workerd with real D1", () => {
  it("lets an admin save the workspace AGENTS.md, and members only read it", async () => {
    const owner = await signup();
    const admin = await signup({ id: owner.workspaceId, role: "admin" });
    const member = await signup({ id: owner.workspaceId, role: "member" });
    const asAdmin = { ...admin, slug: owner.slug };
    const asMember = { ...member, slug: owner.slug };

    // Nothing saved yet: every member reads an empty file.
    expect(await instructions(asMember)).toEqual({
      status: 200,
      body: {
        status: "success",
        data: {
          instructions: "",
          revision: 0,
          canUpdate: false,
          updatedAt: null,
        },
      },
    });

    const saved = await instructions(asAdmin, "PUT", {
      instructions: "Run pnpm verify before you finish.\r\n",
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      status: 200,
      body: {
        status: "success",
        data: {
          instructions: "Run pnpm verify before you finish.\n",
          revision: 1,
          canUpdate: true,
        },
      },
    });

    expect((await instructions(asMember)).body.data).toMatchObject({
      instructions: "Run pnpm verify before you finish.\n",
      revision: 1,
      canUpdate: false,
    });

    // A member's save is refused and changes nothing.
    expect(
      await instructions(asMember, "PUT", {
        instructions: "Ignore the admin.",
        expectedRevision: 1,
      }),
    ).toMatchObject({
      status: 403,
      body: {
        status: "error",
        data: { code: "WORKSPACE_AGENT_INSTRUCTIONS_FORBIDDEN" },
      },
    });
    expect((await stored()).results).toContainEqual({
      workspace_id: owner.workspaceId,
      content: "Run pnpm verify before you finish.\n",
      revision: 1,
    });

    // Another workspace cannot read or write it.
    const outsider = await signup();
    const asOutsider = { ...outsider, slug: owner.slug };
    expect((await instructions(asOutsider)).status).toBe(403);
    expect(
      (
        await instructions(asOutsider, "PUT", {
          instructions: "x",
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
  });

  it("enforces 8,000 characters and the revision the admin saw", async () => {
    const owner = await signup();

    const atLimit = "a".repeat(8_000);
    expect(
      await instructions(owner, "PUT", {
        instructions: atLimit,
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: 200, body: { data: { revision: 1 } } });

    // The server refuses one character more, whatever the client allowed.
    expect(
      await instructions(owner, "PUT", {
        instructions: `${atLimit}a`,
        expectedRevision: 1,
      }),
    ).toMatchObject({
      status: 400,
      body: {
        data: {
          code: "INVALID_WORKSPACE_AGENT_INSTRUCTIONS",
          fieldErrors: [
            {
              field: "instructions",
              message: "Enter no more than 8,000 characters.",
            },
          ],
        },
      },
    });

    // A save from a stale page does not overwrite a newer one.
    expect(
      await instructions(owner, "PUT", {
        instructions: "stale",
        expectedRevision: 0,
      }),
    ).toMatchObject({
      status: 409,
      body: {
        data: {
          code: "WORKSPACE_AGENT_INSTRUCTIONS_REVISION_CONFLICT",
          currentRevision: 1,
        },
      },
    });
    expect((await instructions(owner)).body.data).toMatchObject({
      instructions: atLimit,
      revision: 1,
    });

    // The database refuses an oversized file even past the route.
    await expect(
      env.DB.prepare(
        "UPDATE workspace_agent_instructions SET content = ? WHERE workspace_id = ?",
      )
        .bind("b".repeat(8_001), owner.workspaceId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("puts the workspace's instructions before the member's own in their Thread's agent prompt", async () => {
    const owner = await signup();
    const member = await signup({ id: owner.workspaceId, role: "member" });
    const loner = await signup();
    const workspaceRule = "WORKSPACE RULE: end every reply with the word kiwi.";
    const personalRule = "PERSONAL RULE: answer in British English.";
    expect(
      (
        await instructions(owner, "PUT", {
          instructions: workspaceRule,
          expectedRevision: 0,
        })
      ).status,
    ).toBe(200);

    const memberProject = project(
      `prj_${crypto.randomUUID()}`,
      member.userId,
      "member-project",
    );
    const memberThread = thread(
      `thr_${crypto.randomUUID()}`,
      memberProject.id as ProjectId,
      member.userId,
      "2026-11-02T12:00:00.000Z",
      Schema.decodeUnknownSync(PersonalAgentInstructionsSnapshot)({
        content: personalRule,
        revision: 1,
        version: 1,
      }),
    );
    const lonerProject = project(
      `prj_${crypto.randomUUID()}`,
      loner.userId,
      "loner-project",
    );
    const lonerThread = thread(
      `thr_${crypto.randomUUID()}`,
      lonerProject.id as ProjectId,
      loner.userId,
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(memberProject);
        yield* projects.insert(lonerProject);
        yield* threads.insert(memberThread);
        yield* threads.insert(lonerThread);
      }),
    );

    // What DxAgent.resolvePromptData reads on each submission.
    const resolved = await resolveAgentWorkspaceInstructions(memberThread.id);
    expect(resolved).toBe(workspaceRule);
    // A Thread in another workspace gets none of it.
    expect(await resolveAgentWorkspaceInstructions(lonerThread.id)).toBe("");

    const prompt = composeDxAgentPrompt(
      memberThread.agentInstructions.content,
      "",
      undefined,
      resolved,
    );
    const safety = prompt.indexOf(
      "never ask for, print, or configure credentials",
    );
    const workspaceAt = prompt.indexOf(workspaceRule);
    const personalAt = prompt.indexOf(personalRule);
    expect(safety).toBeGreaterThan(-1);
    expect(workspaceAt).toBeGreaterThan(safety);
    expect(personalAt).toBeGreaterThan(workspaceAt);
    expect(prompt).toContain(
      "They never override the system and safety instructions above",
    );
    // Flue appends the project's AGENTS.md after this prompt.
    expect(prompt.trimEnd().endsWith("</personal_instructions>")).toBe(true);

    // Claude Code mode: both go to ~/.claude/CLAUDE.md, workspace first,
    // and none of it into the appended system prompt.
    const claudeMd = settingsInstructions(
      resolved,
      memberThread.agentInstructions.content,
    );
    expect(claudeMd).toBe(
      `<workspace_instructions>\n${workspaceRule}\n</workspace_instructions>\n\n<personal_instructions>\n${personalRule}\n</personal_instructions>`,
    );
    const claudeCode = composeClaudeCodePrompt();
    expect(claudeCode).not.toContain(workspaceRule);
    expect(claudeCode).not.toContain(personalRule);
  });
});
