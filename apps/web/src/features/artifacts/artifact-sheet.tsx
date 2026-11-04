import { Dialog } from "@base-ui/react/dialog";
import type { ThreadId } from "@dx/domain";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import { openedArtifactSheet } from "../../shared/navigation/open-artifact.js";
import { ArtifactsView } from "./artifacts-view.js";
import "./artifact-sheet.css";

/**
 * An artifact full screen over the Thread, opened from its card on a phone.
 * Close, Back, or Escape returns to the Thread.
 */
export function ArtifactSheet({
  threadId,
  readOnly,
}: {
  readonly threadId: ThreadId;
  readonly readOnly: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const opened = openedArtifactSheet(useLocation().state);
  // Open pushed a history entry: Close goes back over it, so Back after
  // Close never shows the sheet again. A link that arrived with the sheet
  // open is replaced instead.
  const close = () => {
    if (opened) {
      router.history.back();
      return;
    }
    void navigate({
      to: ".",
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const { sheet: _sheet, ...rest } = previous;
        return rest;
      },
    });
  };
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Popup className="artifact-sheet">
          <div className="artifact-sheet-bar">
            <Dialog.Title className="artifact-sheet-title">
              Artifact
            </Dialog.Title>
            <Dialog.Close
              className="artifact-sheet-close"
              aria-label="Close artifact"
            >
              <X aria-hidden="true" />
              <span>Close</span>
            </Dialog.Close>
          </div>
          <div className="artifact-sheet-body">
            <ArtifactsView threadId={threadId} active readOnly={readOnly} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
