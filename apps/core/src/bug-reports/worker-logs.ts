import type { ThreadId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { observeExternal } from "../observability/boundaries.js";

/**
 * The reported Thread's Worker log lines, read from this deployment's own
 * Workers Observability data with the read-only token the deploy mints
 * (`DX_WORKER_LOGS`, `{ accountId, token }`). The query names the Thread,
 * and every returned line is checked again, so a line from another Thread
 * never reaches a report. Adapted from the Workers Observability client in
 * draft #897 (`apps/console/src/worker/sources/cloudflare.ts`).
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** Lines a report carries at most, newest kept. */
const LINE_LIMIT = 500;
/** How far back a report reads; Cloudflare keeps seven days. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const MESSAGE_LIMIT = 4_000;

type Scalar = string | number | boolean;

export interface WorkerLogLine {
  readonly at: string;
  readonly level: string;
  readonly message: string;
  /** The line's own fields: `event`, `requestId`, `route`, `status`, ... */
  readonly fields: Readonly<Record<string, Scalar>>;
}

export class WorkerLogsUnavailable extends Error {
  override readonly name = "WorkerLogsUnavailable";
}

interface Access {
  readonly accountId: string;
  readonly token: string;
}

const access = (bindings: Bindings): Access | undefined => {
  try {
    const value = JSON.parse(bindings.DX_WORKER_LOGS ?? "") as Partial<Access>;
    return typeof value.accountId === "string" &&
      /^[a-f0-9]{32}$/.test(value.accountId) &&
      typeof value.token === "string" &&
      value.token !== ""
      ? { accountId: value.accountId, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
};

/** Whether this deployment can read its Worker logs. */
export const workerLogsAvailable = (bindings: Bindings) =>
  access(bindings) !== undefined;

const flatten = (
  value: unknown,
  prefix: string,
  into: Record<string, Scalar>,
) => {
  if (value === null || value === undefined) return into;
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, into);
    return into;
  }
  if (prefix === "") return into;
  into[prefix] =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? value
      : JSON.stringify(value);
  return into;
};

interface RawEvent {
  readonly timestamp?: number;
  readonly source?: unknown;
  readonly $metadata?: Record<string, unknown>;
}

/** Log lines of the events, oldest first; spans and other Threads' lines are dropped. */
export const workerLogLines = (
  events: ReadonlyArray<RawEvent>,
  threadId: string,
): ReadonlyArray<WorkerLogLine> =>
  events
    .flatMap((event) => {
      const meta = event.$metadata ?? {};
      if (meta.type === "span" || meta.type === "cf-worker-event") return [];
      const source = flatten(event.source, "", {});
      if (source.threadId !== threadId) return [];
      const at =
        typeof event.timestamp === "number" ? event.timestamp : Date.now();
      const message =
        typeof source.message === "string"
          ? source.message
          : typeof meta.message === "string"
            ? meta.message
            : "";
      const fields = { ...source };
      for (const key of ["message", "level", "timestamp"]) delete fields[key];
      return [
        {
          at,
          line: {
            at: new Date(at).toISOString(),
            level:
              typeof source.level === "string"
                ? source.level
                : typeof meta.level === "string"
                  ? meta.level
                  : "info",
            message: message.slice(0, MESSAGE_LIMIT),
            fields,
          },
        },
      ];
    })
    .sort((left, right) => left.at - right.at)
    .slice(-LINE_LIMIT)
    .map(({ line }) => line);

/**
 * The Thread's log lines since it started, or the last 24 hours of a longer
 * Thread. Throws `WorkerLogsUnavailable` without access.
 */
export const readThreadWorkerLogs = async (
  bindings: Bindings,
  threadId: ThreadId,
  fetcher: typeof fetch = fetch,
) => {
  const credentials = access(bindings);
  if (credentials === undefined)
    throw new WorkerLogsUnavailable(
      "This deployment has no Worker logs access.",
    );
  const to = Date.now();
  const created = await bindings.DB?.prepare(
    "SELECT created_at FROM threads WHERE id = ?1",
  )
    .bind(threadId)
    .first<{ created_at: string }>();
  const startedAt = Date.parse(created?.created_at ?? "");
  const from = Math.max(
    to - WINDOW_MS,
    Number.isFinite(startedAt) ? startedAt - 60_000 : to - WINDOW_MS,
  );
  const url = `${CLOUDFLARE_API}/accounts/${credentials.accountId}/workers/observability/telemetry/query`;
  const response = await observeExternal(
    "cloudflare",
    "observability-query",
    url,
    () =>
      fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          queryId: "dx-bug-report",
          view: "events",
          limit: 2_000,
          timeframe: { from, to },
          parameters: {
            filterCombination: "and",
            filters: [
              {
                key: "threadId",
                operation: "eq",
                type: "string",
                value: threadId,
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(8_000),
      }),
  );
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: ReadonlyArray<{ message?: string }>;
    result?: { events?: { events?: ReadonlyArray<RawEvent> } };
  } | null;
  if (!response.ok || payload?.success !== true)
    throw new Error(
      `Workers Observability answered ${response.status}${
        payload?.errors?.[0]?.message === undefined
          ? ""
          : `: ${payload.errors[0].message.slice(0, 200)}`
      }.`,
    );
  const events = payload.result?.events?.events ?? [];
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    lines: workerLogLines(events, threadId),
  };
};
