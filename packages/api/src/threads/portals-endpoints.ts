import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { NotFoundResponseSchema } from "../http/not-found-response.js";
import {
  GetThreadPortalsResponseSchema,
  PublishThreadPortalRequestSchema,
  PublishThreadPortalResponseSchema,
  RevokeThreadPortalResponseSchema,
  ThreadPortalPublicErrorResponseSchema,
  ThreadPortalsReadOnlyResponseSchema,
} from "./portals.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/** The Portal endpoints, apart from `portals.ts`'s schemas. */

export const ThreadPortalsParamsSchema = Schema.Struct({ threadId: ThreadId });

/** The port as its path segment, such as `"3000"`; Core checks its range. */
export const ThreadPortalPublicParamsSchema = Schema.Struct({
  threadId: ThreadId,
  port: Schema.String.check(Schema.isPattern(/^[0-9]{1,5}$/)),
});

const portalsRefusals = [
  ...ThreadAccessRefusals,
  // A deployment without Portals answers as if the route did not exist.
  { status: 404, schema: NotFoundResponseSchema },
  { status: 403, schema: ThreadPortalsReadOnlyResponseSchema },
  ...ThreadActiveRefusals,
] as const;

const portalPublicRefusals = [
  ...portalsRefusals,
  // One union of codes, each sent with its own status.
  { status: 400, schema: ThreadPortalPublicErrorResponseSchema },
  { status: 403, schema: ThreadPortalPublicErrorResponseSchema },
  { status: 409, schema: ThreadPortalPublicErrorResponseSchema },
] as const;

export const ListThreadPortalsEndpoint = defineEndpoint({
  id: "threads.portals.list",
  method: "GET",
  path: "/v1/threads/:threadId/portals",
  params: ThreadPortalsParamsSchema,
  success: GetThreadPortalsResponseSchema,
  refusals: portalsRefusals,
});

/** Resumes a paused workspace, then lists its Portals. */
export const WakeThreadPortalsEndpoint = defineEndpoint({
  id: "threads.portals.wake",
  method: "POST",
  path: "/v1/threads/:threadId/portals/wake",
  params: ThreadPortalsParamsSchema,
  success: GetThreadPortalsResponseSchema,
  refusals: portalsRefusals,
});

export const PublishThreadPortalEndpoint = defineEndpoint({
  id: "threads.portals.publish",
  method: "PUT",
  path: "/v1/threads/:threadId/portals/:port/public",
  params: ThreadPortalPublicParamsSchema,
  body: PublishThreadPortalRequestSchema,
  success: PublishThreadPortalResponseSchema,
  refusals: portalPublicRefusals,
});

export const RevokeThreadPortalEndpoint = defineEndpoint({
  id: "threads.portals.revoke",
  method: "DELETE",
  path: "/v1/threads/:threadId/portals/:port/public",
  params: ThreadPortalPublicParamsSchema,
  success: RevokeThreadPortalResponseSchema,
  refusals: portalPublicRefusals,
});
