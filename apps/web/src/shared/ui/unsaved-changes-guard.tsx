import { useBlocker } from "@tanstack/react-router";
import { Button } from "./button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "./dialog.js";

interface GuardedLocation {
  readonly pathname: string;
  readonly search: Readonly<Record<string, unknown>>;
}

/**
 * Asks "Discard unsaved changes?" before navigating away from a dirty
 * settings form, and enables the browser's beforeunload prompt.
 */
export function UnsavedChangesGuard({
  dirty,
  onDiscard,
  allowNavigation,
}: {
  readonly dirty: boolean;
  /** Navigations that keep the form mounted and so need no prompt. */
  readonly allowNavigation?: (
    current: GuardedLocation,
    next: GuardedLocation,
  ) => boolean;
  readonly onDiscard: () => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty && !(allowNavigation?.(current, next) ?? false),
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
