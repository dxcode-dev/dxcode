import {
  artifactListOptions,
  deleteArtifactMutation,
  isMissingArtifact,
} from "../artifacts/artifact-document-queries.js";

/**
 * What the `artifact` tool's delete card reads and writes: the Artifacts
 * view's own list query, so the card and the view answer from one cache, and
 * the view's delete mutation, which refreshes it.
 */

export { isMissingArtifact };

export const artifactListQueryOptions = artifactListOptions;

export const deleteArtifactMutationOptions = deleteArtifactMutation;
