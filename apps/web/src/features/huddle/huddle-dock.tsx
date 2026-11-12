import { Headphones } from "lucide-react";
import * as React from "react";
import type { HuddleCallState } from "./huddle-client.js";
import { HuddleControls } from "./huddle-controls.js";
import { featured } from "./huddle-featured.js";
import {
  type HuddleCorner,
  type HuddlePlace,
  huddleView,
} from "./huddle-session.js";
import { HuddleTile } from "./huddle-tile.js";

const nearestCorner = (x: number, y: number): HuddleCorner =>
  `${y < window.innerHeight / 2 ? "top" : "bottom"}-${x < window.innerWidth / 2 ? "left" : "right"}`;

/**
 * The huddle's contents in a small window: the featured person or screen,
 * where the huddle is, and the controls. Shared by the in-page dock and the
 * browser's Picture-in-Picture window.
 */
export function HuddleDockContent({
  call,
  place,
  window: where,
  onOpenPlace,
  dragHandle,
}: {
  readonly call: HuddleCallState;
  readonly place: HuddlePlace | undefined;
  readonly window: "dock" | "popout";
  readonly onOpenPlace: (place: HuddlePlace) => void;
  readonly dragHandle?: React.HTMLAttributes<HTMLElement>;
}) {
  const main = featured(call.participants);
  const speaker = call.participants.find(({ speaking }) => speaking);
  return (
    <>
      <div className="huddle-dock-video" {...dragHandle}>
        {call.status === "joining" || main === undefined ? (
          <div className="huddle-stage-empty">
            <span className="huddle-pulse" aria-hidden="true" />
            Connecting…
          </div>
        ) : (
          <HuddleTile
            participant={main.participant}
            screen={main.screen}
            size="dock"
          />
        )}
      </div>
      <div className="huddle-dock-bar">
        <button
          type="button"
          className="huddle-dock-place"
          title={place === undefined ? undefined : `Open ${place.name}`}
          disabled={place === undefined}
          onClick={() => {
            if (place !== undefined) onOpenPlace(place);
          }}
        >
          <Headphones aria-hidden="true" />
          <span className="huddle-dock-place-name">
            {place?.name ?? "Huddle"}
          </span>
          <span className="huddle-dock-count">
            {speaker !== undefined && !speaker.isSelf
              ? `${speaker.name.split(" ")[0]} is speaking`
              : `${call.participants.length} in huddle`}
          </span>
        </button>
        <HuddleControls call={call} size="dock" window={where} />
      </div>
    </>
  );
}

/**
 * The floating window a docked huddle shows in, above every page. Drag it to
 * any corner; it stays there for the rest of the call.
 */
export function HuddleDock({
  call,
  place,
  corner,
  mobile,
  onOpenPlace,
}: {
  readonly call: HuddleCallState;
  readonly place: HuddlePlace | undefined;
  readonly corner: HuddleCorner;
  readonly mobile: boolean;
  readonly onOpenPlace: (place: HuddlePlace) => void;
}) {
  const [drag, setDrag] = React.useState<
    { startX: number; startY: number; x: number; y: number } | undefined
  >(undefined);
  const dragHandle: React.HTMLAttributes<HTMLElement> = {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ startX: event.clientX, startY: event.clientY, x: 0, y: 0 });
    },
    onPointerMove: (event) => {
      if (drag === undefined) return;
      setDrag({
        ...drag,
        x: event.clientX - drag.startX,
        y: event.clientY - drag.startY,
      });
    },
    onPointerUp: (event) => {
      if (drag === undefined) return;
      setDrag(undefined);
      if (Math.abs(drag.x) + Math.abs(drag.y) < 6) {
        // A tap, not a drag: phones expand, desktops keep the click target.
        if (mobile) huddleView.expand();
        return;
      }
      huddleView.moveTo(nearestCorner(event.clientX, event.clientY));
    },
    onPointerCancel: () => setDrag(undefined),
  };
  return (
    <section
      className="huddle-dock"
      aria-label="Huddle"
      data-corner={corner}
      data-dragging={drag === undefined ? undefined : ""}
      data-mobile={mobile || undefined}
      style={
        drag === undefined
          ? undefined
          : { transform: `translate(${drag.x}px, ${drag.y}px)` }
      }
    >
      <HuddleDockContent
        call={call}
        place={place}
        window="dock"
        onOpenPlace={onOpenPlace}
        dragHandle={dragHandle}
      />
    </section>
  );
}
