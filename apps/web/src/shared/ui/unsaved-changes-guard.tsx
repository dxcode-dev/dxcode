import { useBlocker } from "@tanstack/react-router";
import { ConfirmDialog } from "./confirm-dialog.js";

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
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
      title="Discard unsaved changes?"
      description="Changes on this settings page have not been saved."
      cancelLabel="Stay on page"
      confirmLabel="Discard and leave"
      destructive
      onConfirm={() => {
        onDiscard();
        blocker.proceed();
      }}
    />
  );
}
