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
        /** The new-Thread composer, framed by `HomeNewThreadFrame`. */
        readonly composer: React.ReactNode;
      }
    | {
        readonly layout: "phone";
        readonly onStartNewThread: () => void;
        /** Draws one static frame of the mark, as for reduced motion. */
        readonly still?: boolean;
      },
) {
  if (props.layout === "wide")
    return (
      <section
        className="authenticated-home"
        data-layout="wide"
        aria-label="DX home"
      >
        {props.composer}
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
      </div>
    </section>
  );
}

/**
 * The home page's frame for the new-Thread composer: the New Thread
 * dialog's surface, in the page. While the composer loads it keeps the
 * composer's height, so nothing moves when it appears.
 */
export function HomeNewThreadFrame({
  loading = false,
  children,
}: {
  readonly loading?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <section
      className="new-thread-surface home-new-thread"
      aria-label="New thread"
      aria-busy={loading || undefined}
    >
      {loading ? (
        <span className="sr-only" role="status">
          Loading New Thread draft…
        </span>
      ) : (
        children
      )}
    </section>
  );
}
