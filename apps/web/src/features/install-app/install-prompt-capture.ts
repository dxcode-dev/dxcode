/** Chrome's install prompt event; the DOM typings do not include it. */
interface BeforeInstallPromptEvent extends Event {
  readonly prompt: () => Promise<void>;
  readonly userChoice: Promise<{
    readonly outcome: "accepted" | "dismissed";
  }>;
}

// Chrome fires `beforeinstallprompt` once per page, often before the signed-in
// app's chunks load, so the entry module imports this file to keep the event.
let deferredPrompt: BeforeInstallPromptEvent | undefined;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // dx shows its own banner in the signed-in app instead of Chrome's
    // mini-infobar, which would also appear on the landing page.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = undefined;
    notify();
  });
}

export const installPrompt = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  available: () => deferredPrompt !== undefined,
  installed: () => installed,
  /** Opens the browser's install dialog; each event can prompt only once. */
  prompt: async () => {
    const event = deferredPrompt;
    if (event === undefined) return;
    deferredPrompt = undefined;
    notify();
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome !== "accepted") return;
    installed = true;
    notify();
  },
};
