/**
 * Hands navigations that start outside the page to the signed-in app's
 * router, so a running dx changes route instead of loading itself again:
 *
 * - a notification click, which `public/sw.js` posts to an open dx window;
 * - a dx link the system opened in the installed app (Chromium's Launch
 *   Handler, with `launch_handler.client_mode` set to `focus-existing`);
 * - a dx link inside the installed app, which would otherwise open in a
 *   browser sheet: on iPhone that sheet is Safari, signed out.
 *
 * The entry module imports this file, so the worker's message and the launch
 * find a listener even before the signed-in chunks load.
 */

/** The message `public/sw.js` posts; keep the two in step. */
const NAVIGATE_MESSAGE = "dx:navigate";

/** Routes a same-origin URL in place; false when the router has no page for it. */
type RouteInPlace = (url: URL) => boolean;

let routeInPlace: RouteInPlace | undefined;

const sameOrigin = (href: string) => {
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin ? url : undefined;
  } catch {
    return undefined;
  }
};

const isCurrent = (url: URL) =>
  url.pathname + url.search + url.hash ===
  window.location.pathname + window.location.search + window.location.hash;

/** Routes `href` without a reload when the signed-in app can; true if it did. */
const routeHere = (href: string) => {
  const url = sameOrigin(href);
  if (url === undefined || routeInPlace === undefined) return false;
  if (isCurrent(url)) return true;
  return routeInPlace(url);
};

const installed = () =>
  (navigator as { standalone?: boolean }).standalone === true ||
  window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)")
    .matches === true;

/** The signed-in app lends its router while it is mounted. */
export const attachInAppNavigation = (route: RouteInPlace) => {
  routeInPlace = route;
  return () => {
    if (routeInPlace === route) routeInPlace = undefined;
  };
};

interface LaunchParams {
  readonly targetURL?: string;
}

if (typeof window !== "undefined") {
  // The worker waits for this answer; without one, or with `handled: false`,
  // it navigates the window itself, which loads dx again but still arrives.
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== NAVIGATE_MESSAGE) return;
    const handled = typeof data.url === "string" && routeHere(data.url);
    event.ports[0]?.postMessage({ handled });
  });
  // Messages wait in a queue until the page starts it; start it now rather
  // than whenever the browser decides the page has loaded.
  navigator.serviceWorker?.startMessages();

  // `focus-existing` raises this window and leaves the URL to the page. The
  // launch that opened the window is delivered too, for the URL it loaded.
  (
    window as {
      launchQueue?: {
        setConsumer: (consumer: (params: LaunchParams) => void) => void;
      };
    }
  ).launchQueue?.setConsumer(({ targetURL }) => {
    const url = targetURL === undefined ? undefined : sameOrigin(targetURL);
    // Opening the app from its icon launches the start URL; the person wants
    // the window back as they left it, not the home page.
    if (url === undefined || url.href === new URL("/", url).href) return;
    if (!routeHere(url.href) && !isCurrent(url))
      window.location.assign(url.href);
  });

  // Runs after React's own handlers, so a router `Link` has already
  // prevented the default and is left alone.
  window.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.hasAttribute("download")
    )
      return;
    const target = anchor.target.toLowerCase();
    // In a browser tab a new tab is what `_blank` asks for. An installed app
    // has no tabs, so its own pages stay in it.
    if (target !== "" && target !== "_self" && !installed()) return;
    if (routeHere(anchor.href)) event.preventDefault();
  });
}
