import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { ThreadArtifactIdSchema } from "../threads/artifacts.js";

/** The most artifacts a Space's Artifacts tab lists. */
export const SPACE_ARTIFACTS_LIMIT = 300;

/** One artifact of a Space or of a thread it started, with that thread. */
export const SpaceArtifactItemSchema = Schema.Struct({
  id: ThreadArtifactIdSchema,
  title: Schema.String,
  folder: Schema.String,
  updatedAt: Schema.Number,
  thread: Schema.Struct({
    id: ThreadId,
    title: Schema.String,
    archived: Schema.Boolean,
  }),
});

export type SpaceArtifactItem = typeof SpaceArtifactItemSchema.Type;

/**
 * `GET /v1/spaces/:threadId/artifacts`: the Space's own artifacts, then
 * those of the threads it started, newest thread first; within a thread,
 * the most recently saved first. Only threads the viewer may open.
 */
export const SpaceArtifactsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(SpaceArtifactItemSchema) }),
);

export type SpaceArtifactsResponse =
  typeof SpaceArtifactsResponseSchema.Encoded;
