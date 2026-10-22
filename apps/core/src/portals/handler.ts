// A request to `t-<uuid>-p<port>.<portal-domain>`. Order matters:
//   1. a malformed host, a missing capability, or a dx path answers here;
//   2. cross-site requests that could ride the cookie are refused;
//   3. a valid Portal session goes to the Thread execution object with the
//      member's identity;
//   4. without one, a public port (public-links.ts) serves the visitor
//      anonymously: rate-limited per host, a first-visit page before the
//      first document, and no identity headers;
//   5. otherwise a navigation starts the sign-in handshake and anything else
//      gets 401. None of this touches the Thread execution object, so
//      unauthenticated traffic to a private port never wakes a sandbox.

import { portalLogger } from "../logging.js";
import { recheckPortalSession } from "./access.js";
import { redeemPortalCode } from "./codes.js";
import { portalSigningKey, RANDOM_TOKEN, randomToken } from "./crypto.js";
import {
  type PortalBindings,
  type PortalConfiguration,
  type PortalHostMatch,
  portalReturnPath,
} from "./host.js";
import {
  PORTAL_PUBLIC_CONTINUE_PATH,
  PORTAL_SIGN_IN_PATH,
  portalFailure,
  portalPage,
  portalPublicNotice,
  wantsDocument,
} from "./pages.js";
import {
  findPublicLink,
  type PublicLink,
  takePublicRequest,
} from "./public-links.js";
import {
  type PortalIdentity,
  type PortalRelayTarget,
  portalResponse,
  relayError,
  relayHttp,
  relayWebSocket,
} from "./relay.js";
import {
  clearPortalCookie,
  decodePortalSession,
  encodePortalSession,
  encodePublicAcknowledgement,
  guestCookieHeader,
  hasPublicAcknowledgement,
  isDxCookieName,
  PORTAL_EMBED_COOKIE,
  PORTAL_PUBLIC_ACK_SECONDS,
  PORTAL_RECHECK_SECONDS,
  PORTAL_SESSION_SECONDS,
  PORTAL_STATE_COOKIE,
  PORTAL_STATE_SECONDS,
  PORTAL_TOP_COOKIE,
  type PortalCookieKind,
  type PortalSession,
  parseCookies,
  portalSetCookie,
} from "./session.js";

export interface PortalWorkerBindings extends PortalBindings {
  readonly DB?: D1Database;
  readonly THREAD_EXECUTION?: DurableObjectNamespace;
  readonly BETTER_AUTH_SECRET?: string;
}

/** Paths under this prefix belong to dx and never reach the guest. */
export const PORTAL_RESERVED_PREFIX = "/__dx_portal/";
export const PORTAL_CALLBACK_PATH = `${PORTAL_RESERVED_PREFIX}callback`;
export const PORTAL_AUTHORIZE_PATH = "/v1/portal-auth/authorize";
const MAX_RETURN_PATH = 2_048;
const MAX_FORM_BYTES = 4_096;
// Guest cookies forwarded per request, at most; nginx and Node refuse more
// than 8–16 KiB of headers.
const MAX_GUEST_COOKIE_BYTES = 8_192;

type PortalMatch = Extract<PortalHostMatch, { kind: "portal" }>;

const isWebSocket = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const safeMethod = (method: string) => method === "GET" || method === "HEAD";

/**
 * Sibling Portal hosts share a registrable domain, so the Lax cookie rides
 * their requests too. Only same-origin requests and plain navigations
 * (links, the dx frame) may carry it; a WebSocket must come from the Portal.
 *
 * Without Fetch Metadata (browsers before 2023, or a non-browser client), a
 * request that carries a Portal session must show it is from the Portal
 * itself (Origin, else Referer) unless it is a GET or HEAD for a document,
 * which SameSite=Lax lets any site trigger as a top-level link anyway. A
 * request without a session has nothing to ride and passes, except an unsafe
 * one from another origin.
 */
export const crossSiteRefused = (request: Request, portalOrigin: string) => {
  const origin = request.headers.get("origin");
  if (isWebSocket(request)) return origin !== null && origin !== portalOrigin;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return false;
  if (site === "same-site" || site === "cross-site")
    return !(
      request.headers.get("sec-fetch-mode") === "navigate" &&
      safeMethod(request.method)
    );
  if (!carriesSession(request))
    return (
      origin !== null && origin !== portalOrigin && !safeMethod(request.method)
    );
  const from = origin ?? refererOrigin(request);
  if (from === portalOrigin) return false;
  return !(
    safeMethod(request.method) &&
    (request.headers.get("accept") ?? "").includes("text/html")
  );
};

