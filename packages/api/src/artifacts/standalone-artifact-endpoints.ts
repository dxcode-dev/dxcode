import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  CreateThreadArtifactCommentRequestSchema,
  DeleteThreadArtifactResponseSchema,
  NotifyArtifactAgentResponseSchema,
  SaveThreadArtifactRequestSchema,
  ThreadArtifactCommentListResponseSchema,
  ThreadArtifactCommentResponseSchema,
  ThreadArtifactErrorResponseSchema,
  ThreadArtifactImageResponseSchema,
  ThreadArtifactResponseSchema,
  ThreadArtifactRevisionResponseSchema,
} from "../threads/artifacts.js";
import {
  ArtifactImageQuerySchema,
  ThreadArtifactErrorStatuses,
} from "../threads/thread-artifact-endpoints.js";
import { GetThreadMembersResponseSchema } from "../threads/thread-chat.js";

/**
 * A standalone artifact's routes, `/v1/standalone-artifacts/:artifactId`:
 * the same reads and writes as a Thread's artifact, found by the artifact's
 * id alone. It has no list or create; the library makes standalone
 * artifacts. `authorizeStandaloneArtifact` refuses with the artifact errors
 * (`ARTIFACT_NOT_FOUND`, `ARTIFACT_READ_ONLY`) before a route runs.
 */
/** A standalone artifact refuses as a Thread's does, without a Thread. */
const StandaloneArtifactRefusals = ThreadArtifactErrorStatuses.map(
  (status) => ({ status, schema: ThreadArtifactErrorResponseSchema }),
);

/** Any string: an unknown artifact is `ARTIFACT_NOT_FOUND`. */
const StandaloneArtifactParamsSchema = Schema.Struct({
  artifactId: Schema.String,
});

export const GetStandaloneArtifactEndpoint = defineEndpoint({
  id: "standaloneArtifacts.get",
  method: "GET",
  path: "/v1/standalone-artifacts/:artifactId",
  params: StandaloneArtifactParamsSchema,
  success: ThreadArtifactResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

export const SaveStandaloneArtifactEndpoint = defineEndpoint({
  id: "standaloneArtifacts.save",
  method: "PUT",
  path: "/v1/standalone-artifacts/:artifactId",
  params: StandaloneArtifactParamsSchema,
  body: SaveThreadArtifactRequestSchema,
  success: ThreadArtifactResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

/** Only the owner deletes a standalone artifact. */
export const DeleteStandaloneArtifactEndpoint = defineEndpoint({
  id: "standaloneArtifacts.delete",
  method: "DELETE",
  path: "/v1/standalone-artifacts/:artifactId",
  params: StandaloneArtifactParamsSchema,
  success: DeleteThreadArtifactResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

/** `revision` is the revision's number, such as `"3"`. */
export const GetStandaloneArtifactRevisionEndpoint = defineEndpoint({
  id: "standaloneArtifacts.revision",
  method: "GET",
  path: "/v1/standalone-artifacts/:artifactId/revisions/:revision",
  params: Schema.Struct({
    artifactId: Schema.String,
    revision: Schema.String,
  }),
  success: ThreadArtifactRevisionResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

/** The image's bytes are the body; its type comes from them. */
export const UploadStandaloneArtifactImageEndpoint = defineEndpoint({
  id: "standaloneArtifacts.uploadImage",
  method: "POST",
  path: "/v1/standalone-artifacts/:artifactId/images",
  params: StandaloneArtifactParamsSchema,
  query: ArtifactImageQuerySchema,
  upload: "bytes",
  success: ThreadArtifactImageResponseSchema,
  successStatus: 201,
  refusals: StandaloneArtifactRefusals,
});

/** An image the artifact holds, at the `url` its upload answered with. */
export const GetStandaloneArtifactImageEndpoint = defineEndpoint({
  id: "standaloneArtifacts.image",
  method: "GET",
  path: "/v1/standalone-artifacts/:artifactId/images/:imageId/:name",
  params: Schema.Struct({
    artifactId: Schema.String,
    imageId: Schema.String,
    name: Schema.String,
  }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: StandaloneArtifactRefusals,
});

export const ListStandaloneArtifactCommentsEndpoint = defineEndpoint({
  id: "standaloneArtifacts.comments.list",
  method: "GET",
  path: "/v1/standalone-artifacts/:artifactId/comments",
  params: StandaloneArtifactParamsSchema,
  success: ThreadArtifactCommentListResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

export const CreateStandaloneArtifactCommentEndpoint = defineEndpoint({
  id: "standaloneArtifacts.comments.create",
  method: "POST",
  path: "/v1/standalone-artifacts/:artifactId/comments",
  params: StandaloneArtifactParamsSchema,
  body: CreateThreadArtifactCommentRequestSchema,
  success: ThreadArtifactCommentResponseSchema,
  successStatus: 201,
  refusals: StandaloneArtifactRefusals,
});

export const ResolveStandaloneArtifactCommentEndpoint = defineEndpoint({
  id: "standaloneArtifacts.comments.resolve",
  method: "POST",
  path: "/v1/standalone-artifacts/:artifactId/comments/:commentId/resolve",
  params: Schema.Struct({
    artifactId: Schema.String,
    commentId: Schema.String,
  }),
  success: ThreadArtifactCommentResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

/** Who `@` lists on a standalone artifact: the members it is shared with. */
export const ListStandaloneArtifactMembersEndpoint = defineEndpoint({
  id: "standaloneArtifacts.members",
  method: "GET",
  path: "/v1/standalone-artifacts/:artifactId/members",
  params: StandaloneArtifactParamsSchema,
  success: GetThreadMembersResponseSchema,
  refusals: StandaloneArtifactRefusals,
});

/**
 * A standalone artifact has no agent: Core refuses it with
 * `INVALID_REQUEST`. Defined so the artifact routes stay alike per scope.
 */
export const NotifyStandaloneArtifactAgentEndpoint = defineEndpoint({
  id: "standaloneArtifacts.notify",
  method: "POST",
  path: "/v1/standalone-artifacts/:artifactId/notify",
  params: StandaloneArtifactParamsSchema,
  success: NotifyArtifactAgentResponseSchema,
  refusals: StandaloneArtifactRefusals,
});
