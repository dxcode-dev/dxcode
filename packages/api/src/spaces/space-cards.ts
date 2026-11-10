import { Timestamp } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { SpaceThreadItemSchema } from "./space-data.js";

/** `GET /v1/spaces/:threadId/threads/:childId`: one thread's card. */
export const SpaceThreadResponseSchema = successResponse(
  Schema.Struct({ item: SpaceThreadItemSchema }),
);

export type SpaceThreadResponse = typeof SpaceThreadResponseSchema.Encoded;

export const SPACE_CATCH_UP_MAX_LENGTH = 4_000;

/**
 * "Since you've been gone": what the Space's threads did while the
 * requester was away, visible only to them. `body` is Markdown whose links
 * to the Space's threads render as thread chips.
 */
export const SpaceCatchUpSchema = Schema.Struct({
  /** When they last had the Space open: the card covers what changed since. */
  since: Timestamp,
  until: Timestamp,
  body: Schema.String.check(Schema.isMaxLength(SPACE_CATCH_UP_MAX_LENGTH)),
});

export type SpaceCatchUp = typeof SpaceCatchUpSchema.Type;

/**
 * `GET /v1/spaces/:threadId/catch-up` (also records that the requester has
 * the Space open) and `POST /v1/spaces/:threadId/catch-up/dismiss`. Null when
 * there is nothing to catch up on.
 */
export const SpaceCatchUpResponseSchema = successResponse(
  Schema.Struct({ catchUp: Schema.NullOr(SpaceCatchUpSchema) }),
);

export type SpaceCatchUpResponse = typeof SpaceCatchUpResponseSchema.Encoded;
