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
 * Standalone artifacts (made here, not in a Thread) belong to their owner
 * with no Thread or Project; they sit beside the artifacts of the person's
 * Threads and Spaces and those shared with them. A Thread's artifact reads
 * and saves through `/v1/threads/:threadId/artifacts`; a standalone one
 * through the same routes at `/v1/standalone-artifacts/:artifactId`. Every
 * artifact has one link, `/artifacts/<id>`.
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
  /** The Thread whose artifact routes read and save it; null when standalone. */
  threadId: Schema.NullOr(ThreadId),
  source: ArtifactSourceSchema,
  owner: Schema.Struct({ userId: UserId, name: Schema.NullOr(Schema.String) }),
  access: ArtifactAccessSchema,
  /** Who besides the owner can open it: the artifact's, or its Thread's. */
  sharing: ArtifactSharingSchema,
  revision: Schema.Int,
  /** Who made it: a person, or the agent. */
  createdBy: ThreadArtifactAuthorSchema,
  updatedBy: ThreadArtifactAuthorSchema,
  /** The reader pinned it: it lists first, for them only. */
  pinned: Schema.Boolean,
  /** The reader's folder holding it, or null; for them only. */
  folderId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ArtifactLibraryItem = typeof ArtifactLibraryItemSchema.Type;

/**
 * Which artifacts list. `all` leaves out what the agent made that no person
 * has touched since: edited, commented on, pinned, or filed in a folder.
 * `pinned` is the reader's pins, `mine` what the reader made, `agent`
 * everything the agent made, `shared` what other people own.
 */
export const ArtifactLibraryFilterSchema = Schema.Literals([
  "all",
  "pinned",
  "mine",
  "agent",
  "shared",
]);
export type ArtifactLibraryFilter = typeof ArtifactLibraryFilterSchema.Type;

/** The most personal folders one person keeps. */
export const ARTIFACT_FOLDER_LIMIT = 100;

/** One level of the reader's own folders; only they see it. */
export const ArtifactFolderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type ArtifactFolder = typeof ArtifactFolderSchema.Type;

/** A folder name: one trimmed line of 1 to 64 characters. */
export const ArtifactFolderNameSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);

/**
 * `GET /v1/artifacts?q=&filter=`: the reader's pins first, then what the
 * reader made, then the rest, each most recently saved first. `q` matches
 * titles, case-insensitively, and finds what `all` leaves out. `folders`
 * are the reader's folders by name.
 */
export const ArtifactLibraryResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ArtifactLibraryItemSchema),
    folders: Schema.Array(ArtifactFolderSchema),
  }),
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

/** `PUT /v1/artifacts/:artifactId/folder`: file it, or null to take it out. */
export const MoveArtifactToFolderRequestSchema = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
});
export type MoveArtifactToFolderRequest =
  typeof MoveArtifactToFolderRequestSchema.Type;

/** `POST /v1/artifacts/folders` and `PATCH /v1/artifacts/folders/:id`. */
export const ArtifactFolderRequestSchema = Schema.Struct({
  name: ArtifactFolderNameSchema,
});
export type ArtifactFolderRequest = typeof ArtifactFolderRequestSchema.Type;

/** A created or renamed folder. */
export const ArtifactFolderResponseSchema = successResponse(
  Schema.Struct({ folder: ArtifactFolderSchema }),
);
export type ArtifactFolderResponse = typeof ArtifactFolderResponseSchema.Type;

/** `DELETE /v1/artifacts/folders/:id`: its artifacts go back to the top. */
export const DeleteArtifactFolderResponseSchema = successResponse(
  Schema.Struct({ deleted: Schema.Literal(true) }),
);

export const ArtifactLibraryErrorCodeSchema = Schema.Literals([
  "INVALID_REQUEST",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_SHARING_OWNER_ONLY",
  "ARTIFACT_SHARING_STANDALONE_ONLY",
  "ARTIFACT_SHARING_UNAVAILABLE",
  "ARTIFACT_FOLDER_NOT_FOUND",
  "ARTIFACT_FOLDER_EXISTS",
  "ARTIFACT_FOLDER_LIMIT",
  "ARTIFACTS_UNAVAILABLE",
]);
export type ArtifactLibraryErrorCode =
  typeof ArtifactLibraryErrorCodeSchema.Type;
