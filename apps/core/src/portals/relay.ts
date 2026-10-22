// The one path from a Portal to the sandbox: the Thread execution Durable
// Object relays the request over the resident daemon's outbound connection.
// Call it only after the Portal session is authenticated and authorized, or
// for an anonymous visitor while the port is public.
//
// Contract (Thread execution object):
//   POST|GET|… https://thread-execution/proxy/http       guest HTTP request
//   GET        https://thread-execution/proxy/websocket  guest WebSocket
//   GET        https://thread-execution/proxy/ports      guest TCP listeners
// with x-dx-thread-id, x-dx-proxy-port, x-dx-proxy-target (path and query),
// x-dx-proxy-host (the Host the guest sees), and x-dx-proxy-wake ("1" may
// wake a paused workspace). The object drops every other x-dx-* header and
// forwards the rest. Failures carry x-dx-proxy-error (see
// threads/resident-proxy-relay.ts for the full list and statuses).

import type { ThreadId } from "@dx/domain";
import {
  type BrowserSessionBinding,
  setBrowserSessionHeaders,
} from "../auth/session-sockets.js";
import { guestCookieHeader, isDxCookieName, parseCookies } from "./session.js";

export type PortalRelayError =
  | "upstream-unreachable"
  | "upstream-timeout"
  | "upstream-reset"
  | "upstream-rejected"
  | "invalid-response"
  | "invalid-request"
  | "closed"
  | "too-many-streams"
  | "workspace-unavailable"
  | "workspace-paused"
  | "service-starting";

const RELAY_ERRORS = new Set<string>([
  "upstream-unreachable",
  "upstream-timeout",
  "upstream-reset",
  "upstream-rejected",
  "invalid-response",
  "invalid-request",
  "closed",
  "too-many-streams",
  "workspace-unavailable",
  "workspace-paused",
  "service-starting",
]);

/** The relay's own failure, distinct from a guest that answered 502 itself. */
export const relayError = (response: Response) => {
  const value = response.headers.get("x-dx-proxy-error");
  return value !== null && RELAY_ERRORS.has(value)
    ? (value as PortalRelayError)
    : undefined;
};

export interface PortalIdentity {
  readonly userId: string;
  readonly email?: string;
  readonly name?: string;
}

export interface PortalRelayTarget {
  readonly namespace: DurableObjectNamespace;
  readonly threadId: ThreadId;
  readonly port: number;
  /** Lowercase `host[:port]` the browser addressed. */
  readonly host: string;
  readonly protocol: "https:" | "http:";
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const WEBSOCKET_HANDSHAKE = new Set([
  "connection",
  "upgrade",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
]);
// Headers a browser or Cloudflare supplies that would let a visitor spoof
// what dx asserts (identity, client address, relay instructions). Many
// servers (CGI, PHP, nginx with underscores_in_headers) read `X_Portal_User_Id`
// as `X-Portal-User-Id`, so underscores count as hyphens.
const isReservedRequestHeader = (header: string) => {
  const name = header.toLowerCase().replaceAll("_", "-");
  return (
    name === "host" ||
    name === "cookie" ||
    name === "forwarded" ||
    name === "x-real-ip" ||
    name === "true-client-ip" ||
    name === "cdn-loop" ||
    name.startsWith("x-dx-") ||
    name.startsWith("x-portal-") ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("cf-")
  );
};

/**
 * An identity header value the guest decodes with `decodeURIComponent`:
 * printable ASCII without `%` passes as is (decoding leaves it unchanged);
 * anything else, including a literal `%`, is percent-encoded.
 */
const portalHeaderValue = (value: string) =>
  /^[\x20-\x24\x26-\x7e]*$/.test(value) ? value : encodeURIComponent(value);

/**
 * A guest Set-Cookie without its Domain attribute: Portal cookies stay on the
 * one Portal host that set them and never reach other Threads' Portals.
 */
const hostOnlyCookie = (cookie: string) =>
  cookie
    .split(";")
    .filter(
      (attribute, index) =>
        index === 0 || !/^\s*domain\s*(?:=|$)/i.test(attribute),
    )
    .join(";");

/**
 * The headers the guest service receives. Identity goes in `X-Portal-*`
 * (the relay drops `x-dx-*`), only for a signed-in dx user, and always
 * replaces whatever the browser sent under those names. An anonymous visitor
 * of a public Portal (no identity) gets no `X-Portal-*` header at all.
 */
export const guestRequestHeaders = (
  request: Request,
  target: PortalRelayTarget,
  identity: PortalIdentity | undefined,
  websocket: boolean,
) => {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (isReservedRequestHeader(name)) continue;
    if (websocket && WEBSOCKET_HANDSHAKE.has(name)) headers.set(name, value);
    else if (!HOP_BY_HOP.has(name)) headers.set(name, value);
  }
  const cookie = guestCookieHeader(request.headers.get("cookie"));
  if (cookie !== undefined) headers.set("cookie", cookie);
  headers.set("host", target.host);
  headers.set("x-forwarded-host", target.host);
  headers.set("x-forwarded-proto", target.protocol.slice(0, -1));
  const client = request.headers.get("cf-connecting-ip");
  if (client !== null) headers.set("x-forwarded-for", client);
  if (identity === undefined) return headers;
  headers.set("x-portal-authenticated", "yes");
  headers.set("x-portal-user-id", identity.userId);
  if (identity.email !== undefined)
    headers.set("x-portal-user-email", portalHeaderValue(identity.email));
  if (identity.name !== undefined)
    headers.set("x-portal-user-name", portalHeaderValue(identity.name));
  return headers;
};

