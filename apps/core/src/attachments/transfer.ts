import { AwsClient } from "aws4fetch";
import type { Bindings } from "../http/types.js";

/**
 * How attachment bytes move. Deployed stages sign short-lived R2 URLs, so
 * browsers upload straight to storage and the browser and dxd download
 * straight from it; Core only authorizes and signs. Local development has no
 * real R2, so there Core carries the bytes through its own routes. The mode
 * comes from composition: local development, and self-hosts deployed with
 * Alchemy OAuth (which cannot mint a signing token), carry bytes through
 * Core; any other deployed stage without signing credentials has no
 * attachments rather than a slower path.
 */
export type AttachmentTransfer = DirectTransfer | CoreTransfer;

interface Common {
  /** Start a multipart upload; returns its upload id. */
  readonly create: (key: string) => Promise<string>;
  /**
   * Where the browser PUTs each part, in part order. A presigned URL signs
   * the part's exact length, so R2 itself refuses a part of any other size.
   */
  readonly partUrls: (
    id: string,
    key: string,
    uploadId: string,
    partLengths: ReadonlyArray<number>,
  ) => Promise<ReadonlyArray<string>>;
  readonly complete: (
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  ) => Promise<void>;
  readonly abort: (key: string, uploadId: string) => Promise<void>;
}

export interface DirectTransfer extends Common {
  readonly kind: "direct";
  /** A presigned GET that sets the response's type and disposition. */
  readonly readUrl: (
    key: string,
    response: { readonly contentType: string; readonly disposition: string },
  ) => Promise<string>;
}

export interface CoreTransfer extends Common {
  readonly kind: "core";
}

/** Presigned upload and read URLs live this long. */
export const PRESIGNED_URL_SECONDS = 3600;

/** R2's S3 endpoint for the bucket, e.g. `https://<account>.r2.cloudflarestorage.com/<bucket>`. */
const parseEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    const bucket = url.pathname.replace(/^\/+|\/+$/g, "");
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".r2.cloudflarestorage.com") ||
      bucket === "" ||
      bucket.includes("/") ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    return `${url.origin}/${bucket}`;
  } catch {
    return undefined;
  }
};

const parseCredentials = (value: string) => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "accessKeyId" in parsed &&
      "secretAccessKey" in parsed &&
      typeof parsed.accessKeyId === "string" &&
      typeof parsed.secretAccessKey === "string" &&
      parsed.accessKeyId !== "" &&
      parsed.secretAccessKey !== ""
    )
      return {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
      };
  } catch {}
  return undefined;
};

/** S3 ETags arrive quoted; R2 parts are named by the bare value. */
export const bareEtag = (etag: string) => etag.trim().replace(/^"|"$/g, "");

const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const direct = (endpoint: string, client: AwsClient): DirectTransfer => {
  const objectUrl = (key: string) =>
    `${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const call = async (url: string, init: RequestInit, operation: string) => {
    const response = await client.fetch(url, init);
    const text = await response.text();
    // S3 may answer 200 and still describe an error in the body.
    if (!response.ok || text.includes("<Error>"))
      throw new Error(`R2 ${operation} failed with HTTP ${response.status}.`);
    return text;
  };
  const presign = async (
    url: string,
    method: "GET" | "PUT",
    contentLength?: number,
  ) =>
    (
      await client.sign(url, {
        method,
        ...(contentLength === undefined
          ? {}
          : { headers: { "content-length": String(contentLength) } }),
        aws: { signQuery: true, allHeaders: contentLength !== undefined },
      })
    ).url;
  return {
    kind: "direct",
    create: async (key) => {
      const text = await call(
        `${objectUrl(key)}?uploads`,
        { method: "POST" },
        "create multipart upload",
      );
      const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
      if (uploadId === undefined)
        throw new Error("R2 returned no multipart upload id.");
      return uploadId;
    },
    partUrls: (_id, key, uploadId, partLengths) =>
      Promise.all(
        partLengths.map((length, index) =>
          presign(
            `${objectUrl(key)}?partNumber=${index + 1}&uploadId=${encodeURIComponent(uploadId)}&X-Amz-Expires=${PRESIGNED_URL_SECONDS}`,
            "PUT",
            length,
          ),
        ),
      ),
    complete: async (key, uploadId, parts) => {
      await call(
        `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/xml" },
          body: `<CompleteMultipartUpload>${parts
            .map(
              ({ partNumber, etag }) =>
                `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${xmlEscape(bareEtag(etag))}"</ETag></Part>`,
            )
            .join("")}</CompleteMultipartUpload>`,
        },
        "complete multipart upload",
      );
    },
    abort: async (key, uploadId) => {
      const response = await client.fetch(
        `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`,
        { method: "DELETE" },
      );
      await response.body?.cancel();
    },
    readUrl: (key, { contentType, disposition }) =>
      presign(
        `${objectUrl(key)}?response-content-type=${encodeURIComponent(contentType)}&response-content-disposition=${encodeURIComponent(disposition)}&X-Amz-Expires=${PRESIGNED_URL_SECONDS}`,
        "GET",
      ),
  };
};

/** Core carries the bytes itself: local development only. */
const throughCore = (bucket: R2Bucket): CoreTransfer => ({
  kind: "core",
  create: async (key) => (await bucket.createMultipartUpload(key)).uploadId,
  partUrls: async (id, _key, _uploadId, partLengths) =>
    partLengths.map((_, index) => `/v1/attachments/${id}/parts/${index + 1}`),
  complete: async (key, uploadId, parts) => {
    await bucket.resumeMultipartUpload(key, uploadId).complete(
      parts.map(({ partNumber, etag }) => ({
        partNumber,
        etag: bareEtag(etag),
      })),
    );
  },
  abort: (key, uploadId) => bucket.resumeMultipartUpload(key, uploadId).abort(),
});

/**
 * The stage's attachment transfer, or undefined when attachments are not
 * available: a deployed stage needs R2 signing credentials.
 */
export const attachmentTransfer = (
  bindings: Bindings,
): AttachmentTransfer | undefined => {
  if (bindings.DX_STORAGE === undefined) return undefined;
  const endpoint =
    bindings.DX_ATTACHMENT_R2_ENDPOINT === undefined
      ? undefined
      : parseEndpoint(bindings.DX_ATTACHMENT_R2_ENDPOINT);
  const credentials =
    bindings.DX_ATTACHMENT_R2_CREDENTIALS === undefined
      ? undefined
      : parseCredentials(bindings.DX_ATTACHMENT_R2_CREDENTIALS);
  if (endpoint !== undefined && credentials !== undefined)
    return direct(
      endpoint,
      new AwsClient({ ...credentials, service: "s3", region: "auto" }),
    );
  // Local development has no real R2; a deployment that cannot mint a
  // signing token (Alchemy OAuth self-host) records that it carries bytes
  // through Core. Anything else without credentials has no attachments.
  return bindings.DX_RUNTIME_MODE === "local" ||
    bindings.DX_ATTACHMENT_TRANSFER === "core"
    ? throughCore(bindings.DX_STORAGE)
    : undefined;
};
