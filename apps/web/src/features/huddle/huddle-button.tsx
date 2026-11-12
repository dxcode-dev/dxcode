import { useQuery } from "@tanstack/react-query";
import { Headphones } from "lucide-react";
import * as React from "react";
import { ParticipantStack } from "../../shared/ui/avatar.js";
import { huddleScopeKey } from "./huddle-client.js";
import { HuddlePrejoin } from "./huddle-prejoin.js";
import { huddleSummaryQueryOptions } from "./huddle-queries.js";
import {
  type HuddlePlace,
  huddleClient,
  huddleView,
  useHuddleCall,
  useHuddleView,
} from "./huddle-session.js";
import "./huddle.css";

/**
 * The Huddle control in a Space's or thread's header: start one, join the
 * one that is on (with who is in it), or return to the one you're in.
 */
export default function HuddleButton({
  place,
  variant,
}: {
  readonly place: HuddlePlace;
  readonly variant: "space" | "thread";
}) {
  const [prejoin, setPrejoin] = React.useState(false);
  const summary = useQuery(huddleSummaryQueryOptions(place.scope));
  const call = useHuddleCall();
  const view = useHuddleView();
  const live =
    call.status === "joining" ||
    call.status === "connected" ||
    call.status === "reconnecting";
  const here =
    live &&
    call.scope !== undefined &&
    huddleScopeKey(call.scope) === huddleScopeKey(place.scope);
  const elsewhere =
    live && !here ? (view.place?.name ?? "another place") : undefined;
  const people = summary.data?.active === true ? summary.data.participants : [];
  const base =
    variant === "space"
      ? "space-icon-button huddle-header-button"
      : "thread-title-action huddle-header-button";
  if (here)
    return (
      <button
        type="button"
        className={`${base} huddle-header-pill`}
        data-state="in"
        title="You're in this huddle. Open it."
        onClick={huddleView.expand}
      >
        <span className="huddle-live-dot" aria-hidden="true" />
        <Headphones aria-hidden="true" />
        <span className="huddle-header-label">In huddle</span>
      </button>
    );
  const names = people.map(({ name }) => name).join(", ");
  // Gets the call ready while the person checks their camera and mic.
  const openPrejoin = () => {
    huddleClient.prepare(place.scope);
    setPrejoin(true);
  };
  return (
    <>
      {people.length === 0 ? (
        <button
          type="button"
          className={base}
          aria-label="Start a huddle"
          title="Start a huddle"
          onClick={openPrejoin}
        >
          <Headphones aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className={`${base} huddle-header-pill`}
          data-state="on"
          aria-label={`Join huddle with ${names}`}
          title={`In the huddle: ${names}`}
          onClick={openPrejoin}
        >
          <span className="huddle-live-dot" aria-hidden="true" />
          <ParticipantStack
            participants={people.map(({ userId, name, avatarUrl }) => ({
              userId,
              name,
              image: avatarUrl,
            }))}
            limit={variant === "space" ? 2 : 3}
          />
          <span className="huddle-header-label">Join</span>
        </button>
      )}
      {prejoin ? (
        <HuddlePrejoin
          open
          onOpenChange={setPrejoin}
          place={place}
          summary={summary.data}
          leaving={elsewhere}
        />
      ) : null}
    </>
  );
}
