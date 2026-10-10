import type * as React from "react";
import { cn } from "../utils.js";
import "./avatar.css";

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** A person's picture, or their initials on a color derived from their id. */
export function Avatar({
  name,
  image,
  seed,
  className,
  live,
}: {
  readonly name: string;
  readonly image?: string;
  readonly seed: string;
  readonly className?: string;
  /** Shows a presence dot. */
  readonly live?: boolean;
}) {
  let hash = 0;
  for (const character of seed)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return (
    <span
      className={cn("dx-avatar", className)}
      style={
        { "--avatar-hue": `${Math.abs(hash) % 360}` } as React.CSSProperties
      }
      data-live={live ? "" : undefined}
    >
      {image === undefined ? (
        <span aria-hidden="true">{initials(name)}</span>
      ) : (
        <img src={image} alt="" referrerPolicy="no-referrer" />
      )}
    </span>
  );
}

/** Overlapping avatars, live people marked, with a "+N" overflow. */
export function ParticipantStack({
  participants,
  present,
  limit = 3,
}: {
  readonly participants: ReadonlyArray<{
    readonly userId: string;
    readonly name: string;
    readonly image?: string;
  }>;
  readonly present?: ReadonlySet<string>;
  readonly limit?: number;
}) {
  const shown = participants.slice(0, limit);
  const hidden = participants.length - shown.length;
  return (
    <span className="participant-stack">
      {shown.map((participant) => (
        <Avatar
          key={participant.userId}
          name={participant.name}
          image={participant.image}
          seed={participant.userId}
          live={present?.has(participant.userId)}
        />
      ))}
      {hidden > 0 ? <span className="participant-more">+{hidden}</span> : null}
    </span>
  );
}
