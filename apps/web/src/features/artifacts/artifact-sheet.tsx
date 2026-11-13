import type { ThreadId } from "@dx/domain";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import { openedArtifactSheet } from "../../shared/navigation/open-artifact.js";
import { Button } from "../../shared/ui/button.js";
import {
  SheetClose,
  SheetContent,
  SheetRoot,
  SheetTitle,
} from "../../shared/ui/sheet.js";
import { ArtifactsView } from "./artifacts-view.js";
import "./artifact-sheet.css";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";

/**
 * An artifact full screen over the Thread, opened from its card on a phone.
 * Close, Back, or Escape returns to the Thread.
 */
export function ArtifactSheet({
  threadId,
  readOnly,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly readOnly: boolean;
  /** The composer's mic, when the Thread page offers dictation. */
  readonly dictation?: DictationSlot | undefined;
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
    <SheetRoot open onOpenChange={(open) => (open ? undefined : close())}>
      {/* Under the app's dialogs, so comments and confirmations open over
          it. */}
      <SheetContent
        size="full"
        layer="panel"
        padded={false}
        className="artifact-sheet"
      >
        <div className="artifact-sheet-bar">
          <SheetTitle className="artifact-sheet-title">Artifact</SheetTitle>
          <SheetClose
            render={<Button variant="ghost" className="artifact-sheet-close" />}
            aria-label="Close artifact"
          >
            <X aria-hidden="true" />
            <span>Close</span>
          </SheetClose>
        </div>
        <div className="artifact-sheet-body">
          <ArtifactsView
            threadId={threadId}
            active
            readOnly={readOnly}
            dictation={dictation}
          />
        </div>
      </SheetContent>
    </SheetRoot>
  );
}
