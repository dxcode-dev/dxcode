import type { ThreadId } from "@dx/domain";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

/** The Space a page shows, and the threads it started. */
export interface SpaceThreadsContextValue {
  readonly spaceThreadId: ThreadId;
  readonly childThreadIds: ReadonlySet<string>;
  /** Brings an opened thread's tab to the front where tabs share a strip. */
  readonly reveal?: (threadId: ThreadId) => void;
}

export const SpaceThreadsContext = React.createContext<
  SpaceThreadsContextValue | undefined
>(undefined);

/** `/threads/<id>` of a same-origin link, else undefined. */
export const threadIdOfHref = (href: string): ThreadId | undefined => {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return undefined;
  return /^\/threads\/(thr_[0-9a-f-]{36})\/?$/u.exec(url.pathname)?.[1] as
    | ThreadId
    | undefined;
};

/**
 * Opens a thread the Space started in a tab beside its chat (`?thread=`), as
 * a card, a chip, or a link in the chat does; with `artifact`, its Artifacts
 * view shows that artifact. Returns false outside a Space page, where the
 * caller navigates as usual.
 */
export const useOpenSpaceThread = () => {
  const space = React.use(SpaceThreadsContext);
  const navigate = useNavigate();
  return (threadId: ThreadId, { artifact }: { artifact?: string } = {}) => {
    if (space === undefined || threadId === space.spaceThreadId) return false;
    space.reveal?.(threadId);
    void navigate({
      to: "/threads/$threadId",
      params: { threadId: space.spaceThreadId },
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        thread: threadId,
        ...(artifact === undefined ? {} : { artifact }),
      }),
    });
    return true;
  };
};

/** Closes the open thread's tab. */
export const useCloseSpaceThread = () => {
  const space = React.use(SpaceThreadsContext);
  const navigate = useNavigate();
  return () => {
    if (space === undefined) return;
    void navigate({
      to: "/threads/$threadId",
      params: { threadId: space.spaceThreadId },
      search: ({ thread: _thread, ...rest }: Record<string, unknown>) => rest,
    });
  };
};
