/**
 * PATCH /v1/projects/:id input. Apart from the responses in
 * `update-project.ts`, so the web client, which imports only those, does not
 * bundle the remote-alias parser this validation needs.
 */
import {
  CommitAuthorPreference,
  GitRemoteAliasInput,
  MAX_PROJECT_ADDITIONAL_REPOSITORIES,
  MAX_PROJECT_REMOTE_ALIASES,
  ProjectDescription,
  ProjectId,
  ProjectNameInput,
  ProjectShipAction,
  PublicGitRepositoryUrl,
  RunnerProfileId,
  ShipPrompt,
} from "@dx/domain";
import { Schema } from "effect";

export const UpdateProjectParamsSchema = Schema.Struct({
  projectId: ProjectId,
});
export const UpdateProjectRequestSchema = Schema.Struct({
  revision: Schema.Int,
  name: Schema.optional(ProjectNameInput),
  description: Schema.optional(ProjectDescription),
  runnerProfileId: Schema.optional(RunnerProfileId),
  /** Custom Ship needs a prompt, sent with it or already saved. */
  shipAction: Schema.optional(ProjectShipAction),
  shipPrompt: Schema.optional(ShipPrompt),
  commitAuthor: Schema.optional(CommitAuthorPreference),
  dxCoAuthor: Schema.optional(Schema.Boolean),
  additionalRepositories: Schema.optional(
    Schema.Array(PublicGitRepositoryUrl).check(
      Schema.isMaxLength(MAX_PROJECT_ADDITIONAL_REPOSITORIES),
    ),
  ),
  /** Replaces the whole list. */
  remoteAliases: Schema.optional(
    Schema.Array(GitRemoteAliasInput).check(
      Schema.isMaxLength(MAX_PROJECT_REMOTE_ALIASES),
    ),
  ),
});
