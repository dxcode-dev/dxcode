import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const visible = () => document.visibilityState === "visible";
const serverVisible = () => true;

/** Whether the browser tab is showing, so work can wait while it is not. */
export const usePageVisible = () =>
  useSyncExternalStore(subscribe, visible, serverVisible);
