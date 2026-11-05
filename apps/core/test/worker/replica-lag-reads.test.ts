import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { createArtifact } from "../../src/thread-artifacts/store.js";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * A browser read without a bookmark, or with one older than another
 * request's write, is served by any D1 replica (#1386). On staging a replica
 * missed a Thread 7 s after its insert, so the updates stream answered 404
 * THREAD_NOT_FOUND to its owner mid-reply (#1784). A lookup that decides
 * whether a request may see something must not conclude "not found" from a
 * replica that may be behind.
 *
 * How it could fail, each covered below:
 * - A replica that has not applied a Thread's insert answers its owner 404,
 *   on the agent's update stream, the Thread detail, or a Thread subroute.
 * - The same for a Project, an artifact the agent just saved, or a share
 *   another person just granted.
 * - Confirming at the primary authorizes what the primary does not: a Thread
 *   that does not exist, or someone else's, must still answer 404, the same
 *   404 either way, so a non-owner learns nothing.
 * - A deleted Thread stops answering its owner 410.
 * - A replica that has the row pays a primary round trip anyway, undoing
 *   #1386's latency win.
 *
 * Local D1 has no replicas. The binding below stands in for one that lags:
 * a read request's session (any constraint but `first-primary`) sees
 * nothing of a row the test marks unapplied, while the bare binding and a
 * write's session see the primary.
 */

const origin = "http://dx.test";
const unapplied = new Set<string>();
/** Reads at the primary (bare binding or a primary session), by bound IDs. */
const primaryReads: string[][] = [];

const mentionsUnapplied = (args: ReadonlyArray<unknown>) =>
  args.some((value) => typeof value === "string" && unapplied.has(value));

/** The real statement behind a lagging one, for `batch`. */
const real = new WeakMap<object, D1PreparedStatement>();

const laggingStatement = (
  statement: D1PreparedStatement,
  args: ReadonlyArray<unknown> = [],
): D1PreparedStatement => {
  const behind = () => mentionsUnapplied(args);
  const wrapped = {
    bind: (...values: unknown[]) =>
      laggingStatement(statement.bind(...values), values),
    first: (column?: string) =>
      behind()
        ? Promise.resolve(null)
        : column === undefined
          ? statement.first()
          : statement.first(column),
    all: () =>
      behind()
        ? Promise.resolve({ results: [], success: true, meta: {} })
        : statement.all(),
    raw: (options?: { columnNames?: boolean }) =>
      behind()
        ? Promise.resolve(options?.columnNames === true ? [[]] : [])
        : statement.raw(options as { columnNames: true }),
    run: () => statement.run(),
  } as unknown as D1PreparedStatement;
  real.set(wrapped, statement);
  return wrapped;
};

const recordingStatement = (
  statement: D1PreparedStatement,
  args: ReadonlyArray<unknown> = [],
): D1PreparedStatement => {
  const record = () => {
    primaryReads.push(args.map(String));
  };
  const wrapped = {
    bind: (...values: unknown[]) =>
      recordingStatement(statement.bind(...values), values),
    first: (column?: string) => {
      record();
      return column === undefined ? statement.first() : statement.first(column);
    },
    all: () => {
      record();
      return statement.all();
    },
    raw: (options?: { columnNames?: boolean }) => {
      record();
      return statement.raw(options as { columnNames: true });
    },
    run: () => statement.run(),
  } as unknown as D1PreparedStatement;
  real.set(wrapped, statement);
  return wrapped;
};

const unwrap = (statements: D1PreparedStatement[]) =>
  statements.map((statement) => real.get(statement) ?? statement);

const laggingReplicaDb = new Proxy(env.DB, {
  get(target, property) {
    if (property === "prepare")
      return (query: string) => recordingStatement(target.prepare(query));
    if (property === "batch")
      return (statements: D1PreparedStatement[]) =>
        target.batch(unwrap(statements));
    if (property === "withSession")
      return (constraint?: string) => {
        const session = target.withSession(constraint);
        if (constraint === "first-primary")
          return {
            prepare: (query: string) =>
              recordingStatement(session.prepare(query)),
            batch: (statements: D1PreparedStatement[]) =>
              session.batch(unwrap(statements)),
            getBookmark: () => session.getBookmark(),
          };
        return {
          prepare: (query: string) => laggingStatement(session.prepare(query)),
          batch: (statements: D1PreparedStatement[]) =>
            session.batch(unwrap(statements)),
          getBookmark: () => session.getBookmark(),
        };
      };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const bindings: Bindings = {
  ...(env as unknown as Bindings),
  DB: laggingReplicaDb,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "replica-lag-test-secret-0000000000000000",
};

const BOOKMARK_COOKIE = "dx-d1-bookmark";
let signups = 0;

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .filter((cookie) => !cookie.startsWith(`${BOOKMARK_COOKIE}=`));

/** A browser that keeps its auth cookies but no bookmark, as the batch did. */
const signUp = async (name: string) => {
  const email = `replica-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${++signups}`,
      },
      body: JSON.stringify({ name, email, password: "replica-lag-pass-123" }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: UserId }>();
  if (!user) throw new Error("Expected the signed-up user");
  const cookie = cookiesOf(response).join("; ");
  const send = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    headers.set("origin", origin);
    return app.request(path, { ...init, headers }, bindings);
  };
  return { id: user.id, send };
};

const codeOf = async (response: Response) =>
  ((await response.clone().json()) as { data?: { code?: string } }).data?.code;

const n = () => crypto.randomUUID().slice(-12);

/** A Project and Thread written at the primary, as an agent's request would. */
const seed = async (ownerUserId: UserId) => {
  const projectId = `prj_00000000-0000-4000-8000-${n()}` as ProjectId;
  const threadId = `thr_00000000-0000-4000-8000-${n()}`;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, ownerUserId, `replica-${n()}`),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, ownerUserId),
      );
    }),
  );
  return { projectId, threadId };
};

