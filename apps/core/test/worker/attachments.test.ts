import { createHash } from "node:crypto";
import {
  ATTACHMENT_PART_BYTES,
  type AttachmentData,
  type CreateAttachmentResponse,
  formatMessageAttachments,
  parseMessageAttachments,
} from "@dx/api";
import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitMessageAttachments,
  MessageAttachmentsRejected,
  resolveMessageAttachments,
} from "../../src/attachments/message.js";
import { attachmentRoutes } from "../../src/attachments/routes.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { forwardDaemonAttachment } from "../../src/threads/daemon-ingress.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Attachments through workerd's real D1, R2, and Thread execution object.
 * In a deployed stage Core only authorizes and signs: the browser PUTs parts
 * to presigned R2 URLs and reads, like the guest's `dxd files get`, follow a
 * presigned GET. An emulator of R2's S3 API backed by the same R2 bucket
 * stands in for storage, so every byte below goes "browser" ⇄ "R2" and the
 * test can see that none passes through Core.
 */

const R2_ORIGIN = "https://testaccount.r2.cloudflarestorage.com";
const R2_BUCKET = "dx-storage-test";
const direct: Partial<Bindings> = {
  DX_ATTACHMENT_R2_ENDPOINT: `${R2_ORIGIN}/${R2_BUCKET}`,
  DX_ATTACHMENT_R2_CREDENTIALS: JSON.stringify({
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret",
  }),
};

const owner = Schema.decodeSync(UserId)("attachment-owner");
const stranger = Schema.decodeSync(UserId)("attachment-stranger");
const projectEntity = project(
  "prj_00000000-0000-4000-8000-000000000a01",
  owner,
  "Attachments",
);
const threadEntity = thread(
  "thr_00000000-0000-4000-8000-000000000a02",
  projectEntity.id,
  owner,
);
const otherThread = thread(
  "thr_00000000-0000-4000-8000-000000000a03",
  projectEntity.id,
  owner,
);
const strangerProject = project(
  "prj_00000000-0000-4000-8000-000000000a04",
  stranger,
  "Stranger",
);
const strangerThread = thread(
  "thr_00000000-0000-4000-8000-000000000a05",
  strangerProject.id,
  stranger,
);
const DAEMON_KEY = "dxd_attachment-test-key-0123456789";

const digest = (bytes: ArrayBuffer | Uint8Array) =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

/** Every request the emulated R2 receives, to prove where bytes went. */
const r2Requests: Array<{ method: string; url: URL; signed: boolean }> = [];
const coreRequests: string[] = [];

const xmlTag = (text: string, tag: string) =>
  [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  );

/** R2's S3 API, served from the test's R2 bucket. */
const emulateR2 = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const signed =
    url.searchParams.has("X-Amz-Signature") ||
    (request.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256");
  r2Requests.push({ method: request.method, url, signed });
  if (!signed) return new Response("<Error>unsigned</Error>", { status: 403 });
  const prefix = `/${R2_BUCKET}/`;
  if (!url.pathname.startsWith(prefix))
    return new Response(null, { status: 404 });
  const key = url.pathname
    .slice(prefix.length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const uploadId = url.searchParams.get("uploadId");
  if (request.method === "POST" && url.searchParams.has("uploads")) {
    const upload = await env.DX_STORAGE.createMultipartUpload(key);
    return new Response(
      `<InitiateMultipartUploadResult><UploadId>${upload.uploadId}</UploadId></InitiateMultipartUploadResult>`,
    );
  }
  if (request.method === "PUT" && uploadId !== null) {
    const body = new Uint8Array(await request.arrayBuffer());
    // The URL signs the part's length: R2 refuses any other size.
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    const length = request.headers.get("x-test-signed-length");
    if (
      signedHeaders.split(";").includes("content-length") &&
      length !== null &&
      Number(length) !== body.byteLength
    )
      return new Response("<Error>SignatureDoesNotMatch</Error>", {
        status: 403,
      });
    const part = await env.DX_STORAGE.resumeMultipartUpload(
      key,
      uploadId,
    ).uploadPart(Number(url.searchParams.get("partNumber")), body);
    return new Response(null, { headers: { etag: `"${part.etag}"` } });
  }
  if (request.method === "POST" && uploadId !== null) {
    const text = await request.text();
    const numbers = xmlTag(text, "PartNumber").map(Number);
    const etags = xmlTag(text, "ETag").map((etag) =>
      etag.replaceAll("&quot;", "").replaceAll('"', ""),
    );
    await env.DX_STORAGE.resumeMultipartUpload(key, uploadId).complete(
      numbers.map((partNumber, index) => ({
        partNumber,
        etag: etags[index] ?? "",
      })),
    );
    return new Response("<CompleteMultipartUploadResult/>");
  }
  if (request.method === "DELETE" && uploadId !== null) {
    await env.DX_STORAGE.resumeMultipartUpload(key, uploadId).abort();
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET") {
    const object = await env.DX_STORAGE.get(key);
    if (object === null) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type":
          url.searchParams.get("response-content-type") ??
          "application/octet-stream",
        "content-disposition":
          url.searchParams.get("response-content-disposition") ?? "",
      },
    });
  }
  return new Response(null, { status: 400 });
};

