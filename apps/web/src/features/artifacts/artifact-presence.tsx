import type * as React from "react";
import type { CommentPeople } from "../../shared/comments/comment-text.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { collaboratorColor } from "./artifact-people.js";
import "./artifact-presence.css";

/** Who else is on the artifact now, in their cursor colors. */
export function PresenceStack({
  users,
  people,
  where,
}: {
  readonly users: ReadonlyArray<string>;
  readonly people: CommentPeople;
  /** What they are on, for the label: "board" or "document". */
  readonly where: string;
}) {
  const unique = [...new Set(users)];
  if (unique.length === 0) return null;
  const names = unique.map((userId) => people.get(userId)?.name ?? "Someone");
  return (
    <span
      className="artifact-presence"
      role="status"
      aria-label={`On this ${where}: ${names.join(", ")}`}
      title={`On this ${where}: ${names.join(", ")}`}
    >
      {unique.slice(0, 4).map((userId, index) => {
        const person = people.get(userId);
        return (
          <span
            key={userId}
            className="artifact-presence-person"
            style={
              {
                "--artifact-person": collaboratorColor(userId).stroke,
              } as React.CSSProperties
            }
          >
            <Avatar
              name={names[index] ?? "Someone"}
              {...(person?.image === undefined ? {} : { image: person.image })}
              seed={userId}
            />
          </span>
        );
      })}
      {unique.length > 4 ? (
        <span className="artifact-presence-more">+{unique.length - 4}</span>
      ) : null}
    </span>
  );
}
