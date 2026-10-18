import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSpans, type SpanCapture } from "./span-capture.js";
import { installTracing, traceSpan } from "./tracing.js";

/**
 * Workers Logs volume. Ways the log sink could fail:
 * - named Effect.fn spans reach the log as one record each;
 * - a failed or defected Effect span is dropped with the noise;
 * - the per-request summary is missing, repeated, or miscounts calls;
 * - a nested span is summarized as if it were a request;
 * - trimming the log also trims what tests and Workers Traces receive.
 */

installTracing();

const step = Effect.fn("journey.step")(function* (index: number) {
  return yield* Effect.succeed(index);
});
const failingStep = Effect.fn("journey.failing")(function* () {
  return yield* Effect.fail({ _tag: "StepRejected" as const });
});
const dyingStep = Effect.fn("journey.dying")(function* () {
  return yield* Effect.die(new Error("boom"));
});
const d1 = (table: string) =>
  traceSpan("d1.first", "d1", { "dx.d1.table": table }, async () => table);

/** A request: 300 Effect.fn spans, two sequential D1 calls, two parallel. */
const request = () =>
  traceSpan(
    "http.request",
    "request",
    { "dx.request_id": "log-volume", "http.route": "/v1/threads" },
    async () => {
      await Effect.runPromise(
        Effect.forEach(
          Array.from({ length: 300 }, (_, i) => i),
          step,
        ),
      );
      await d1("threads");
      await d1("projects");
      await Promise.all([d1("member"), d1("user")]);
      await Effect.runPromise(Effect.exit(failingStep()));
      await Effect.runPromise(Effect.exit(dyingStep()));
    },
  );

type LogLine = Record<string, unknown>;

let capture: SpanCapture;
let lines: Array<LogLine>;

beforeEach(() => {
  capture = captureSpans({ logs: true });
  lines = [];
  vi.spyOn(console, "info").mockImplementation((line: LogLine) => {
    if (line.category === "dx.trace") lines.push(line);
  });
});

afterEach(() => {
  capture.stop();
  vi.restoreAllMocks();
});

describe("span log records", () => {
  it("logs boundary and failed spans plus one request summary; capture sees every span", async () => {
    await request();

    const spans = lines.filter((line) => line.event === "span_finished");
    expect(spans.map((line) => line.span).sort()).toEqual([
      "d1.first",
      "d1.first",
      "d1.first",
      "d1.first",
      "http.request",
      "journey.dying",
      "journey.failing",
    ]);
    expect(
      spans
        .filter((line) => line.kind === "effect")
        .map((line) => [line.span, line.status, line.attributes]),
    ).toEqual(
      expect.arrayContaining([
        ["journey.failing", "error", { "error.type": "StepRejected" }],
        ["journey.dying", "error", { "error.type": "defect" }],
      ]),
    );

    const summaries = lines.filter((line) => line.event === "request_summary");
    expect(summaries).toHaveLength(1);
    const [root] = capture.find({ kind: "request" });
    expect(summaries[0]).toMatchObject({
      span: "http.request",
      kind: "request",
      traceId: root?.traceId,
      status: "ok",
      durationMs: root?.durationMs,
      attributes: {
        "dx.request_id": "log-volume",
        "http.route": "/v1/threads",
      },
      spans: 307,
      byKind: { d1: 4, effect: 302, request: 1 },
      sequentialRoundTrips: 3,
    });

    // Tests and the Workers custom-span bridge still receive everything.
    expect(capture.count({ name: "journey.step" })).toBe(300);
    expect(capture.summary()).toMatchObject({
      spans: 307,
      byKind: { d1: 4, effect: 302, request: 1 },
      sequentialRoundTrips: 3,
    });
  });

  it("writes no summary for a span that is not a trace root", async () => {
    await traceSpan("outer", "phase", {}, () =>
      traceSpan("http.request", "request", {}, async () => {
        await d1("threads");
      }),
    );
    expect(lines.filter((line) => line.event === "request_summary")).toEqual(
      [],
    );
  });

  it("still summarizes a request whose spans exceed the per-trace cap", async () => {
    await traceSpan("http.request", "request", {}, () =>
      Effect.runPromise(
        Effect.forEach(
          Array.from({ length: 600 }, (_, i) => i),
          step,
        ),
      ),
    );
    expect(capture.count()).toBe(513);
    expect(
      lines.filter((line) => line.event === "request_summary"),
    ).toMatchObject([
      { spans: 513, byKind: { effect: 512, request: 1 }, droppedSpans: 88 },
    ]);
  });
});

/**
 * `pnpm dev` re-evaluates this module when Vite reloads, in the same isolate,
 * while the D1 and Durable Object binding wrappers keep the copy that
 * patched them. Ways tracing could fail across two copies:
 * - a boundary span parented to the other copy's span starts its own tally,
 *   so the request summary omits it;
 * - a Promise-code span cannot see the other copy's active request and
 *   starts its own trace;
 * - each copy's log sink logs the span again, or neither does;
 * - separate span-event counters miscount sequential round trips;
 * - a test capture misses the other copy's spans.
 */
describe("a reloaded copy of the tracing module", () => {
  it("summarizes the boundary spans the first copy opens inside its request", async () => {
    const reloaded = await vi.importActual<typeof import("./tracing.js")>(
      "./tracing.js?reloaded",
    );
    reloaded.installTracing();

    await reloaded.traceSpan(
      "http.request",
      "request",
      { "dx.request_id": "reloaded", "http.route": "/v1/threads" },
      async () => {
        // A repository query: the reloaded Effect span, the first copy's D1.
        await Effect.runPromise(
          Effect.promise(() => d1("threads")).pipe(
            Effect.withSpan("ThreadRepository.find"),
          ),
        );
        await d1("projects");
        await traceSpan(
          "ThreadExecutionObject.fetch",
          "durable-object",
          {},
          async () => undefined,
        );
      },
    );

    const spans = lines.filter((line) => line.event === "span_finished");
    expect(spans.map((line) => line.span).sort()).toEqual([
      "ThreadExecutionObject.fetch",
      "d1.first",
      "d1.first",
      "http.request",
    ]);
    const summaries = lines.filter((line) => line.event === "request_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      span: "http.request",
      spans: 5,
      byKind: { d1: 2, "durable-object": 1, effect: 1, request: 1 },
      sequentialRoundTrips: 3,
    });
    expect(new Set(spans.map((line) => line.traceId))).toEqual(
      new Set([summaries[0]?.traceId]),
    );
    expect(capture.summary()).toMatchObject({
      spans: 5,
      byKind: { d1: 2, "durable-object": 1, effect: 1, request: 1 },
      sequentialRoundTrips: 3,
    });
  });
});
