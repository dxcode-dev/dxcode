import type { TranscriptRow, TranscriptTurn } from "@dx/client";
import { ExternalLink, GitPullRequest } from "lucide-react";
import * as React from "react";
import { useTimeText } from "../../../shared/hooks/use-clock.js";
import { chipVariants } from "../../../shared/ui/chip-variants.js";
import { ImageTiles } from "../message-attachments-ui.js";
import { ProcessingIndicator } from "../processing-indicator.js";
import {
  ToolMediaSourceContext,
  toolImages,
} from "../tool-output-media-model.js";
import { TranscriptActivityList } from "../transcript-activities.js";
import { formatDuration } from "../transcript-duration.js";
import {
  SIMPLE_ACTIVITY_TEXT,
  type SimpleActivity,
  type SimpleLink,
  type SimpleTurn,
  simpleTurn,
} from "./simple-turn-model.js";
import "./simple-view.css";

const MINUTE_MS = 60_000;

/** A turn by the start of what the person asked, for its landmarks' names. */
const turnName = (simple: SimpleTurn) => {
  const prompt = simple.prompts[0];
  const text = prompt?.kind === "user-prompt" ? prompt.text.trim() : "";
  if (text === "") return "this turn";
  return `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
};

/** A running turn's time, once it passes a minute; nothing before. */
const elapsedText = (startedAt: number | undefined, now: number) => {
  if (startedAt === undefined) return "";
  const minutes = Math.floor((now - startedAt) / MINUTE_MS);
  return minutes < 1 ? "" : (formatDuration(minutes * MINUTE_MS) ?? "");
};

/**
 * What a running turn shows instead of its steps: a breathing dot, what
 * the agent is doing in plain words, and, after a minute, for how long.
 */
export function SimpleWorkingLine({
  activity,
  startedAt,
}: {
  readonly activity: SimpleActivity;
  /** When the turn began, in epoch ms; the time shows after a minute. */
  readonly startedAt?: number;
}) {
  const elapsed = useTimeText((now) => elapsedText(startedAt, now));
  const text = SIMPLE_ACTIVITY_TEXT[activity];
  return (
    <div className="simple-turn-status" data-state="working">
      <ProcessingIndicator
        accessibleLabel={elapsed === "" ? text : `${text}, ${elapsed}`}
        label={
          <span className="simple-turn-status-text">
            {/* Keyed so each new step fades in rather than swapping. */}
            <span key={activity} className="simple-turn-activity">
              {text}
            </span>
            {elapsed === "" ? null : (
              <span className="simple-turn-elapsed">{elapsed}</span>
            )}
          </span>
        }
      />
    </div>
  );
}

/** A finished turn's one line: how it ended and how long it took. */
export function SimpleTurnSummary({
  outcome,
  durationMs,
}: {
  readonly outcome: Exclude<SimpleTurn["outcome"], "working">;
  readonly durationMs?: number;
}) {
  const duration = formatDuration(durationMs);
  const text =
    outcome === "done"
      ? duration === undefined
        ? "Done"
        : `Done in ${duration}`
      : outcome === "stopped"
        ? duration === undefined
          ? "Stopped"
          : `Stopped after ${duration}`
        : duration === undefined
          ? "Didn't finish"
          : `Didn't finish after ${duration}`;
  return (
    <p className="simple-turn-status" data-state={outcome}>
      {text}
    </p>
  );
}

/** Images the turn captured, such as screenshots, as one strip of tiles. */
function SimpleTurnMedia({
  parts,
  label,
}: {
  readonly parts: SimpleTurn["mediaParts"];
  /** Names the strip; unique among the Thread's turns. */
  readonly label: string;
}) {
  const source = React.useContext(ToolMediaSourceContext);
  const images = parts.flatMap((part) =>
    toolImages(part, source).map((image) => ({
      ...image,
      key: `${part.toolCallId}:${image.key}`,
    })),
  );
  if (images.length === 0) return null;
  return (
    <ImageTiles images={images} label={label} className="simple-turn-media" />
  );
}

/** Pull requests and links the turn produced that its answer leaves out. */
function SimpleTurnLinks({
  links,
  label,
}: {
  readonly links: ReadonlyArray<SimpleLink>;
  /** Names the list; unique among the Thread's turns. */
  readonly label: string;
}) {
  if (links.length === 0) return null;
  return (
    <ul className="simple-turn-links" aria-label={label}>
      {links.map((link) => (
        <li key={link.url}>
          <a
            className={chipVariants({ variant: "outline", size: "sm" })}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            title={link.url}
          >
            {link.kind === "pull-request" ? (
              <GitPullRequest aria-hidden="true" />
            ) : (
              <ExternalLink aria-hidden="true" />
            )}
            <span className="simple-turn-link-label">{link.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * One turn in the Simple thread view (Settings → Appearance → Thread View):
 * the person's message, the cards and media the agent showed, its answer,
 * then one line saying how the turn ended and how long it took. While it
 * runs, a single line says what the agent is doing.
 */
export function SimpleTranscriptTurn({
  turn,
  rows,
  renderRow,
  processing,
}: {
  readonly turn: TranscriptTurn;
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly renderRow: (row: TranscriptRow) => React.ReactNode;
  readonly processing: boolean;
}) {
  const simple = simpleTurn(turn, rows, processing);
  const answered = rows.some(
    (row) => row.kind !== "user-prompt" && row.kind !== "attachment",
  );
  return (
    <section
      className="transcript-turn simple-turn"
      data-turn-id={turn.id}
      data-outcome={simple.outcome}
    >
      {simple.prompts.map(renderRow)}
      {simple.attachments.map(renderRow)}
      {simple.shown.length > 0 ? (
        <TranscriptActivityList
          rows={simple.shown}
          renderRow={renderRow}
          processing={false}
        />
      ) : null}
      {simple.answer.map(renderRow)}
      <SimpleTurnMedia
        parts={simple.mediaParts}
        label={`Images from ${turnName(simple)}`}
      />
      <SimpleTurnLinks
        links={simple.links}
        label={`Links from ${turnName(simple)}`}
      />
      {simple.outcome === "working" ? (
        // A queued message's turn waits silently; only the running one speaks.
        processing ? (
          <SimpleWorkingLine
            activity={simple.activity}
            {...(simple.startedAt === undefined
              ? {}
              : { startedAt: simple.startedAt })}
          />
        ) : null
      ) : answered ? (
        <SimpleTurnSummary
          outcome={simple.outcome}
          {...(simple.durationMs === undefined
            ? {}
            : { durationMs: simple.durationMs })}
        />
      ) : null}
    </section>
  );
}
