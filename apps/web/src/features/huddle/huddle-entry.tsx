import { lazy, Suspense } from "react";
import type { HuddleSlotProps } from "../../shared/huddle/huddle-slot.js";
import { useHuddleEnabled } from "./huddle-flag.js";
import type { HuddlePlace } from "./huddle-session.js";

// Huddle loads only for people who turned it on.
const HuddleButton = lazy(() => import("./huddle-button.js"));
const HuddleLayer = lazy(() => import("./huddle-layer.js"));

/** The header control for the Huddle slot; its fallback while Huddle is off. */
export function HuddleButtonEntry({
  kind,
  threadId,
  name,
  fallback = null,
}: HuddleSlotProps) {
  const enabled = useHuddleEnabled();
  if (!enabled) return fallback;
  const place: HuddlePlace = {
    scope:
      kind === "space"
        ? { kind: "space", spaceId: threadId }
        : { kind: "thread", threadId },
    name,
    threadId,
  };
  return (
    <Suspense fallback={fallback}>
      <HuddleButton place={place} variant={kind} />
    </Suspense>
  );
}

/** The tab's huddle window, beside the router, for people with Huddle on. */
export function HuddleLayerEntry({
  onOpenPlace,
}: {
  readonly onOpenPlace: (place: HuddlePlace) => void;
}) {
  const enabled = useHuddleEnabled();
  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <HuddleLayer onOpenPlace={onOpenPlace} />
    </Suspense>
  );
}
