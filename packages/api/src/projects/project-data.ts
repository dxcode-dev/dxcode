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

export const ProjectDataSchema = Schema.Struct({
  id: ProjectId,
  name: ProjectName,
  description: Schema.optional(ProjectDescription),
  iconUrl: Schema.optional(Schema.String),
  repository: Schema.optional(ProjectRepositoryIdentity),
  additionalRepositories: Schema.optional(ProjectAdditionalRepositories),
  revision: Schema.Int,
  workspaceId: Schema.optional(WorkspaceId),
  configuration: ProjectConfiguration,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ProjectData = typeof ProjectDataSchema.Type;
