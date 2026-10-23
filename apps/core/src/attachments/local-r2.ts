import { AwsV4Signer } from "aws4fetch";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { parseAttachmentRange } from "./store.js";

/**
 * Local development's stand-in for R2's S3 API, so attachments take the one
 * path every stage takes: Core signs URLs, the browser PUTs parts and reads
 * straight from "R2", and dxd downloads from a presigned GET. Mounted at
 * `/dx-local-r2` (the endpoint's bucket name) and answering only when
 * `DX_RUNTIME_MODE` is `local`; it stores objects in the stage's own
 * `DX_STORAGE` binding, which Core reads, heads, and deletes directly.
 *
 * It implements only what dx uses: multipart create, presigned part PUT,
 * complete, abort, and presigned GET/HEAD with ranges and response-header
 * overrides. Presigned requests are verified like R2 does, including the
 * signed part length.
 */
export const LOCAL_R2_BUCKET = "dx-local-r2";

const xml = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });

const s3Error = (code: string, status: number) =>
  xml(`<Error><Code>${code}</Code></Error>`, status);

const localCredentials = (context: Context<AppEnv>) => {
  try {
    const parsed = JSON.parse(context.env.DX_ATTACHMENT_R2_CREDENTIALS ?? "");
    return typeof parsed?.accessKeyId === "string" &&
      typeof parsed?.secretAccessKey === "string"
      ? {
          accessKeyId: parsed.accessKeyId as string,
          secretAccessKey: parsed.secretAccessKey as string,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A presigned request is valid when re-signing its URL, at its own date and
 * with the length it actually carries, reproduces its signature.
 */
const verifyPresigned = async (
  request: Request,
  credentials: { accessKeyId: string; secretAccessKey: string },
  bodyLength: number | undefined,
) => {
  const url = new URL(request.url);
  const signature = url.searchParams.get("X-Amz-Signature");
  const date = url.searchParams.get("X-Amz-Date");
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  if (
    signature === null ||
    date === null ||
    !Number.isFinite(expires) ||
    !credential.startsWith(`${credentials.accessKeyId}/`)
  )
    return false;
  const signedAt = Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
  );
  if (!(Date.now() <= signedAt + expires * 1000)) return false;
  const signedHeaders = (url.searchParams.get("X-Amz-SignedHeaders") ?? "")
    .split(";")
    .filter((name) => name !== "host");
  const headers = new Headers();
  for (const name of signedHeaders) {
    const value =
      name === "content-length" && bodyLength !== undefined
        ? String(bodyLength)
        : request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const name of [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
  ])
    url.searchParams.delete(name);
  const resigned = await new AwsV4Signer({
    ...credentials,
    method: request.method === "HEAD" ? "GET" : request.method,
    url: url.toString(),
    headers,
    service: "s3",
    region: "auto",
    datetime: date,
    signQuery: true,
    allHeaders: signedHeaders.length > 0,
  }).sign();
  return resigned.url.searchParams.get("X-Amz-Signature") === signature;
};

/** Core's own S3 calls are header-signed with the same key. */
const headerSigned = (request: Request, credentials: { accessKeyId: string }) =>
  (request.headers.get("authorization") ?? "").startsWith(
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/`,
  );

/** The bucket's one CORS rule, as deployments configure it on R2. */
const cors = (context: Context<AppEnv>, response: Response) => {
  const origin = context.req.header("origin");
  const trusted = (context.env.DX_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim());
  if (origin === undefined || !trusted.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-expose-headers",
    "etag, content-length, content-range",
  );
  headers.set("vary", "origin");
  return new Response(response.body, { status: response.status, headers });
};

const objectKey = (path: string) =>
  path
    .slice(`/${LOCAL_R2_BUCKET}/`.length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");

const tags = (text: string, tag: string) =>
  [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  );

export const localR2Routes = new Hono<AppEnv>()
  .use("*", async (context, next) => {
    if (
      context.env.DX_RUNTIME_MODE !== "local" ||
      context.env.DX_STORAGE === undefined
    )
      return context.notFound();
    await next();
  })
  .options("*", (context) =>
    cors(
      context,
      new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, HEAD, PUT",
          "access-control-allow-headers": "content-type, range",
          "access-control-max-age": "3600",
        },
      }),
    ),
  )
  .all("*", async (context) => {
    const bucket = context.env.DX_STORAGE as R2Bucket;
    const credentials = localCredentials(context);
    const request = context.req.raw;
    const url = new URL(request.url);
    if (credentials === undefined) return s3Error("InvalidAccessKeyId", 403);
    const presigned = url.searchParams.has("X-Amz-Signature");
    // A part is checked against the length it carries, as R2 checks the
    // signed length.
    const body =
      request.method === "PUT" ? await request.arrayBuffer() : undefined;
    if (
      presigned
        ? !(await verifyPresigned(request, credentials, body?.byteLength))
        : !headerSigned(request, credentials)
    )
      return cors(context, s3Error("SignatureDoesNotMatch", 403));
    const key = objectKey(url.pathname);
    const uploadId = url.searchParams.get("uploadId");
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const upload = await bucket.createMultipartUpload(key);
      return xml(
        `<InitiateMultipartUploadResult><UploadId>${upload.uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === "PUT" && uploadId !== null) {
      const part = await bucket
        .resumeMultipartUpload(key, uploadId)
        .uploadPart(
          Number(url.searchParams.get("partNumber")),
          body ?? new ArrayBuffer(0),
        );
      return cors(
        context,
        new Response(null, { headers: { etag: `"${part.etag}"` } }),
      );
    }
    if (request.method === "POST" && uploadId !== null) {
      const body = await request.text();
      const numbers = tags(body, "PartNumber").map(Number);
      const etags = tags(body, "ETag").map((etag) =>
        etag.replaceAll("&quot;", "").replaceAll('"', ""),
      );
      try {
        await bucket.resumeMultipartUpload(key, uploadId).complete(
          numbers.map((partNumber, index) => ({
            partNumber,
            etag: etags[index] ?? "",
          })),
        );
      } catch {
        return s3Error("InvalidPart", 400);
      }
      return xml("<CompleteMultipartUploadResult/>");
    }
    if (request.method === "DELETE" && uploadId !== null) {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const head = await bucket.head(key);
      if (head === null) return cors(context, s3Error("NoSuchKey", 404));
      const headers = new Headers({
        "accept-ranges": "bytes",
        "content-type":
          url.searchParams.get("response-content-type") ??
          "application/octet-stream",
        etag: `"${head.etag}"`,
      });
      const disposition = url.searchParams.get("response-content-disposition");
      if (disposition !== null) headers.set("content-disposition", disposition);
      const range = parseAttachmentRange(
        context.req.header("range"),
        head.size,
      );
      if (range === "unsatisfiable") {
        headers.set("content-range", `bytes */${head.size}`);
        return cors(context, new Response(null, { status: 416, headers }));
      }
      const { start, end } = range ?? { start: 0, end: head.size - 1 };
      const length = end - start + 1;
      headers.set("content-length", String(length));
      if (range !== undefined)
        headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
      const status = range === undefined ? 200 : 206;
      if (request.method === "HEAD")
        return cors(context, new Response(null, { status, headers }));
      const object = await bucket.get(key, {
        range: { offset: start, length },
      });
      return cors(
        context,
        new Response(object?.body ?? null, { status, headers }),
      );
    }
    return s3Error("NotImplemented", 501);
  });
