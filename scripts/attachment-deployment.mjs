/**
 * The storage bucket's one CORS rule. Browsers PUT attachment parts to
 * presigned R2 URLs and read attachments from them, so the bucket admits the
 * deployment's origin for exactly that: PUT with the part body, GET and HEAD
 * with ranges, and the ETag that names each uploaded part.
 */
export const attachmentBucketCors = (origin) => ({
  allowedMethods: ["GET", "HEAD", "PUT"],
  allowedOrigins: [origin],
  allowedHeaders: ["content-type", "range"],
  exposeHeaders: ["etag", "content-length", "content-range"],
  maxAgeSeconds: 3600,
});

/** The one permission the attachment signing token has. */
export const ATTACHMENT_SIGNING_PERMISSION =
  "Workers R2 Storage Bucket Item Write";

/**
 * The account token a deployment mints for signing attachment URLs: object
 * read and write on the stage's bucket and nothing else. Core derives R2's
 * S3 credentials from it.
 */
export const attachmentSigningTokenProps = (accountId, bucketName) => ({
  name: `dx attachments · ${bucketName}`,
  accountId,
  policies: [
    {
      effect: "allow",
      permissionGroups: [ATTACHMENT_SIGNING_PERMISSION],
      resources: {
        [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]:
          "*",
      },
    },
  ],
});

/**
 * How an operator creates the R2 API token an Alchemy OAuth self-host signs
 * attachment URLs with. Alchemy's browser login cannot create tokens, so the
 * operator creates one in the dashboard once; the deployment holds it.
 */
export const operatorR2CredentialsGuidance = (bucketName) =>
  [
    "",
    "Attachments upload straight to R2 through URLs this deployment signs, so it needs an R2 API token:",
    '  1. Cloudflare dashboard → R2 Object Storage → Overview → Manage API tokens ("API Tokens").',
    "  2. Create Account API token. Permissions: Object Read & Write.",
    `  3. Specify bucket(s): Apply to specific buckets only → ${bucketName}. On a first deploy the bucket`,
    "     does not exist yet: choose Apply to all buckets in this account, or deploy once and rerun with --rotate.",
    "  4. Create the token and copy the Access Key ID and Secret Access Key it shows (shown once).",
    "",
  ].join("\n");

const R2_ACCESS_KEY_ID = /^[a-f0-9]{32}$/;
const R2_SECRET_ACCESS_KEY = /^[a-f0-9]{64}$/;

/**
 * The `{ accessKeyId, secretAccessKey }` JSON Core signs attachment URLs
 * with, from an operator's R2 API token. R2's S3 keys are 32 and 64 hex
 * characters; anything else is a paste of the wrong value.
 */
export const operatorR2Credentials = ({ accessKeyId, secretAccessKey }) => {
  const id = accessKeyId?.trim() ?? "";
  const secret = secretAccessKey?.trim() ?? "";
  if (!R2_ACCESS_KEY_ID.test(id))
    throw new Error(
      "The R2 Access Key ID is 32 hex characters (R2 → Manage API tokens).",
    );
  if (!R2_SECRET_ACCESS_KEY.test(secret))
    throw new Error(
      "The R2 Secret Access Key is 64 hex characters (R2 → Manage API tokens).",
    );
  return JSON.stringify({ accessKeyId: id, secretAccessKey: secret });
};

/** The one permission the Worker logs token has. */
export const WORKER_LOGS_PERMISSION = "Workers Observability Read";

/**
 * The account token a deployment mints so Core can read its own Workers
 * logs for a bug report: Workers Observability read on the deployment's
 * account and nothing else. A deployment that can mint its attachment
 * signing token mints this one too; one that cannot reports Worker logs as
 * unavailable.
 */
export const workerLogsTokenProps = (accountId, workerName) => ({
  name: `dx worker logs · ${workerName}`,
  accountId,
  policies: [
    {
      effect: "allow",
      permissionGroups: [WORKER_LOGS_PERMISSION],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    },
  ],
});
