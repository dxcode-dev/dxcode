import { env } from "cloudflare:test";
import {
  type CreateThreadStorageFileResponse,
  THREAD_STORAGE_PART_BYTES,
  THREAD_STORAGE_TEMPORARY_TTL_MS,
  type ThreadStorageFile,
  type ThreadStorageListResponse,
} from "@dx/api";
import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { purgeDeletedThread } from "../../src/thread-deletion/cleanup.js";
import { createThreadStorageTools } from "../../src/thread-storage/agent-tools.js";
import { threadStorageRoutes } from "../../src/thread-storage/routes.js";
import {
  findThreadStorageFile,
  sweepThreadStorage,
} from "../../src/thread-storage/store.js";
import { forwardDaemonStorage } from "../../src/threads/daemon-ingress.js";
import { project, thread } from "./fixtures.js";
import {
  DAEMON_KEY,
  digest,
  direct,
  pngBytes,
  R2_ORIGIN,
  r2Requests,
  routeNetwork,
  seedDaemonAuthority,
  wokenNamespace,
} from "./r2-harness.js";
import { runRepositories } from "./runtime.js";

/**
 * Thread storage through workerd's real D1, R2, and Thread execution object.
 *
 * Ways it could fail, each covered below:
 * - a browser session, another Thread's key, or a revoked key writes a file;
 * - a key for one Thread writes into another Thread's storage;
 * - the bytes pass through Core instead of going straight to R2;
 * - a renamed file poses as an image, or HTML renders inline;
 * - an unfinished, missized, or twice-completed upload becomes readable;
 * - a reader needs the Orb: the file is unreadable once the Thread is
 *   archived or its execution object is gone;
 * - someone who cannot read the Thread reads its file, including through a
 *   URL that names a Thread they can read but the file does not belong to;
 * - another of the owner's Threads cannot fetch the file, or a stranger's
 *   Thread can;
 * - deleting the Thread leaves rows or bytes behind;
 * - abandoned uploads pile up;
 * - a temporary file stays readable, or listed, past its three hours, or
 *   its bytes outlive it; the sweep removes a lasting file;
 * - a thread file tool reaches a stranger's Thread, or a private Thread from
 *   a shared one; a guest that names a file it did not stage gets that file
 *   deleted or shared.
 */

const owner = Schema.decodeSync(UserId)("storage-owner");
const stranger = Schema.decodeSync(UserId)("storage-stranger");
const projectEntity = project(
  "prj_00000000-0000-4000-8000-000000000b01",
  owner,
  "Storage",
);
const threadEntity = thread(
  "thr_00000000-0000-4000-8000-000000000b02",
  projectEntity.id,
  owner,
);
const siblingThread = thread(
  "thr_00000000-0000-4000-8000-000000000b03",
  projectEntity.id,
  owner,
);
const strangerProject = project(
  "prj_00000000-0000-4000-8000-000000000b04",
  stranger,
  "Stranger",
);
const strangerThread = thread(
  "thr_00000000-0000-4000-8000-000000000b05",
  strangerProject.id,
  stranger,
);
const SIBLING_KEY = "dxd_storage-sibling-key-0123456789";
const STRANGER_KEY = "dxd_storage-stranger-key-0123456789";
const ORIGIN = "https://dx.example";
const coreBindings: Partial<Bindings> = { ...direct, DX_AUTH_URL: ORIGIN };

afterEach(() => vi.restoreAllMocks());

/** The browser: a session for `userId` against Core's mounted routes. */
const browser = (userId: UserId, bindings: Partial<Bindings> = {}) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", Schema.decodeSync(Principal)({ userId }));
    await next();
  });
  routes.use("/v1/threads/:threadId/storage/*", authorizeThread);
  routes.route("/v1/threads", threadStorageRoutes);
  return (path: string, init?: RequestInit) =>
    routes.request(`https://dx.test${path}`, init, {
      DB: env.DB,
      DX_STORAGE: env.DX_STORAGE,
      DX_RUNTIME_MODE: "deployed",
      ...coreBindings,
      // Reads never reach the Thread's execution object or its Orb.
      THREAD_EXECUTION: undefined,
      ...bindings,
    });
};

