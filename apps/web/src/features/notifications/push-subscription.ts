import type { RegisterPushDeviceRequest } from "@dx/api";

/**
 * Push notifications in the browser: the permission, the service worker, and
 * the `PushSubscription` this browser holds. This module only talks to the
 * browser; `notifications-queries.ts` carries what it produces to dx.
 *
 * Everything here touches browser state, so it is called from handlers and
 * from query functions, never during render.
 */

/** Where the worker lives; its scope is the whole origin. */
const SERVICE_WORKER_URL = "/sw.js";

export const pushSupported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

/**
 * iPhone and iPad offer Web Push only to a web app on the Home Screen; Safari
 * in a tab has no `PushManager`. dx's manifest makes it installable, so such
 * a browser needs installing, not giving up on.
 */
export const pushNeedsHomeScreen = () => {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return false;
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS reports a Mac, but Macs have no touch screen.
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const installed =
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  return ios && !installed;
};

export class PushPermissionDenied extends Error {
  constructor() {
    super("The browser refused notification permission.");
  }
}

export class PushSubscribeFailed extends Error {
  constructor(cause?: unknown) {
    super("The browser's push service refused the subscription.", { cause });
  }
}

const base64UrlToBytes = (value: string) => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** The SHA-256 the server identifies this device's registration by. */
export const endpointHash = async (endpoint: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** "Chrome on macOS", for the device list. */
export const deviceLabel = (userAgent: string) => {
  const name = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const platform = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Macintosh/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux|X11|CrOS/.test(userAgent)
            ? "Linux"
            : undefined;
  return platform === undefined ? name : `${name} on ${platform}`;
};

const readyRegistration = async () => {
  const registration =
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  // `ready` resolves once a worker controls this scope, which subscribing
  // requires; registering alone only starts the install.
  await navigator.serviceWorker.ready;
  return registration;
};

/** What this browser itself knows about push, read fresh each time. */
export interface BrowserPushState {
  readonly supported: boolean;
  /** Unsupported here, but supported once dx is added to the Home Screen. */
  readonly needsHomeScreen?: boolean;
  readonly permission: NotificationPermission | "unsupported";
  /** Present when this browser holds a subscription right now. */
  readonly endpointHash?: string;
}

export const readBrowserPushState = async (): Promise<BrowserPushState> => {
  if (!pushSupported())
    return {
      supported: false,
      ...(pushNeedsHomeScreen() ? { needsHomeScreen: true } : {}),
      permission: "unsupported",
    };
  const permission = Notification.permission;
  const registration =
    await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  return {
    supported: true,
    permission,
    ...(subscription === undefined || subscription === null
      ? {}
      : { endpointHash: await endpointHash(subscription.endpoint) }),
  };
};

/**
 * Asks for permission, installs the worker, and subscribes with the
 * deployment's VAPID key. A browser that already holds a subscription for
 * another key resubscribes, so a deployment that rotated its keys heals on
 * the next enable. What it returns is what dx needs to reach this browser.
 */
export const subscribeThisBrowser = async (
  publicKey: string,
): Promise<RegisterPushDeviceRequest> => {
  if (!pushSupported()) throw new PushSubscribeFailed();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionDenied();
  const registration = await readyRegistration();
  const existing = await registration.pushManager.getSubscription();
  const applicationServerKey = base64UrlToBytes(publicKey);
  if (existing !== null && !sameKey(existing, applicationServerKey))
    await existing.unsubscribe();
  const subscription =
    existing !== null && sameKey(existing, applicationServerKey)
      ? existing
      : await registration.pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey as BufferSource,
          })
          .catch((cause: unknown) => {
            throw new PushSubscribeFailed(cause);
          });
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (
    json.endpoint === undefined ||
    keys.p256dh === undefined ||
    keys.auth === undefined
  )
    throw new PushSubscribeFailed();
  return {
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    label: deviceLabel(navigator.userAgent),
  };
};

const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === key.length && bytes.every((byte, at) => byte === key[at])
  );
};

/**
 * Stops this browser receiving. dx is told to forget the subscription first,
 * so a push cannot arrive at a device the person just turned off; `drop`
 * then ends it with the browser's push service.
 */
export const unsubscribeThisBrowser = async (): Promise<
  { readonly endpoint: string; readonly drop: () => Promise<void> } | undefined
> => {
  if (!pushSupported()) return undefined;
  const registration =
    await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription === undefined || subscription === null) return undefined;
  return {
    endpoint: subscription.endpoint,
    drop: async () => {
      await subscription.unsubscribe();
    },
  };
};