const realFetch = globalThis.fetch;
const routeNetwork = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === R2_ORIGIN
      ? emulateR2(request)
      : realFetch(input, init);
  });

afterEach(() => vi.restoreAllMocks());

const app = (userId: UserId, bindings: Partial<Bindings> = direct) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    coreRequests.push(`${context.req.method} ${context.req.path}`);
    context.set("principal", Schema.decodeSync(Principal)({ userId }));
    await next();
  });
  routes.route("/v1/attachments", attachmentRoutes);
  return (path: string, init?: RequestInit) =>
    routes.request(`https://dx.test${path}`, init, {
      DB: env.DB,
      DX_STORAGE: env.DX_STORAGE,
      DX_RUNTIME_MODE: "deployed",
      ...bindings,
    });
};

const pngBytes = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < size; index++) bytes[index] = index % 251;
  return bytes;
};

/** What the browser does: create, PUT each part where told, complete. */
const upload = async (
  request: ReturnType<typeof app>,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
) => {
  const created = await request("/v1/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, mimeType, size: bytes.byteLength }),
  });
  expect(created.status).toBe(201);
  const response = (await created.json()) as CreateAttachmentResponse;
  const parts = [];
  for (const target of response.parts) {
    const start = (target.partNumber - 1) * response.partSize;
    const body = bytes.slice(start, start + response.partSize);
    const put = target.url.startsWith("/")
      ? await request(target.url, { method: "PUT", body })
      : await fetch(target.url, {
          method: "PUT",
          body,
          headers: { "x-test-signed-length": String(body.byteLength) },
        });
    expect(put.status).toBe(200);
    parts.push({
      partNumber: target.partNumber,
      etag: put.headers.get("etag") ?? "",
    });
    await put.arrayBuffer();
  }
  const completed = await request(`/v1/attachments/${response.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  expect(completed.status).toBe(200);
  return {
    created: response,
    data: (await completed.json()) as AttachmentData,
  };
};

const admit = (body: string, threadId: string, senderUserId: string) =>
  admitMessageAttachments(
    {
      DB: env.DB,
      DX_STORAGE: env.DX_STORAGE,
      DX_AUTH_URL: "https://dx.example",
      ...direct,
    },
    { threadId, senderUserId, body, requestUrl: "https://dx.test/v1" },
  );

const proposal = (attachment: AttachmentData) =>
  formatMessageAttachments([
    {
      id: attachment.id,
      name: "client-claimed-name.exe",
      mimeType: "text/html",
      size: 1,
      url: "https://evil.example/",
    },
  ]);

const seedDaemonAuthority = async (threadId: string, ownerId: string) => {
  const keyId = `key-${threadId}`;
  // The key's D1 row, which Core confirms behind the stored hash.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO apikey
       (id, configId, referenceId, key, enabled, createdAt, updatedAt)
     VALUES (?, 'daemon-keys', ?, 'hashed', 1, ?, ?)`,
  )
    .bind(keyId, ownerId, Date.now(), Date.now())
    .run();
  const stub = env.THREAD_EXECUTION.getByName(threadId);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("daemon-authority", {
      threadId,
      generation: 1,
      apiKeyId: keyId,
      apiKeyHash: createHash("sha256").update(DAEMON_KEY).digest("hex"),
      release: "0.10.0",
      protocolMajor: 2,
      terminalVersion: 1,
      workloadIdentityVersion: 1,
      runtimeProvider: "e2b",
      runtimeAssurance: "dx_dxd_channel_v1",
    });
  });
  return keyId;
};

