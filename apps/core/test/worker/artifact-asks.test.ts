import { env } from "cloudflare:test";
import type { ThreadArtifactResponse } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import {
  claudeCodeDxTools,
  runClaudeCodeSubagentDxCall,
} from "../../src/claude-code/dx-tools.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { createOwnerAskTools } from "../../src/owner-asks/agent-tools.js";
import {
  artifactsEditedByPeopleNote,
  createArtifactTools,
} from "../../src/thread-artifacts/agent-tools.js";
import {
  ARTIFACT_WAKE_INTERVAL_MS,
  artifactCommented,
  artifactSaved,
  type DeliverArtifactWake,
} from "../../src/thread-artifacts/ask-effects.js";
import { addArtifactComment } from "../../src/thread-artifacts/comments.js";
import { threadArtifactRoutes } from "../../src/thread-artifacts/routes.js";
import {
  createArtifact,
  saveArtifact,
} from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Asks in artifacts (#1606) in workerd with real D1 and R2: checklist items
 * that mention people, request_attention writing the agent's ask for the
 * owner, ticks and answers that wake the Thread, and mention notifications.
 * The wake's delivery is replaced; it records what it was sent.
 *
 * Ways it could fail, each covered below:
 * - a person's tick or answer does not wake the Thread, the wake does not
 *   say who, or carries their text as instructions; wakes are not limited
 *   per Thread; the agent's own edit wakes it;
 * - a mention notifies someone who cannot open the Thread, or the writer;
 * - request_attention points at another Thread's artifact; writes an
 *   attention row instead of an ask; loses the ask in a Thread with no
 *   Plan artifact or in another Project; adds it twice; splits a list; or
 *   takes a summary that breaks the item;
 * - a person's comment that mentions the agent does not wake the Thread,
 *   or, when rate-limited, never reaches the agent; a comment's people
 *   mentions notify outsiders.
 */

const owner = Schema.decodeSync(UserId)("asks-owner");
const member = Schema.decodeSync(UserId)("asks-member");
const outsider = Schema.decodeSync(UserId)("asks-outsider");
const workspaceId = "asks-workspace";
const ORIGIN = "https://dx.test";
const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-00000000a901", owner, "Asks"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
let sequence = 0;
const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: ORIGIN,
};

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const wakes: Array<Parameters<DeliverArtifactWake>[0]> = [];
const deliver: DeliverArtifactWake = async (input) => {
  wakes.push(input);
};

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  routes.use("/v1/threads/:threadId/artifacts/*", authorizeThread);
  routes.route("/v1/threads", threadArtifactRoutes);
  return (path: string, method = "GET", body?: unknown) =>
    routes.request(
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
};

