import { PLUGIN_SERVICE_HTTP_TOKEN_PREFIX } from "@dx/domain";
import { type Context, Hono } from "hono";
import { readBoundedBody } from "../../http/bounded-body.js";
import type { AppEnv, Bindings } from "../../http/types.js";
import { insertPluginAudit } from "../audit/audit.js";
import { callService, SERVICE_CALL_MAX_MS } from "./host.js";
import { actingUserOf, loadServiceInstall } from "./installs.js";

/**
 * A plugin program's address on the internet (`service.http`):
 * `/api/plugin-services/<install id>/http/<path>`. Core answers it, not the
 * plugin Orb, so a caller without a token this plugin issued is refused
 * before any Orb work: no wake, no dxd call.
 *
 * In order: 404 for an install that is not running or declares no
 * `service.http`; 401 unless the bearer token's SHA-256 is a key the
 * program stored in its dx state (`http-token:<sha256 hex>`, whose value may
 * limit it to one path); 413 for a body over 1 MiB. A request with no
 * bearer token gets 401 with no D1 read at all. Callers with a valid token
 * are never rate-limited: only refusals spend a per-install budget, and
 * once it is spent a request with no token gets 429, so a flood of bad
 * requests never slows the people using the address. An accepted request writes one `service.http` audit
 * row (method, path, status, time; never a body or a token) and reaches the
 * program as `POST /http` with `{ method, path, headers, body }` over the
 * service-call channel. The program answers `{ status, headers, body }`.
 *
 * That channel buffers each reply (dxd's `service.call`: up to 5 minutes and
 * 8 MiB), so a reply never streams: an MCP
 * server behind it answers each POST with one JSON reply and its GET push
 * stream with 405, as Streamable HTTP allows.
 */

const MAX_BODY_BYTES = 1_048_576;
const MAX_TOKEN_LENGTH = 512;

/** Request headers the program sees; never Authorization or cookies. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "user-agent",
] as const;

/** Reply headers the program may set. */
const FORWARDED_RESPONSE_HEADERS = new Set([
  "allow",
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
]);

// Refused requests per install, per isolate: a burst of 600, then 20 a
// second. Accepted requests spend nothing.
const BUCKET_CAPACITY = 600;
const BUCKET_REFILL_PER_MS = 20 / 1_000;
const BUCKET_CACHE_LIMIT = 10_000;
const buckets = new Map<string, { tokens: number; at: number }>();

const refusalBudget = (pluginId: string, nowMs: number) => {
  const bucket = buckets.get(pluginId);
  return bucket === undefined
    ? BUCKET_CAPACITY
    : Math.min(
        BUCKET_CAPACITY,
        bucket.tokens + Math.max(0, nowMs - bucket.at) * BUCKET_REFILL_PER_MS,
      );
};

/** Charges one refusal to an install's budget. */
const chargeRefusal = (pluginId: string, nowMs: number) => {
  if (!buckets.has(pluginId) && buckets.size >= BUCKET_CACHE_LIMIT)
    buckets.clear();
  buckets.set(pluginId, {
    tokens: Math.max(0, refusalBudget(pluginId, nowMs) - 1),
    at: nowMs,
  });
};

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const refusal = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
      ...(status === 429 ? { "retry-after": "1" } : {}),
    },
  });

const bearerToken = (header: string | undefined) => {
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(header?.trim() ?? "");
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_TOKEN_LENGTH
    ? token
    : undefined;
};

/** Whether a stored token opens `path`: any path, or its own and below. */
const tokenOpens = (value: unknown, path: string) => {
  const limit = (value as { path?: unknown } | null)?.path;
  if (typeof limit !== "string" || limit === "" || limit === "/") return true;
  const prefix = limit.endsWith("/") ? limit.slice(0, -1) : limit;
  return path === prefix || path.startsWith(`${prefix}/`);
};

const findToken = async (db: D1Database, pluginId: string, token: string) => {
  const row = await db
    .prepare(
      "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
    )
    .bind(
      pluginId,
      `${PLUGIN_SERVICE_HTTP_TOKEN_PREFIX}${await sha256Hex(token)}`,
    )
    .first<{ value_json: string }>();
  if (row === null) return undefined;
  try {
    return { value: JSON.parse(row.value_json) as unknown };
  } catch {
    return { value: null };
  }
};

