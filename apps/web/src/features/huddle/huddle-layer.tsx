import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { useMobile } from "../../shared/use-mobile.js";
import { HuddleDock, HuddleDockContent } from "./huddle-dock.js";
import {
  type HuddlePlace,
  huddleClient,
  joinHuddle,
  useHuddleCall,
  useHuddleView,
} from "./huddle-session.js";
import { HuddleStage } from "./huddle-stage.js";
import "./huddle.css";

/**
 * The tab's huddle window, mounted beside the router so it survives every
 * route change: the expanded stage, the docked window, or the browser's
 * Picture-in-Picture window when popped out.
 */
export default function HuddleLayer({
  onOpenPlace,
}: {
  readonly onOpenPlace: (place: HuddlePlace) => void;
}) {
  const call = useHuddleCall();
  const view = useHuddleView();
  const mobile = useMobile();
  if (call.status === "error")
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) huddleClient.dismissError();
        }}
        title="Couldn't join the huddle"
        description={call.error?.message}
        cancelLabel="Close"
        confirmLabel="Join without camera"
        onConfirm={() => {
          if (view.place !== undefined)
            void joinHuddle(view.place, { audio: true, video: false });
          else huddleClient.dismissError();
        }}
      />
    );
  if (call.status === "idle" || call.status === "left") return null;
  if (view.popout !== undefined)
    return createPortal(
      <section className="huddle-popout" aria-label="Huddle">
        <HuddleDockContent
          call={call}
          place={view.place}
          window="popout"
          onOpenPlace={(place) => {
            window.focus();
            onOpenPlace(place);
          }}
        />
      </section>,
      view.popout.document.body,
    );
  if (view.mode === "expanded")
    return <HuddleStage call={call} place={view.place} />;
  return (
    <HuddleDock
      call={call}
      place={view.place}
      corner={view.corner}
      mobile={mobile}
      onOpenPlace={onOpenPlace}
    />
  );
}
