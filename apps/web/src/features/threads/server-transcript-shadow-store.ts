import type { TranscriptItemsEventSchema, TranscriptPage } from "@dx/api";
import {
  ApiError,
  applyTranscriptItemOps,
  compareTranscriptItems,
  readEventStream,
  type TranscriptItemDifference,
  type TranscriptItems,
  type TranscriptViewModel,
  transcriptItems,
} from "@dx/client";
import type { ThreadId } from "@dx/domain";
import { openTranscriptUpdates } from "./server-transcript-queries.js";

/**
 * The server transcript shadow (prototype, `server-transcript` experimental
 * feature): follows the items Core projects for this Thread and compares
 * them with the web's own model once both have been still for `SETTLE_MS`.
 * The web keeps rendering its own model; differences only go to the console
 * and to `window.__dxTranscriptShadow`, which journeys read.
 */

const SETTLE_MS = 1500;
const RECONNECT_MS = 3000;

export interface ShadowReport {
  readonly threadId: string;
  readonly connected: boolean;
  readonly events: number;
  /** Bytes of event data received, before any decompression the browser did. */
  readonly bytes: number;
  readonly comparisons: number;
  /** Comparisons that found no difference. */
  readonly matches: number;
  readonly itemsCompared: number;
  /** The latest comparison's differences. */
  readonly differences: ReadonlyArray<TranscriptItemDifference>;
  /** Every distinct difference seen, by `kind id fields`. */
  readonly seen: ReadonlyArray<string>;
  readonly error?: string;
}

declare global {
  interface Window {
    __dxTranscriptShadow?: Record<string, ShadowReport>;
  }
}

type ItemsEvent = typeof TranscriptItemsEventSchema.Type;

export interface ServerTranscriptShadow {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ShadowReport;
}

export const createServerTranscriptShadow = (
  threadId: ThreadId,
  localModel: () => TranscriptViewModel,
): ServerTranscriptShadow => {
  let report: ShadowReport = {
    threadId,
    connected: false,
    events: 0,
    bytes: 0,
    comparisons: 0,
    matches: 0,
    itemsCompared: 0,
    differences: [],
    seen: [],
  };
  const listeners = new Set<() => void>();
  let server: TranscriptItems | undefined;
  let lastLocal: TranscriptViewModel | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let abort: AbortController | undefined;
  const publish = (next: Partial<ShadowReport>) => {
    report = { ...report, ...next };
    window.__dxTranscriptShadow = {
      ...window.__dxTranscriptShadow,
      [threadId]: report,
    };
    for (const listener of listeners) listener();
  };
  const compare = () => {
    settle = undefined;
    try {
      compareNow();
    } catch (cause) {
      publish({
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const compareNow = () => {
    if (server === undefined) return;
    const local = transcriptItems(localModel());
    const differences = compareTranscriptItems(local, server);
    const seen = new Set(report.seen);
    for (const difference of differences)
      seen.add(
        `${difference.kind} ${difference.id} ${(difference.fields ?? []).join(",")}`,
      );
    if (differences.length > 0)
      console.warn("dx transcript shadow: server items differ", {
        threadId,
        differences,
      });
    publish({
      comparisons: report.comparisons + 1,
      matches: report.matches + (differences.length === 0 ? 1 : 0),
      itemsCompared: report.itemsCompared + server.items.length,
      differences,
      seen: [...seen],
    });
  };
  const changed = () => {
    if (settle !== undefined) clearTimeout(settle);
    settle = setTimeout(compare, SETTLE_MS);
  };
  const follow = async (signal: AbortSignal) => {
    for (;;) {
      try {
        const response = await openTranscriptUpdates(threadId, signal);
        publish({ connected: true, error: undefined });
        for await (const { event, data } of readEventStream(response, signal)) {
          publish({
            events: report.events + 1,
            bytes: report.bytes + data.length,
          });
          if (event === "reset") {
            const page = JSON.parse(data) as TranscriptPage;
            server = { turns: page.turns, items: page.items };
          } else if (event === "items" && server !== undefined) {
            const { ops } = JSON.parse(data) as ItemsEvent;
            server = applyTranscriptItemOps(server, ops);
          }
          changed();
        }
      } catch (cause) {
        if (signal.aborted) return;
        // Turned off, or no access: nothing to compare.
        if (cause instanceof ApiError && cause.status < 500) {
          publish({ connected: false, error: cause.message });
          return;
        }
        publish({
          connected: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      if (signal.aborted) return;
      publish({ connected: false });
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
      if (signal.aborted) return;
    }
  };
  const start = () => {
    abort = new AbortController();
    void follow(abort.signal);
    // The web's model changes with its own stream; check for that too.
    watch = setInterval(() => {
      const model = localModel();
      if (model !== lastLocal) {
        lastLocal = model;
        changed();
      }
    }, 250);
  };
  const stop = () => {
    abort?.abort();
    abort = undefined;
    if (watch !== undefined) clearInterval(watch);
    if (settle !== undefined) clearTimeout(settle);
    watch = undefined;
    settle = undefined;
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => report,
  };
};
