import { SquarePen } from "lucide-react";
import type * as React from "react";
import { DxMark } from "../../shared/brand/dx-mark.js";
import { Button } from "../../shared/ui/button.js";
import "./home-screen.css";

/**
 * The signed-in home page (`/`). Wide screens show the new-Thread composer
 * in the page; a phone shows the dx mark with a button that opens the
 * composer.
 */
export function HomeScreen(
  props:
    | {
        readonly layout: "wide";
        /** The new-Thread composer, inline (`InlineNewThread`). */
        readonly composer: React.ReactNode;
        /** A new account's setup checklist, under the composer. */
        readonly checklist?: React.ReactNode;
      }
    | {
        readonly layout: "phone";
        readonly onStartNewThread: () => void;
        /** Draws one static frame of the mark, as for reduced motion. */
        readonly still?: boolean;
        /** A new account's setup checklist, under the button. */
        readonly checklist?: React.ReactNode;
      },
) {
  if (props.layout === "wide")
    return (
      <section
        className="authenticated-home"
        data-layout="wide"
        aria-label="DX home"
      >
        {props.checklist === undefined ? (
          props.composer
        ) : (
          <div className="home-with-checklist">
            {props.composer}
            {props.checklist}
          </div>
        )}
      </section>
    );
  return (
    <section
      className="authenticated-home"
      data-layout="phone"
      aria-label="DX home"
    >
      <div className="home-phone-start">
        <DxMark state="idle" interactive still={props.still} />
        <Button size="lg" shape="round" onClick={props.onStartNewThread}>
          <SquarePen aria-hidden="true" />
          Start new thread
        </Button>
        {props.checklist}
      </div>
    </section>
  );
}
