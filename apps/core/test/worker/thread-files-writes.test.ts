import { env } from "cloudflare:test";
import { THREAD_FILES_UPLOAD_CHUNK_BYTES } from "@dx/api";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { enforceThreadActive } from "../../src/auth/enforce-thread-active.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { d1Session } from "../../src/persistence/d1-session.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadFilesRoutes } from "../../src/thread-files/routes.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/*
 * Files tree writes (#1154), through the same middleware as `app.ts`, real
 * D1, and a stand-in for the Thread's execution object that records what
 * would reach dxd.
 *
 * Ways the routes could fail, each covered below:
 * - a View member, an outsider, or an archived Thread's request reaches dxd;
 * - a path with `..` (plain or percent-encoded), `.git`, an absolute path, a
 *   backslash, or a `.dx-files-` temporary reaches dxd;
 * - a write runs outside the Changes mutation lease, or reaches dxd without
 *   the lease's refresh, so Changes misses it;
 * - an upload arrives out of order, over its bound, or refreshes Changes
 *   before its last chunk;
 * - dxd's refusal (a symbolic link on the way, an existing entry) answers
 *   success.
 */

const owner = "files-owner" as UserId;
const member = "files-member" as UserId;
const outsider = "files-outsider" as UserId;
const workspaceId = "files-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000001154",
  owner,
  "files-owner",
);
const threadId = "thr_00000000-0000-4000-8000-000000001154" as ThreadId;

interface DaemonCall {
  readonly operation: Record<string, unknown>;
  /** Changes mutation leases held when dxd received it. */
  readonly leases: number;
}

let calls: DaemonCall[] = [];
let refreshes = 0;
/** What dxd answers each write; `changed` unless a test says otherwise. */
let answer: (operation: Record<string, unknown>) => { kind: string } = () => ({
  kind: "changed",
});

const leases = async () =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS held FROM thread_changes_mutation_lease WHERE thread_id = ?",
    )
      .bind(threadId)
      .first<{ held: number }>()
  )?.held ?? 0;

const execution = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/changes/refresh") {
        refreshes += 1;
        return new Response(null, { status: 204 });
      }
      if (path !== "/daemon/request")
        return new Response(null, { status: 404 });
      const operation = JSON.parse(String(init.body)) as Record<
        string,
        unknown
      >;
      calls.push({ operation, leases: await leases() });
      return Response.json(answer(operation));
    },
  }),
} as unknown as DurableObjectNamespace;

const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  THREAD_EXECUTION: execution,
  DX_RUNTIME_MODE: "deployed",
} as Bindings;

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", d1Session);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/v1/threads", threadSharingRoutes);
  // As in app.ts.
  app.use("/v1/threads/:threadId/files/*", authorizeThread);
  app.use("/v1/threads/:threadId/files/*", enforceThreadActive);
  app.route("/v1/threads", threadFilesRoutes);
  app.onError(errorHandler);
  return app;
};

const filesUrl = `/v1/threads/${threadId}/files`;

const write = (body: unknown, userId: UserId = owner) =>
  createApp(userId).request(
    filesUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "dx-test=1" },
      body: JSON.stringify(body),
    },
    bindings,
  );

