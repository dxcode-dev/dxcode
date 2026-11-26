import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  ArtifactFolderRequestSchema,
  ArtifactFolderResponseSchema,
  ArtifactLibraryErrorResponseSchema,
  ArtifactLibraryFilterSchema,
  ArtifactLibraryItemResponseSchema,
  ArtifactLibraryResponseSchema,
  CreateStandaloneArtifactRequestSchema,
  DeleteArtifactFolderResponseSchema,
  MoveArtifactToFolderRequestSchema,
  UpdateArtifactSharingRequestSchema,
} from "./library.js";

/**
 * Endpoints live apart from their schemas: a module that defines endpoints
 * ships whole with whatever imports it, so the Thread page, which reads
 * these schemas, never loads them (wiki/headless-client.md).
 */

/** Library errors go out with each of these statuses (artifact-library/routes.ts). */
export const ArtifactLibraryRefusals = ([400, 403, 404, 409, 503] as const).map(
  (status) => ({ status, schema: ArtifactLibraryErrorResponseSchema }),
);

/** Any string: an unknown artifact is `ARTIFACT_NOT_FOUND`. */
export const ArtifactLibraryItemParamsSchema = Schema.Struct({
  artifactId: Schema.String,
});
/** Any string: an unknown folder is `ARTIFACT_FOLDER_NOT_FOUND`. */
export const ArtifactFolderParamsSchema = Schema.Struct({
  folderId: Schema.String,
});

/**
 * `?filter=&q=`, in that order. Core refuses a `q` over 200 characters with
 * `INVALID_REQUEST`.
 */
export const ArtifactLibraryQuerySchema = Schema.Struct({
  filter: ArtifactLibraryFilterSchema,
  q: Schema.optional(Schema.String),
});

export const ListArtifactLibraryEndpoint = defineEndpoint({
  id: "artifacts.list",
  method: "GET",
  path: "/v1/artifacts",
  query: ArtifactLibraryQuerySchema,
  success: ArtifactLibraryResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const CreateStandaloneArtifactEndpoint = defineEndpoint({
  id: "artifacts.create",
  method: "POST",
  path: "/v1/artifacts",
  body: CreateStandaloneArtifactRequestSchema,
  success: ArtifactLibraryItemResponseSchema,
  successStatus: 201,
  refusals: ArtifactLibraryRefusals,
});

/** Where an artifact lives, for its `/artifacts/<id>` link. */
export const GetArtifactLibraryItemEndpoint = defineEndpoint({
  id: "artifacts.get",
  method: "GET",
  path: "/v1/artifacts/:artifactId",
  params: ArtifactLibraryItemParamsSchema,
  success: ArtifactLibraryItemResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const UpdateArtifactSharingEndpoint = defineEndpoint({
  id: "artifacts.share",
  method: "PUT",
  path: "/v1/artifacts/:artifactId/sharing",
  params: ArtifactLibraryItemParamsSchema,
  body: UpdateArtifactSharingRequestSchema,
  success: ArtifactLibraryItemResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const PinArtifactEndpoint = defineEndpoint({
  id: "artifacts.pin",
  method: "PUT",
  path: "/v1/artifacts/:artifactId/pin",
  params: ArtifactLibraryItemParamsSchema,
  success: ArtifactLibraryItemResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const UnpinArtifactEndpoint = defineEndpoint({
  id: "artifacts.unpin",
  method: "DELETE",
  path: "/v1/artifacts/:artifactId/pin",
  params: ArtifactLibraryItemParamsSchema,
  success: ArtifactLibraryItemResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const MoveArtifactToFolderEndpoint = defineEndpoint({
  id: "artifacts.moveToFolder",
  method: "PUT",
  path: "/v1/artifacts/:artifactId/folder",
  params: ArtifactLibraryItemParamsSchema,
  body: MoveArtifactToFolderRequestSchema,
  success: ArtifactLibraryItemResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const CreateArtifactFolderEndpoint = defineEndpoint({
  id: "artifacts.folders.create",
  method: "POST",
  path: "/v1/artifacts/folders",
  body: ArtifactFolderRequestSchema,
  success: ArtifactFolderResponseSchema,
  successStatus: 201,
  refusals: ArtifactLibraryRefusals,
});

export const RenameArtifactFolderEndpoint = defineEndpoint({
  id: "artifacts.folders.rename",
  method: "PATCH",
  path: "/v1/artifacts/folders/:folderId",
  params: ArtifactFolderParamsSchema,
  body: ArtifactFolderRequestSchema,
  success: ArtifactFolderResponseSchema,
  refusals: ArtifactLibraryRefusals,
});

export const DeleteArtifactFolderEndpoint = defineEndpoint({
  id: "artifacts.folders.delete",
  method: "DELETE",
  path: "/v1/artifacts/folders/:folderId",
  params: ArtifactFolderParamsSchema,
  success: DeleteArtifactFolderResponseSchema,
  refusals: ArtifactLibraryRefusals,
});
