import type * as React from "react";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import type { SubagentPresentationModel } from "./subagent-presentation.js";
import { ThreadTranscript } from "./thread-transcript.js";

const statusLabel = {
  active: "Processing",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
} as const;

export function SubagentStatusRow({
  model,
  onOpen,
  triggerRef,
}: {
  readonly model: SubagentPresentationModel;
  readonly onOpen: () => void;
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="subagent-status-row"
      onClick={onOpen}
      ref={triggerRef}
      aria-label={`Open ${model.accessibleName}`}
    >
      <span className="subagent-status-title">{model.title}</span>
      <span className="subagent-status-compact">
        <span
          className={`subagent-processing-dot ${model.status === "active" ? "is-active" : ""}`}
          aria-hidden="true"
        />
        {model.status === "active"
          ? model.currentStatus
          : statusLabel[model.status]}
      </span>
    </button>
  );
}

export function SubagentDetailDialog({
  model,
  open,
  onOpenChange,
  finalFocus,
}: {
  readonly model: SubagentPresentationModel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="subagent-detail-dialog" finalFocus={finalFocus}>
        <header className="subagent-dialog-header">
          <DialogTitle>{model.accessibleName}</DialogTitle>
        </header>
        <div className="subagent-dialog-transcript">
          <ThreadTranscript model={model.transcript} />
        </div>
        <footer className="subagent-dialog-current-status" aria-live="polite">
          <span
            className={`subagent-processing-dot ${model.status === "active" ? "is-active" : ""}`}
            aria-hidden="true"
          />
          <span>{model.currentStatus}</span>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}
