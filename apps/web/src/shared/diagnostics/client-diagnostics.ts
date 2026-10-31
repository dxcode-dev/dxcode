/**
 * What the web app noticed going wrong, kept in memory for a bug report:
 * console errors and warnings, uncaught errors, failed dx requests, and the
 * realtime connection's changes. The shared dx transports report failed
 * requests through `observeRequest`. Nothing leaves the page unless the person
 * sends a report with Thread and App Diagnostics; Core redacts it then.
 */

const LOG_LIMIT = 200;
const REQUEST_LIMIT = 100;
const CONNECTION_LIMIT = 100;
const MESSAGE_LIMIT = 4_000;

export interface AppLogEntry {
  readonly at: string;
  readonly level: "error" | "warn";
  readonly message: string;
}

export interface FailedRequestEntry {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly durationMs: number;
}

export interface ConnectionEntry {
  readonly at: string;
  readonly event: string;
  readonly detail?: string;
}

const logs: AppLogEntry[] = [];
const failedRequests: FailedRequestEntry[] = [];
const connection: ConnectionEntry[] = [];

const push = <T>(buffer: T[], limit: number, entry: T) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

const describe = (value: unknown): string => {
  if (value instanceof Error)
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const log = (level: AppLogEntry["level"], values: ReadonlyArray<unknown>) =>
  push(logs, LOG_LIMIT, {
    at: new Date().toISOString(),
    level,
    message: values.map(describe).join(" ").slice(0, MESSAGE_LIMIT),
  });

/** Records a change in the realtime connection. */
export const recordConnectionEvent = (event: string, detail?: string) =>
  push(connection, CONNECTION_LIMIT, {
    at: new Date().toISOString(),
    event,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
  });

/** A copy of everything recorded so far. */
export const clientDiagnostics = () => ({
  logs: [...logs],
  failedRequests: [...failedRequests],
  connection: [...connection],
});

/**
 * Runs one dx request and records it when it fails: a status of 400 or
 * more, or no response. An abort is the app's own choice, not a failure.
 */
export const observeRequest = async (
  path: string,
  method: string | undefined,
  run: () => Promise<Response>,
): Promise<Response> => {
  const startedAt = performance.now();
  const record = (status?: number, requestId?: string | null) =>
    push(failedRequests, REQUEST_LIMIT, {
      at: new Date().toISOString(),
      method: (method ?? "GET").toUpperCase().slice(0, 16),
      path: path.split(/[?#]/, 1)[0]?.slice(0, 1_024) ?? "",
      ...(status === undefined ? {} : { status }),
      ...(requestId ? { requestId: requestId.slice(0, 128) } : {}),
      durationMs: Math.round(performance.now() - startedAt),
    });
  try {
    const response = await run();
    if (response.status >= 400)
      record(response.status, response.headers.get("x-request-id"));
    return response;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "AbortError"))
      record();
    throw cause;
  }
};

let installed = false;

/** Starts recording; later calls do nothing. */
export const installClientDiagnostics = () => {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const { error, warn } = console;
  console.error = (...values: unknown[]) => {
    log("error", values);
    error.apply(console, values);
  };
  console.warn = (...values: unknown[]) => {
    log("warn", values);
    warn.apply(console, values);
  };
  window.addEventListener("error", (event) =>
    log("error", [event.error ?? event.message]),
  );
  window.addEventListener("unhandledrejection", (event) =>
    log("error", ["Unhandled rejection:", event.reason]),
  );
  window.addEventListener("online", () => recordConnectionEvent("online"));
  window.addEventListener("offline", () => recordConnectionEvent("offline"));
};
