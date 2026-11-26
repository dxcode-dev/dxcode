import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  CreateThreadArtifactCommentRequestSchema,
  CreateThreadArtifactRequestSchema,
  DeleteThreadArtifactResponseSchema,
  NotifyArtifactAgentResponseSchema,
  SaveThreadArtifactRequestSchema,
  ThreadArtifactCommentListResponseSchema,
  ThreadArtifactCommentResponseSchema,
  ThreadArtifactErrorResponseSchema,
  ThreadArtifactImageResponseSchema,
  ThreadArtifactListResponseSchema,
  ThreadArtifactResponseSchema,
  ThreadArtifactRevisionResponseSchema,
} from "./artifacts.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/**
 * Endpoints live apart from their schemas: a module that defines endpoints
 * ships whole with whatever imports it, so the Thread page, which reads
 * these schemas, never loads them (wiki/headless-client.md).
 */

/**
 * What a Thread's artifact routes refuse with: their own errors, and
 * `authorizeThread`'s before they run.
 */
/**
 * Artifact errors go out with each of these statuses
 * (thread-artifacts/routes.ts).
 */
export const ThreadArtifactErrorStatuses = [
  400, 403, 404, 409, 413, 415, 422, 503,
] as const;

export const ThreadArtifactRefusals = [
  ...ThreadArtifactErrorStatuses.map((status) => ({
    status,
    schema: ThreadArtifactErrorResponseSchema,
  })),
  ...ThreadAccessRefusals,
];

export const ThreadArtifactsParamsSchema = Schema.Struct({
  threadId: ThreadId,
});
/** Any string: an unknown artifact is the route's `ARTIFACT_NOT_FOUND`. */
export const ThreadArtifactParamsSchema = Schema.Struct({
  threadId: ThreadId,
  artifactId: Schema.String,
});

/** `?name=`: the image's file name; dx names it when left out. */
export const ArtifactImageQuerySchema = Schema.Struct({
  name: Schema.optional(Schema.String),
});

export const ListThreadArtifactsEndpoint = defineEndpoint({
  id: "threadArtifacts.list",
  method: "GET",
  path: "/v1/threads/:threadId/artifacts",
  params: ThreadArtifactsParamsSchema,
  success: ThreadArtifactListResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const CreateThreadArtifactEndpoint = defineEndpoint({
  id: "threadArtifacts.create",
  method: "POST",
  path: "/v1/threads/:threadId/artifacts",
  params: ThreadArtifactsParamsSchema,
  body: CreateThreadArtifactRequestSchema,
  success: ThreadArtifactResponseSchema,
  successStatus: 201,
  refusals: ThreadArtifactRefusals,
});

/** The image's bytes are the body; its type comes from them. */
export const UploadThreadArtifactImageEndpoint = defineEndpoint({
  id: "threadArtifacts.uploadImage",
  method: "POST",
  path: "/v1/threads/:threadId/artifacts/images",
  params: ThreadArtifactsParamsSchema,
  query: ArtifactImageQuerySchema,
  upload: "bytes",
  success: ThreadArtifactImageResponseSchema,
  successStatus: 201,
  refusals: ThreadArtifactRefusals,
});

export const GetThreadArtifactEndpoint = defineEndpoint({
  id: "threadArtifacts.get",
  method: "GET",
  path: "/v1/threads/:threadId/artifacts/:artifactId",
  params: ThreadArtifactParamsSchema,
  success: ThreadArtifactResponseSchema,
  refusals: ThreadArtifactRefusals,
});

/** `revision` is the revision's number, such as `"3"`. */
export const GetThreadArtifactRevisionEndpoint = defineEndpoint({
  id: "threadArtifacts.revision",
  method: "GET",
  path: "/v1/threads/:threadId/artifacts/:artifactId/revisions/:revision",
  params: Schema.Struct({
    threadId: ThreadId,
    artifactId: Schema.String,
    revision: Schema.String,
  }),
  success: ThreadArtifactRevisionResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const SaveThreadArtifactEndpoint = defineEndpoint({
  id: "threadArtifacts.save",
  method: "PUT",
  path: "/v1/threads/:threadId/artifacts/:artifactId",
  params: ThreadArtifactParamsSchema,
  body: SaveThreadArtifactRequestSchema,
  success: ThreadArtifactResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const DeleteThreadArtifactEndpoint = defineEndpoint({
  id: "threadArtifacts.delete",
  method: "DELETE",
  path: "/v1/threads/:threadId/artifacts/:artifactId",
  params: ThreadArtifactParamsSchema,
  success: DeleteThreadArtifactResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const ListThreadArtifactCommentsEndpoint = defineEndpoint({
  id: "threadArtifacts.comments.list",
  method: "GET",
  path: "/v1/threads/:threadId/artifacts/:artifactId/comments",
  params: ThreadArtifactParamsSchema,
  success: ThreadArtifactCommentListResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const CreateThreadArtifactCommentEndpoint = defineEndpoint({
  id: "threadArtifacts.comments.create",
  method: "POST",
  path: "/v1/threads/:threadId/artifacts/:artifactId/comments",
  params: ThreadArtifactParamsSchema,
  body: CreateThreadArtifactCommentRequestSchema,
  success: ThreadArtifactCommentResponseSchema,
  successStatus: 201,
  refusals: ThreadArtifactRefusals,
});

export const ResolveThreadArtifactCommentEndpoint = defineEndpoint({
  id: "threadArtifacts.comments.resolve",
  method: "POST",
  path: "/v1/threads/:threadId/artifacts/:artifactId/comments/:commentId/resolve",
  params: Schema.Struct({
    threadId: ThreadId,
    artifactId: Schema.String,
    commentId: Schema.String,
  }),
  success: ThreadArtifactCommentResponseSchema,
  refusals: ThreadArtifactRefusals,
});

export const NotifyThreadArtifactAgentEndpoint = defineEndpoint({
  id: "threadArtifacts.notify",
  method: "POST",
  path: "/v1/threads/:threadId/artifacts/:artifactId/notify",
  params: ThreadArtifactParamsSchema,
  success: NotifyArtifactAgentResponseSchema,
  refusals: ThreadArtifactRefusals,
});