const newThread = async () => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xa90000 + sequence).toString(16).padStart(12, "0")}`,
    workspaceProject.id,
    owner,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(entity);
    }),
  );
  return entity.id as ThreadId;
};

const share = (threadId: string, access: "view" | "contribute") =>
  env.DB.prepare(
    `UPDATE threads SET shared_workspace_id = ?1, workspace_access = ?2,
            contribute_until = CASE WHEN ?2 = 'contribute' THEN ?3 ELSE NULL END
      WHERE id = ?4`,
  )
    .bind(
      workspaceId,
      access,
      new Date(Date.now() + 3_600_000).toISOString(),
      threadId,
    )
    .run();

/** The agent writes an artifact, and its after-save effects run. */
const agentWrites = async (threadId: string, markdown: string) => {
  const [tool] = createArtifactTools(threadId, () => ({
    db: env.DB,
    bindings,
  }));
  if (tool === undefined) throw new Error("Expected the artifact tool.");
  const output = (
    (await tool.run({
      data: { action: "create", title: "Plan", markdown },
      toolCallId: "call",
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as never)) as { output: { artifact_id: string } }
  ).output;
  return output.artifact_id;
};

/** A person saves through the store, then the after-save effects run. */
const personSaves = async (
  threadId: string,
  artifactId: string,
  userId: UserId,
  edit: (markdown: string) => string,
  now?: number,
) => {
  const current = (await (
    await app(owner)(`/v1/threads/${threadId}/artifacts/${artifactId}`)
  ).json()) as ThreadArtifactResponse;
  const result = await saveArtifact(bindings, {
    threadId,
    artifactId,
    baseRevision: current.data.artifact.revision,
    markdown: edit(current.data.markdown),
    writer: { kind: "user", userId },
  });
  if (result.kind !== "saved") throw new Error(`save: ${result.kind}`);
  await artifactSaved(
    bindings,
    {
      threadId,
      artifactId,
      title: result.value.artifact.title,
      revision: result.value.artifact.revision,
      before: result.previous,
      after: result.value.markdown,
      writer: { kind: "user", userId },
    },
    { deliver, ...(now === undefined ? {} : { now }) },
  );
  return result.value;
};

/** request_attention as the agent calls it: Flue validates the input first. */
const requestAttention = async (
  threadId: string,
  data: Record<string, unknown>,
) => {
  const [tool] = createOwnerAskTools(threadId, () => ({
    db: env.DB,
    bindings,
  }));
  if (tool === undefined) throw new Error("Expected request_attention.");
  const parsed = v.parse(tool.input as v.GenericSchema, data);
  return (
    (await tool.run({
      data: parsed,
      toolCallId: "call",
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as never)) as { output: Record<string, unknown> }
  ).output;
};

const markdownOf = async (threadId: string, artifactId: string) =>
  (
    (await (
      await app(owner)(`/v1/threads/${threadId}/artifacts/${artifactId}`)
    ).json()) as ThreadArtifactResponse
  ).data.markdown;

const attentionRows = async (threadId: string) =>
  Number(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM thread_attention_request WHERE thread_id = ?",
    )
      .bind(threadId)
      .first("n"),
  );

const notifications = (recipient: string) =>
  env.DB.prepare(
    `SELECT topic, actor_user_id, excerpt FROM notification
      WHERE recipient_user_id = ? AND source_key LIKE 'artifact-mention:%'
      ORDER BY created_at`,
  )
    .bind(recipient)
    .all<{ topic: string; actor_user_id: string | null; excerpt: string }>()
    .then(({ results }) => results);

const PLAN = [
  "# Plan",
  "",
  "- [ ] @[Olive](user:asks-owner) Approve merging #1240",
  "- [x] @[Olive](user:asks-owner) Already done",
  "- [ ] Write notes, no mention",
  "- [ ] @[Maya](user:asks-member) Review the copy",
  "```",
  "- [ ] @[Olive](user:asks-owner) not an ask, in code",
  "```",
  "",
].join("\n");

