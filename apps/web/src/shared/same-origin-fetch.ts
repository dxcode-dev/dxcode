import {
  ABSENT_CONVERSATION_REQUEST_HEADER,
  ABSENT_CONVERSATION_RESPONSE_HEADER,
  SHELL_PARTS,
  type ShellPart,
  ShellResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { noticeUnauthenticated } from "./auth/session-ended.js";
import { observeRequest } from "./diagnostics/client-diagnostics.js";

/** The request's path, as the failed-request log records it. */
const requestPath = (input: RequestInfo | URL) => {
  try {
    return new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    ).pathname;
  } catch {
    return "";
  }
};

/** The request's path and query, which boot reads are keyed by. */
const requestTarget = (input: RequestInfo | URL) => {
  try {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    return url.origin === window.location.origin
      ? url.pathname + url.search
      : undefined;
  } catch {
    return undefined;
  }
};

/** A read of a Thread agent's history, by its URL. */
const isAgentHistoryRead = (url: string) => /[?&]view=history(&|$)/.test(url);

/**
 * Flue's answer for a conversation that has not started, made in the page.
 * Core answers a history read that asks 204 instead, so the browser logs no
 * error (see `ABSENT_CONVERSATION_REQUEST_HEADER`); Flue's client still
 * reads its own 404.
 */