const refererOrigin = (request: Request) => {
  try {
    return new URL(request.headers.get("referer") ?? "").origin;
  } catch {
    return undefined;
  }
};

const carriesSession = (request: Request) =>
  parseCookies(request.headers.get("cookie")).some(
    ([name]) => name === PORTAL_TOP_COOKIE || name === PORTAL_EMBED_COOKIE,
  );

/** Only a navigation can follow the sign-in redirect and come back. */
const startsHandshake = (request: Request) => {
  if (!safeMethod(request.method) || isWebSocket(request)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  return mode === null || mode === "navigate";
};

const noStore = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

const nowSeconds = (nowMs: number) => Math.floor(nowMs / 1_000);

interface Authenticated {
  readonly session: PortalSession;
  /** Set-Cookie values that re-stamp a re-checked session. */
  readonly refresh: ReadonlyArray<string>;
}

const authenticate = async (
  request: Request,
  key: CryptoKey,
  db: D1Database,
  match: PortalMatch,
  nowMs: number,
): Promise<Authenticated | { readonly clear: boolean }> => {
  const now = nowSeconds(nowMs);
  const presented = parseCookies(request.headers.get("cookie")).flatMap(
    ([name, value]): ReadonlyArray<readonly [PortalCookieKind, string]> =>
      name === PORTAL_TOP_COOKIE
        ? [["top", value]]
        : name === PORTAL_EMBED_COOKIE
          ? [["embed", value]]
          : [],
  );
  for (const [kind, value] of presented) {
    const session = await decodePortalSession(key, value, match.host, now);
    if (session === undefined) continue;
    if (now - session.checkedAt < PORTAL_RECHECK_SECONDS)
      return { session, refresh: [] };
    if (!(await recheckPortalSession(db, session, match.threadId, nowMs))) {
      portalLogger.info("Portal session no longer has access.", {
        event: "portal_session_revoked",
        threadId: match.threadId,
        port: match.port,
      });
      return { clear: true };
    }
    const checked = { ...session, checkedAt: now };
    return {
      session: checked,
      refresh: [
        portalSetCookie(
          kind,
          await encodePortalSession(key, checked),
          checked.expiresAt - now,
        ),
      ],
    };
  }
  return { clear: presented.length > 0 };
};

const clearSessionCookies = [
  clearPortalCookie("top"),
  clearPortalCookie("embed"),
];

const requestPath = (request: Request) => {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
};

const startHandshake = (
  configuration: PortalConfiguration,
  match: PortalMatch,
  clear: boolean,
  returnPath: string,
) => {
  const state = randomToken();
  const authorize = new URL(PORTAL_AUTHORIZE_PATH, configuration.appOrigin);
  authorize.search = new URLSearchParams({
    thread: match.threadId,
    port: String(match.port),
    return: returnPath.length <= MAX_RETURN_PATH ? returnPath : "/",
    state,
  }).toString();
  const headers = new Headers({ ...noStore, location: authorize.href });
  headers.append(
    "set-cookie",
    portalSetCookie("state", state, PORTAL_STATE_SECONDS),
  );
  if (clear)
    for (const cookie of clearSessionCookies)
      headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

const signInExpired = (request: Request, configuration: PortalConfiguration) =>
  portalFailure(request, {
    status: 400,
    title: "This sign-in link has expired",
    message: "Open the Portal again to sign in.",
    frameAncestor: configuration.appOrigin,
    headers: { "set-cookie": clearPortalCookie("state") },
  });

const completeHandshake = async (
  request: Request,
  key: CryptoKey,
  db: D1Database,
  configuration: PortalConfiguration,
  match: PortalMatch,
  nowMs: number,
) => {
  const code = new URL(request.url).searchParams.get("code");
  const state = parseCookies(request.headers.get("cookie")).find(
    ([name]) => name === PORTAL_STATE_COOKIE,
  )?.[1];
  if (
    request.method !== "GET" ||
    code === null ||
    state === undefined ||
    !RANDOM_TOKEN.test(code) ||
    !RANDOM_TOKEN.test(state)
  )
    return signInExpired(request, configuration);
  const grant = await redeemPortalCode(db, code, state, match.host, nowMs);
  if (grant === undefined) {
    portalLogger.warn("Portal sign-in code was refused.", {
      event: "portal_handshake_refused",
      threadId: match.threadId,
      port: match.port,
    });
    return signInExpired(request, configuration);
  }
  const now = nowSeconds(nowMs);
  const value = await encodePortalSession(key, {
    host: match.host,
    userId: grant.userId,
    sessionId: grant.sessionId,
    ...(grant.email === undefined ? {} : { email: grant.email }),
    ...(grant.name === undefined ? {} : { name: grant.name }),
    issuedAt: now,
    expiresAt: now + PORTAL_SESSION_SECONDS,
    checkedAt: now,
  });
  const headers = new Headers({ ...noStore, location: grant.returnPath });
  headers.append(
    "set-cookie",
    portalSetCookie("top", value, PORTAL_SESSION_SECONDS),
  );
  headers.append(
    "set-cookie",
    portalSetCookie("embed", value, PORTAL_SESSION_SECONDS),
  );
  headers.append("set-cookie", clearPortalCookie("state"));
  portalLogger.info("Portal sign-in completed.", {
    event: "portal_handshake_completed",
    threadId: match.threadId,
    port: match.port,
  });
  return new Response(null, { status: 302, headers });
};

const unavailable = (
  request: Request,
  configuration: PortalConfiguration,
  headers?: HeadersInit,
) =>
  portalFailure(request, {
    status: 503,
    title: "This Portal is unavailable",
    message: "The workspace could not be reached. Try again in a moment.",
    retry: true,
    frameAncestor: configuration.appOrigin,
    ...(headers === undefined ? {} : { headers }),
  });

const relayFailure = (
  request: Request,
  response: Response,
  configuration: PortalConfiguration,
  match: PortalMatch,
  refresh: ReadonlyArray<string>,
) => {
  const error = relayError(response);
  if (error === undefined) return undefined;
  const headers = new Headers();
  for (const cookie of refresh) headers.append("set-cookie", cookie);
  const common = { frameAncestor: configuration.appOrigin, headers };
  const port = match.port;
  switch (error) {
    case "upstream-unreachable":
    case "closed":
      return portalFailure(request, {
        ...common,
        status: 502,
        title: `Nothing is listening on port ${port}`,
        message: `Start a server in the Thread on port ${port}, bound to 0.0.0.0 or 127.0.0.1. Declare it in .dx/services.yaml and dx starts it when the Portal opens.`,
        plain: error,
        retry: true,
      });
    case "upstream-reset":
    case "upstream-rejected":
    case "invalid-response":
      return portalFailure(request, {
        ...common,
        status: 502,
        title: `The server on port ${port} failed to answer`,
        message:
          "It closed the connection or sent a response that is not valid HTTP. Check its logs, then retry.",
        plain: error,
        retry: true,
      });
    case "upstream-timeout":
      return portalFailure(request, {
        ...common,
        status: 504,
        title: `Port ${port} did not respond in time`,
        message: "The server is running but has not answered. Try again.",
        plain: error,
        retry: true,
      });
    case "invalid-request":
      return portalFailure(request, {
        ...common,
        status: 400,
        title: "This request cannot be relayed",
        message: "Its address or headers are not allowed through a Portal.",
        plain: error,
      });
    case "too-many-streams":
      return portalFailure(request, {
        ...common,
        status: 503,
        title: "This Portal is busy",
        message:
          "Too many requests are open at once. This page reloads shortly.",
        plain: error,
        waking: true,
      });
    case "workspace-paused":
      return portalFailure(request, {
        ...common,
        status: 503,
        title: "The workspace is paused",
        message: "Reload the page to wake it.",
        plain: error,
        retry: true,
      });
    case "service-starting":
      return portalFailure(request, {
        ...common,
        status: 503,
        title: `Starting the server on port ${port}…`,
        message: "This page reloads when it is listening.",
        plain: error,
        waking: true,
      });
    case "workspace-unavailable":
      return portalFailure(request, {
        ...common,
        status: 503,
        title: "Waking the workspace…",
        message: "This page reloads when the workspace is ready.",
        plain: error,
        waking: true,
      });
  }
};

/**
 * Answers a Portal request. A failure of D1 or another dependency fails
 * closed with the unavailable page: nothing reaches the guest, and the
 * standalone Portal Worker never throws (which Cloudflare shows as 1101).
 */
export const handlePortalRequest = async (
  request: Request,
  bindings: PortalWorkerBindings,
  configuration: PortalConfiguration,
  match: PortalHostMatch,
): Promise<Response> => {
  try {
    return await servePortalRequest(request, bindings, configuration, match);
  } catch (error) {
    portalLogger.error("Portal request failed.", {
      event: "portal_request_failed",
      ...(match.kind === "portal"
        ? { threadId: match.threadId, port: match.port }
        : {}),
      error,
    });
    return unavailable(request, configuration);
  }
};

const servePortalRequest = async (
  request: Request,
  bindings: PortalWorkerBindings,
  configuration: PortalConfiguration,
  match: PortalHostMatch,
): Promise<Response> => {
  if (match.kind === "malformed")
    return portalFailure(request, {
      status: 404,
      title: "This Portal does not exist",
      message:
        "Check the address. Portal addresses look like t-<thread>-p<port>.",
      plain: "Not found",
      frameAncestor: configuration.appOrigin,
    });
  const url = new URL(request.url);
  if (configuration.protocol === "https:" && url.protocol !== "https:") {
    if (!safeMethod(request.method))
      return new Response("HTTPS required", { status: 400 });
    url.protocol = "https:";
    return new Response(null, {
      status: 308,
      headers: { location: url.href, "cache-control": "no-store" },
    });
  }
  const key = await portalSigningKey(bindings.BETTER_AUTH_SECRET);
  const db = bindings.DB;
  if (key === undefined || db === undefined)
    return unavailable(request, configuration);
  const nowMs = Date.now();
  if (url.pathname === PORTAL_CALLBACK_PATH)
    return completeHandshake(request, key, db, configuration, match, nowMs);
  if (url.pathname === PORTAL_SIGN_IN_PATH && safeMethod(request.method))
    return startHandshake(
      configuration,
      match,
      false,
      portalReturnPath(url.searchParams.get("return")) ?? "/",
    );
  if (url.pathname === PORTAL_PUBLIC_CONTINUE_PATH)
    return acknowledgePublicLink(request, key, db, match, nowMs);
  if (url.pathname.startsWith(PORTAL_RESERVED_PREFIX))
    return portalFailure(request, {
      status: 404,
      title: "Not found",
      message: "This address is reserved by dx.",
      frameAncestor: configuration.appOrigin,
    });
  if (crossSiteRefused(request, match.origin)) return crossSiteRefusal();

  const authenticated = await authenticate(request, key, db, match, nowMs);
  if ("session" in authenticated) {
    const { session, refresh } = authenticated;
    return relay(
      request,
      bindings,
      configuration,
      match,
      refresh,
      {
        userId: session.userId,
        ...(session.email === undefined ? {} : { email: session.email }),
        ...(session.name === undefined ? {} : { name: session.name }),
      },
      session,
    );
  }
  const link =
    framedByApp(request) && startsHandshake(request)
      ? undefined
      : await findPublicLink(db, match.threadId, match.port, nowMs);
  if (link !== undefined)
    return servePublic(
      request,
      bindings,
      configuration,
      match,
      key,
      link,
      authenticated.clear,
      nowMs,
    );
  if (startsHandshake(request))
    return startHandshake(
      configuration,
      match,
      authenticated.clear,
      requestPath(request),
    );
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
  });
  if (authenticated.clear)
    for (const cookie of clearSessionCookies)
      headers.append("set-cookie", cookie);
  return new Response("Portal sign-in required", { status: 401, headers });
};

