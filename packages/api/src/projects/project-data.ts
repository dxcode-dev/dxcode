import {
  ProjectAdditionalRepositories,
  ProjectConfiguration,
  ProjectDescription,
  ProjectId,
  ProjectName,
  ProjectRepositoryIdentity,
  Timestamp,
  WorkspaceId,
} from "@dx/domain";
import { Schema } from "effect";

/**
 * What the requesting user may do with a Project. A workspace member starts
 * Threads in a connected Project with their own source-control connection.
 */
export const ProjectViewerAccessSchema = Schema.Struct({
  canManage: Schema.Boolean,
  threads: Schema.Union([
    Schema.Struct({ status: Schema.Literal("available") }),
    Schema.Struct({
      status: Schema.Literals(["connect", "no-repository-access"]),
      provider: Schema.Literals(["github", "bitbucket"]),
    }),
  ]),
});

export type ProjectViewerAccess = typeof ProjectViewerAccessSchema.Type;

export const ProjectDataSchema = Schema.Struct({
  id: ProjectId,
  name: ProjectName,
  description: Schema.optional(ProjectDescription),
  iconUrl: Schema.optional(Schema.String),
  repository: Schema.optional(ProjectRepositoryIdentity),
  additionalRepositories: Schema.optional(ProjectAdditionalRepositories),
  revision: Schema.Int,
  workspaceId: Schema.optional(WorkspaceId),
  viewerAccess: Schema.optional(ProjectViewerAccessSchema),
  configuration: ProjectConfiguration,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ProjectData = typeof ProjectDataSchema.Type;