const programReply = (body: unknown) => {
  const reply = body as {
    status?: unknown;
    headers?: unknown;
    body?: unknown;
  } | null;
  const status = reply?.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599
  )
    return undefined;
  const headers = new Headers({ "cache-control": "no-store" });
  if (reply?.headers !== null && typeof reply?.headers === "object")
    for (const [name, value] of Object.entries(reply.headers))
      if (
        FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) &&
        typeof value === "string"
      )
        headers.set(name, value);
  const content =
    reply?.body === undefined || reply.body === null
      ? null
      : typeof reply.body === "string"
        ? reply.body
        : JSON.stringify(reply.body);
  if (content !== null && !headers.has("content-type"))
    headers.set(
      "content-type",
      typeof reply?.body === "string" ? "text/plain" : "application/json",
    );
  // A 204 or 304 carries no body.
  return new Response(status === 204 || status === 304 ? null : content, {
    status,
    headers,
  });
};

export const servePluginServiceHttp = async (
  bindings: Bindings,
  request: Request,
  input: {
    readonly pluginId: string;
    /** The path under `/http`, starting with `/`. */
    readonly path: string;
    readonly requestId?: string;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<Response> => {
  const db = bindings.DB;
  if (db === undefined)
    return refusal(404, "not-found", "No such plugin address.");
  const token = bearerToken(request.headers.get("authorization") ?? undefined);
  // Without a token the answer is 401 whatever the install: no D1 read.
  if (token === undefined) {
    if (refusalBudget(input.pluginId, Date.now()) < 1)
      return refusal(429, "rate-limited", "Too many refused requests.");
    chargeRefusal(input.pluginId, Date.now());
    return refusal(
      401,
      "unauthorized",
      "Send a bearer token this plugin issued for this address.",
    );
  }
  const install = await loadServiceInstall(db, input.pluginId);
  if (install === undefined || install.code.service?.http !== true) {
    chargeRefusal(input.pluginId, Date.now());
    return refusal(404, "not-found", "No such plugin address.");
  }
  const stored = await findToken(db, install.pluginId, token);
  if (stored === undefined || !tokenOpens(stored.value, input.path)) {
    chargeRefusal(input.pluginId, Date.now());
    return refusal(
      401,
      "unauthorized",
      "Send a bearer token this plugin issued for this address.",
    );
  }
  const bytes = await readBoundedBody(request, MAX_BODY_BYTES);
  if (bytes === undefined)
    return refusal(413, "too-large", "A request body is at most 1 MiB.");
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const url = new URL(request.url);
  const started = Date.now();
  const outcome = await callService(bindings, install, {
    path: "/http",
    body: {
      method: request.method,
      path: `${input.path}${url.search}`,
      headers,
      body: new TextDecoder().decode(bytes),
    },
    timeoutMs: SERVICE_CALL_MAX_MS,
  });
  const response = !outcome.ok
    ? refusal(
        503,
        outcome.reason,
        `${install.displayName}'s program is not available: ${outcome.message}`,
      )
    : outcome.value.status >= 400
      ? refusal(
          502,
          "program-failed",
          `${install.displayName}'s program answered ${outcome.value.status}.`,
        )
      : (programReply(outcome.value.body) ??
        refusal(
          502,
          "bad-reply",
          `${install.displayName}'s program did not answer with { status, headers, body }.`,
        ));
  const audit = insertPluginAudit(db, {
    pluginId: install.pluginId,
    pluginName: install.name,
    pluginVersion: install.version,
    scope: install.scope,
    ownerUserId: actingUserOf(install) ?? install.targetId,
    action: "service.http",
    target: input.path,
    outcome: response.status < 500 ? "success" : "failed",
    detail: {
      method: request.method,
      status: response.status,
      ms: Date.now() - started,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    },
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  if (input.waitUntil === undefined) await audit;
  else input.waitUntil(audit);
  return response;
};

/** `/api/plugin-services`: no session; the program's own tokens decide. */
export const pluginServiceHttpRoutes = new Hono<AppEnv>();

const serve = async (context: Context<AppEnv>) => {
  const method = context.req.method;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    return refusal(405, "method", "Use GET, POST, PUT, PATCH, or DELETE.");
  const pluginId = context.req.param("pluginId") ?? "";
  const prefix = `/api/plugin-services/${encodeURIComponent(pluginId)}/http`;
  const pathname = new URL(context.req.url).pathname;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const execution = context.executionCtx;
    waitUntil = (promise) => execution.waitUntil(promise);
  } catch {
    waitUntil = undefined;
  }
  return servePluginServiceHttp(context.env, context.req.raw, {
    pluginId,
    path: rest === "" ? "/" : rest,
    requestId: context.get("requestId"),
    ...(waitUntil === undefined ? {} : { waitUntil }),
  });
};

pluginServiceHttpRoutes.all("/:pluginId/http/*", (context) => serve(context));
pluginServiceHttpRoutes.all("/:pluginId/http", (context) => serve(context));
