export function attachmentBucketCors(origin: string): {
  allowedMethods: ("GET" | "HEAD" | "PUT")[];
  allowedOrigins: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
};
export const ATTACHMENT_SIGNING_PERMISSION: "Workers R2 Storage Bucket Item Write";
export function attachmentSigningTokenProps(
  accountId: string,
  bucketName: string,
): {
  name: string;
  accountId: string;
  policies: {
    effect: "allow";
    permissionGroups: "Workers R2 Storage Bucket Item Write"[];
    resources: Record<`com.cloudflare.edge.r2.bucket.${string}`, string>;
  }[];
};
