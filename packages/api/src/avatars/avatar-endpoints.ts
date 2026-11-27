import { UserId, WorkspaceId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";

/**
 * Uploaded pictures. Core puts their URLs in a person's or workspace's data
 * (`image`, `avatarUrl`), so a UI loads them as an `<img src>`; each upload
 * gets a new file name, so a URL's bytes never change. Only the current
 * picture is served; any other file is not found.
 */

/** 404: not the current picture, or one the viewer may not see. */
export const AvatarNotFoundResponseSchema = errorResponse(
  "AVATAR_NOT_FOUND",
  "Avatar not found.",
);
export type AvatarNotFoundResponse = typeof AvatarNotFoundResponseSchema.Type;

/** A person's picture: anyone signed in may see it. */
export const GetUserAvatarEndpoint = defineEndpoint({
  id: "avatars.user",
  summary: "Download a person's uploaded picture",
  method: "GET",
  path: "/v1/avatars/users/:userId/:file",
  params: Schema.Struct({ userId: UserId, file: Schema.String }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: [{ status: 404, schema: AvatarNotFoundResponseSchema }],
});

/** A workspace's picture: only its members may see it. */
export const GetWorkspaceAvatarEndpoint = defineEndpoint({
  id: "avatars.workspace",
  summary: "Download a workspace's uploaded picture",
  method: "GET",
  path: "/v1/avatars/workspaces/:workspaceId/:file",
  params: Schema.Struct({ workspaceId: WorkspaceId, file: Schema.String }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: [{ status: 404, schema: AvatarNotFoundResponseSchema }],
});
