import {
  sameTranscriptRows,
  sameTranscriptTurn,
  type TranscriptRow,
  type TranscriptTurn as TranscriptTurnModel,
} from "@dx/client";
import { ChevronRight } from "lucide-react";
import * as React from "react";
import type { ThreadView } from "../../shared/theme/theme-store.js";
import { SimpleTranscriptTurn } from "./simple-view/simple-turn.js";
import { TranscriptActivityList } from "./transcript-activities.js";
import { formatDuration } from "./transcript-duration.js";
import { useThreadPresentation } from "./use-thread-presentation.js";

interface TranscriptTurnProps {
  readonly turn: TranscriptTurnModel;
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly renderRow: (row: TranscriptRow) => React.ReactNode;
  readonly processing?: boolean;
  readonly defaultWorkExpanded?: boolean;
  /** Simple shows only what the agent showed and its answer. */
  readonly view?: ThreadView;
}

/**
 * A settled turn renders identically across stream chunks, scrolling, typing,
 * and layout changes. Compare its content, not the identity of a fresh
 * derivation, so only the turn that actually changed re-renders.
 */
export const TranscriptTurn = React.memo(
  TranscriptTurnView,
  (previous: TranscriptTurnProps, next: TranscriptTurnProps) =>
    previous.renderRow === next.renderRow &&
    previous.processing === next.processing &&
    previous.defaultWorkExpanded === next.defaultWorkExpanded &&
    previous.view === next.view &&
    sameTranscriptTurn(previous.turn, next.turn) &&
    sameTranscriptRows(previous.rows, next.rows),
);

function TranscriptTurnView({ view, ...props }: TranscriptTurnProps) {
  return view === "simple" ? (
    <SimpleTranscriptTurn
      turn={props.turn}
      rows={props.rows}
      renderRow={props.renderRow}
      processing={props.processing ?? props.turn.status === "active"}
    />
  ) : (
    <TranscriptTurnContent {...props} />
  );
}

function TranscriptTurnContent({
  turn,
  rows,
  renderRow,
  processing: processingProp,
  defaultWorkExpanded = false,
}: TranscriptTurnProps) {
  const processing = processingProp ?? turn.status === "active";
  const [workExpanded, setWorkExpanded] = useThreadPresentation(
    `work:${turn.id}`,
    defaultWorkExpanded,
  );
  const prompt = rows.filter((row) => row.kind === "user-prompt");
  const intermediateIds = new Set(turn.intermediateRowIds);
  // The answer: the last reply, and any it follows that came after the work.
  const final = rows.filter(
    (row) => !intermediateIds.has(row.id) && row.kind !== "user-prompt",
  );
  const attachments = rows.filter((row) => row.kind === "attachment");
  const intermediate = rows.filter(
    (row) => intermediateIds.has(row.id) && row.kind !== "attachment",
  );
  const visibleIntermediate = intermediate.filter(
    (row) =>
      !(
        (row.kind === "active-work" || row.kind === "settled-work") &&
        row.part.type === "reasoning"
      ),
  );
  const duration = formatDuration(turn.durationMs);
  const active = turn.status === "active";
  const collapsedIds = new Set(turn.workDisclosure?.collapsedRowIds);
  const retainedIds = new Set(turn.workDisclosure?.retainedRowIds);
  const inView = (row: TranscriptRow) => retainedIds.has(row.id);
  const collapsed = visibleIntermediate.filter(
    (row) => collapsedIds.has(row.id) && !inView(row),
  );
  const retained = visibleIntermediate.filter(inView);
  const pinnedIds = new Set(turn.workDisclosure?.pinnedRowIds);
  const pinned = visibleIntermediate.filter((row) => pinnedIds.has(row.id));
  return (
    <section className="transcript-turn" data-turn-id={turn.id}>
      {prompt.map(renderRow)}
      {attachments.map(renderRow)}
      {active && (visibleIntermediate.length > 0 || processing) ? (
        <TranscriptActivityList
          rows={visibleIntermediate}
          renderRow={renderRow}
          processing={processing}
        />
      ) : turn.workDisclosure ? (
        <>
          {pinned.length > 0 ? (
            <TranscriptActivityList
              rows={pinned}
              renderRow={renderRow}
              processing={false}
            />
          ) : null}
          <details
            className="transcript-turn-work"
            open={workExpanded}
            onToggle={(event) => setWorkExpanded(event.currentTarget.open)}
          >
            <summary>
              <span className="transcript-work-label">
                {turn.workDisclosure.kind === "elapsed"
                  ? duration
                    ? `Worked for ${duration}`
                    : "Worked"
                  : turn.workDisclosure.kind === "stopped"
                    ? "Stopped"
                    : "Show Work"}
                <ChevronRight />
              </span>
            </summary>
            {collapsed.length > 0 ? (
              <TranscriptActivityList
                rows={collapsed}
                renderRow={renderRow}
                processing={false}
              />
            ) : null}
          </details>
          {retained.length > 0 ? (
            <TranscriptActivityList
              rows={retained}
              renderRow={renderRow}
              processing={false}
            />
          ) : null}
        </>
      ) : (
        visibleIntermediate.map(renderRow)
      )}
      {final.map(renderRow)}
    </section>
  );
}
