import { env } from "cloudflare:test";
import {
  type CreateThreadStorageFileResponse,
  THREAD_STORAGE_PART_BYTES,
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
import { threadStorageRoutes } from "../../src/thread-storage/routes.js";
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
 * - abandoned uploads pile up.
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
) => {
  const created = await daemon(
    threadId,
    "",
    json({ name, mimeType, size: bytes.byteLength }),
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
});
