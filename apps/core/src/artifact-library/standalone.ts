import type { ArtifactSharing, ThreadArtifactKind } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  type ArtifactBindings,
  type ArtifactWithMarkdown,
  type ArtifactWriter,
  createArtifact,
} from "../thread-artifacts/store.js";
import { ownerWorkspaceId } from "../thread-sharing/service.js";

/**
 * Standalone artifacts: made from the Artifacts library or by the agent with
 * `standalone: true`, they belong to their owner with no Thread and no
 * Project. Sharing is the artifact's own, per artifact.
 */

export type CreateStandaloneResult =
  | {
      readonly kind: "created";
      readonly artifactId: string;
      readonly value: ArtifactWithMarkdown;
    }
  | { readonly kind: "invalid"; readonly message: string };

/** Creates a standalone artifact at revision 1, private to `ownerUserId`. */
export const createStandaloneArtifact = async (
  bindings: ArtifactBindings,
  input: {
    readonly ownerUserId: string;
    readonly title: string;
    readonly kind?: ThreadArtifactKind;
    readonly markdown?: string;
    readonly writer: ArtifactWriter;
    readonly now?: Date;
  },
): Promise<CreateStandaloneResult> => {
  const result = await createArtifact(bindings, {
    threadId: null,
    ownerUserId: input.ownerUserId,
    title: input.title,
    kind: input.kind ?? "document",
    markdown: input.markdown ?? "",
    writer: input.writer,
    now: (input.now ?? new Date()).getTime(),
  });
  if (result.kind === "saved")
    return {
      kind: "created",
      artifactId: result.value.artifact.id,
      value: result.value,
    };
  return {
    kind: "invalid",
    message:
      result.kind === "invalid"
        ? result.message
        : result.kind === "too-large"
          ? "The artifact is too large."
          : "The artifact could not be created.",
  };
};

export type ShareResult =
  | { readonly kind: "shared" }
  | { readonly kind: "no-workspace" };

/**
 * Sets who besides its owner opens a standalone artifact: no one, every
 * member of the owner's workspace to read, or to edit. The caller has
 * checked that `ownerUserId` owns `artifactId`.
 */
export const shareStandaloneArtifact = async (
  db: D1Database,
  input: {
    readonly artifactId: string;
    readonly ownerUserId: UserId;
    readonly sharing: ArtifactSharing;
  },
): Promise<ShareResult> => {
  const workspaceId =
    input.sharing === "private"
      ? undefined
      : await ownerWorkspaceId(db, input.ownerUserId);
  if (input.sharing !== "private" && workspaceId === undefined)
    return { kind: "no-workspace" };
  await db
    .prepare(
      `UPDATE thread_artifact
          SET workspace_access = ?2, shared_workspace_id = ?3
        WHERE id = ?1 AND thread_id IS NULL AND owner_user_id = ?4
          AND deleted_at IS NULL`,
    )
    .bind(
      input.artifactId,
      input.sharing === "private" ? "none" : input.sharing,
      workspaceId ?? null,
      input.ownerUserId,
    )
    .run();
  return { kind: "shared" };
};
