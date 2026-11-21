import { useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import type { ComposerEmail } from "../../shared/new-thread-surface.js";
import { DialogRoot } from "../../shared/ui/dialog.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { InsertCurrentThreadButton } from "./insert-current-thread.js";
import { newThreadLabel } from "./new-thread-label.js";

/** The composer as a dialog over the page, with Close and its header. */
export function NewThreadDialog({
  email,
  textareaRef,
  finalFocus,
  onClose,
  prompt,
  submitting,
  onPromptChange,
  spotlight,
  children,
}: {
  readonly email?: ComposerEmail;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly finalFocus?: React.ComponentProps<typeof ModalSurface>["finalFocus"];
  readonly onClose: () => void;
  readonly prompt: string;
  readonly submitting: boolean;
  readonly onPromptChange: (prompt: string) => void;
  /** A `SpotlightBand` that frames the dialog, such as Set up Orbs. */
  readonly spotlight?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <ModalSurface
        className="new-thread-dialog"
        ariaLabel={newThreadLabel(email)}
        initialFocus={textareaRef}
        finalFocus={finalFocus}
        spotlight={spotlight}
      >
        <NewThreadModalHeader
          prompt={prompt}
          textareaRef={textareaRef}
          disabled={submitting}
          onPromptChange={onPromptChange}
        />
        {children}
      </ModalSurface>
    </DialogRoot>
  );
}

/** Close, and over an open Thread, Insert Current Thread. */
function NewThreadModalHeader(
  props: Omit<
    React.ComponentProps<typeof InsertCurrentThreadButton>,
    "threadId"
  >,
) {
  // The Thread open behind the dialog, if any: its URL can go in the prompt.
  const threadId = useRouterState({
    select: (state) =>
      state.matches
        .map(({ params }) => (params as { threadId?: string }).threadId)
        .find((id) => id !== undefined),
  });
  return (
    <ModalSurfaceHeader>
      <ModalSurfaceClose />
      {threadId === undefined ? null : (
        <InsertCurrentThreadButton threadId={threadId} {...props} />
      )}
    </ModalSurfaceHeader>
  );
}
