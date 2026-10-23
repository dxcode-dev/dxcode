/**
 * dx's service worker: it exists so the installed app and the browser can
 * receive push notifications while no dx tab is open. It caches nothing —
 * the app is served fresh over the network, as it is without a worker.
 *
 * Plain JavaScript on purpose: the browser loads this file as-is from the
 * origin root, so it is never bundled and carries no dependencies.
 */

/** A push whose payload dx could not read still tells the person something. */
const FALLBACK = {
  title: "dx",
  body: "Something happened in one of your Threads.",
  url: "/",
  tag: "dx",
};

const payloadOf = (event) => {
  if (!event.data) return FALLBACK;
  try {
    const data = event.data.json();
    return {
      title: typeof data.title === "string" ? data.title : FALLBACK.title,
      body: typeof data.body === "string" ? data.body : FALLBACK.body,
      url: typeof data.url === "string" ? data.url : FALLBACK.url,
      tag: typeof data.tag === "string" ? data.tag : FALLBACK.tag,
    };
  } catch {
    return FALLBACK;
  }
};

self.addEventListener("install", () => {
  // A new worker takes over at once; there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Declared so the browser treats dx as installable; every request goes to the
// network exactly as it would without a service worker.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  const payload = payloadOf(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // The tag collapses repeats; renotify alerts again for a new event in
      // the same Thread instead of silently replacing the last one.
      renotify: true,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url ?? "/",
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse a dx window when one is open: the person keeps their session,
      // their sidebar, and their place.
      for (const client of clients) {
        if (new URL(client.url).origin !== target.origin) continue;
        // Raising the window needs the click's user activation, which some
        // browsers withhold; the window still goes where the notification
        // pointed.
        await client.focus().catch(() => {});
        if (client.url === target.href) return;
        const navigated = await client
          .navigate(target.href)
          .then(() => true)
          .catch(() => false);
        if (navigated) return;
      }
      await self.clients.openWindow(target.href).catch(() => {});
    })(),
  );
});

/**
 * A push service may replace a subscription on its own. The worker takes the
 * new one and re-registers it, so pushes keep arriving without the person
 * opening dx.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey =
        event.oldSubscription?.options?.applicationServerKey;
      if (!applicationServerKey) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const json = subscription.toJSON();
      await fetch("/v1/notifications/push/devices", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          label: "This browser",
        }),
      });
    })(),
  );
});
