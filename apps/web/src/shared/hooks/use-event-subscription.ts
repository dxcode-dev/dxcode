import { useEffect, useEffectEvent } from "react";

/**
 * Listens to an outside event source while mounted, handling each event
 * with the latest `onEvent`, so a handler that reads current state never
 * goes stale. `subscribe` must be stable (a module function); it returns
 * its cleanup.
 */
export function useEventSubscription<Event>(
  subscribe: (listener: (event: Event) => void) => () => void,
  onEvent: (event: Event) => void,
) {
  const handle = useEffectEvent(onEvent);
  useEffect(() => subscribe((event) => handle(event)), [subscribe]);
}
