import { useSyncExternalStore } from "react";
import { useMountEffect } from "../hooks/use-mount-effect.js";

// index.html carries the landing title, for crawlers that run no script. Once
// the app runs, React owns the tab title: main.tsx drops that element before
// the first render, `FallbackTitle` shows "dx", and a page that names itself
// takes the fallback's place, so the head holds one `<title>`.

let claims = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const claimTitle = () => {
  claims += 1;
  notify();
  return () => {
    claims -= 1;
    notify();
  };
};
const isClaimed = () => claims > 0;

/**
 * Names the browser tab `text` while this renders. React 19 hoists the element
 * into the head ahead of any other title, so the newest page wins, and the
 * fallback "dx" steps aside until every page title unmounts.
 */
export function PageTitle({ text }: { readonly text: string }) {
  useMountEffect(claimTitle);
  return <title>{text}</title>;
}

/** Names the browser tab "<name> - dx" while this renders. */
export function DocumentTitle({ name }: { readonly name: string }) {
  return <PageTitle text={`${name} - dx`} />;
}

/** The tab title "dx", rendered once at the root while no page names itself. */
export function FallbackTitle() {
  const claimed = useSyncExternalStore(subscribe, isClaimed);
  return claimed ? null : <title>dx</title>;
}
