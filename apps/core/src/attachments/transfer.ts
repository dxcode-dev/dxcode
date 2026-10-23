import { AwsClient } from "aws4fetch";
import type { Bindings } from "../http/types.js";

/**
 * How attachment bytes move, the same in every composition: Core signs
 * short-lived R2 URLs, browsers upload straight to storage, and the browser
 * and dxd download straight from it; Core only authorizes and signs. Local
 * development signs for its own emulation of R2's S3 API (`local-r2.ts`). A
 * stage without signing credentials has no attachments.
 */
export interface AttachmentTransfer {
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
  /** A presigned GET that sets the response's type and disposition. */
  readonly readUrl: (
    key: string,
    response: { readonly contentType: string; readonly disposition: string },
  ) => Promise<string>;
}

/** Presigned upload and read URLs live this long. */
export const PRESIGNED_URL_SECONDS = 3600;

/**
 * R2's S3 endpoint for the bucket, e.g.
 * `https://<account>.r2.cloudflarestorage.com/<bucket>`. Local development
 * names its loopback emulation of that API instead.
 */
const parseEndpoint = (value: string, local: boolean) => {
  try {
    const url = new URL(value);
    const bucket = url.pathname.replace(/^\/+|\/+$/g, "");
    const r2 =
      url.protocol === "https:" &&
      url.hostname.endsWith(".r2.cloudflarestorage.com");
    const loopback =
      local &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (
      !(r2 || loopback) ||
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

const direct = (endpoint: string, client: AwsClient): AttachmentTransfer => {
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

/**
 * The stage's attachment transfer, or undefined when attachments are not
 * available: every stage needs R2 signing credentials.
 */
export const attachmentTransfer = (
  bindings: Bindings,
): AttachmentTransfer | undefined => {
  if (bindings.DX_STORAGE === undefined) return undefined;
  const endpoint =
    bindings.DX_ATTACHMENT_R2_ENDPOINT === undefined
      ? undefined
      : parseEndpoint(
          bindings.DX_ATTACHMENT_R2_ENDPOINT,
          bindings.DX_RUNTIME_MODE === "local",
        );
  const credentials =
    bindings.DX_ATTACHMENT_R2_CREDENTIALS === undefined
      ? undefined
      : parseCredentials(bindings.DX_ATTACHMENT_R2_CREDENTIALS);
  return endpoint === undefined || credentials === undefined
    ? undefined
    : direct(
        endpoint,
        new AwsClient({ ...credentials, service: "s3", region: "auto" }),
      );
};