beforeEach(async () => {
  wakes.length = 0;
  await env.DB.batch([
    ...[
      [owner, "Olive Owner", "olive-owner"],
      [member, "Maya Member", "maya-member"],
      [outsider, "Otto Outsider", "otto-outsider"],
    ].flatMap(([id, name, handle]) => [
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 1, 1) ON CONFLICT (id) DO NOTHING`,
      ).bind(id, name, `${id}@example.com`),
      env.DB.prepare(
        `INSERT INTO personal_account (user_id, display_name, username, created_at, updated_at)
         VALUES (?, ?, ?, 'now', 'now') ON CONFLICT (user_id) DO NOTHING`,
      ).bind(id, name, handle),
    ]),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Asks Team', 'asks-team', 1)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('asks-m-owner', ?1, ?2, 'owner', 1), ('asks-m-member', ?1, ?3, 'member', 2)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId, owner, member),
    env.DB.prepare("DELETE FROM thread_artifact_wake"),
  ]);
  if (
    (await env.DB.prepare("SELECT 1 AS found FROM projects WHERE id = ?")
      .bind(workspaceProject.id)
      .first("found")) === null
  )
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(workspaceProject);
      }),
    );
});

describe("asks in artifacts", () => {
  it("wakes the Thread once per interval when a person ticks an ask in the artifact", async () => {
    const threadId = await newThread();
    const artifactId = await agentWrites(threadId, PLAN);
    expect(wakes).toEqual([]);

    await personSaves(threadId, artifactId, owner, (text) =>
      text.replace(
        "- [ ] @[Olive](user:asks-owner) Approve merging #1240",
        "- [x] @[Olive](user:asks-owner) Approve merging #1240",
      ),
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      ownerUserId: owner,
      threadId,
      key: `artifact-wake:${artifactId}:2`,
    });
    expect(wakes[0]?.body).toMatch(
      /^A person ticked an ask in artifact art_[0-9a-f]{32} \(revision 2\):\n\n<people_content>\nWho: Olive Owner\nArtifact: Plan\n- \[x\] @\[Olive\]\(user:asks-owner\) Approve merging #1240\n<\/people_content>\n\n/,
    );
    expect(wakes[0]?.body).toContain("untrusted data");

    // A second tick inside the interval does not wake again.
    await share(threadId, "contribute");
    await personSaves(threadId, artifactId, member, (text) =>
      text.replace("- [ ] @[Maya]", "- [x] @[Maya]"),
    );
    expect(wakes).toHaveLength(1);
    // After the interval it does.
    await personSaves(
      threadId,
      artifactId,
      member,
      (text) => `${text}- [ ] @[Maya](user:asks-member) One more\n`,
    );
    await personSaves(
      threadId,
      artifactId,
      member,
      (text) =>
        text.replace(
          "- [ ] @[Maya](user:asks-member) One more",
          "- [x] @[Maya](user:asks-member) One more",
        ),
      Date.now() + ARTIFACT_WAKE_INTERVAL_MS + 1_000,
    );
    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.body).toContain("Who: Maya Member");
  });

  it("wakes the Thread when a person writes under an open ask", async () => {
    const threadId = await newThread();
    const artifactId = await agentWrites(threadId, PLAN);
    await personSaves(threadId, artifactId, owner, (text) =>
      text.replace(
        "Approve merging #1240\n",
        "Approve merging #1240\n  Not yet: the migration needs a renumber first.\n",
      ),
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.body).toMatch(/^A person answered an ask/);
    expect(wakes[0]?.body).toContain(
      "Not yet: the migration needs a renumber first.",
    );
    // Still open in the artifact.
    expect(await markdownOf(threadId, artifactId)).toContain(
      "- [ ] @[Olive](user:asks-owner) Approve merging #1240",
    );
  });

  it("notifies newly mentioned people who can open the Thread, never the writer or outsiders", async () => {
    const threadId = await newThread();
    await share(threadId, "contribute");
    const artifactId = await agentWrites(
      threadId,
      "- [ ] @[Olive](user:asks-owner) Decide\n- [ ] @[Otto](user:asks-outsider) Sneaky\n",
    );
    expect(await notifications(owner)).toEqual([
      expect.objectContaining({ topic: "mention", actor_user_id: null }),
    ]);
    expect((await notifications(owner))[0]?.excerpt).toBe(
      "Plan: - [ ] @Olive Decide",
    );
    expect(await notifications(outsider)).toEqual([]);

    await personSaves(
      threadId,
      artifactId,
      member,
      (text) =>
        `${text}- [ ] @[Maya](user:asks-member) self\n- [ ] @[Olive](user:asks-owner) again\n`,
    );
    // Olive was already mentioned; Maya wrote her own mention.
    expect(await notifications(owner)).toHaveLength(1);
    expect(await notifications(member)).toEqual([]);
  });

  it("lets request_attention point only at this Thread's artifact, and adds nothing where the owner's ask already is", async () => {
    const threadId = await newThread();
    const other = await newThread();
    const created = await createArtifact(bindings, {
      threadId: other,
      title: "Elsewhere",
      markdown: "x",
      writer: { kind: "agent" },
    });
    if (created.kind !== "saved") throw new Error("Expected an artifact.");
    const artifactId = await agentWrites(threadId, PLAN);
    await expect(
      requestAttention(threadId, {
        kind: "approval",
        summary: "Approve merging #1240",
        artifact_id: created.value.artifact.id,
      }),
    ).rejects.toThrow(/not in this Thread/);
    expect(
      await requestAttention(threadId, {
        kind: "approval",
        summary: "Approve merging #1240",
        artifact_id: artifactId,
      }),
    ).toMatchObject({ listed: true, artifact_id: artifactId, revision: 1 });
    expect(await markdownOf(threadId, artifactId)).toBe(PLAN);
    expect(await attentionRows(threadId)).toBe(0);
  });

  it("puts the ask of a Claude Code Thread's mcp__dx__request_attention call in its Plan artifact, through the same tool", async () => {
    const threadId = await newThread();
    // Claude Code mode registers dx's tools under the MCP server's prefix.
    claudeCodeDxTools(
      threadId,
      createOwnerAskTools(threadId, () => ({ db: env.DB, bindings })),
    );
    const results = new Map<string, string>();
    await runClaudeCodeSubagentDxCall(
      threadId,
      {
        id: "toolu_ask",
        name: "mcp__dx__request_attention",
        input: { kind: "approval", summary: "Approve the release notes" },
      },
      {
        log: { info() {}, warn() {}, error() {}, debug() {} },
        harness: {
          sandbox: {
            writeFile: async (path: string, content: string) => {
              results.set(path, content);
            },
          },
        },
      } as never,
    );
    // Claude reads the tool's result from the file the MCP server waits on.
    const [result] = [...results.values()];
    expect(JSON.parse(result ?? "{}")).toMatchObject({ isError: false });
    const { artifact_id: planId } = JSON.parse(
      JSON.parse(result ?? "{}").content[0].text,
    ) as { artifact_id: string };
    expect(await markdownOf(threadId, planId)).toBe(
      "- [ ] @[Olive Owner](user:asks-owner) Approve the release notes\n",
    );
    expect((await notifications(owner)).at(-1)).toMatchObject({
      topic: "mention",
    });
    expect(await attentionRows(threadId)).toBe(0);
  });

  it("puts request_attention's ask in the Thread's Plan artifact, in any Project, notifying the owner, and a tick there wakes the Thread", async () => {
    // A Thread in the owner's own Project, with no artifact yet.
    const personal = project(
      "prj_00000000-0000-4000-8000-00000000a902",
      owner,
      "Personal",
    );
    if (
      (await env.DB.prepare("SELECT 1 AS found FROM projects WHERE id = ?")
        .bind(personal.id)
        .first("found")) === null
    )
      await runRepositories(
        Effect.gen(function* () {
          yield* (yield* ProjectRepository).insert(personal);
        }),
      );
    sequence += 1;
    const entity = thread(
      `thr_00000000-0000-4000-8000-${(0xa90000 + sequence).toString(16).padStart(12, "0")}`,
      personal.id,
      owner,
    );
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ThreadRepository).insert(entity);
      }),
    );
    const threadId = entity.id as ThreadId;
    const workspaceThread = await newThread();

    const first = await requestAttention(threadId, {
      kind: "approval",
      summary: "  Approve merging PR #12  ",
      url: "https://github.com/acme/app/pull/12",
    });
    expect(first).toMatchObject({ listed: true, title: "Plan", revision: 1 });
    const planId = String(first.artifact_id);
    expect(await markdownOf(threadId, planId)).toBe(
      "- [ ] @[Olive Owner](user:asks-owner) Approve merging PR #12 ([link](https://github.com/acme/app/pull/12))\n",
    );
    // No attention row: the ask lives in the artifact.
    expect(await attentionRows(threadId)).toBe(0);
    // The owner's mention notifies them.
    expect((await notifications(owner)).at(-1)).toMatchObject({
      topic: "mention",
    });

    // The same ask again adds nothing; another joins the same list.
    expect(
      await requestAttention(threadId, {
        kind: "approval",
        summary: "Approve merging PR #12",
        url: "https://github.com/acme/app/pull/12",
      }),
    ).toMatchObject({ artifact_id: planId, revision: 1 });
    await requestAttention(threadId, {
      kind: "question",
      summary: "Which region should the bucket live in?",
    });
    expect(await markdownOf(threadId, planId)).toBe(
      [
        "- [ ] @[Olive Owner](user:asks-owner) Approve merging PR #12 ([link](https://github.com/acme/app/pull/12))",
        "- [ ] @[Olive Owner](user:asks-owner) Which region should the bucket live in?",
        "",
      ].join("\n"),
    );

    // A Plan a person already wrote takes the ask at its end.
    const written = await agentWrites(workspaceThread, "# Plan\n\nShip it.\n");
    expect(
      await requestAttention(workspaceThread, {
        kind: "question",
        summary: "Ship today?",
      }),
    ).toMatchObject({ artifact_id: written, revision: 2 });
    expect(await markdownOf(workspaceThread, written)).toBe(
      "# Plan\n\nShip it.\n\n- [ ] @[Olive Owner](user:asks-owner) Ship today?\n",
    );

    // The owner ticks one in the Plan: the Thread wakes.
    await personSaves(threadId, planId, owner, (text) =>
      text.replace(
        "- [ ] @[Olive Owner](user:asks-owner) Which region",
        "- [x] @[Olive Owner](user:asks-owner) Which region",
      ),
    );
    expect(wakes.map(({ threadId: id }) => id)).toEqual([threadId]);

    // Bad input is refused before anything is written.
    for (const bad of [
      { kind: "question", summary: "" },
      { kind: "question", summary: "Two\nlines" },
      { kind: "question", summary: "Look", url: "javascript:alert(1)" },
      { kind: "question", summary: "Look", url: "https://x.test/a b" },
    ])
      await expect(requestAttention(threadId, bad)).rejects.toThrow();
    // Only the tick changed the Plan since.
    expect(await markdownOf(threadId, planId)).toBe(
      [
        "- [ ] @[Olive Owner](user:asks-owner) Approve merging PR #12 ([link](https://github.com/acme/app/pull/12))",
        "- [x] @[Olive Owner](user:asks-owner) Which region should the bucket live in?",
        "",
      ].join("\n"),
    );
  });

  it("wakes the Thread for a comment that mentions the agent, and keeps it in the next turn's note until the agent replies", async () => {
    const threadId = await newThread();
    await share(threadId, "contribute");
    const artifactId = await agentWrites(threadId, PLAN);
    // Posted through the store: the route runs these same effects after its
    // response, with the real delivery.
    const commented = await addArtifactComment(bindings, {
      threadId,
      artifactId,
      quote: "Review the copy",
      body: "@[dx](agent) shorten this, and @[Olive](user:asks-owner) please look",
      writer: { kind: "user", userId: member },
    });
    if (commented.kind !== "saved") throw new Error("Expected a comment.");
    const comment = commented.comment;
    await artifactCommented(
      bindings,
      {
        threadId,
        artifactId,
        commentId: comment.id,
        quote: comment.quote,
        body: comment.body,
        writer: { kind: "user", userId: member },
      },
      { deliver },
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.key).toBe(`artifact-comment-wake:${comment.id}`);
    expect(wakes[0]?.body).toMatch(
      new RegExp(`^A person mentioned you in a comment \\(${comment.id}\\)`),
    );
    expect(wakes[0]?.body).toContain("Who: Maya Member");
    expect(wakes[0]?.body).toContain(`reply to comment ${comment.id}`);
    // Olive is notified of the comment's mention; Otto, who cannot open the
    // Thread, is not part of it.
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM notification WHERE recipient_user_id = ? AND source_key = ?",
      )
        .bind(owner, `artifact-comment-mention:${comment.id}`)
        .first<number>("n"),
    ).toBe(1);

    // The next turn's note names it until the agent replies.
    expect(await artifactsEditedByPeopleNote(env.DB, threadId)).toContain(
      "Comments mention you",
    );
    const [tool] = createArtifactTools(threadId, () => ({
      db: env.DB,
      bindings,
    }));
    if (tool === undefined) throw new Error("Expected the artifact tool.");
    await tool.run({
      data: {
        action: "update",
        artifact_id: artifactId,
        base_revision: 1,
        comments: [{ reply: { comment_id: comment.id, text: "Shortened." } }],
      },
      toolCallId: "call",
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as never);
    expect(await artifactsEditedByPeopleNote(env.DB, threadId)).toBeUndefined();
  });
});