const crossSiteRefusal = () =>
  new Response("Cross-site request refused", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * A frame the dx app shows (the Preview pane) signs in even on a public port,
 * so members keep their identity there. A same-origin frame (a guest framing
 * itself, as Storybook does) is the guest's own and stays anonymous.
 */
const framedByApp = (request: Request) => {
  const destination = request.headers.get("sec-fetch-dest");
  return (
    (destination === "iframe" || destination === "frame") &&
    request.headers.get("sec-fetch-site") !== "same-origin"
  );
};

/** An anonymous visitor of a public port. */
const servePublic = async (
  request: Request,
  bindings: PortalWorkerBindings,
  configuration: PortalConfiguration,
  match: PortalMatch,
  key: CryptoKey,
  link: PublicLink,
  clear: boolean,
  nowMs: number,
) => {
  const refresh = clear ? clearSessionCookies : [];
  if (!takePublicRequest(match.host, nowMs)) {
    portalLogger.warn("Public Portal request was rate limited.", {
      event: "portal_public_rate_limited",
      threadId: match.threadId,
      port: match.port,
    });
    return portalFailure(request, {
      status: 429,
      title: "This preview is busy",
      message: "It is getting more requests than it can serve. Try again soon.",
      plain: "Too many requests",
      retry: true,
      frameAncestor: configuration.appOrigin,
      headers: { "retry-after": "5" },
    });
  }
  if (
    wantsDocument(request) &&
    !(await hasPublicAcknowledgement(
      key,
      request.headers.get("cookie"),
      match.host,
      link.id,
      nowSeconds(nowMs),
    ))
  ) {
    const notice = portalPublicNotice(match.host, requestPath(request));
    for (const cookie of refresh) notice.headers.append("set-cookie", cookie);
    return notice;
  }
  return relay(request, bindings, configuration, match, refresh, undefined);
};

/**
 * The first-visit page's Continue button: a same-origin form post, so another
 * site cannot acknowledge the page on a visitor's behalf.
 */
const acknowledgePublicLink = async (
  request: Request,
  key: CryptoKey,
  db: D1Database,
  match: PortalMatch,
  nowMs: number,
) => {
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== match.origin
  )
    return crossSiteRefusal();
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES)
    return new Response("Request too large", { status: 413 });
  const body = await request.text();
  if (body.length > MAX_FORM_BYTES)
    return new Response("Request too large", { status: 413 });
  const headers = new Headers({
    ...noStore,
    location: portalReturnPath(new URLSearchParams(body).get("return")) ?? "/",
  });
  const link = await findPublicLink(db, match.threadId, match.port, nowMs);
  if (link !== undefined) {
    const now = nowSeconds(nowMs);
    const expiresAt = Math.min(
      now + PORTAL_PUBLIC_ACK_SECONDS,
      Math.floor(link.expiresAt / 1_000),
    );
    headers.append(
      "set-cookie",
      portalSetCookie(
        "public",
        await encodePublicAcknowledgement(key, match.host, link.id, expiresAt),
        expiresAt - now,
      ),
    );
  }
  return new Response(null, { status: 303, headers });
};

