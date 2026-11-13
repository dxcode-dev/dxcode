import { ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import {
  ThreadArtifactAuthorSchema,
  ThreadArtifactIdSchema,
  ThreadArtifactKindSchema,
  ThreadArtifactTitleSchema,
} from "../threads/artifacts.js";

/**
 * The Artifacts library: every artifact a person may open, in one list.
 * Standalone artifacts (made here, not in a Thread) sit beside the
 * artifacts of the person's Threads and Spaces and those shared with them.
 * A standalone artifact lives in its own artifact home, a hidden Thread, so
 * reading and saving it go through the Thread artifact routes with
 * `location.threadId`; the library only lists, creates, locates, and
 * shares. Every artifact has one link, `/artifacts/<id>`.
 */

/** The most items one library page returns. */
export const ARTIFACT_LIBRARY_LIMIT = 500;

/** Who can open a standalone artifact besides its owner. */
export const ArtifactSharingSchema = Schema.Literals([
  "private",
  "view",
  "edit",
]);
export type ArtifactSharing = typeof ArtifactSharingSchema.Type;

/** What the reader may do: `owner` and `edit` save and comment; `view` reads. */
export const ArtifactAccessSchema = Schema.Literals(["owner", "edit", "view"]);
export type ArtifactAccess = typeof ArtifactAccessSchema.Type;

/** Where an artifact lives. */
export const ArtifactSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("standalone") }),
  Schema.Struct({
    kind: Schema.Literals(["thread", "space"]),
    title: Schema.String,
    archived: Schema.Boolean,
  }),
]);
export type ArtifactSource = typeof ArtifactSourceSchema.Type;

export const ArtifactLibraryItemSchema = Schema.Struct({
  id: ThreadArtifactIdSchema,
  kind: ThreadArtifactKindSchema,
  title: Schema.String,
  /** The Thread (or artifact home) whose artifact routes read and save it. */
  threadId: ThreadId,
  source: ArtifactSourceSchema,
  owner: Schema.Struct({ userId: UserId, name: Schema.NullOr(Schema.String) }),
  access: ArtifactAccessSchema,
  /** Who besides the owner can open it: the artifact's, or its Thread's. */
  sharing: ArtifactSharingSchema,
  revision: Schema.Int,
  updatedBy: ThreadArtifactAuthorSchema,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ArtifactLibraryItem = typeof ArtifactLibraryItemSchema.Type;

export const ArtifactLibraryFilterSchema = Schema.Literals([
  "all",
  "mine",
  "shared",
  "threads",
]);
export type ArtifactLibraryFilter = typeof ArtifactLibraryFilterSchema.Type;

/**
 * `GET /v1/artifacts?q=&filter=`: most recently saved first. `q` matches
 * titles, case-insensitively. `mine` is the reader's standalone artifacts,
 * `shared` those other people shared, `threads` those in Threads and Spaces.
 */
export const ArtifactLibraryResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(ArtifactLibraryItemSchema) }),
);
export type ArtifactLibraryResponse = typeof ArtifactLibraryResponseSchema.Type;

/** `GET /v1/artifacts/:artifactId`, a create, and a sharing change. */
export const ArtifactLibraryItemResponseSchema = successResponse(
  Schema.Struct({ item: ArtifactLibraryItemSchema }),
);
export type ArtifactLibraryItemResponse =
  typeof ArtifactLibraryItemResponseSchema.Type;

/** `POST /v1/artifacts`: a standalone artifact, private to its creator. */
export const CreateStandaloneArtifactRequestSchema = Schema.Struct({
  title: ThreadArtifactTitleSchema,
  kind: Schema.optional(ThreadArtifactKindSchema),
  markdown: Schema.optional(Schema.String),
});
export type CreateStandaloneArtifactRequest =
  typeof CreateStandaloneArtifactRequestSchema.Type;

/** `PUT /v1/artifacts/:artifactId/sharing`: the owner of a standalone artifact. */
export const UpdateArtifactSharingRequestSchema = Schema.Struct({
  sharing: ArtifactSharingSchema,
});
export type UpdateArtifactSharingRequest =
  typeof UpdateArtifactSharingRequestSchema.Type;

export const ArtifactLibraryErrorCodeSchema = Schema.Literals([
  "INVALID_REQUEST",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_SHARING_OWNER_ONLY",
  "ARTIFACT_SHARING_STANDALONE_ONLY",
  "ARTIFACT_SHARING_UNAVAILABLE",
  "ARTIFACT_PROJECT_REQUIRED",
  "ARTIFACTS_UNAVAILABLE",
]);
export type ArtifactLibraryErrorCode =
  typeof ArtifactLibraryErrorCodeSchema.Type;
