import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { DXD_RELEASE } from "../../src/execution/dxd/protocol.js";
import type { Bindings } from "../../src/http/types.js";

/**
 * R2 and the Thread execution object as Core's file features meet them in a
 * deployed stage: an emulator of R2's S3 API backed by the test's R2 bucket,
 * so presigned transfers really move bytes, and a Thread whose stored daemon
 * authority admits one key, behind the real ingress forwarders.
 */

export const R2_ORIGIN = "https://testaccount.r2.cloudflarestorage.com";
export const R2_BUCKET = "dx-storage-test";
export const direct: Partial<Bindings> = {
  DX_ATTACHMENT_R2_ENDPOINT: `${R2_ORIGIN}/${R2_BUCKET}`,
  DX_ATTACHMENT_R2_CREDENTIALS: JSON.stringify({
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret",
  }),
};

export const DAEMON_KEY = "dxd_attachment-test-key-0123456789";

export const digest = (bytes: ArrayBuffer | Uint8Array) =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

/** Every request the emulated R2 receives, to prove where bytes went. */
export const r2Requests: Array<{ method: string; url: URL; signed: boolean }> =
  [];

export const xmlTag = (text: string, tag: string) =>
  [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  );

/** R2's S3 API, served from the test's R2 bucket. */
export const emulateR2 = async (request: Request): Promise<Response> => {
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

export const realFetch = globalThis.fetch;
export const routeNetwork = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === R2_ORIGIN
      ? emulateR2(request)
      : realFetch(input, init);
  });

export const pngBytes = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < size; index++) bytes[index] = index % 251;
  return bytes;
};

export const seedDaemonAuthority = async (
  threadId: string,
  ownerId: string,
  key = DAEMON_KEY,
) => {
  const keyId = `key-${threadId}`;
  // The key's D1 row, which Core confirms behind the stored hash.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO apikey
       (id, configId, referenceId, key, enabled, createdAt, updatedAt)
     VALUES (?, 'daemon-keys', ?, ?, 1, ?, ?)`,
  )
    .bind(keyId, ownerId, `hashed-${keyId}`, Date.now(), Date.now())
    .run();
  const stub = env.THREAD_EXECUTION.getByName(threadId);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("daemon-authority", {
      threadId,
      generation: 1,
      apiKeyId: keyId,
      apiKeyHash: createHash("sha256").update(key).digest("hex"),
      release: DXD_RELEASE,
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
export const wokenNamespace = (bindings: Partial<Bindings>) =>
  ({
    idFromName: (name: string) => env.THREAD_EXECUTION.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: async (request: Request) => {
        // A body read outside the object is I/O it may not touch; the
        // ingress Worker sends a buffered body too.
        const body =
          request.body === null ? undefined : await request.arrayBuffer();
        return runInDurableObject(
          env.THREAD_EXECUTION.get(id),
          async (instance, state) => {
            const Woken = instance.constructor as new (
              state: DurableObjectState,
              bindings: typeof env,
            ) => typeof instance;
            const woken = new Woken(state, { ...env, ...bindings });
            await state.blockConcurrencyWhile(async () => {});
            const response = await woken.fetch(
              new Request(request.url, {
                method: request.method,
                headers: request.headers,
                ...(body === undefined ? {} : { body }),
              }),
            );
            return new Response(await response.arrayBuffer(), response);
          },
        );
      },
    }),
  }) as unknown as DurableObjectNamespace;
