import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { CSP_POLICIES } from "./content-security-policy.mjs";

const logger = getLogger(["dx", "security", "csp"]);

/** A report is a few hundred bytes; a batch from the Reporting API more. */
const MAX_BODY_BYTES = 16 * 1_024;
const MAX_REPORTS_PER_REQUEST = 20;
const WINDOW_MS = 60_000;
/** Per client address in one isolate, and for the whole isolate. */
const CLIENT_LIMIT = 30;
const ISOLATE_LIMIT = 600;

let windowStartedAt = 0;
let isolateCount = 0;
const clientCounts = new Map<string, number>();

/** Counts in memory only; the address is never logged or stored. */
const admit = (client: string, now: number) => {
  if (now - windowStartedAt >= WINDOW_MS) {
    windowStartedAt = now;
    isolateCount = 0;
    clientCounts.clear();
  }
  const count = clientCounts.get(client) ?? 0;
  if (count >= CLIENT_LIMIT || isolateCount >= ISOLATE_LIMIT) return false;
  clientCounts.set(client, count + 1);
  isolateCount += 1;
  return true;
};

/** For tests: a fresh window. */
export const resetCspReportLimits = () => {
  windowStartedAt = 0;
  isolateCount = 0;
  clientCounts.clear();
};

/** The body as UTF-8, or undefined once it passes `MAX_BODY_BYTES`. */
const boundedText = async (body: ReadableStream<Uint8Array> | null) => {
  if (body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const KEYWORD = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The blocked resource without anything that could identify a person: an
 * http(s) or ws(s) URL keeps its origin and path, never its query or
 * fragment; `inline`, `eval`, and other keywords stay as they are; anything
 * else becomes its scheme.
 */
export const blockedResource = (value: unknown): string => {
  if (typeof value !== "string" || value === "") return "none";
  if (KEYWORD.test(value)) return value;
  try {
    const url = new URL(value);
    if (/^(?:https?|wss?):$/.test(url.protocol))
      return `${url.origin}${url.pathname}`.slice(0, 300);
    const scheme = url.protocol.slice(0, -1);
    return KEYWORD.test(scheme) ? scheme : "other";
  } catch {
    return "other";
  }
};

const keyword = (value: unknown) =>
  typeof value === "string" && KEYWORD.test(value) ? value : "unknown";

interface Violation {
  readonly directive: string;
  readonly blockedUrl: string;
  readonly disposition: string;
}

const field = (record: Record<string, unknown>, ...names: string[]) =>
  names.map((name) => record[name]).find((value) => value !== undefined);

const violation = (record: Record<string, unknown>): Violation => ({
  directive: keyword(
    field(record, "effective-directive", "effectiveDirective") ??
      String(field(record, "violated-directive") ?? "").split(" ")[0],
  ),
  blockedUrl: blockedResource(field(record, "blocked-uri", "blockedURL")),
  disposition: keyword(field(record, "disposition")),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `report-uri` posts `{ "csp-report": {…} }`; the Reporting API posts an
 * array of `{ type: "csp-violation", body: {…} }`.
 */
export const violationsIn = (payload: unknown): Violation[] => {
  if (isRecord(payload) && isRecord(payload["csp-report"]))
    return [violation(payload["csp-report"])];
  if (!Array.isArray(payload)) return [];
  return payload
    .slice(0, MAX_REPORTS_PER_REQUEST)
    .filter(
      (report): report is { type: string; body: Record<string, unknown> } =>
        isRecord(report) &&
        report.type === "csp-violation" &&
        isRecord(report.body),
    )
    .map((report) => violation(report.body));
};

/**
 * Mounted at `CSP_REPORT_PATH`, without sign-in: browsers send reports
 * without credentials. Each report becomes one log line with the policy, the
 * directive, and the blocked URL; nothing about the person or the page.
 */
export const cspReportRoutes = new Hono<AppEnv>().post("/", async (context) => {
  const client = context.req.header("cf-connecting-ip") ?? "unknown";
  if (!admit(client, Date.now())) return context.body(null, 429);
  const declared = Number(context.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return context.body(null, 413);
  const text = await boundedText(context.req.raw.body);
  if (text === undefined) return context.body(null, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return context.body(null, 400);
  }
  const requested = context.req.query("policy");
  const policy = CSP_POLICIES.find((name) => name === requested) ?? "unknown";
  for (const report of violationsIn(payload))
    logger.warn("Content Security Policy violation.", {
      event: "csp_violation",
      policy,
      ...report,
    });
  return context.body(null, 204);
});
