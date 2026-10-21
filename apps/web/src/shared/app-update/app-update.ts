import { useSyncExternalStore } from "react";
import { sameOriginFetch } from "../same-origin-fetch.js";

// Each build names its entry script after a content hash, and every chunk's
// hash chains into it, so the entry's `src` identifies the running build.
// Vite's preload helper adds only `<link>` tags at runtime, never scripts.
const entrySelector = 'script[type="module"][src]';
const checkIntervalMs = 5 * 60_000;

const runningEntry =
  typeof document === "undefined"
    ? undefined
    : (document.querySelector(entrySelector)?.getAttribute("src") ?? undefined);

/** The entry script the server answers with now, or undefined if unknown. */
const fetchServedEntry = async () => {
  const response = await sameOriginFetch("/", {
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  if (!response.ok) return undefined;
  const html = await response.text();
  const served = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(entrySelector)
    ?.getAttribute("src");
  return served ?? undefined;
};

let availableEntry: string | undefined;
let pendingCheck: Promise<void> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

const check = () => {
  pendingCheck ??= fetchServedEntry()
    .then(
      (served) => {
        if (served === undefined) return;
        const next = served === runningEntry ? undefined : served;
        if (next === availableEntry) return;
        availableEntry = next;
        notify();
      },
      // Offline or between deploys: try again on the next return or tick.
      () => undefined,
    )
    .finally(() => {
      pendingCheck = undefined;
    });
  return pendingCheck;
};

// Checks on every return to the app (switching back, unlocking the phone,
// reopening the installed app) and every few minutes while it is visible.
// dx never reloads itself: the person chooses when, from the sidebar.
const onVisibilityChange = () => {
  if (document.visibilityState === "visible") void check();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1 && runningEntry !== undefined) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    interval = setInterval(onVisibilityChange, checkIntervalMs);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    clearInterval(interval);
    interval = undefined;
  };
};

/** Whether the server has a newer dx build than this tab runs. */
export const useAppUpdateAvailable = () =>
  useSyncExternalStore(
    subscribe,
    () => availableEntry !== undefined,
    () => false,
  );

/** Loads the newer build. */
export const applyAppUpdate = () => window.location.reload();
