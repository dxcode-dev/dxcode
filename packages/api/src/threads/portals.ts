import { Timestamp } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A TCP port a guest service listens on: canonical 1–65535. */
export const ThreadPortalPortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
);

/** One guest listener and the Portal URL that serves it. */
export const ThreadPortalSchema = Schema.Struct({
  port: ThreadPortalPortSchema,
  url: Schema.String,
});
export type ThreadPortal = typeof ThreadPortalSchema.Type;

/**
 * A port anyone with its Portal URL may open without signing in, until
 * `expiresAt`. Visitors get no identity headers and no Thread access.
 */
export const ThreadPortalPublicLinkSchema = Schema.Struct({
  port: ThreadPortalPortSchema,
  url: Schema.String,
  expiresAt: Timestamp,
});
export type ThreadPortalPublicLink = typeof ThreadPortalPublicLinkSchema.Type;

/**
 * The Thread's Portals. Listing never wakes the workspace: a paused
 * workspace reports `paused` with no ports, and opening a Portal wakes it.
 * `publicLinks` lists public ports whether or not they are listening;
 * `canPublish` is true only for the Thread's owner.
 */
export const ThreadPortalsDataSchema = Schema.Struct({
  workspace: Schema.Literals(["running", "paused", "unavailable"]),
  portals: Schema.Array(ThreadPortalSchema),
  publicLinks: Schema.Array(ThreadPortalPublicLinkSchema),
  canPublish: Schema.Boolean,
});
export type ThreadPortalsData = typeof ThreadPortalsDataSchema.Type;

export const GetThreadPortalsResponseSchema = successResponse(
  ThreadPortalsDataSchema,
);
export type GetThreadPortalsResponse =
  typeof GetThreadPortalsResponseSchema.Encoded;

/** Portals need Contribute access, like the Terminal. */
export const ThreadPortalsReadOnlyResponseSchema = errorResponse(
  "THREAD_READ_ONLY",
  "Only contributors can open Portals in a shared Thread.",
);

/** How long a Portal stays public. */
export const ThreadPortalPublicDurationSchema = Schema.Literals([
  "1h",
  "1d",
  "7d",
]);
export type ThreadPortalPublicDuration =
  typeof ThreadPortalPublicDurationSchema.Type;

export const PublishThreadPortalRequestSchema = Schema.Struct({
  duration: ThreadPortalPublicDurationSchema,
});
export type PublishThreadPortalRequest =
  typeof PublishThreadPortalRequestSchema.Type;

/** Making a port public again restarts its lifetime from now. */
export const PublishThreadPortalResponseSchema = successResponse(
  ThreadPortalPublicLinkSchema,
);

/** Revoking is idempotent: a port that is not public answers the same. */
export const RevokeThreadPortalResponseSchema = successResponse(
  Schema.Struct({ port: ThreadPortalPortSchema }),
);

/** At most this many ports of one Thread are public at once. */
export const THREAD_PORTAL_PUBLIC_LIMIT = 3;

export const ThreadPortalPublicErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "PORTAL_PUBLIC_OWNER_ONLY",
  "PORTAL_PUBLIC_LIMIT",
]);

/** Making a Portal public, or revoking it, was refused. */
export const ThreadPortalPublicErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadPortalPublicErrorCode,
    message: Schema.String,
    requestId: Schema.String,
  }),
});