export const absentHistoryResponse = () =>
  new Response('{"error":{"type":"stream_not_found"}}', {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const absentAsNotFound = (response: Response) =>
  response.status === 204 &&
  response.headers.get(ABSENT_CONVERSATION_RESPONSE_HEADER) === "absent"
    ? absentHistoryResponse()
    : response;

/**
 * The signed-in app's first-load reads, started at boot as soon as the
 * session check finds someone signed in, beside the app's code (#1379,
 * #1156, #1599):
 *
 * - `GET /v1/shell` for the shell's parts;
 * - the reads every page waits on, the account and the sidebar layout, each
 *   on its own because alone each answers sooner than the shell;
 * - on a Thread's page, the reads it waits on before it shows: the Thread,
 *   its pane layout, and its first page of history.
 *
 * The dx transport (`request`) and this fetch hand each answer to the first
 * `GET` of the same path and query, so the features' own queries and Flue's
 * client stay the owners of their data and only their first read skips the
 * network. A failed answer, a path read a second time, and anything asked
 * after `BOOT_READ_LIFETIME_MS` go to the network.
 */

/** How long after an answer arrives it may serve a first read. */
const BOOT_READ_LIFETIME_MS = 15_000;

/** Read alone at boot: each page renders only once these answer. */
const GATING_BOOT_READS = [
  "/v1/settings/personal/account",
  "/v1/sidebar-layout",
] as const;

/** Flue's first history page, as the Thread session asks for it. */
const threadHistoryPath = (threadId: string) =>
  `/v1/agents/dx/${encodeURIComponent(threadId)}?view=history&promptLimit=2&maxBytes=1048576`;

/** A Thread page's reads, from its URL; none elsewhere. */
const threadBootReads = (pathname: string) => {
  const threadId = /^\/threads\/(thr_[0-9a-f-]{36})\/?$/.exec(pathname)?.[1];
  if (threadId === undefined) return [];
  const thread = `/v1/threads/${encodeURIComponent(threadId)}`;
  return [thread, `${thread}/layout`, threadHistoryPath(threadId)];
};

export interface BootAnswer {
  readonly arrivedAt: number;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

let bootReads: Map<string, Promise<BootAnswer | undefined>> | undefined;
/** When `prefetchThreadHistory` started each of its reads. */
const prefetchedAt = new Map<string, number>();

const readAlone = async (path: string): Promise<BootAnswer | undefined> => {
  try {
    const response = absentAsNotFound(
      await fetch(path, {
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(isAgentHistoryRead(path)
            ? { [ABSENT_CONVERSATION_REQUEST_HEADER]: "1" }
            : {}),
        },
      }),
    );
    const answer = {
      arrivedAt: Date.now(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
    };
    if (response.ok) return { ...answer, text: await response.text() };
    // Flue answers 404 for a Thread with no history yet; that answer serves
    // a first read too. Anything else is read again.
    if (response.status === 404)
      return { ...answer, text: await response.text() };
    return { ...answer, text: "" };
  } catch {
    return undefined;
  }
};

const readShell = async () => {
  const answer = await readAlone("/v1/shell");
  // Signed out, or a Core without the route: every read goes out itself.
  if (answer?.status !== 200) return undefined;
  try {
    const shell = await Schema.decodeUnknownPromise(ShellResponseSchema)(
      JSON.parse(answer.text),
    );
    return {
      arrivedAt: answer.arrivedAt,
      parts: new Map<string, ShellPart>(
        Object.entries(SHELL_PARTS).map(([name, path]) => [
          path,
          shell.data[name as keyof typeof SHELL_PARTS],
        ]),
      ),
    };
  } catch {
    return undefined;
  }
};

/** Starts the boot reads; later calls reuse them until they are cleared. */
export const prefetchBootReads = () => {
  if (bootReads !== undefined) return;
  const shell = readShell();
  bootReads = new Map([
    ...[...GATING_BOOT_READS, ...threadBootReads(window.location.pathname)].map(
      (path) => [path, readAlone(path)] as const,
    ),
    ...Object.values(SHELL_PARTS).map(
      (path) =>
        [
          path,
          shell.then((answer): BootAnswer | undefined => {
            const part = answer?.parts.get(path);
            return answer === undefined || part === undefined
              ? undefined
              : {
                  arrivedAt: answer.arrivedAt,
                  status: part.status,
                  contentType: "application/json",
                  text: JSON.stringify(part.body),
                };
          }),
        ] as const,
    ),
  ]);
};

/**
 * Reads a Thread's first history page ahead of opening it, as hovering or
 * pressing its link does, so Flue's first read of it takes this answer
 * (#1438). A read started within the answer lifetime is reused.
 */
export const prefetchThreadHistory = (threadId: string) => {
  const target = threadHistoryPath(threadId);
  bootReads ??= new Map();
  const started = prefetchedAt.get(target);
  // Boot's own read of it, or a recent prefetch, still serves.
  if (
    bootReads.has(target) &&
    (started === undefined || Date.now() - started < BOOT_READ_LIFETIME_MS)
  )
    return;
  prefetchedAt.set(target, Date.now());
  bootReads.set(target, readAlone(target));
};

/** Signing out drops answers read for the previous person. */
export const clearBootReads = () => {
  bootReads = undefined;
  prefetchedAt.clear();
};

/**
 * The boot answer for the first `GET` of `target` (path and query), once it
 * arrives, or undefined when the read should go to the network.
 */
export const takeBootRead = async (
  target: string,
): Promise<BootAnswer | undefined> => {
  const pending = bootReads?.get(target);
  if (pending === undefined) return undefined;
  bootReads?.delete(target);
  const answer = await pending;
  if (answer === undefined) return undefined;
  if (Date.now() - answer.arrivedAt > BOOT_READ_LIFETIME_MS) return undefined;
  return answer;
};

export const sameOriginFetch: typeof fetch = async (input, init) => {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  const target = requestTarget(input);
  if (method === "GET" && target !== undefined) {
    const answer = await takeBootRead(target);
    if (answer?.status === 200 || answer?.status === 404)
      return new Response(answer.text, {
        status: answer.status,
        headers: { "content-type": answer.contentType },
      });
  }
  const historyRead =
    method === "GET" &&
    isAgentHistoryRead(input instanceof Request ? input.url : String(input));
  const headers = historyRead
    ? new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
    : undefined;
  headers?.set(ABSENT_CONVERSATION_REQUEST_HEADER, "1");
  const response = await observeRequest(
    requestPath(input),
    init?.method ?? (input instanceof Request ? input.method : undefined),
    () =>
      fetch(input, {
        ...init,
        ...(headers === undefined ? {} : { headers }),
        credentials: "same-origin",
      }),
  );
  noticeUnauthenticated(response);
  return historyRead ? absentAsNotFound(response) : response;
};
