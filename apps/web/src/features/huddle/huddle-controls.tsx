import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  PictureInPicture2,
  Video,
  VideoOff,
} from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import type { HuddleCallState } from "./huddle-client.js";
import { canPopOut, popOutHuddle } from "./huddle-popout.js";
import { huddleClient, huddleView, leaveHuddle } from "./huddle-session.js";

const canShareScreen = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function";

/**
 * Mute, camera, screen share, and leave, with expand or dock and pop out
 * where the window allows them.
 */
export function HuddleControls({
  call,
  size,
  window: place,
}: {
  readonly call: HuddleCallState;
  readonly size: "stage" | "dock";
  /** Which window these controls sit in, for expand, dock, and pop out. */
  readonly window: "stage" | "dock" | "popout";
}) {
  const { self } = call;
  const live = call.status === "connected" || call.status === "reconnecting";
  const micLabel = self.audioMuted ? "Unmute" : "Mute";
  const cameraLabel = self.videoOn ? "Turn camera off" : "Turn camera on";
  const shareLabel = self.screenSharing ? "Stop sharing" : "Share screen";
  return (
    <div
      className="huddle-controls"
      data-size={size}
      role="toolbar"
      aria-label="Huddle controls"
    >
      <Button
        variant="secondary"
        size="lg"
        shape="round"
        tone={self.audioMuted ? "danger" : undefined}
        className="huddle-control"
        data-off={self.audioMuted || undefined}
        aria-label={micLabel}
        aria-pressed={!self.audioMuted}
        title={micLabel}
        disabled={!live}
        onClick={() => void huddleClient.setAudioMuted(!self.audioMuted)}
      >
        {self.audioMuted ? (
          <MicOff aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="secondary"
        size="lg"
        shape="round"
        tone={self.videoOn ? undefined : "danger"}
        className="huddle-control"
        data-off={!self.videoOn || undefined}
        aria-label={cameraLabel}
        aria-pressed={self.videoOn}
        title={cameraLabel}
        disabled={!live}
        onClick={() => void huddleClient.setVideoOn(!self.videoOn)}
      >
        {self.videoOn ? (
          <Video aria-hidden="true" />
        ) : (
          <VideoOff aria-hidden="true" />
        )}
      </Button>
      {size === "stage" && canShareScreen() ? (
        <Button
          variant={self.screenSharing ? "default" : "secondary"}
          size="lg"
          shape="round"
          className="huddle-control"
          data-active={self.screenSharing || undefined}
          aria-label={shareLabel}
          aria-pressed={self.screenSharing}
          title={shareLabel}
          disabled={!live}
          onClick={() =>
            void huddleClient.setScreenSharing(!self.screenSharing)
          }
        >
          <MonitorUp aria-hidden="true" />
        </Button>
      ) : null}
      {place === "stage" ? (
        <Button
          variant="secondary"
          size="lg"
          shape="round"
          className="huddle-control"
          aria-label="Minimize huddle"
          title="Minimize: keep the huddle in a small window while you work"
          onClick={huddleView.dock}
        >
          <Minimize2 aria-hidden="true" />
        </Button>
      ) : null}
      {place === "dock" ? (
        <Button
          variant="secondary"
          size="lg"
          shape="round"
          className="huddle-control"
          aria-label="Expand huddle"
          title="Expand huddle"
          onClick={huddleView.expand}
        >
          <Maximize2 aria-hidden="true" />
        </Button>
      ) : null}
      {place !== "popout" && canPopOut() ? (
        <Button
          variant="secondary"
          size="lg"
          shape="round"
          className="huddle-control"
          aria-label="Pop out huddle"
          title="Pop out: keep the huddle on top of other tabs and apps"
          onClick={() => void popOutHuddle()}
        >
          <PictureInPicture2 aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        variant="destructive"
        size="lg"
        shape="round"
        className="huddle-control"
        data-tone="leave"
        aria-label="Leave huddle"
        title="Leave huddle"
        onClick={() => void leaveHuddle()}
      >
        <PhoneOff aria-hidden="true" />
        {size === "stage" ? <span>Leave</span> : null}
      </Button>
    </div>
  );
}
