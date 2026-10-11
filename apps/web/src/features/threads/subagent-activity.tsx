import { ChevronRight, Maximize2, X } from "lucide-react";
import * as React from "react";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import type { SubagentView } from "./subagent-view.js";
import type { ToolPart } from "./transcript-activity-projection.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";

type RenderStep = (part: ToolPart, key: string) => React.ReactNode;

const STATUS_LABEL: Readonly<Record<SubagentView["status"], string>> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
};

const heading = (view: SubagentView) => `Subagent (${view.type})`;

const duration = (milliseconds: number) =>
  milliseconds < 60_000
    ? `${Math.max(1, Math.round(milliseconds / 1000))}s`
    : `${Math.round(milliseconds / 60_000)}m`;

/** The prompt, the subagent's own steps, and its report. */
function SubagentBody({
  view,
  renderStep,
}: {
  readonly view: SubagentView;
  readonly renderStep: RenderStep;
}) {
  const meta = [
    view.model,
    view.durationMs === undefined ? undefined : duration(view.durationMs),
  ].filter((part) => part !== undefined);
  return (
    <div className="subagent-body">
      {view.prompt === "" ? null : (
        <section className="subagent-prompt" aria-label="Subagent prompt">
          {view.prompt}
        </section>
      )}
      {view.steps.length === 0 ? null : (
        <div className="subagent-steps">
          {view.steps.map((step) =>
            step.kind === "text" ? (
              <div className="subagent-step-text" key={step.id}>
                <TranscriptMarkdown>{step.text}</TranscriptMarkdown>
              </div>
            ) : (
              renderStep(step.part, step.id)
            ),
          )}
        </div>
      )}
      {view.error === undefined ? null : (
        <p className="subagent-error" role="alert">
          {view.error}
        </p>
      )}
      {view.report === undefined ? null : (
        <section className="subagent-report" aria-label="Subagent report">
          <TranscriptMarkdown>{view.report}</TranscriptMarkdown>
        </section>
      )}
      {meta.length === 0 ? null : (
        <p className="subagent-meta">{meta.join(" · ")}</p>
      )}
    </div>
  );
}

/**
 * A subagent in the transcript: a row naming its type and status, which
 * opens an inline card and, from there, a full view.
 */
export function SubagentActivity({
  view,
  renderStep,
}: {
  readonly view: SubagentView;
  readonly renderStep: RenderStep;
}) {
  const [open, setOpen] = React.useState(false);
  const [full, setFull] = React.useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="subagent-row"
        data-status={view.status}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        <span>
          {heading(view)} {STATUS_LABEL[view.status]}
        </span>
        <ChevronRight
          className="transcript-activity-chevron"
          aria-hidden="true"
        />
      </button>
    );
  return (
    <section className="subagent-card" aria-label={`${heading(view)} details`}>
      <header className="subagent-card-head">
        <strong>{heading(view)}</strong>
        <span className="subagent-card-description">{view.description}</span>
        <button
          type="button"
          className="subagent-card-action"
          aria-label="Open subagent in full view"
          onClick={() => setFull(true)}
        >
          <Maximize2 aria-hidden="true" />
        </button>
        <button
          type="button"
          className="subagent-card-action"
          aria-label="Close subagent"
          onClick={() => setOpen(false)}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="subagent-card-scroll">
        <SubagentBody view={view} renderStep={renderStep} />
      </div>
      <DialogRoot open={full} onOpenChange={setFull}>
        <DialogContent className="subagent-dialog">
          <DialogTitle>{heading(view)}</DialogTitle>
          <DialogDescription>{view.description}</DialogDescription>
          <div className="subagent-dialog-scroll">
            <SubagentBody view={view} renderStep={renderStep} />
          </div>
        </DialogContent>
      </DialogRoot>
    </section>
  );
}