/**
 * A browser holding more guest cookies than a Portal forwards (a guest, or a
 * script on another Portal before the domain is on the Public Suffix List,
 * can pile them up) gets a page that clears them, host-only and on the
 * Portal domain, instead of a request every server would refuse.
 */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const cookieOverflow = (
  request: Request,
  configuration: PortalConfiguration,
) => {
  const header = request.headers.get("cookie");
  const forwarded = guestCookieHeader(header);
  if (forwarded === undefined || forwarded.length <= MAX_GUEST_COOKIE_BYTES)
    return undefined;
  const domain = configuration.domain.split(":", 1)[0] ?? configuration.domain;
  const headers = new Headers();
  const names = new Set(
    parseCookies(header)
      .map(([name]) => name)
      .filter((name) => !isDxCookieName(name) && COOKIE_NAME.test(name)),
  );
  for (const name of [...names].slice(0, 100)) {
    headers.append("set-cookie", `${name}=; Max-Age=0; Path=/`);
    headers.append(
      "set-cookie",
      `${name}=; Max-Age=0; Path=/; Domain=${domain}`,
    );
  }
  return portalFailure(request, {
    status: 431,
    title: "This Portal has too many cookies",
    message: "They have been cleared. Reload the page.",
    plain: "Cookies too large",
    retry: true,
    frameAncestor: configuration.appOrigin,
    headers,
  });
};

