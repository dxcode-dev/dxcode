import { ProjectId, ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * A sidebar section that opens and closes: a Project, No Project (every
 * scope's in one), Snoozed, Inactive, or Archived.
 */
export const SidebarSectionIdSchema = Schema.Union([
  ProjectId,
  Schema.Literals(["no-project", "snoozed", "inactive", "archived"]),
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

/** The desktop sidebar's narrowest and widest widths, in CSS pixels. */
export const SIDEBAR_WIDTH_MIN_PX = 250;
export const SIDEBAR_WIDTH_MAX_PX = 480;

/** The width the person dragged the desktop sidebar to, in CSS pixels. */
export const SidebarWidthSchema = Schema.Int.check(
  Schema.isBetween({
    minimum: SIDEBAR_WIDTH_MIN_PX,
    maximum: SIDEBAR_WIDTH_MAX_PX,
  }),
);

/** Records the desktop sidebar's width. */
export const SidebarWidthUpdateSchema = Schema.Struct({
  kind: Schema.Literal("width"),
  width: SidebarWidthSchema,
});

export type SidebarWidthUpdate = typeof SidebarWidthUpdateSchema.Type;

/** Records whether the desktop sidebar is collapsed. */
export const SidebarCollapsedUpdateSchema = Schema.Struct({
  kind: Schema.Literal("collapsed"),
  collapsed: Schema.Boolean,
});

export type SidebarCollapsedUpdate = typeof SidebarCollapsedUpdateSchema.Type;

/**
 * `width` is absent until the person resizes the desktop sidebar; the
 * sidebar's default applies until then. `collapsed` is true while they keep
 * the desktop sidebar collapsed; the server omits it otherwise.
 */
export const SidebarLayoutDataSchema = Schema.Struct({
  entries: Schema.Array(SidebarLayoutEntrySchema),
  width: Schema.optional(SidebarWidthSchema),
  collapsed: Schema.optional(Schema.Boolean),
});

export type SidebarLayoutData = typeof SidebarLayoutDataSchema.Type;

/**
 * `GET /v1/sidebar-layout`, and `PUT` with one entry, the width, or whether
 * the sidebar is collapsed: the signed-in
 * person's sidebar layout, the same on every device they use.
 */
export const SidebarLayoutResponseSchema = successResponse(
  SidebarLayoutDataSchema,
);

export const UpdateSidebarLayoutRequestSchema = Schema.Union([
  SidebarLayoutEntrySchema,
  SidebarWidthUpdateSchema,
  SidebarCollapsedUpdateSchema,
]);

export type UpdateSidebarLayoutRequest =
  typeof UpdateSidebarLayoutRequestSchema.Type;

export const SidebarLayoutErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
