import { Headphones, Minimize2 } from "lucide-react";
import type * as React from "react";
import type { HuddleCallState } from "./huddle-client.js";
import { HuddleControls } from "./huddle-controls.js";
import { featured } from "./huddle-featured.js";
import {
  type HuddlePlace,
  huddleClient,
  huddleView,
} from "./huddle-session.js";
import { HuddleTile } from "./huddle-tile.js";

/** Columns and rows that fill the stage, wide on desktops and tall on phones. */
const gridSize = (count: number) => {
  const wide = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const tall = count <= 2 ? 1 : 2;
  return {
    "--huddle-columns": wide,
    "--huddle-rows": Math.ceil(count / wide),
    "--huddle-columns-phone": tall,
    "--huddle-rows-phone": Math.ceil(count / tall),
  } as React.CSSProperties;
};

const statusLabel = (call: HuddleCallState) =>
  call.status === "joining"
    ? "Joining…"
    : call.status === "reconnecting"
      ? "Reconnecting…"
      : `${call.participants.length} ${call.participants.length === 1 ? "person" : "people"}`;

/**
 * The expanded huddle: everyone's camera in a grid, or a shared screen with
 * everyone in a strip beside it, and the controls below.
 */
export function HuddleStage({
  call,
  place,
}: {
  readonly call: HuddleCallState;
  readonly place: HuddlePlace | undefined;
}) {
  const main = featured(call.participants);
  const sharing = main?.screen === true ? main.participant : undefined;
  const alone = call.status === "connected" && call.participants.length === 1;
  return (
    <div className="huddle-stage-layer">
      <button
        type="button"
        className="huddle-stage-backdrop"
        aria-label="Minimize huddle"
        tabIndex={-1}
        onClick={huddleView.dock}
      />
      <section
        className="huddle-stage"
        aria-label="Huddle"
        data-status={call.status}
      >
        <header className="huddle-stage-header">
          <Headphones aria-hidden="true" className="huddle-stage-icon" />
          <strong className="huddle-stage-title">
            {place?.name ?? "Huddle"}
          </strong>
          <span className="huddle-stage-meta" aria-live="polite">
            {statusLabel(call)}
          </span>
          <span className="huddle-spacer" />
          <button
            type="button"
            className="huddle-header-button"
            aria-label="Minimize huddle"
            title="Minimize"
            onClick={huddleView.dock}
          >
            <Minimize2 aria-hidden="true" />
          </button>
        </header>
        {call.error === undefined ? null : (
          <p className="huddle-banner" role="alert">
            <span>{call.error.message}</span>
            <button type="button" onClick={() => huddleClient.dismissError()}>
              {call.error.action ?? "Dismiss"}
            </button>
          </p>
        )}
        {call.status === "joining" ? (
          <div className="huddle-stage-empty">
            <span className="huddle-pulse" aria-hidden="true" />
            Connecting to the huddle…
          </div>
        ) : sharing !== undefined ? (
          <div className="huddle-stage-body" data-layout="screen">
            <div className="huddle-stage-main">
              <HuddleTile participant={sharing} screen />
            </div>
            <div className="huddle-stage-strip">
              {call.participants.map((participant) => (
                <HuddleTile
                  key={participant.id}
                  participant={participant}
                  size="strip"
                />
              ))}
            </div>
          </div>
        ) : (
          <div
            className="huddle-stage-body"
            data-layout="grid"
            style={gridSize(call.participants.length)}
          >
            {call.participants.map((participant) => (
              <HuddleTile key={participant.id} participant={participant} />
            ))}
            {alone ? (
              <p className="huddle-stage-hint">
                You're the only one here. People in this{" "}
                {place?.scope.kind === "thread" ? "thread" : "Space"} see that a
                huddle is on and can join.
              </p>
            ) : null}
          </div>
        )}
        <footer className="huddle-stage-footer">
          <HuddleControls call={call} size="stage" window="stage" />
        </footer>
      </section>
    </div>
  );
}
