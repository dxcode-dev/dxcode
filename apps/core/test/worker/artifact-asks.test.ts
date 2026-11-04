import { env } from "cloudflare:test";
import type { NeedsYouAsk, ThreadArtifactResponse } from "@dx/api";
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
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { createNeedsYouTools } from "../../src/needs-you/agent-tools.js";
import { listNeedsYou } from "../../src/needs-you/repository.js";
import { createNeedsYouRoutes } from "../../src/needs-you/routes.js";
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
  sweepDeletedArtifacts,
} from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Asks in artifacts (#1606 step 7) in workerd with real D1 and R2: checklist
 * items that mention people, the Needs-you page reading them, ticks that
 * wake the Thread, and mention notifications. The wake's delivery is
 * replaced; it records what it was sent.
 *
 * Ways it could fail, each covered below:
 * - an open ask is not indexed, or a ticked item, one with no mention, or
 *   one inside a code fence is; an ask's waiting time restarts on an
 *   unrelated edit; a deleted artifact's or deleted account's asks stay;
 * - someone sees asks in a Thread they cannot open, or a View member is
 *   offered Tick; the routes answer with the flag off;
 * - a tick from the page changes more than its checkbox, saves over a newer
 *   revision, or works for a View member;
 * - a person's tick or answer does not wake the Thread, the wake does not
 *   say who, or carries their text as instructions; wakes are not limited
 *   per Thread; the agent's own edit wakes it;
 * - a mention notifies someone who cannot open the Thread, or the writer;
 * - request_attention points at another Thread's artifact;
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
  routes.route("/v1/needs-you", createNeedsYouRoutes(undefined, deliver));
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

const enableAsks = (userId: UserId, enabled = true) =>
  env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      userId,
      JSON.stringify(enabled ? [{ id: "artifact-asks", enabled }] : []),
      new Date().toISOString(),
    )
    .run();

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