const pathAndQuery = (url: URL) => `${url.pathname}${url.search}`;

const stub = (target: PortalRelayTarget) =>
  target.namespace.get(target.namespace.idFromName(target.threadId));

const relayHeaders = (
  headers: Headers,
  target: PortalRelayTarget,
  path: string,
  wake: boolean,
) => {
  headers.set("x-dx-thread-id", target.threadId);
  headers.set("x-dx-proxy-port", String(target.port));
  headers.set("x-dx-proxy-target", path);
  headers.set("x-dx-proxy-host", target.host);
  headers.set("x-dx-proxy-wake", wake ? "1" : "0");
  return headers;
};

/** An ordinary request: may wake a paused workspace. */
export const relayHttp = (
  request: Request,
  target: PortalRelayTarget,
  identity: PortalIdentity | undefined,
) => {
  const url = new URL(request.url);
  const bodyless = request.method === "GET" || request.method === "HEAD";
  return stub(target).fetch(
    new Request("https://thread-execution/proxy/http", {
      method: request.method,
      headers: relayHeaders(
        guestRequestHeaders(request, target, identity, false),
        target,
        pathAndQuery(url),
        true,
      ),
      body: bodyless ? null : request.body,
      redirect: "manual",
    }),
  );
};

/**
 * A WebSocket upgrade never wakes a paused workspace: a dev server's
 * hot-reload socket in a forgotten tab would otherwise keep waking it.
 */
export const relayWebSocket = (
  request: Request,
  target: PortalRelayTarget,
  identity: PortalIdentity | undefined,
  session: BrowserSessionBinding | undefined,
) =>
  stub(target).fetch(
    new Request("https://thread-execution/proxy/websocket", {
      method: "GET",
      headers: setBrowserSessionHeaders(
        relayHeaders(
          guestRequestHeaders(request, target, identity, true),
          target,
          pathAndQuery(new URL(request.url)),
          false,
        ),
        session,
      ),
    }),
  );

export interface GuestPort {
  readonly port: number;
}

/** Guest TCP listeners; only an explicit `wake` resumes a paused workspace. */
export const listGuestPorts = async (
  namespace: DurableObjectNamespace,
  threadId: ThreadId,
  wake = false,
): Promise<
  | { readonly kind: "running"; readonly ports: ReadonlyArray<number> }
  | { readonly kind: "paused" | "unavailable" }
> => {
  const response = await namespace.get(namespace.idFromName(threadId)).fetch(
    new Request("https://thread-execution/proxy/ports", {
      headers: {
        "x-dx-thread-id": threadId,
        "x-dx-proxy-wake": wake ? "1" : "0",
      },
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    return {
      kind:
        relayError(response) === "workspace-paused" ? "paused" : "unavailable",
    };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { readonly ports?: unknown }
    | undefined;
  if (!Array.isArray(body?.ports)) return { kind: "unavailable" };
  const ports = new Set<number>();
  for (const entry of body.ports) {
    const port = (entry as { readonly port?: unknown } | null)?.port;
    if (
      typeof port === "number" &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
    )
      ports.add(port);
  }
  return { kind: "running", ports: [...ports].sort((a, b) => a - b) };
};

const LOOPBACK_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::([0-9]{1,5}))?(?=[/?#]|$)/i;

/**
 * The guest response as the browser sees it: dx cookies cannot be set or
 * cleared by the guest, only dx may frame it, and a redirect to the guest's
 * own loopback address points back at the Portal.
 */
export const portalResponse = (
  response: Response,
  target: PortalRelayTarget,
  appOrigin: string,
) => {
  const headers = new Headers();
  for (const [name, value] of response.headers)
    if (name !== "set-cookie" && name !== "x-dx-proxy-error")
      headers.set(name, value);
  for (const cookie of response.headers.getSetCookie()) {
    const name = parseCookies(cookie.split(";", 1)[0] ?? "")[0]?.[0] ?? "";
    if (!isDxCookieName(name))
      headers.append("set-cookie", hostOnlyCookie(cookie));
  }
  const location = headers.get("location");
  const loopback = location === null ? null : LOOPBACK_ORIGIN.exec(location);
  if (
    location !== null &&
    loopback !== null &&
    (loopback[1] === undefined || Number(loopback[1]) === target.port)
  )
    headers.set(
      "location",
      `${target.protocol}//${target.host}${location.slice(loopback[0].length) || "/"}`,
    );
  headers.append(
    "content-security-policy",
    `frame-ancestors 'self' ${appOrigin}`,
  );
  headers.set("x-robots-tag", "noindex");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