const readsAtPrimaryOf = (id: string) =>
  primaryReads.filter((args) => args.includes(id)).length;

beforeEach(() => {
  unapplied.clear();
  primaryReads.length = 0;
});

describe("Reads from a D1 replica that has not applied a write", () => {
  it("serves the owner's update stream for a Thread the replica has not applied", async () => {
    const owner = await signUp("Stream Owner");
    const { threadId } = await seed(owner.id);
    unapplied.add(threadId);

    const updates = await owner.send(
      `/v1/agents/dx/${threadId}?view=updates&offset=-1`,
    );
    // dx's admission let the read through to the agent's own router, which
    // answers in Flue's error shape here (no agent runs in this test), never
    // dx's THREAD_NOT_FOUND.
    const answer = (await updates.json()) as {
      error?: unknown;
      data?: { code?: string };
    };
    expect(answer.data?.code).toBeUndefined();
    expect(answer.error).toBeDefined();

    const members = await owner.send(`/v1/threads/${threadId}/members`);
    expect(members.status).toBe(200);
  });

  it("serves the owner's Thread and Project the replica has not applied", async () => {
    const owner = await signUp("Detail Owner");
    const { projectId, threadId } = await seed(owner.id);
    unapplied.add(threadId);
    unapplied.add(projectId);

    const detail = await owner.send(`/v1/threads/${threadId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { id: threadId } });

    const listItem = await owner.send(`/v1/threads/${threadId}/list-item`);
    expect(listItem.status).toBe(200);

    const projectRead = await owner.send(`/v1/projects/${projectId}`);
    expect(projectRead.status).toBe(200);
    expect(await projectRead.json()).toMatchObject({ data: { id: projectId } });
  });

  it("serves an artifact the agent just saved that the replica has not applied", async () => {
    const owner = await signUp("Artifact Owner");
    const { threadId } = await seed(owner.id);
    const created = await createArtifact(
      { DB: env.DB, DX_STORAGE: env.DX_STORAGE },
      {
        threadId,
        title: "Plan",
        markdown: "# Plan\n\nStep one.",
        writer: { kind: "agent" },
      },
    );
    if (created.kind !== "saved") throw new Error("Expected a saved artifact");
    const artifactId = created.value.artifact.id;
    unapplied.add(artifactId);

    const read = await owner.send(
      `/v1/threads/${threadId}/artifacts/${artifactId}`,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      data: { artifact: { id: artifactId }, markdown: "# Plan\n\nStep one." },
    });
    const revision = await owner.send(
      `/v1/threads/${threadId}/artifacts/${artifactId}/revisions/1`,
    );
    expect(revision.status).toBe(200);
  });

  it("serves a member a Thread just shared with their workspace", async () => {
    const owner = await signUp("Sharing Owner");
    const member = await signUp("Sharing Member");
    const workspaceId = `ws-${n()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
      ).bind(workspaceId, "Replica Team", workspaceId),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1, ?3, ?4, 'owner', 1), (?2, ?3, ?5, 'member', 2)`,
      ).bind(`m-${n()}`, `m-${n()}`, workspaceId, owner.id, member.id),
    ]);
    const { threadId } = await seed(owner.id);
    // The owner shares it; the member's replica has not applied that yet.
    const shared = await owner.send(`/v1/threads/${threadId}/sharing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceAccess: "view" }),
    });
    expect(shared.status).toBe(200);
    unapplied.add(threadId);

    const seen = await member.send(`/v1/threads/${threadId}`);
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({
      data: { id: threadId, access: "view" },
    });
    const members = await member.send(`/v1/threads/${threadId}/members`);
    expect(members.status).toBe(200);
  });

  it("still answers 404 for a Thread that is not there or not theirs, the same 404 either way", async () => {
    const owner = await signUp("Real Owner");
    const stranger = await signUp("Stranger");
    const { threadId } = await seed(owner.id);
    const missing = `thr_00000000-0000-4000-8000-${n()}`;
    unapplied.add(threadId);
    unapplied.add(missing);

    const answers = [];
    for (const [id, path] of [
      [threadId, `/v1/agents/dx/${threadId}?view=updates&offset=-1`],
      [threadId, `/v1/threads/${threadId}`],
      [missing, `/v1/agents/dx/${missing}?view=updates&offset=-1`],
      [missing, `/v1/threads/${missing}`],
    ] as const) {
      primaryReads.length = 0;
      const response = await stranger.send(path);
      const body = (await response.json()) as {
        data: { code: string; message: string };
      };
      answers.push({ status: response.status, ...body.data });
      // The replica's miss was confirmed at the primary.
      expect(readsAtPrimaryOf(id)).toBeGreaterThan(0);
    }
    for (const answer of answers)
      expect(answer).toMatchObject({
        status: 404,
        code: "THREAD_NOT_FOUND",
        message: "Thread not found.",
      });

    // The owner's own Thread that never existed is a 404 too.
    const ownMissing = await owner.send(`/v1/threads/${missing}/members`);
    expect(ownMissing.status).toBe(404);
  });

  it("still answers 410 to the owner of a deleted Thread", async () => {
    const owner = await signUp("Deleting Owner");
    const { threadId } = await seed(owner.id);
    // Deleted at the primary, and the replica has applied the tombstone.
    expect(
      await tombstoneThreads(
        env.DB,
        [threadId as ThreadId],
        owner.id,
        new Date().toISOString(),
      ),
    ).toEqual([threadId]);

    const read = await owner.send(`/v1/threads/${threadId}/members`);
    expect(read.status).toBe(410);
    expect(await codeOf(read)).toBe("THREAD_DELETED");
  });

  it("reads nothing at the primary when the replica has the Thread", async () => {
    const owner = await signUp("Fast Owner");
    const { threadId } = await seed(owner.id);
    primaryReads.length = 0;

    expect((await owner.send(`/v1/threads/${threadId}/members`)).status).toBe(
      200,
    );
    expect((await owner.send(`/v1/threads/${threadId}`)).status).toBe(200);
    expect(readsAtPrimaryOf(threadId)).toBe(0);
  });
});
