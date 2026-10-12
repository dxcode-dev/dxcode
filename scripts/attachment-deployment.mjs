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
