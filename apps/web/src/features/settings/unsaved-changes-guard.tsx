import { useBlocker } from "@tanstack/react-router";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { isModeOnlyNavigation } from "./mode-search-navigation.js";
import { shouldBlockUnsavedChanges } from "./unsaved-changes.js";

export function UnsavedChangesGuard({
  dirty,
  onDiscard,
  allowModeChanges = false,
}: {
  readonly dirty: boolean;
  readonly allowModeChanges?: boolean;
  readonly onDiscard: () => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      shouldBlockUnsavedChanges(dirty) &&
      !(allowModeChanges && isModeOnlyNavigation(current, next)),
    enableBeforeUnload: dirty,
    disabled: !dirty,
    withResolver: true,
  });

  if (blocker.status !== "blocked") return null;

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
    >
      <DialogContent>
        <div className="dialog-form">
          <div>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Changes on this settings page have not been saved.
            </DialogDescription>
          </div>
          <div className="dialog-actions">
            <Button
              size="sm"
              variant="outline"
              autoFocus
              onClick={blocker.reset}
            >
              Stay on page
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                onDiscard();
                blocker.proceed();
              }}
            >
              Discard and leave
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
