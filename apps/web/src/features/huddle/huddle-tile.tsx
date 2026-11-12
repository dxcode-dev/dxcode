import { MicOff, MonitorUp } from "lucide-react";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { Avatar } from "../../shared/ui/avatar.js";
import type { HuddleParticipant } from "./huddle-client.js";

/** Plays a track in a video element; the element's lifetime owns the stream. */
export function HuddleVideo({
  track,
  mirrored,
  className,
}: {
  readonly track: MediaStreamTrack;
  readonly mirrored?: boolean;
  readonly className?: string;
}) {
  return (
    <video
      className={className ?? "huddle-video"}
      data-mirrored={mirrored || undefined}
      autoPlay
      playsInline
      muted
      ref={(element) => {
        if (element === null) return;
        element.srcObject = new MediaStream([track]);
        return () => {
          element.srcObject = null;
        };
      }}
    />
  );
}

/**
 * One person in a huddle: their camera, or their avatar when it is off, with
 * their name, a muted mark, and a ring while they speak. `screen` shows what
 * they share instead.
 */
export function HuddleTile({
  participant,
  screen = false,
  size = "grid",
}: {
  readonly participant: HuddleParticipant;
  readonly screen?: boolean;
  readonly size?: "grid" | "strip" | "dock";
}) {
  const track = screen ? participant.screenTrack : participant.videoTrack;
  const me = useIdentity()?.identity;
  const name = participant.isSelf ? "You" : participant.name;
  // Your own tile shows your dx avatar, whatever the call names you.
  const person =
    participant.isSelf && me !== undefined
      ? { name: me.name, image: undefined, seed: me.id }
      : {
          name: participant.name,
          image: participant.avatarUrl,
          seed: participant.userId,
        };
  return (
    <figure
      className="huddle-tile"
      data-size={size}
      data-screen={screen || undefined}
      data-speaking={(!screen && participant.speaking) || undefined}
      aria-label={screen ? `${name}'s screen` : name}
    >
      {track !== undefined && (screen || participant.videoOn) ? (
        <HuddleVideo
          key={track.id}
          track={track}
          mirrored={participant.isSelf && !screen}
          className={
            screen ? "huddle-video huddle-video-screen" : "huddle-video"
          }
        />
      ) : (
        <span className="huddle-tile-avatar">
          <Avatar name={person.name} image={person.image} seed={person.seed} />
        </span>
      )}
      <figcaption className="huddle-tile-name">
        {screen ? <MonitorUp aria-hidden="true" /> : null}
        <span>{screen ? `${name}'s screen` : name}</span>
        {!screen && participant.audioMuted ? (
          <MicOff aria-label="Muted" className="huddle-tile-muted" />
        ) : null}
      </figcaption>
    </figure>
  );
}
