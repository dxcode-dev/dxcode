import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { ParticipantStack } from "../../shared/ui/avatar.js";
import { Chip } from "../../shared/ui/chip.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import type { HuddleSummary } from "./huddle-client.js";
import { type HuddlePlace, joinHuddle } from "./huddle-session.js";
import { HuddleVideo } from "./huddle-tile.js";

/** Your camera before you join; it turns off when the preview closes. */
function CameraPreview() {
  const [state, setState] = React.useState<
    { track: MediaStreamTrack } | { error: string } | undefined
  >(undefined);
  useMountEffect(() => {
    let track: MediaStreamTrack | undefined;
    let closed = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        track = stream.getVideoTracks()[0];
        if (closed) track?.stop();
        else if (track !== undefined) setState({ track });
      })
      .catch((error: unknown) => {
        if (closed) return;
        setState({
          error:
            error instanceof DOMException && error.name === "NotAllowedError"
              ? "Camera blocked. Allow it in the address bar to be seen."
              : "No camera found.",
        });
      });
    return () => {
      closed = true;
      track?.stop();
    };
  });
  if (state === undefined)
    return <span className="huddle-preview-note">Starting camera…</span>;
  if ("error" in state)
    return <span className="huddle-preview-note">{state.error}</span>;
  return <HuddleVideo track={state.track} mirrored />;
}

/**
 * Before joining: who is there, your camera, and whether you start muted or
 * with the camera off.
 */
export function HuddlePrejoin({
  open,
  onOpenChange,
  place,
  summary,
  leaving,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly place: HuddlePlace;
  readonly summary: HuddleSummary | undefined;
  /** The other huddle you're in, which joining leaves. */
  readonly leaving?: string;
}) {
  const [audio, setAudio] = React.useState(true);
  const [video, setVideo] = React.useState(false);
  const people = summary?.active === true ? summary.participants : [];
  const where = place.scope.kind === "space" ? "Space" : "thread";
  // Until the summary loads, nobody is known to be here: say so, and offer
  // Join rather than Start, since a huddle link opens this before it loads.
  const loading = summary === undefined;
  const starting = !loading && people.length === 0;
  const description = loading
    ? "Checking who's here…"
    : people.length === 0
      ? `Nobody is here yet. People in this ${where} see the huddle and can join.`
      : `${people.map(({ name }) => name.split(" ")[0]).join(", ")} ${people.length === 1 ? "is" : "are"} here.`;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        starting
          ? `Start a huddle in ${place.name}`
          : `Join the huddle in ${place.name}`
      }
      description={
        leaving === undefined
          ? description
          : `${description} Joining leaves the huddle in ${leaving}.`
      }
      confirmLabel={starting ? "Start huddle" : "Join"}
      onConfirm={() => {
        onOpenChange(false);
        void joinHuddle(place, { audio, video });
      }}
    >
      <div className="huddle-prejoin">
        <div className="huddle-preview" data-camera={video || undefined}>
          {video ? (
            <CameraPreview />
          ) : (
            <span className="huddle-preview-note">Camera off</span>
          )}
          {people.length === 0 ? null : (
            <span className="huddle-preview-people">
              <ParticipantStack
                participants={people.map(({ userId, name, avatarUrl }) => ({
                  userId,
                  name,
                  image: avatarUrl,
                }))}
                limit={4}
              />
            </span>
          )}
        </div>
        <div className="huddle-prejoin-toggles">
          <Chip
            variant="outline"
            size="md"
            className="huddle-toggle"
            aria-pressed={audio}
            onClick={() => setAudio(!audio)}
          >
            {audio ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
            {audio ? "Microphone on" : "Muted"}
          </Chip>
          <Chip
            variant="outline"
            size="md"
            className="huddle-toggle"
            aria-pressed={video}
            onClick={() => setVideo(!video)}
          >
            {video ? (
              <Video aria-hidden="true" />
            ) : (
              <VideoOff aria-hidden="true" />
            )}
            {video ? "Camera on" : "Camera off"}
          </Chip>
        </div>
      </div>
    </ConfirmDialog>
  );
}
