import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, Trash2 } from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import {
  artifactListOptions,
  deleteArtifactMutation,
  isMissingArtifact,
} from "../artifact-document-queries.js";
import type { ArtifactSession } from "./artifact-session.js";

/** A folder name the artifact store takes: one name, no `/`. */
const folderProblem = (folder: string) =>
  folder.includes("/")
    ? "A folder is one name, without /."
    : folder.length > 64
      ? "Use 64 characters or fewer."
      : undefined;

/**
 * The switcher's file actions, as the reference editor has them: Move to
 * Folder… and Delete Artifact…, for people who can edit. `items` go in the
 * switcher's menu; `dialogs` render beside the editor, since the menu
 * closes as an item is chosen.
 */
export function useArtifactFileActions({
  session,
  threadId,
  artifactId,
  folder,
  readOnly,
}: {
  readonly session: ArtifactSession;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly folder: string;
  readonly readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [moving, setMoving] = React.useState(false);
  const [target, setTarget] = React.useState(folder);
  const [deleting, setDeleting] = React.useState(false);
  const remove = useMutation(
    deleteArtifactMutation(queryClient, threadId, artifactId),
  );
  const listed = useQuery(artifactListOptions(threadId, !readOnly)).data;
  const folders = new Set<string>();
  for (const artifact of listed ?? [])
    if (artifact.folder !== "") folders.add(artifact.folder);
  if (readOnly) return { items: null, dialogs: null };
  const problem = folderProblem(target.trim());
  const items = (
    <>
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className="thread-menu-item"
        onClick={() => {
          setTarget(folder);
          setMoving(true);
        }}
      >
        <FolderInput aria-hidden="true" />
        Move to Folder…
      </Menu.Item>
      <Menu.Item
        className="thread-menu-item"
        data-tone="destructive"
        onClick={() => setDeleting(true)}
      >
        <Trash2 aria-hidden="true" />
        Delete Artifact…
      </Menu.Item>
    </>
  );
  const dialogs = (
    <>
      <ConfirmDialog
        open={moving}
        onOpenChange={setMoving}
        title="Move to Folder"
        description="Leave it empty to keep the artifact outside any folder."
        confirmLabel="Move"
        confirmDisabled={problem !== undefined}
        {...(problem === undefined ? {} : { error: problem })}
        onConfirm={() => {
          session.moveTo(target);
          setMoving(false);
        }}
      >
        <input
          className="artifact-folder-input"
          aria-label="Folder"
          list="artifact-folders"
          value={target}
          maxLength={80}
          onChange={(event) => setTarget(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && problem === undefined) {
              event.preventDefault();
              session.moveTo(target);
              setMoving(false);
            }
          }}
        />
        <datalist id="artifact-folders">
          {[...folders].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this artifact?"
        description="It is deleted for everyone in this Thread, with its comments."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        {...(remove.isError && !isMissingArtifact(remove.error)
          ? { error: "Couldn't delete it. Try again." }
          : {})}
        onConfirm={() =>
          remove.mutate(undefined, { onSuccess: () => setDeleting(false) })
        }
      />
    </>
  );
  return { items, dialogs };
}
