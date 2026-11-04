import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import {
  lastSaveOf,
  restartOrbMutationOptions,
} from "./orb-restart-mutations.js";

const savedTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Asks before restarting the Thread's Orb (#1592), and says what a restart
 * does: files are kept, running processes stop. When the Orb's files can't
 * be saved (a full disk), it offers to restart from the last save instead,
 * saying what is lost.
 */
export function RestartOrbDialog({
  threadId,
  onClose,
}: {
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const restart = useMutation(restartOrbMutationOptions(queryClient, threadId));
  const lastSave = lastSaveOf(restart.error);
  const confirm = (discardUnsaved: boolean) =>
    restart.mutate(discardUnsaved ? { discardUnsaved: true } : {}, {
      onSuccess: ({ files, rescue, restoredName }) => {
        toast(
          files === "kept"
            ? "Orb restarted. Its files were kept."
            : `Orb restarted ${files === "earlier" ? "from its last save" : "from a fresh image"}.${
                rescue === "copied" && restoredName !== undefined
                  ? ` Unsaved work was copied to ~/dx-recovered/${restoredName}.`
                  : rescue === "failed"
                    ? " Its unsaved work couldn't be copied."
                    : ""
              }`,
        );
        onClose();
      },
    });
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={
        lastSave === undefined
          ? "Restart the Orb?"
          : "Restart the Orb from its last save?"
      }
      description={
        lastSave === undefined ? (
          "dx saves the Orb and starts it again. Its files are kept. Running processes, such as dev servers, tests, and the Terminal's commands, stop."
        ) : (
          <>
            dx couldn't save the Orb's files, so it didn't restart it. Its disk
            may be full. It can start again from its last save, made{" "}
            {savedTime.format(lastSave)}. Everything that changed since is lost.
            Before that, dx tries to copy the checkout's uncommitted changes,
            untracked files, and unpushed commits into ~/dx-recovered/ and the
            Thread's storage.
          </>
        )
      }
      error={
        restart.isError && lastSave === undefined
          ? restart.error instanceof Error && restart.error.message !== ""
            ? restart.error.message
            : "The Orb could not be restarted."
          : undefined
      }
      confirmLabel={
        restart.isPending
          ? "Restarting…"
          : lastSave === undefined
            ? "Restart Orb"
            : "Restart From Last Save"
      }
      destructive={lastSave !== undefined}
      pending={restart.isPending}
      onConfirm={() => confirm(lastSave !== undefined)}
    />
  );
}