/** The guest's dxd: a request to the daemon ingress with a Thread key. */
const daemon = (
  threadId: string,
  path: string,
  init: RequestInit = {},
  key = DAEMON_KEY,
) =>
  forwardDaemonStorage(
    new Request(`https://dxd.test/v1/dxd/${threadId}/storage${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...init.headers },
    }),
    wokenNamespace(coreBindings),
    threadId,
    path,
  );

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** What `dxd files put` does: create, PUT each part where told, complete. */
const put = async (
  threadId: string,
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  key = DAEMON_KEY,
  temporary = false,
) => {
  const created = await daemon(
    threadId,
    "",
    json({
      name,
      mimeType,
      size: bytes.byteLength,
      ...(temporary ? { temporary: true } : {}),
    }),
    key,
  );
  expect(created.status).toBe(201);
  const response = (await created.json()) as CreateThreadStorageFileResponse;
  const parts = [];
  for (const target of response.parts) {
    const start = (target.partNumber - 1) * response.partSize;
    const body = bytes.slice(start, start + response.partSize);
    const stored = await fetch(target.url, {
      method: "PUT",
      body,
      headers: { "x-test-signed-length": String(body.byteLength) },
    });
    expect(stored.status).toBe(200);
    parts.push({
      partNumber: target.partNumber,
      etag: stored.headers.get("etag") ?? "",
    });
    await stored.arrayBuffer();
  }
  const completed = await daemon(
    threadId,
    `/${response.id}/complete`,
    json({ parts }),
    key,
  );
  expect(completed.status).toBe(200);
  return {
    created: response,
    file: (await completed.json()) as ThreadStorageFile,
  };
};

const seedThreads = () =>
  runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(projectEntity);
      yield* projects.insert(strangerProject);
      const threads = yield* ThreadRepository;
      yield* threads.insert(threadEntity);
      yield* threads.insert(siblingThread);
      yield* threads.insert(strangerThread);
    }),
  );

const rowCount = async (threadId: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM thread_storage_files WHERE thread_id = ?",
    )
      .bind(threadId)
      .first<{ count: number }>()
  )?.count;

describe("Thread storage", () => {
  it("takes files only from the Thread's own Orb and serves them to its readers without it", async () => {
    routeNetwork();
    await seedThreads();
    await seedDaemonAuthority(threadEntity.id, owner);
    const asOwner = browser(owner);
    const asStranger = browser(stranger);

    // Two parts. The declared type is wrong; the bytes prove a PNG.
    const bytes = pngBytes(THREAD_STORAGE_PART_BYTES + 3);
    r2Requests.length = 0;
    const { created, file } = await put(
      threadEntity.id,
      bytes,
      "../login shot.png",
      "text/plain",
    );
    expect(created.parts).toHaveLength(2);
    for (const target of created.parts) {
      const url = new URL(target.url);
      expect(url.origin).toBe(R2_ORIGIN);
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-length;host",
      );
    }
    // The parts went to R2; Core never had a part route to receive them.
    expect(
      r2Requests
        .filter(({ method }) => method === "PUT")
        .map(({ url }) => url.searchParams.get("partNumber")),
    ).toEqual(["1", "2"]);
    expect(file).toMatchObject({
      threadId: threadEntity.id,
      name: "_login shot.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      url: `${ORIGIN}/v1/threads/${threadEntity.id}/storage/${file.id}/_login%20shot.png`,
    });
    expect(file.id).toMatch(/^tsf_[0-9a-f]{32}$/);
    expect(
      await env.DX_STORAGE.head(`thread-storage/${threadEntity.id}/${file.id}`),
    ).not.toBeNull();

    // Only this Thread's key writes here: no key, a wrong key, or another
    // Thread's key is refused before anything is recorded.
    const before = await rowCount(threadEntity.id);
    const wrongKey = await daemon(
      threadEntity.id,
      "",
      json({ name: "x.png", mimeType: "image/png", size: 1 }),
      "dxd_some-other-thread-key-0123456789",
    );
    expect(wrongKey.status).toBe(401);
    await wrongKey.arrayBuffer();
    const unauthenticated = await forwardDaemonStorage(
      new Request(`https://dxd.test/v1/dxd/${threadEntity.id}/storage`, {
        method: "POST",
        body: "{}",
      }),
      wokenNamespace(coreBindings),
      threadEntity.id,
      "",
    );
    expect(unauthenticated.status).toBe(401);
    await seedDaemonAuthority(siblingThread.id, owner, SIBLING_KEY);
    const crossWrite = await daemon(
      siblingThread.id,
      "",
      json({ name: "x.png", mimeType: "image/png", size: 1 }),
      DAEMON_KEY,
    );
    expect(crossWrite.status).toBe(401);
    await crossWrite.arrayBuffer();
    expect(await rowCount(threadEntity.id)).toBe(before);
    expect(await rowCount(siblingThread.id)).toBe(0);
    // A browser session, even the owner's, has no write route.
    const sessionWrite = await asOwner(
      `/v1/threads/${threadEntity.id}/storage`,
      json({ name: "x.png", mimeType: "image/png", size: 1 }),
    );
    expect(sessionWrite.status).toBe(404);
    await sessionWrite.arrayBuffer();

    // A file that claims to be an image but is not one downloads as bytes.
    const { file: fake } = await put(
      threadEntity.id,
      new TextEncoder().encode("<script>alert(1)</script>"),
      "fake.png",
      "image/png",
    );
    expect(fake.mimeType).toBe("application/octet-stream");

    // The owner opens the URL with a session: a presigned R2 GET that shows
    // the image inline and returns the uploaded bytes.
    const read = await asOwner(new URL(file.url).pathname);
    expect(read.status).toBe(302);
    const location = new URL(read.headers.get("location") ?? "");
    expect(location.origin).toBe(R2_ORIGIN);
    expect(location.searchParams.get("response-content-type")).toBe(
      "image/png",
    );
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^inline;/,
    );
    expect(digest(await (await fetch(location)).arrayBuffer())).toBe(
      digest(bytes),
    );
    const download = await asOwner(
      `/v1/threads/${threadEntity.id}/storage/${file.id}?download=1`,
    );
    expect(
      new URL(download.headers.get("location") ?? "").searchParams.get(
        "response-content-disposition",
      ),
    ).toMatch(/^attachment;/);
    const fakeRead = await asOwner(new URL(fake.url).pathname);
    const fakeLocation = new URL(fakeRead.headers.get("location") ?? "");
    expect(fakeLocation.searchParams.get("response-content-type")).toBe(
      "application/octet-stream",
    );
    expect(
      fakeLocation.searchParams.get("response-content-disposition"),
    ).toMatch(/^attachment;/);

    // Nobody who cannot read the Thread reads its file, and a Thread the
    // reader can open does not lend its name to another Thread's file.
    const strangerRead = await asStranger(new URL(file.url).pathname);
    expect(strangerRead.status).toBe(404);
    await strangerRead.arrayBuffer();
    const borrowed = await asOwner(
      `/v1/threads/${siblingThread.id}/storage/${file.id}/x.png`,
    );
    expect(borrowed.status).toBe(404);
    await borrowed.arrayBuffer();

    // The listing names the finished files, newest first.
    const listed = await asOwner(`/v1/threads/${threadEntity.id}/storage`);
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as ThreadStorageListResponse).files.map(
        ({ id }) => id,
      ),
    ).toEqual([fake.id, file.id]);

    // An unfinished upload is nobody's file yet.
    const pending = (await (
      await daemon(
        threadEntity.id,
        "",
        json({ name: "pending.png", mimeType: "image/png", size: 10 }),
      )
    ).json()) as CreateThreadStorageFileResponse;
    const pendingRead = await asOwner(
      `/v1/threads/${threadEntity.id}/storage/${pending.id}/pending.png`,
    );
    expect(pendingRead.status).toBe(404);
    await pendingRead.arrayBuffer();
    const pendingDescribe = await daemon(threadEntity.id, `/${pending.id}`, {});
    expect(pendingDescribe.status).toBe(404);
    await pendingDescribe.arrayBuffer();
    // Parts that do not cover the file, or a file of another size than
    // declared, never become readable.
    const incomplete = await daemon(
      threadEntity.id,
      `/${pending.id}/complete`,
      json({ parts: [{ partNumber: 2, etag: "x" }] }),
    );
    expect(incomplete.status).toBe(400);
    await incomplete.arrayBuffer();
    const short = await fetch(pending.parts[0]?.url ?? "", {
      method: "PUT",
      body: new Uint8Array(10),
    });
    const etag = short.headers.get("etag") ?? "";
    await short.arrayBuffer();
    await env.DB.prepare(
      "UPDATE thread_storage_files SET size = 11 WHERE id = ?",
    )
      .bind(pending.id)
      .run();
    const missized = await daemon(
      threadEntity.id,
      `/${pending.id}/complete`,
      json({ parts: [{ partNumber: 1, etag }] }),
    );
    expect(missized.status).toBe(400);
    await missized.arrayBuffer();
    expect(
      await env.DB.prepare("SELECT 1 FROM thread_storage_files WHERE id = ?")
        .bind(pending.id)
        .first(),
    ).toBeNull();
    // A finished file cannot be completed again.
    const again = await daemon(
      threadEntity.id,
      `/${file.id}/complete`,
      json({ parts: [{ partNumber: 1, etag: "x" }] }),
    );
    expect(again.status).toBe(404);
    await again.arrayBuffer();
    // A file larger than storage holds is refused up front.
    const huge = await daemon(
      threadEntity.id,
      "",
      json({ name: "huge.bin", mimeType: "", size: 501 * 1024 * 1024 }),
    );
    expect(huge.status).toBe(400);
    await huge.arrayBuffer();

    // Another of the owner's Threads fetches the file from its own Orb; a
    // stranger's Thread cannot.
    const fetched = await daemon(
      siblingThread.id,
      `/${file.id}`,
      {},
      SIBLING_KEY,
    );
    expect(fetched.status).toBe(200);
    const descriptor = (await fetched.json()) as {
      url: string;
      name: string;
      size: number;
    };
    expect(descriptor).toMatchObject({
      name: file.name,
      size: bytes.byteLength,
    });
    expect(digest(await (await fetch(descriptor.url)).arrayBuffer())).toBe(
      digest(bytes),
    );
    await seedDaemonAuthority(strangerThread.id, stranger, STRANGER_KEY);
    const strangerFetch = await daemon(
      strangerThread.id,
      `/${file.id}`,
      {},
      STRANGER_KEY,
    );
    expect(strangerFetch.status).toBe(404);
    await strangerFetch.arrayBuffer();

    // The Orb is gone: the Thread is archived and has no execution object.
    // Its readers still open the file.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadEntity.id)
      .run();
    const archived = await asOwner(new URL(file.url).pathname);
    expect(archived.status).toBe(302);
    expect(
      digest(
        await (
          await fetch(archived.headers.get("location") ?? "")
        ).arrayBuffer(),
      ),
    ).toBe(digest(bytes));
    // An archived Thread's key writes nothing more.
    const archivedWrite = await daemon(
      threadEntity.id,
      "",
      json({ name: "late.png", mimeType: "image/png", size: 1 }),
    );
    expect(archivedWrite.status).toBe(401);
    await archivedWrite.arrayBuffer();
  });

  it("deletes a Thread's files with the Thread", async () => {
    routeNetwork();
    await seedThreads();
    await seedDaemonAuthority(threadEntity.id, owner);
    const { file } = await put(
      threadEntity.id,
      pngBytes(64),
      "doomed.png",
      "image/png",
    );
    expect(await rowCount(threadEntity.id)).toBeGreaterThan(0);
    const result = await purgeDeletedThread(
      { DB: env.DB, DX_STORAGE: env.DX_STORAGE },
      {
        eraseAgentHistory: async () => undefined,
        destroySandbox: async () => undefined,
      },
      threadEntity.id,
      owner,
    );
    expect(result.failedSteps).not.toContain("storage");
    expect(await rowCount(threadEntity.id)).toBe(0);
    expect(
      await env.DX_STORAGE.head(`thread-storage/${threadEntity.id}/${file.id}`),
    ).toBeNull();
  });

  it("serves a temporary file for three hours, then refuses and sweeps it", async () => {
    routeNetwork();
    await seedThreads();
    await seedDaemonAuthority(threadEntity.id, owner);
    await seedDaemonAuthority(siblingThread.id, owner, SIBLING_KEY);
    const asOwner = browser(owner);
    const { file: lasting } = await put(
      threadEntity.id,
      pngBytes(48),
      "kept.png",
      "image/png",
    );
    const startedAt = Date.now();
    const { file: temporary } = await put(
      threadEntity.id,
      pngBytes(64),
      "handoff.png",
      "image/png",
      DAEMON_KEY,
      true,
    );
    expect(lasting.expiresAt).toBeUndefined();
    expect(temporary.expiresAt).toBeGreaterThanOrEqual(
      startedAt + THREAD_STORAGE_TEMPORARY_TTL_MS,
    );
    expect(temporary.expiresAt).toBeLessThanOrEqual(
      Date.now() + THREAD_STORAGE_TEMPORARY_TTL_MS,
    );

    // Within its three hours: the owner and another of their Threads read
    // it, but the Thread's file list, which the transcript uses, omits it.
    const read = await asOwner(new URL(temporary.url).pathname);
    expect(read.status).toBe(302);
    await read.arrayBuffer();
    const fetched = await daemon(
      siblingThread.id,
      `/${temporary.id}`,
      { method: "GET" },
      SIBLING_KEY,
    );
    expect(fetched.status).toBe(200);
    await fetched.arrayBuffer();
    const listed = (await (
      await asOwner(`/v1/threads/${threadEntity.id}/storage`)
    ).json()) as ThreadStorageListResponse;
    expect(listed.files.map(({ id }) => id)).toEqual([lasting.id]);

    // Near its end, a cached redirect lasts no longer than the file.
    await env.DB.prepare(
      "UPDATE thread_storage_files SET expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() + 5_000, temporary.id)
      .run();
    const late = await asOwner(new URL(temporary.url).pathname);
    expect(late.status).toBe(302);
    expect(late.headers.get("cache-control")).toMatch(
      /^private, max-age=[0-5]$/,
    );
    await late.arrayBuffer();

    // Three hours later the same reads are refused.
    await env.DB.prepare(
      "UPDATE thread_storage_files SET expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 1, temporary.id)
      .run();
    const expired = await asOwner(new URL(temporary.url).pathname);
    expect(expired.status).toBe(404);
    await expired.arrayBuffer();
    const expiredFetch = await daemon(
      siblingThread.id,
      `/${temporary.id}`,
      { method: "GET" },
      SIBLING_KEY,
    );
    expect(expiredFetch.status).toBe(404);
    await expiredFetch.arrayBuffer();

    // An upload the sibling abandoned and never followed with another.
    const abandoned = (await (
      await daemon(
        siblingThread.id,
        "",
        json({ name: "old.png", mimeType: "image/png", size: 5 }),
        SIBLING_KEY,
      )
    ).json()) as CreateThreadStorageFileResponse;
    await env.DB.prepare(
      "UPDATE thread_storage_files SET created_at = 0 WHERE id = ?",
    )
      .bind(abandoned.id)
      .run();

    // The scheduled sweep deletes both, rows and bytes, and nothing else.
    expect(
      await sweepThreadStorage(
        { DB: env.DB, DX_STORAGE: env.DX_STORAGE },
        undefined,
        Date.now(),
      ),
    ).toBe(2);
    expect(await findThreadStorageFile(env.DB, temporary.id)).toBeNull();
    expect(await findThreadStorageFile(env.DB, abandoned.id)).toBeNull();
    expect(
      await env.DX_STORAGE.head(
        `thread-storage/${threadEntity.id}/${temporary.id}`,
      ),
    ).toBeNull();
    expect(await findThreadStorageFile(env.DB, lasting.id)).not.toBeNull();
    expect(
      await env.DX_STORAGE.head(
        `thread-storage/${threadEntity.id}/${lasting.id}`,
      ),
    ).not.toBeNull();
  });

  it("clears a Thread's abandoned uploads when it starts another", async () => {
    routeNetwork();
    await seedThreads();
    await seedDaemonAuthority(siblingThread.id, owner, SIBLING_KEY);
    const abandoned = (await (
      await daemon(
        siblingThread.id,
        "",
        json({ name: "old.png", mimeType: "image/png", size: 5 }),
        SIBLING_KEY,
      )
    ).json()) as CreateThreadStorageFileResponse;
    await env.DB.prepare(
      "UPDATE thread_storage_files SET created_at = 0 WHERE id = ?",
    )
      .bind(abandoned.id)
      .run();
    await put(
      siblingThread.id,
      pngBytes(32),
      "new.png",
      "image/png",
      SIBLING_KEY,
    );
    await vi.waitFor(async () =>
      expect(
        await env.DB.prepare("SELECT 1 FROM thread_storage_files WHERE id = ?")
          .bind(abandoned.id)
          .first(),
      ).toBeNull(),
    );
  });

  it("moves files only between the owner's reachable Threads, and only files the source staged", async () => {
    await seedThreads();
    const now = Date.now();
    // A stranger's file, and a lasting file of the owner's source Thread:
    // a guest that names either must not get it deleted or shared.
    const seedFile = async (threadId: string, id: string) => {
      const key = `thread-storage/${threadId}/${id}`;
      await env.DB.prepare(
        `INSERT INTO thread_storage_files
           (id, thread_id, object_key, name, mime_type, size, state, created_at)
         VALUES (?, ?, ?, 'kept.txt', 'text/plain', 4, 'ready', ?)`,
      )
        .bind(id, threadId, key, now)
        .run();
      await env.DX_STORAGE.put(key, "kept");
      return key;
    };
    const victim = `tsf_${"a".repeat(32)}`;
    const lasting = `tsf_${"b".repeat(32)}`;
    const victimKey = await seedFile(strangerThread.id, victim);
    const lastingKey = await seedFile(siblingThread.id, lasting);

    // Each Thread's daemon, as the execution object relays it: the source
    // answers an export with whatever ID it likes.
    let forged = victim;
    const transfers: Array<{ thread: string; operation: string }> = [];
    const daemons = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as {
            operation: string;
            files: Array<{ path: string }>;
          };
          transfers.push({ thread: name, operation: body.operation });
          return Response.json(
            body.operation === "storage.export"
              ? {
                  kind: "exported",
                  files: body.files.map(() => ({
                    kind: "stored",
                    id: forged,
                    size: 4,
                    mode: 0o644,
                  })),
                }
              : {
                  kind: "imported",
                  files: body.files.map(({ path }) => ({
                    kind: "written",
                    path,
                    size: 4,
                  })),
                },
          );
        },
      }),
    } as unknown as DurableObjectNamespace;
    const tools = Object.fromEntries(
      createThreadStorageTools(threadEntity.id, () => ({
        db: env.DB,
        bindings: {
          ...coreBindings,
          DB: env.DB,
          DX_STORAGE: env.DX_STORAGE,
          THREAD_EXECUTION: daemons,
        } as Bindings,
      })).map((tool) => [tool.name, tool]),
    );
    const call = async (name: string, data: Record<string, unknown>) =>
      (
        (await (
          tools[name] as { run: (input: unknown) => Promise<unknown> }
        ).run({ data, toolCallId: crypto.randomUUID() })) as {
          output: Record<string, unknown>;
        }
      ).output;

    // A stranger's Thread is not found, and its workspace is never asked.
    await expect(
      call("download_thread_file", {
        thread: strangerThread.id,
        path: "kept.txt",
      }),
    ).rejects.toThrow(/not found among this Thread owner's Threads/);
    expect(transfers).toEqual([]);

    // A forged export: neither file is written, deleted, or shared.
    for (const id of [victim, lasting]) {
      forged = id;
      transfers.length = 0;
      await expect(
        call("download_thread_file", {
          thread: siblingThread.id,
          path: "kept.txt",
        }),
      ).rejects.toThrow(/named a file it did not store/);
      expect(transfers).toEqual([
        { thread: siblingThread.id, operation: "storage.export" },
      ]);
      const shared = await call("thread_file_url", {
        thread: siblingThread.id,
        paths: ["kept.txt"],
      });
      expect(shared.files).toEqual([
        {
          path: "kept.txt",
          error: "failed: the workspace named a file it did not store",
        },
      ]);
    }
    for (const [id, key] of [
      [victim, victimKey],
      [lasting, lastingKey],
    ] as const) {
      expect(await findThreadStorageFile(env.DB, id)).not.toBeNull();
      expect(await env.DX_STORAGE.get(key)).not.toBeNull();
    }

    // Shared, the calling Thread reaches only its family: the owner's other
    // Thread until it becomes a child.
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view' WHERE id = ?",
    )
      .bind(threadEntity.id)
      .run();
    transfers.length = 0;
    await expect(
      call("upload_thread_file", { thread: siblingThread.id, path: "a.txt" }),
    ).rejects.toThrow(/not reachable from this shared Thread/);
    expect(transfers).toEqual([]);
    await env.DB.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?")
      .bind(threadEntity.id, siblingThread.id)
      .run();
    await expect(
      call("upload_thread_file", { thread: siblingThread.id, path: "a.txt" }),
    ).rejects.toThrow(/named a file it did not store/);
    expect(transfers).toEqual([
      { thread: threadEntity.id, operation: "storage.export" },
    ]);
  });
});