const relay = async (
  request: Request,
  bindings: PortalWorkerBindings,
  configuration: PortalConfiguration,
  match: PortalMatch,
  refresh: ReadonlyArray<string>,
  identity: PortalIdentity | undefined,
  session?: PortalSession,
) => {
  const namespace = bindings.THREAD_EXECUTION;
  if (namespace === undefined) return unavailable(request, configuration);
  const overflow = cookieOverflow(request, configuration);
  if (overflow !== undefined) return overflow;
  const target: PortalRelayTarget = {
    namespace,
    threadId: match.threadId,
    port: match.port,
    host: match.host,
    protocol: configuration.protocol,
  };
  const websocket = isWebSocket(request);
  let response: Response;
  try {
    if (websocket && request.method !== "GET")
      return new Response("WebSocket upgrades use GET", { status: 400 });
    response = websocket
      ? await relayWebSocket(
          request,
          target,
          identity,
          // The dx session's expiry is not on the Portal cookie, so the
          // first check reads it.
          session === undefined
            ? undefined
            : {
                sessionId: session.sessionId,
                userId: session.userId,
                expiresAt: 0,
              },
        )
      : await relayHttp(request, target, identity);
  } catch {
    portalLogger.error("Portal relay failed.", {
      event: "portal_relay_failed",
      threadId: match.threadId,
      port: match.port,
      websocket,
    });
    return unavailable(request, configuration);
  }
  if (websocket && response.status === 101) return response;
  const failure = relayFailure(
    request,
    response,
    configuration,
    match,
    refresh,
  );
  if (failure !== undefined) {
    await response.body?.cancel();
    return failure;
  }
  const forwarded = portalResponse(response, target, configuration.appOrigin);
  for (const cookie of refresh) forwarded.headers.append("set-cookie", cookie);
  return forwarded;
};

/** A complete page for a request the app origin cannot authorize. */
export const portalAuthorizationPage = (
  status: 400 | 403 | 404 | 409,
  title: string,
  message: string,
) => portalPage({ status, title, message, headers: noStore });