const upload = (
  path: string,
  bytes: Uint8Array,
  userId: UserId = owner,
  headers: Record<string, string> = {},
) =>
  createApp(userId).request(
    `${filesUrl}/${path}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        cookie: "dx-test=1",
        ...headers,
      },
      body: bytes,
    },
    bindings,
  );

const share = (body: unknown) =>
  createApp(owner).request(
    `/v1/threads/${threadId}/sharing`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: "dx-test=1" },
      body: JSON.stringify(body),
    },
    bindings,
  );

const errorCode = async (response: Response) =>
  ((await response.json()) as { data: { code: string } }).data.code;

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  calls = [];
  refreshes = 0;
  answer = () => ({ kind: "changed" });
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(workspaceId, "Files Team", "files-team"),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('f-owner', ?1, ?2, 'owner', 1),
         ('f-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(
        thread(threadId, ownerProject.id as ProjectId, owner),
      );
    }),
  );
  // A sourced Thread: every write takes the Changes mutation lease.
  await env.DB.prepare(
    `INSERT INTO thread_source_snapshot (
       thread_id, project_id, binding_revision, provider,
       repository_full_name, clone_url, default_branch,
       initial_ref, initial_commit_sha, created_at
     ) VALUES (?, ?, 1, 'github', 'example-org/example-repo',
       'https://github.com/example-org/example-repo.git', 'main', ?, ?, ?)`,
  )
    .bind(
      threadId,
      ownerProject.id,
      "a".repeat(40),
      "a".repeat(40),
      "2026-11-02T12:00:00.000Z",
    )
    .run();
});

const WRITES = [
  { action: "create", path: "docs", kind: "directory" },
  { action: "create", path: "docs/a.md", kind: "file" },
  { action: "move", from: "docs/a.md", to: "docs/b.md" },
  { action: "copy", from: "docs", to: "docs copy" },
  { action: "delete", path: "docs copy" },
] as const;

describe("Files tree writes in workerd with real D1", () => {
  it("runs each write under the Changes lease and hands dxd its refresh", async () => {
    for (const body of WRITES) {
      const response = await write(body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "success",
        data: { kind: "changed" },
      });
    }
    expect(calls.map(({ operation }) => operation.operation)).toEqual([
      "files.create",
      "files.create",
      "files.move",
      "files.copy",
      "files.delete",
    ]);
    for (const call of calls) {
      expect(call.leases).toBe(1);
      expect(call.operation.refresh).toMatchObject({ type: "changes-refresh" });
    }
    expect(calls[2]?.operation).toMatchObject({
      from: "docs/a.md",
      to: "docs/b.md",
    });
    // Released afterwards, and Changes asked to confirm.
    expect(await leases()).toBe(0);
    expect(refreshes).toBe(WRITES.length);
  });

  it("uploads in order, inside one lease, refreshing only after the last chunk", async () => {
    const bytes = new Uint8Array(THREAD_FILES_UPLOAD_CHUNK_BYTES * 2 + 5);
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = index % 251;
    const response = await upload("assets/logo.bin", bytes);
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(3);
    const ids = new Set(calls.map(({ operation }) => operation.upload));
    expect(ids.size).toBe(1);
    expect(calls.map(({ operation }) => operation.offset)).toEqual([
      0,
      THREAD_FILES_UPLOAD_CHUNK_BYTES,
      THREAD_FILES_UPLOAD_CHUNK_BYTES * 2,
    ]);
    expect(calls.map(({ operation }) => operation.last)).toEqual([
      false,
      false,
      true,
    ]);
    expect(calls.map(({ operation }) => "refresh" in operation)).toEqual([
      false,
      false,
      true,
    ]);
    expect(calls.every(({ leases: held }) => held === 1)).toBe(true);
    const joined = calls
      .map(({ operation }) => atob(String(operation.content)))
      .join("");
    expect(joined.length).toBe(bytes.length);
    let mismatches = 0;
    for (let index = 0; index < bytes.length; index += 1)
      if (joined.charCodeAt(index) !== bytes[index]) mismatches += 1;
    expect(mismatches).toBe(0);

    // An empty file is one last chunk.
    calls = [];
    expect((await upload("empty.txt", new Uint8Array())).status).toBe(201);
    expect(calls).toMatchObject([
      { operation: { offset: 0, last: true, content: "" } },
    ]);

    // Over the bound, or a body that disagrees with its length, never starts.
    calls = [];
    const declaredTooLarge = await upload("big.bin", new Uint8Array(4), owner, {
      "content-length": String(25 * 1024 * 1024 + 1),
    });
    expect(declaredTooLarge.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses paths outside the checkout before they reach dxd", async () => {
    const escapes = [
      "../outside",
      "docs/../../outside",
      "/etc/passwd",
      ".git/config",
      "docs/.git/hooks/pre-commit",
      "docs\\..\\outside",
      ".dx-files-0123",
      "docs/",
      "",
    ];
    for (const path of escapes) {
      for (const body of [
        { action: "create", path, kind: "file" },
        { action: "delete", path },
        { action: "move", from: "README.md", to: path },
        { action: "copy", from: path, to: "copied" },
      ]) {
        const response = await write(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await errorCode(response)).toBe("THREAD_FILES_INVALID_REQUEST");
      }
    }
    for (const path of [
      "..%2Foutside",
      "%2E%2E/outside",
      "docs/%2e%2e/%2e%2e/outside",
      ".git%2Fconfig",
      "%2Fetc%2Fpasswd",
    ]) {
      const response = await upload(path, new Uint8Array([1]));
      expect([400, 404], path).toContain(response.status);
    }
    expect(calls).toEqual([]);
    expect(await leases()).toBe(0);
  });

  it("answers dxd's refusals as errors, never success", async () => {
    // dxd refuses a symbolic link on the way (after resolving the real
    // path), and never replaces an existing entry.
    answer = (operation) => ({
      kind: operation.operation === "files.create" ? "conflict" : "invalid",
    });
    const conflict = await write({
      action: "create",
      path: "README.md",
      kind: "file",
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("THREAD_FILES_CONFLICT");
    const linked = await write({
      action: "move",
      from: "out/secret.txt",
      to: "stolen.txt",
    });
    expect(linked.status).toBe(400);
    expect(await errorCode(linked)).toBe("THREAD_FILES_INVALID_REQUEST");
    answer = () => ({ kind: "invalid" });
    expect((await upload("out/secret.txt", new Uint8Array([1]))).status).toBe(
      400,
    );
    expect(await leases()).toBe(0);
  });

  it("gives View members no writes, Contribute members every write, and outsiders nothing", async () => {
    expect((await share({ workspaceAccess: "view" })).status).toBe(200);
    for (const body of WRITES) {
      const response = await write(body, member);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("THREAD_READ_ONLY");
    }
    const viewerUpload = await upload("x.txt", new Uint8Array([1]), member);
    expect(viewerUpload.status).toBe(403);
    expect(await errorCode(viewerUpload)).toBe("THREAD_READ_ONLY");
    expect(calls).toEqual([]);

    expect((await write(WRITES[0], outsider)).status).toBe(404);
    expect((await upload("x.txt", new Uint8Array([1]), outsider)).status).toBe(
      404,
    );
    expect(calls).toEqual([]);

    expect(
      (
        await share({
          workspaceAccess: "contribute",
          contributeFor: "1h",
          skipMultiplayerConfirmation: true,
        })
      ).status,
    ).toBe(200);
    expect((await write(WRITES[0], member)).status).toBe(200);
    expect((await upload("x.txt", new Uint8Array([1]), member)).status).toBe(
      201,
    );
    expect(calls.map(({ operation }) => operation.operation)).toEqual([
      "files.create",
      "files.upload",
    ]);
  });

  it("refuses every write while the Thread is archived", async () => {
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    for (const body of WRITES) {
      const response = await write(body);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("THREAD_ARCHIVED");
    }
    expect((await upload("x.txt", new Uint8Array([1]))).status).toBe(409);
    expect(calls).toEqual([]);
  });
});
