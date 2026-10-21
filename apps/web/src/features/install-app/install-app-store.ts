import { Schema } from "effect";
import { type InstallGuide, installGuideFor } from "./install-platform.js";
import { installPrompt } from "./install-prompt-capture.js";

/**
 * What the signed-in app's install banner shows: nothing, the browser's own
 * install prompt (Android Chrome), or a guide for the device.
 */
export type InstallBannerState = "hidden" | "prompt" | InstallGuide;

/**
 * Whether the person closed the banner in this browser session. Session
 * storage keeps it closed across reloads in the tab and shows it again the
 * next time they open dx.
 */
export const installBannerStorageKey = "dx:install-app-banner:v1";

const DismissalEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  dismissedAt: Schema.Number,
});

/** Reading `sessionStorage` itself throws where storage is blocked. */
const sessionStorageOrUndefined = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

const readDismissed = () => {
  try {
    const raw = sessionStorageOrUndefined()?.getItem(installBannerStorageKey);
    if (raw === null || raw === undefined) return false;
    Schema.decodeUnknownSync(DismissalEnvelope)(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
};

let dismissed: boolean | undefined;
let standaloneQuery: MediaQueryList | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

const standaloneDisplay = () => {
  standaloneQuery ??= window.matchMedia(
    "(display-mode: standalone), (display-mode: fullscreen)",
  );
  return standaloneQuery;
};

/** Opened from the Home Screen: Chrome's display mode or iOS's flag. */
const runningInstalled = () =>
  standaloneDisplay().matches ||
  (navigator as Navigator & { readonly standalone?: boolean }).standalone ===
    true;

export const installAppBanner = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    const display = standaloneDisplay();
    display.addEventListener("change", listener);
    const unsubscribePrompt = installPrompt.subscribe(listener);
    return () => {
      listeners.delete(listener);
      display.removeEventListener("change", listener);
      unsubscribePrompt();
    };
  },
  getSnapshot: (): InstallBannerState => {
    dismissed ??= readDismissed();
    if (dismissed || installPrompt.installed() || runningInstalled())
      return "hidden";
    const guide = installGuideFor(
      navigator.userAgent,
      navigator.maxTouchPoints,
    );
    if (guide === undefined) return "hidden";
    // Desktop Chrome offers a prompt too; only phones and tablets use it.
    return guide === "android" && installPrompt.available() ? "prompt" : guide;
  },
  getServerSnapshot: (): InstallBannerState => "hidden",
  dismiss: () => {
    dismissed = true;
    try {
      sessionStorageOrUndefined()?.setItem(
        installBannerStorageKey,
        JSON.stringify({ version: 1, dismissedAt: Date.now() }),
      );
    } catch {
      // Storage may be full or disabled; the banner stays closed until reload.
    }
    notify();
  },
  install: installPrompt.prompt,
};
