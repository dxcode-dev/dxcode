import { Effect, Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { McpServerId } from "./mcp-server.js";
import { PluginId } from "./plugin-id.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_SKILLS_PER_SCOPE = 20;
/** Files a skill holds besides its instructions: scripts, references, assets. */
export const MAX_SKILL_RESOURCE_FILES = 200;
/** An import bundle's files: the resources plus the instructions and manifest. */
export const MAX_SKILL_FILES = MAX_SKILL_RESOURCE_FILES + 2;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const MAX_SKILL_TOTAL_BYTES = 5_242_880;
/**
 * A SKILL.md body, held to the same limit as any other file of a skill. The
 * agent reads it only when it uses the skill, so its size costs no context
 * until then.
 */
export const MAX_SKILL_INSTRUCTIONS_BYTES = 1_048_576;
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

/**
 * A path a skill file may have: relative segments of letters and digits in
 * any script, spaces, and `_ - . + @ ~ , ( ) [ ] =`, none hidden (a leading
 * `.`) or empty, at most 256 characters. No character the Orb installer's
 * shell quoting would read (`$`, backtick, quotes, backslash) is allowed.
 */
export const isSafeSkillFilePath = (path: string) =>
  path.length > 0 &&
  path.length <= 256 &&
  path
    .split("/")
    .every(
      (segment) =>
        /^[\p{L}\p{N}\p{M}_+@~,()[\]= .-]+$/u.test(segment) &&
        !segment.startsWith(".") &&
        segment.trim() === segment,
    );

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

const SkillSourceLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);

/** Files a person chose in the browser, or that another importer read. */
export const BrowserFilesSkillSource = Schema.Struct({
  type: Schema.Literal("browser-files"),
  label: SkillSourceLabel,
});

/**
 * A skill folder of a public GitHub repository. A skill installed from a
 * GitHub URL records the folder and the commit it was read at. One
 * installed from a directory such as skills.sh records that directory's ID
 * and content hash; the directory read the folder, so its path and commit
 * are not known.
 */
export const GitHubSkillSource = Schema.Struct({
  type: Schema.Literal("github"),
  label: SkillSourceLabel,
  repository: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
  ),
  /** The skill's folder inside the repository; empty for the root. */
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  commit: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ),
  registry: Schema.optional(
    Schema.Struct({
      name: Schema.Literal("skills.sh"),
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      hash: Schema.optional(
        Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      ),
    }),
  ),
});

export const SkillSource = Schema.Union([
  BrowserFilesSkillSource,
  GitHubSkillSource,
]);

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

/** A file of a skill version without its content, which loads on demand. */
export const SkillResourceInfo = Schema.Struct({
  path: SkillResourcePath,
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_SKILL_FILE_BYTES }),
  ),
  integrity: SkillIntegrity,
});

export type SkillResourceInfo = typeof SkillResourceInfo.Type;

export const SkillResource = Schema.Struct({
  ...SkillResourceInfo.fields,
  content: Schema.String.check(Schema.isMaxLength(MAX_SKILL_FILE_BYTES)),
});

export type SkillResource = typeof SkillResource.Type;

export const StoredSkillVersion = Schema.Struct({
  skillId: SkillId,
  version: SkillVersion,
  manifest: SkillManifest,
  instructions: SkillInstructions,
  /** The version's files; their content loads through the repository. */
  resources: Schema.Array(SkillResourceInfo).check(
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
  /** The plugin bundle that installed this skill, when one did. */
  pluginId: Schema.optional(PluginId),
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

/**
 * Files a person chose in the browser: a SKILL.md folder, or dx's layout
 * (skill.json and instructions.md), with the skill's other files.
 */
export const SkillImportBundle = Schema.Struct({
  source: BrowserFilesSkillSource,
  files: Schema.Array(SkillImportFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SKILL_FILES),
  ),
});

export type SkillImportBundle = typeof SkillImportBundle.Type;

export const normalizeSkillName = (value: string): string =>
  value.trim().toLowerCase();