/**
 * The ingress forwarder in front of a freshly constructed object on the
 * Thread's storage, which loads the stored authority as a woken one does.
 */
const wokenNamespace = (bindings: Partial<Bindings>) =>
  ({
    idFromName: (name: string) => env.THREAD_EXECUTION.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: (request: Request) =>
        runInDurableObject(
          env.THREAD_EXECUTION.get(id),
          async (instance, state) => {
            const Woken = instance.constructor as new (
              state: DurableObjectState,
              bindings: typeof env,
            ) => typeof instance;
            const woken = new Woken(state, { ...env, ...bindings });
            await state.blockConcurrencyWhile(async () => {});
            const response = await woken.fetch(request);
            return new Response(await response.arrayBuffer(), response);
          },
        ),
    }),
  }) as unknown as DurableObjectNamespace;

/** What `dxd files get` does first: ask Core with the Thread's key. */
const daemonDescribe = (
  threadId: string,
  id: string,
  key = DAEMON_KEY,
  bindings: Partial<Bindings> = direct,
) =>
  forwardDaemonAttachment(
    new Request(`https://dxd.test/v1/dxd/${threadId}/attachments/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    wokenNamespace(bindings),
    threadId,
    id,
  );

describe("message attachments", () => {
  it("moves bytes straight between the browser, R2, and the guest", async () => {
    routeNetwork();
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects.insert(projectEntity);
        yield* projects.insert(strangerProject);
        const threads = yield* ThreadRepository;
        yield* threads.insert(threadEntity);
        yield* threads.insert(otherThread);
        yield* threads.insert(strangerThread);
      }),
    );
    const asOwner = app(owner);
    const asStranger = app(stranger);

    // Two parts. The declared type is wrong; the bytes prove a PNG.
    const bytes = pngBytes(ATTACHMENT_PART_BYTES + 3);
    coreRequests.length = 0;
    r2Requests.length = 0;
    const { created, data: image } = await upload(
      asOwner,
      bytes,
      "../screen shot.png",
      "text/plain",
    );
    // Each part URL is a presigned R2 URL that signs the part's length.
    expect(created.parts).toHaveLength(2);
    for (const target of created.parts) {
      const url = new URL(target.url);
      expect(url.origin).toBe(R2_ORIGIN);
      expect(url.searchParams.get("partNumber")).toBe(
        String(target.partNumber),
      );
      expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-length;host",
      );
      expect(url.searchParams.get("X-Amz-Credential")).toMatch(
        /^test-access-key\//,
      );
    }
    // Core saw only the create and complete calls; the parts went to R2.
    expect(coreRequests).toEqual([
      "POST /v1/attachments",
      `POST /v1/attachments/${image.id}/complete`,
    ]);
    expect(
      r2Requests
        .filter(({ method }) => method === "PUT")
        .map(({ url }) => url.searchParams.get("partNumber")),
    ).toEqual(["1", "2"]);
    expect(image).toMatchObject({
      filename: "_screen shot.png",
      mimeType: "image/png",
      size: bytes.byteLength,
    });

    // A part of another size than the URL signed is refused by R2.
    const sized = await asOwner("/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "a.bin", mimeType: "", size: 10 }),
    });
    const sizedResponse = (await sized.json()) as CreateAttachmentResponse;
    const wrongSize = await fetch(sizedResponse.parts[0]?.url ?? "", {
      method: "PUT",
      body: new Uint8Array(9),
      headers: { "x-test-signed-length": "10" },
    });
    expect(wrongSize.status).toBe(403);
    await wrongSize.arrayBuffer();
    // Deployed stages have no Core part route.
    const proxied = await asOwner(
      `/v1/attachments/${sizedResponse.id}/parts/1`,
      { method: "PUT", body: new Uint8Array(10) },
    );
    expect(proxied.status).toBe(404);
    await proxied.arrayBuffer();

    // A file that claims to be an image but is not one downloads as bytes.
    const { data: fake } = await upload(
      asOwner,
      new TextEncoder().encode("<script>alert(1)</script>"),
      "fake.png",
      "image/png",
    );
    expect(fake.mimeType).toBe("application/octet-stream");

    // Reads redirect to a presigned R2 GET that sets type and disposition.
    const read = await asOwner(`/v1/attachments/${image.id}/x.png`);
    expect(read.status).toBe(302);
    const location = new URL(read.headers.get("location") ?? "");
    expect(location.origin).toBe(R2_ORIGIN);
    expect(location.searchParams.get("response-content-type")).toBe(
      "image/png",
    );
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^inline;/,
    );
    const fromR2 = await fetch(location);
    expect(digest(await fromR2.arrayBuffer())).toBe(digest(bytes));
    const fakeRead = await asOwner(`/v1/attachments/${fake.id}?download=1`);
    const fakeLocation = new URL(fakeRead.headers.get("location") ?? "");
    expect(fakeLocation.searchParams.get("response-content-type")).toBe(
      "application/octet-stream",
    );
    expect(
      fakeLocation.searchParams.get("response-content-disposition"),
    ).toMatch(/^attachment;/);
    // Before it is sent, only the uploader reads the file.
    const strangerRead = await asStranger(`/v1/attachments/${image.id}`);
    expect(strangerRead.status).toBe(404);
    await strangerRead.arrayBuffer();

    // Nobody else can send the owner's upload, and the check changes nothing.
    await expect(
      resolveMessageAttachments(
        { DB: env.DB },
        { senderUserId: stranger, body: proposal(image) },
      ),
    ).rejects.toBeInstanceOf(MessageAttachmentsRejected);
    await expect(
      admit(`Look ${proposal(image)}`, threadEntity.id, stranger),
    ).rejects.toBeInstanceOf(MessageAttachmentsRejected);

    // Admission records the Thread and rewrites the block from Core's
    // records; a retry yields the same body.
    const first = await admit(
      `Look at this\n\n${proposal(image)}`,
      threadEntity.id,
      owner,
    );
    const retry = await admit(
      `Look at this\n\n${proposal(image)}`,
      threadEntity.id,
      owner,
    );
    expect(retry.body).toBe(first.body);
    expect(parseMessageAttachments(first.body)).toEqual({
      text: "Look at this",
      attachments: [
        {
          id: image.id,
          name: image.filename,
          mimeType: "image/png",
          size: bytes.byteLength,
          url: `https://dx.example/v1/attachments/${image.id}/${encodeURIComponent(image.filename)}`,
        },
      ],
    });
    // A sent file can be sent again in another Thread, but not deleted.
    await admit(proposal(image), otherThread.id, owner);
    const deleted = await asOwner(`/v1/attachments/${image.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(409);
    await deleted.arrayBuffer();
    // A message without a block passes through; typed tags are removed.
    expect(
      (
        await admit(
          'plain <dx_attachment id="x" />text',
          threadEntity.id,
          owner,
        )
      ).body,
    ).toBe("plain text");

    // The guest asks Core with the Thread's key and gets a presigned URL.
    const keyId = await seedDaemonAuthority(threadEntity.id, owner);
    const described = await daemonDescribe(threadEntity.id, image.id);
    expect(described.status).toBe(200);
    const descriptor = (await described.json()) as {
      url: string;
      name: string;
      size: number;
    };
    expect(descriptor).toMatchObject({
      name: image.filename,
      size: bytes.byteLength,
    });
    expect(new URL(descriptor.url).origin).toBe(R2_ORIGIN);
    expect(digest(await (await fetch(descriptor.url)).arrayBuffer())).toBe(
      digest(bytes),
    );
    const wrongKey = await daemonDescribe(
      threadEntity.id,
      image.id,
      "dxd_some-other-thread-key-0123456789",
    );
    expect(wrongKey.status).toBe(401);
    // The key reads as the owner: their unsent uploads too.
    const unsent = await daemonDescribe(threadEntity.id, fake.id);
    expect(unsent.status).toBe(200);
    await unsent.arrayBuffer();
    // Nothing the owner cannot open: a stranger's upload, unsent or sent in
    // the stranger's own Thread.
    const { data: strangers } = await upload(
      asStranger,
      new TextEncoder().encode("stranger"),
      "stranger.txt",
      "text/plain",
    );
    expect((await daemonDescribe(threadEntity.id, strangers.id)).status).toBe(
      404,
    );
    await admit(proposal(strangers), strangerThread.id, stranger);
    expect((await daemonDescribe(threadEntity.id, strangers.id)).status).toBe(
      404,
    );
    // ...and the stranger cannot forward the owner's file into their Thread.
    await expect(
      admit(proposal(image), strangerThread.id, stranger),
    ).rejects.toBeInstanceOf(MessageAttachmentsRejected);
    // A revoked key fails although its hash is still stored.
    await env.DB.prepare("DELETE FROM apikey WHERE id = ?").bind(keyId).run();
    const revoked = await daemonDescribe(threadEntity.id, image.id);
    expect(revoked.status).toBe(401);
    await revoked.arrayBuffer();

    // An unsent upload can be deleted, and then its object is gone.
    const removed = await asOwner(`/v1/attachments/${fake.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(
      await env.DX_STORAGE.head(`attachments/${owner}/${fake.id}`),
    ).toBeNull();
  });

  it("purges an uploader's abandoned uploads when they start another", async () => {
    routeNetwork();
    const asOwner = app(owner);
    const { data: abandoned } = await upload(
      asOwner,
      new TextEncoder().encode("abandoned"),
      "old.txt",
      "text/plain",
    );
    await env.DB.prepare("UPDATE attachments SET created_at = 0 WHERE id = ?")
      .bind(abandoned.id)
      .run();
    await upload(
      asOwner,
      new TextEncoder().encode("fresh"),
      "new.txt",
      "text/plain",
    );
    await vi.waitFor(async () =>
      expect(
        await env.DB.prepare("SELECT 1 FROM attachments WHERE id = ?")
          .bind(abandoned.id)
          .first(),
      ).toBeNull(),
    );
    expect(
      await env.DX_STORAGE.head(`attachments/${owner}/${abandoned.id}`),
    ).toBeNull();
  });

  it("carries bytes through Core only where composition says so", async () => {
    const asLocal = app(owner, { DX_RUNTIME_MODE: "local" });
    const bytes = new TextEncoder().encode("local bytes");
    const { created, data } = await upload(
      asLocal,
      bytes,
      "local.txt",
      "text/plain",
    );
    expect(created.parts[0]?.url).toBe(`/v1/attachments/${data.id}/parts/1`);
    const read = await asLocal(`/v1/attachments/${data.id}`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("local bytes");
    // An Alchemy OAuth self-host records at deploy time that Core carries
    // the bytes.
    const asOauthSelfhost = app(owner, { DX_ATTACHMENT_TRANSFER: "core" });
    const oauthUpload = await upload(
      asOauthSelfhost,
      new TextEncoder().encode("oauth"),
      "oauth.txt",
      "text/plain",
    );
    expect(oauthUpload.created.parts[0]?.url).toBe(
      `/v1/attachments/${oauthUpload.data.id}/parts/1`,
    );
    // A deployed stage without signing credentials has no attachments.
    const unavailable = await app(owner, {})("/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "a", mimeType: "", size: 1 }),
    });
    expect(unavailable.status).toBe(503);
    await unavailable.arrayBuffer();
  });
});
