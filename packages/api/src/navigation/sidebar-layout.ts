import { ProjectId, ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A sidebar section that opens and closes: a Project, Inactive, or Archived. */
export const SidebarSectionIdSchema = Schema.Union([
  ProjectId,
  Schema.Literals(["inactive", "archived"]),
]);

/**
 * One choice the person made in their sidebar: a parent Thread whose
 * children are shown, or a section opened or closed. A choice they never
 * made keeps the sidebar's default.
 */
export const SidebarLayoutEntrySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    id: ThreadId,
    open: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("section"),
    id: SidebarSectionIdSchema,
    open: Schema.Boolean,
  }),
]);

export type SidebarLayoutEntry = typeof SidebarLayoutEntrySchema.Type;

export const SidebarLayoutDataSchema = Schema.Struct({
  entries: Schema.Array(SidebarLayoutEntrySchema),
});

export type SidebarLayoutData = typeof SidebarLayoutDataSchema.Type;

/**
 * `GET /v1/sidebar-layout`, and `PUT` with one entry: the signed-in
 * person's sidebar layout, the same on every device they use.
 */
export const SidebarLayoutResponseSchema = successResponse(
  SidebarLayoutDataSchema,
);

export const UpdateSidebarLayoutRequestSchema = SidebarLayoutEntrySchema;

export const SidebarLayoutErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
