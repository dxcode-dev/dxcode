import {
  SkillId,
  SkillImportBundle,
  SkillIntegrity,
  SkillManifest,
  SkillResourcePath,
  SkillSource,
  SkillVersion,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const SkillResourceDataSchema = Schema.Struct({
  path: SkillResourcePath,
  mediaType: Schema.String,
  sizeBytes: Schema.Int,
  integrity: SkillIntegrity,
});

export type SkillResourceData = typeof SkillResourceDataSchema.Type;

export const SkillVersionDataSchema = Schema.Struct({
  version: SkillVersion,
  manifest: SkillManifest,
  instructions: Schema.String,
  resources: Schema.Array(SkillResourceDataSchema),
  source: SkillSource,
  integrity: SkillIntegrity,
  createdAt: Timestamp,
});

export type SkillVersionData = typeof SkillVersionDataSchema.Type;

export const SkillEffectiveStateSchema = Schema.Literals([
  "disabled",
  "effective",
  "blocked-by-workspace",
  "blocked-by-policy",
]);

export const SkillDataSchema = Schema.Struct({
  id: SkillId,
  scope: Schema.Literals(["personal", "workspace"]),
  name: Schema.String,
  enabled: Schema.Boolean,
  activeVersion: SkillVersion,
  pinned: Schema.Boolean,
  versions: Schema.Array(SkillVersion),
  active: SkillVersionDataSchema,
  effectiveState: SkillEffectiveStateSchema,
  overridesPersonal: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type SkillData = typeof SkillDataSchema.Type;

export const ListSkillsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(SkillDataSchema),
    canMutate: Schema.Boolean,
    precedence: Schema.Literal("workspace-over-personal"),
    allowPersonalSkills: Schema.optional(Schema.Boolean),
  }),
);

export const PreviewSkillRequestSchema = SkillImportBundle;

export const PreviewSkillResponseSchema = successResponse(
  Schema.Struct({
    manifest: SkillManifest,
    instructions: Schema.String,
    resources: Schema.Array(SkillResourceDataSchema),
    source: SkillSource,
    integrity: SkillIntegrity,
    totalBytes: Schema.Int,
  }),
);

export const ImportSkillRequestSchema = Schema.Struct({
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
});

export const ImportSkillResponseSchema = successResponse(SkillDataSchema);

export const SkillParamsSchema = Schema.Struct({ skillId: SkillId });

export const PublishSkillVersionRequestSchema = Schema.Struct({
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
  activate: Schema.Boolean,
});

export const PublishSkillVersionResponseSchema =
  successResponse(SkillDataSchema);

export const UpdateSkillStateRequestSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  activeVersion: Schema.optional(SkillVersion),
  pinned: Schema.optional(Schema.Boolean),
});

export const UpdateSkillStateResponseSchema = successResponse(SkillDataSchema);

export const RemoveSkillResponseSchema = successResponse(
  Schema.Struct({ removedSkillId: SkillId }),
);

export const ExportSkillResponseSchema = successResponse(
  Schema.Struct({
    source: SkillSource,
    integrity: SkillIntegrity,
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        kind: Schema.Literal("file"),
        mediaType: Schema.String,
        encoding: Schema.Literal("utf-8"),
        content: Schema.String,
      }),
    ),
  }),
);

export const UpdateSkillWorkspacePolicyRequestSchema = Schema.Struct({
  allowPersonalSkills: Schema.Boolean,
});

export const UpdateSkillWorkspacePolicyResponseSchema = successResponse(
  Schema.Struct({ allowPersonalSkills: Schema.Boolean }),
);

export const SkillsInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_SKILL_REQUEST"),
    message: Schema.Literal("Skill validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const SkillsForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const SkillNotFoundResponseSchema = errorResponse(
  "SKILL_NOT_FOUND",
  "Skill not found.",
);

export const SkillLimitResponseSchema = errorResponse(
  "SKILL_LIMIT_EXCEEDED",
  "This scope has reached its skill limit.",
);

export const SkillIntegrityConflictResponseSchema = errorResponse(
  "SKILL_INTEGRITY_CONFLICT",
  "The reviewed skill content no longer matches or conflicts with an immutable version.",
);

export const SkillMcpReferenceInvalidResponseSchema = errorResponse(
  "SKILL_MCP_REFERENCE_INVALID",
  "Every MCP dependency must be enabled and have a currently reviewed tool in this scope.",
);

export const SkillsUnavailableResponseSchema = errorResponse(
  "SKILLS_UNAVAILABLE",
  "Skills are temporarily unavailable.",
);

export const SkillsErrorResponseSchema = Schema.Union([
  SkillsInvalidRequestResponseSchema,
  SkillsForbiddenResponseSchema,
  SkillNotFoundResponseSchema,
  SkillLimitResponseSchema,
  SkillIntegrityConflictResponseSchema,
  SkillMcpReferenceInvalidResponseSchema,
  SkillsUnavailableResponseSchema,
]);
