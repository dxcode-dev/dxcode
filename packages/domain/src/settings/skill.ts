import { Effect, Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { McpServerId } from "./mcp-server.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_SKILLS_PER_SCOPE = 20;
export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_RESOURCE_FILES = 30;
export const MAX_SKILL_FILE_BYTES = 65_536;
export const MAX_SKILL_TOTAL_BYTES = 262_144;
export const MAX_SKILL_INSTRUCTIONS_BYTES = 32_768;
export const MAX_SKILL_MANIFEST_BYTES = 16_384;
export const MAX_SKILL_MCP_REFERENCES = 10;

export const SkillId = Schema.String.check(
  Schema.isPattern(
    /^skl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/SkillId"));

export type SkillId = typeof SkillId.Type;

export const SkillName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("@dx/SkillName"));

export type SkillName = typeof SkillName.Type;

export const SkillDescription = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
).pipe(Schema.brand("@dx/SkillDescription"));

export type SkillDescription = typeof SkillDescription.Type;

export const SkillInstructions = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SKILL_INSTRUCTIONS_BYTES),
).pipe(Schema.brand("@dx/SkillInstructions"));

export type SkillInstructions = typeof SkillInstructions.Type;

export const SkillVersion = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("@dx/SkillVersion"));

export type SkillVersion = typeof SkillVersion.Type;

export const SkillIntegrity = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/SkillIntegrity"));

export type SkillIntegrity = typeof SkillIntegrity.Type;

export const SkillResourcePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
).pipe(Schema.brand("@dx/SkillResourcePath"));

export type SkillResourcePath = typeof SkillResourcePath.Type;

export const SkillMcpServerIds = Schema.Array(McpServerId).check(
  Schema.isMaxLength(MAX_SKILL_MCP_REFERENCES),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);

export const SkillManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: SkillName,
  description: SkillDescription,
  mcpServerIds: SkillMcpServerIds.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});

export type SkillManifest = typeof SkillManifest.Type;

export const SkillSource = Schema.Struct({
  type: Schema.Literal("browser-files"),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

export type SkillSource = typeof SkillSource.Type;

export const PersonalSkillTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  id: UserId,
});

export const WorkspaceSkillTarget = Schema.Struct({
  scope: Schema.Literal("workspace"),
  id: WorkspaceId,
});

export const SkillTarget = Schema.Union([
  PersonalSkillTarget,
  WorkspaceSkillTarget,
]);

export type SkillTarget = typeof SkillTarget.Type;

export const SkillResource = Schema.Struct({
  path: SkillResourcePath,
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  content: Schema.String.check(Schema.isMaxLength(MAX_SKILL_FILE_BYTES)),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_SKILL_FILE_BYTES }),
  ),
  integrity: SkillIntegrity,
});

export type SkillResource = typeof SkillResource.Type;

export const StoredSkillVersion = Schema.Struct({
  skillId: SkillId,
  version: SkillVersion,
  manifest: SkillManifest,
  instructions: SkillInstructions,
  resources: Schema.Array(SkillResource).check(
    Schema.isMaxLength(MAX_SKILL_RESOURCE_FILES),
  ),
  source: SkillSource,
  integrity: SkillIntegrity,
  createdAt: Timestamp,
  createdByUserId: UserId,
});

export type StoredSkillVersion = typeof StoredSkillVersion.Type;

export const StoredSkill = Schema.Struct({
  id: SkillId,
  target: SkillTarget,
  name: SkillName,
  enabled: Schema.Boolean,
  activeVersion: SkillVersion,
  pinned: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  removedAt: Schema.optional(Timestamp),
});

export type StoredSkill = typeof StoredSkill.Type;

export const SkillWithVersion = Schema.Struct({
  skill: StoredSkill,
  active: StoredSkillVersion,
  versions: Schema.Array(SkillVersion).check(Schema.isMinLength(1)),
});

export type SkillWithVersion = typeof SkillWithVersion.Type;

export const ResolvedSkillSnapshot = Schema.Struct({
  id: SkillId,
  version: SkillVersion,
  name: SkillName,
  scope: Schema.Literals(["personal", "workspace"]),
  integrity: SkillIntegrity,
});

export type ResolvedSkillSnapshot = typeof ResolvedSkillSnapshot.Type;

export const ResolvedSkillSnapshots = Schema.Array(ResolvedSkillSnapshot).check(
  Schema.isMaxLength(MAX_SKILLS_PER_SCOPE * 2),
);

export const SkillImportFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literals(["file", "symlink"]),
  mediaType: Schema.String.check(Schema.isMaxLength(128)),
  encoding: Schema.Literal("utf-8"),
  content: Schema.String.check(Schema.isMaxLength(MAX_SKILL_FILE_BYTES)),
});

export type SkillImportFile = typeof SkillImportFile.Type;

export const SkillImportBundle = Schema.Struct({
  source: SkillSource,
  files: Schema.Array(SkillImportFile).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(MAX_SKILL_FILES),
  ),
});

export type SkillImportBundle = typeof SkillImportBundle.Type;

export const normalizeSkillName = (value: string): string =>
  value.trim().toLowerCase();
