import {
  addSpanSink,
  type FinishedSpan,
  installTracing,
  muteSpanLogRecords,
  type SpanKind,
} from "./tracing.js";

/**
 * In-memory span capture for tests. Works in Node unit tests and the workerd
 * pool; worker tests that need D1 and Durable Object spans also call
 * `installRuntimeTracing()` from `platform-tracing.ts`.
 */

export interface SpanFilter {
  readonly name?: string;
  readonly kind?: SpanKind;
}

export interface SpanSummary {
  readonly spans: number;
  readonly byKind: Readonly<Record<string, number>>;
  /** D1 round trips; a batch is one. */
  readonly d1Calls: number;
  /** D1 statements; a batch counts each of its statements. */
  readonly d1Statements: number;
  readonly d1ByTable: Readonly<Record<string, number>>;
  readonly durableObjectCalls: number;
  /** `NAMESPACE METHOD /route` → calls. */
  readonly durableObjectsByTarget: Readonly<Record<string, number>>;
  readonly externalCalls: number;
  readonly externalByHost: Readonly<Record<string, number>>;
  /**
   * Most D1, Durable Object, and external calls that ran one after another
   * (no overlap by start/end order): the round trips a caller waited for in
   * sequence, independent of clock resolution.
   */
  readonly sequentialRoundTrips: number;
  readonly phases: ReadonlyArray<string>;
}

const matches = (span: FinishedSpan, filter: SpanFilter) =>
  (filter.name === undefined || span.name === filter.name) &&
  (filter.kind === undefined || span.kind === filter.kind);

const increment = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

const sorted = (counts: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );

const boundaryKinds: ReadonlySet<SpanKind> = new Set([
  "d1",
  "durable-object",
  "external",
]);

export const summarizeSpans = (
  spans: ReadonlyArray<FinishedSpan>,
): SpanSummary => {
  const byKind: Record<string, number> = {};
  const d1ByTable: Record<string, number> = {};
  const durableObjectsByTarget: Record<string, number> = {};
  const externalByHost: Record<string, number> = {};
  let d1Statements = 0;
  for (const span of spans) {
    increment(byKind, span.kind);
    const attribute = (key: string) => span.attributes[key];
    if (span.kind === "d1") {
      const statements = attribute("dx.d1.statements");
      d1Statements += typeof statements === "number" ? statements : 1;
      increment(d1ByTable, String(attribute("dx.d1.table") || "<none>"));
    } else if (span.kind === "durable-object") {
      increment(
        durableObjectsByTarget,
        `${attribute("dx.do.namespace")} ${attribute("http.request.method")} ${attribute("http.route")}`,
      );
    } else if (span.kind === "external") {
      increment(
        externalByHost,
        String(attribute("server.address") ?? attribute("dx.external.service")),
      );
    }
  }
  // Interval scheduling: the earliest-ending boundary call first gives the
  // longest chain of calls that did not overlap.
  let sequentialRoundTrips = 0;
  let chainEnd = 0;
  for (const span of spans
    .filter((candidate) => boundaryKinds.has(candidate.kind))
    .sort((left, right) => left.endSequence - right.endSequence)) {
    if (span.startSequence > chainEnd) {
      sequentialRoundTrips += 1;
      chainEnd = span.endSequence;
    }
  }
  return {
    spans: spans.length,
    byKind: sorted(byKind),
    d1Calls: byKind.d1 ?? 0,
    d1Statements,
    d1ByTable: sorted(d1ByTable),
    durableObjectCalls: byKind["durable-object"] ?? 0,
    durableObjectsByTarget: sorted(durableObjectsByTarget),
    externalCalls: byKind.external ?? 0,
    externalByHost: sorted(externalByHost),
    sequentialRoundTrips,
    phases: [
      ...new Set(
        spans
          .filter((span) => span.kind === "phase")
          .sort((left, right) => left.startSequence - right.startSequence)
          .map((span) => span.name),
      ),
    ],
  };
};

export interface SpanCapture {
  readonly spans: ReadonlyArray<FinishedSpan>;
  count(filter?: SpanFilter): number;
  find(filter?: SpanFilter): ReadonlyArray<FinishedSpan>;
  summary(filter?: { readonly endedBefore?: number }): SpanSummary;
  /** The current span-event position, for `summary({ endedBefore })`. */
  mark(): number;
  reset(): void;
  stop(): void;
}

/**
 * Starts collecting every span that finishes from now on. Span log records
 * are muted while capturing unless `logs: true`.
 */
export const captureSpans = (
  options: { readonly logs?: boolean } = {},
): SpanCapture => {
  installTracing();
  const spans: Array<FinishedSpan> = [];
  let lastSequence = 0;
  const removeSink = addSpanSink({
    end: (span) => {
      lastSequence = span.endSequence;
      spans.push(span);
    },
  });
  const unmute = options.logs === true ? () => {} : muteSpanLogRecords();
  return {
    spans,
    count: (filter = {}) =>
      spans.filter((span) => matches(span, filter)).length,
    find: (filter = {}) => spans.filter((span) => matches(span, filter)),
    summary: ({ endedBefore } = {}) =>
      summarizeSpans(
        endedBefore === undefined
          ? spans
          : spans.filter((span) => span.endSequence <= endedBefore),
      ),
    mark: () => lastSequence,
    reset: () => {
      spans.length = 0;
    },
    stop: () => {
      removeSink();
      unmute();
    },
  };
};