const asksOf = async (userId: UserId) => {
  const response = await app(userId)("/v1/needs-you/asks");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { asks: NeedsYouAsk[] } }).data
    .asks;
};

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
  for (const userId of [owner, member, outsider]) await enableAsks(userId);
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
  it("lists each person's open asks, keeps how long they waited, and drops deleted ones", async () => {
    const threadId = await newThread();
    const artifactId = await agentWrites(threadId, PLAN);
    const [ownerAsk, ...rest] = await asksOf(owner);
    expect(rest).toEqual([]);
    expect(ownerAsk).toMatchObject({
      threadId,
      artifactId,
      artifactTitle: "Plan",
      text: "@[Olive](user:asks-owner) Approve merging #1240",
      revision: 1,
      canTick: true,
    });
    // The member's ask is in a Thread they cannot open yet.
    expect(await asksOf(member)).toEqual([]);
    await share(threadId, "view");
    expect(await asksOf(member)).toEqual([
      expect.objectContaining({
        text: "@[Maya](user:asks-member) Review the copy",
        canTick: false,
      }),
    ]);
    expect(await asksOf(outsider)).toEqual([]);

    // An unrelated edit keeps the ask's waiting time.
    await personSaves(
      threadId,
      artifactId,
      owner,
      (text) => `${text}More notes.\n`,
      Date.now() + 60_000,
    );
    const [later] = await asksOf(owner);
    expect(later?.waitingSince).toBe(ownerAsk?.waitingSince);
    expect(later?.revision).toBe(2);

    await app(owner)(
      `/v1/threads/${threadId}/artifacts/${artifactId}`,
      "DELETE",
    );
    expect(await asksOf(owner)).toEqual([]);
  });

  it("answers only with the flag on", async () => {
    await enableAsks(owner, false);
    for (const [path, method] of [
      ["/v1/needs-you/asks", "GET"],
      ["/v1/needs-you/asks/tick", "POST"],
    ] as const) {
      const response = await app(owner)(
        path,
        method,
        method === "GET"
          ? undefined
          : {
              threadId: "thr_00000000-0000-4000-8000-000000000000",
              artifactId: "art_00000000000000000000000000000000",
              itemKey: "x",
            },
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("ASKS_DISABLED");
    }
  });

  it("ticks from Needs-you as the person, changing only the checkbox, and wakes the Thread once per interval", async () => {
    const threadId = await newThread();
    const artifactId = await agentWrites(threadId, PLAN);
    expect(wakes).toEqual([]);
    const [ask] = await asksOf(owner);
    if (ask === undefined) throw new Error("Expected an ask.");

    const ticked = await app(owner)("/v1/needs-you/asks/tick", "POST", {
      threadId,
      artifactId,
      itemKey: ask.itemKey,
    });
    expect(ticked.status).toBe(200);
    const after = (await (
      await app(owner)(`/v1/threads/${threadId}/artifacts/${artifactId}`)
    ).json()) as ThreadArtifactResponse;
    expect(after.data.markdown).toBe(
      PLAN.replace(
        "- [ ] @[Olive](user:asks-owner) Approve merging #1240",
        "- [x] @[Olive](user:asks-owner) Approve merging #1240",
      ),
    );
    expect(after.data.artifact.updatedBy).toMatchObject({
      kind: "user",
      userId: owner,
    });
    expect(await asksOf(owner)).toEqual([]);
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
    // Still open, so it stays on the page.
    expect(await asksOf(owner)).toHaveLength(1);
  });

  it("refuses a View member's tick, and a tick of an ask that is gone", async () => {
    const threadId = await newThread();
    const artifactId = await agentWrites(threadId, PLAN);
    await share(threadId, "view");
    const [memberAsk] = await asksOf(member);
    if (memberAsk === undefined) throw new Error("Expected an ask.");
    const refused = await app(member)("/v1/needs-you/asks/tick", "POST", {
      threadId,
      artifactId,
      itemKey: memberAsk.itemKey,
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("THREAD_READ_ONLY");
    const outsiderTick = await app(outsider)(
      "/v1/needs-you/asks/tick",
      "POST",
      {
        threadId,
        artifactId,
        itemKey: memberAsk.itemKey,
      },
    );
    expect(outsiderTick.status).toBe(404);
    expect(wakes).toEqual([]);

    const [ownerAsk] = await asksOf(owner);
    await personSaves(threadId, artifactId, owner, (text) =>
      text.replace("- [ ] @[Olive]", "- [x] @[Olive]"),
    );
    const stale = await app(owner)("/v1/needs-you/asks/tick", "POST", {
      threadId,
      artifactId,
      itemKey: ownerAsk?.itemKey,
    });
    expect(stale.status).toBe(404);
    expect(await stale.text()).toContain("ASK_NOT_FOUND");
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

  it("forgets a deleted account's asks", async () => {
    const threadId = await newThread();
    await share(threadId, "view");
    await agentWrites(threadId, PLAN);
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(member).run();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM thread_artifact_ask WHERE mentioned_user_id = ?",
      )
        .bind(member)
        .first("n"),
    ).toBe(0);
    await sweepDeletedArtifacts(bindings);
  });

  it("lets request_attention point only at this Thread's artifact", async () => {
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
    const [tool] = createNeedsYouTools(threadId, () => ({
      db: env.DB,
      bindings,
    }));
    if (tool === undefined) throw new Error("Expected request_attention.");
    const run = (artifact: string) =>
      tool.run({
        data: {
          kind: "approval",
          summary: "Approve merging #1240",
          artifact_id: artifact,
        },
        toolCallId: "call",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never);
    await expect(run(created.value.artifact.id)).rejects.toThrow(
      /not in this Thread/,
    );
    await run(artifactId);
    const [item] = await listNeedsYou(env.DB, owner, new Date().toISOString());
    expect(item).toMatchObject({ threadId, artifactId });
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
