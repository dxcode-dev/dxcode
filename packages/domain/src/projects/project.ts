import { DateTime, Effect, Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { ProjectConfiguration } from "../settings/project-defaults.js";
import { WorkspaceId } from "../settings/workspace.js";
import { canonicalPublicGitRepositoryLocator } from "../source-control/public-git-repository-locator.js";
import { UserId } from "../users/user-id.js";
import { ProjectId } from "./project-id.js";

export const ProjectDescription = Schema.String.check(Schema.isMaxLength(500));
export const ProjectIconKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
);

export const ProjectRepositoryIdentity = Schema.Struct({
  provider: Schema.Literals([
    "git",
    "github",
    "bitbucket",
    "gitlab",
    "forgejo",
  ]),
  bindingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  fullName: Schema.String,
  webUrl: Schema.String,
  cloneUrl: Schema.optional(Schema.String),
});
export type ProjectRepositoryIdentity = typeof ProjectRepositoryIdentity.Type;

/**
 * A repository cloned beside the primary checkout, under
 * `~/workspace/repos/<name>`, in every Thread workspace of the Project. It is
 * identity only: the Thread owner's native Git credential decides access.
 */
export const ProjectAdditionalRepository = Schema.Struct({
  provider: Schema.Literals(["git", "github", "bitbucket"]),
  fullName: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(512)),
  webUrl: Schema.String,
  cloneUrl: Schema.String,
});
export type ProjectAdditionalRepository =
  typeof ProjectAdditionalRepository.Type;

export const MAX_PROJECT_ADDITIONAL_REPOSITORIES = 10;

export const ProjectAdditionalRepositories = Schema.Array(
  ProjectAdditionalRepository,
).check(Schema.isMaxLength(MAX_PROJECT_ADDITIONAL_REPOSITORIES));

/** Canonical identity for an additional repository URL, or `undefined`. */
export const projectAdditionalRepositoryFromUrl = (
  url: string,
): ProjectAdditionalRepository | undefined => {
  const locator = canonicalPublicGitRepositoryLocator(url);
  if (locator === undefined) return undefined;
  const host = new URL(locator.webUrl).hostname;
  const twoSegments = locator.fullName.split("/").length === 2;
  const provider =
    host === "github.com" && twoSegments
      ? ("github" as const)
      : host === "bitbucket.org" && twoSegments
        ? ("bitbucket" as const)
        : ("git" as const);
  return { provider, ...locator };
};

export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const PROJECTLESS_PROJECT_NAME = "No Project";
export const PROJECT_NAME_HELP =
  "Use 2–64 letters, numbers, periods, hyphens, or underscores.";

export const normalizeProjectName = (value: string) => value.trim();
export const isValidProjectName = (value: string) => {
  const normalized = normalizeProjectName(value);
  return (
    normalized.length >= 2 &&
    normalized.length <= 64 &&
    PROJECT_NAME_PATTERN.test(normalized)
  );
};

export const ProjectName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
export const ProjectNameInput = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(PROJECT_NAME_PATTERN),
);

export type ProjectName = typeof ProjectName.Type;
export type ProjectNameInput = typeof ProjectNameInput.Type;

export const Project = Schema.Struct({
  id: ProjectId,
  ownerUserId: UserId,
  workspaceId: Schema.optional(WorkspaceId),
  name: ProjectName,
  description: Schema.optional(ProjectDescription),
  iconKey: Schema.optional(ProjectIconKey),
  repository: Schema.optional(ProjectRepositoryIdentity),
  additionalRepositories: ProjectAdditionalRepositories.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  configuration: ProjectConfiguration,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Project = typeof Project.Type;

export const CreateProjectInput = Schema.Struct({
  ownerUserId: UserId,
  workspaceId: Schema.optional(WorkspaceId),
  name: ProjectNameInput,
  description: Schema.optional(ProjectDescription),
  repository: Schema.optional(ProjectRepositoryIdentity),
  additionalRepositories: Schema.optional(ProjectAdditionalRepositories),
  configuration: ProjectConfiguration,
});

export type CreateProjectInput = typeof CreateProjectInput.Type;

export const createProject = Effect.fn("createProject")(function* (
  input: CreateProjectInput,
) {
  const now = yield* DateTime.now;
  const id = yield* Schema.decodeUnknownEffect(ProjectId)(
    `prj_${crypto.randomUUID()}`,
  );

  return yield* Schema.decodeUnknownEffect(Schema.toType(Project))({
    id,
    ...input,
    additionalRepositories: input.additionalRepositories ?? [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
});
