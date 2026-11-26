import type { ChoiceCardOption } from "../ui/choice-cards.js";
import type { ThreadView } from "./theme-store.js";
import "./thread-view-picker.css";

/** A sketch of a turn: the message, then each line as the view draws it. */
function TurnSketch({ view }: { readonly view: ThreadView }) {
  return (
    <span className="thread-view-sketch" data-view={view}>
      <span className="thread-view-sketch-prompt" />
      {view === "detailed" ? (
        <>
          <span className="thread-view-sketch-step" />
          <span className="thread-view-sketch-step" data-width="short" />
          <span className="thread-view-sketch-step" />
          <span className="thread-view-sketch-step" data-width="short" />
          <span className="thread-view-sketch-answer" />
          <span className="thread-view-sketch-answer" data-width="short" />
        </>
      ) : (
        <>
          <span className="thread-view-sketch-answer" />
          <span className="thread-view-sketch-answer" data-width="short" />
          <span className="thread-view-sketch-media">
            <span className="thread-view-sketch-tile" />
            <span className="thread-view-sketch-tile" />
            <span className="thread-view-sketch-tile" />
          </span>
          <span className="thread-view-sketch-meta" />
        </>
      )}
    </span>
  );
}

export const THREAD_VIEW_OPTIONS: ReadonlyArray<ChoiceCardOption<ThreadView>> =
  [
    {
      value: "simple",
      title: "Simple",
      description:
        "The agent's answers, with the pictures, previews, and documents it made. Its steps stay out of the way.",
      preview: <TurnSketch view="simple" />,
    },
    {
      value: "detailed",
      title: "Detailed",
      description:
        "Every step the agent takes as it works: commands, file edits, and searches.",
      preview: <TurnSketch view="detailed" />,
    },
  ];
