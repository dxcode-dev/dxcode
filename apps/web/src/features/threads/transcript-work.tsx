import { ChevronRight } from "lucide-react";
import type * as React from "react";
import { TranscriptActivityList } from "./transcript-activities.js";
import type {
  TranscriptRow,
  TranscriptTurn as TranscriptTurnModel,
} from "./transcript-view-model.js";
import { useThreadPresentation } from "./use-thread-presentation.js";

const formatDuration = (durationMs: number | undefined) => {
  if (durationMs === undefined) return undefined;
  if (durationMs < 30_000) {
    const seconds = Math.max(1, Math.round(durationMs / 1_000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

export function TranscriptTurn({
  turn,
  rows,
  renderRow,
  processing = turn.status === "active",
  defaultWorkExpanded = false,
}: {
  readonly turn: TranscriptTurnModel;
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly renderRow: (row: TranscriptRow) => React.ReactNode;
  readonly processing?: boolean;
  readonly defaultWorkExpanded?: boolean;
}) {
  const [workExpanded, setWorkExpanded] = useThreadPresentation(
    `work:${turn.id}`,
    defaultWorkExpanded,
  );
  const prompt = rows.filter((row) => row.kind === "user-prompt");
  const final = rows.filter((row) => row.id === turn.finalAnswerRowId);
  const attachments = rows.filter((row) => row.kind === "attachment");
  const intermediateIds = new Set(turn.intermediateRowIds);
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
  const collapsed = visibleIntermediate.filter((row) =>
    collapsedIds.has(row.id),
  );
  const retained = visibleIntermediate.filter((row) => retainedIds.has(row.id));
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
