import { AsyncLocalStorage } from "node:async_hooks";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Tracer,
} from "effect";
import * as Hex from "effect/encoding/Hex";
import { traceLogger } from "../logging.js";

/**
 * dx tracing: every finished span, from Effect (`Effect.fn`, `Effect.withSpan`,
 * `@effect/sql`) or from Promise code (`observeCall`), becomes one
 * content-free record for each registered sink. The Cloudflare bridge
 * (platform-tracing.ts) mirrors every span as a Workers custom span, and tests
 * add a capture sink. The LogTape sink writes only boundary and failed spans to
 * Workers Logs, plus one summary per request.
 *
 * Tracing is passive: a failing sink or span constructor never fails the
 * traced work, and nothing here performs I/O.
 */

export type SpanKind =
  | "request"
  | "invocation"
  | "phase"
  | "d1"
  | "durable-object"
  | "external"
  | "effect";

export type SpanStatus = "ok" | "error" | "interrupted";

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<
  Record<string, SpanAttributeValue | undefined>
>;

export interface FinishedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  /** Order of this span's start and end among all span events in the isolate. */
  readonly startSequence: number;
  readonly endSequence: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}

export interface SpanSink {
  /** An Effect span started; Promise-code spans are activated instead. */
  readonly start?: (span: DxSpan) => void;
  /** Runs `call` with `span` active on the platform, if the sink can. */
  readonly activate?: <A>(span: DxSpan, call: () => A) => A;
  readonly end: (span: FinishedSpan, live: DxSpan) => void;
}

const MAX_ATTRIBUTES = 24;
const MAX_STRING = 128;
/**
 * Bounds records per trace so a runaway loop cannot flood Workers Logs. The
 * trace root is always delivered, so its request summary survives the cap.
 */
const MAX_SPANS_PER_TRACE = 512;

/**
 * Only these attribute keys leave the process, besides dx's own `dx.*` keys.
 * Effect and `@effect/sql` attach others (notably `db.query.text`), which are
 * dropped.
 */
const allowedAttributes = new Set([
  "db.system.name",
  "db.operation.name",
  "error.type",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "server.address",
]);

const errorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const boundedValue = (value: unknown): SpanAttributeValue | undefined => {
  if (typeof value === "string")
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
};

const sanitizeAttributes = (
  attributes: ReadonlyMap<string, unknown>,
): Record<string, SpanAttributeValue> => {
  const result: Record<string, SpanAttributeValue> = {};
  let count = 0;
  for (const [key, value] of attributes) {
    if (count >= MAX_ATTRIBUTES) break;
    if (key === "dx.kind") continue;
    if (!key.startsWith("dx.") && !allowedAttributes.has(key)) continue;
    const bounded = boundedValue(value);
    if (bounded === undefined) continue;
    result[key] = bounded;
    count += 1;
  }
  return result;
};

const spanKinds: ReadonlySet<string> = new Set<SpanKind>([
  "request",
  "invocation",
  "phase",
  "d1",
  "durable-object",
  "external",
  "effect",
]);

const errorType = (cause: unknown): string => {
  const tag = Predicate.hasProperty(cause, "_tag") ? cause._tag : undefined;
  if (typeof tag === "string" && errorTypePattern.test(tag)) return tag;
  if (cause instanceof Error && errorTypePattern.test(cause.name))
    return cause.name;
  return "unknown";
};

const exitOutcome = (
  exit: Exit.Exit<unknown, unknown>,
): { status: SpanStatus; errorType?: string } => {
  if (Exit.isSuccess(exit)) return { status: "ok" };
  if (Cause.hasInterruptsOnly(exit.cause)) return { status: "interrupted" };
  const failure = Cause.findErrorOption(exit.cause);
  return {
    status: "error",
    errorType: Option.isSome(failure) ? errorType(failure.value) : "defect",
  };
};

interface TraceBudget {
  recorded: number;
  dropped: number;
}

/**
 * Isolate-wide tracing state. `pnpm dev` re-evaluates this module when Vite
 * reloads, in the same isolate, while the D1 and Durable Object binding
 * wrappers keep the copy that patched them; every copy shares one state, so
 * their spans join one trace, tally, and set of sinks.
 */
interface TracingState {
  /** Span starts and ends so far, across copies. */
  sequence: number;
  readonly sinks: Set<SpanSink>;
  readonly activeSpan: AsyncLocalStorage<DxSpan>;
  logRecordsMuted: number;
  logSink: SpanSink | undefined;
}

const stateKey = Symbol.for("dx.tracing.state");
const isolate = globalThis as { [stateKey]?: TracingState };
isolate[stateKey] ??= {
  sequence: 0,
  sinks: new Set(),
  activeSpan: new AsyncLocalStorage(),
  logRecordsMuted: 0,
  logSink: undefined,
};
const state = isolate[stateKey];
const { sinks, activeSpan } = state;

/** Brands a `DxSpan` from any copy of this module. */
const dxSpan = Symbol.for("dx.tracing.span");
const isDxSpan = (span: unknown): span is DxSpan =>
  Predicate.hasProperty(span, dxSpan);

const safely = (operation: () => void) => {
  try {
    operation();
  } catch {
    // Tracing is passive: a sink failure never reaches traced work.
  }
};

/** One dx span; also Effect's `Tracer.Span`, so Effect fibers can parent to it. */
export class DxSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly [dxSpan] = true;
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | undefined;
  readonly startSequence: number;
  readonly links: Array<Tracer.SpanLink>;
  readonly attributes = new Map<string, unknown>();
  readonly budget: TraceBudget;
  status: Tracer.SpanStatus;
  #startedAt: number;
  #ended = false;

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly annotations: Context.Context<never>,
    links: ReadonlyArray<Tracer.SpanLink>,
    startTime: bigint,
    readonly kind: Tracer.SpanKind,
    readonly sampled: boolean,
  ) {
    const parentSpan = Option.getOrUndefined(parent);
    this.traceId = parentSpan?.traceId ?? Hex.random(32);
    this.spanId = Hex.random(16);
    this.parentSpanId = parentSpan?.spanId;
    this.budget = isDxSpan(parentSpan)
      ? parentSpan.budget
      : { recorded: 0, dropped: 0 };
    this.links = [...links];
    this.startSequence = ++state.sequence;
    this.#startedAt = performance.now();
    this.status = { _tag: "Started", startTime };
  }

  attribute(key: string, value: unknown): void {
    if (!this.#ended) this.attributes.set(key, value);
  }

  event(): void {}

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
  }

  /** Effect's end; dx code calls `finish`. */
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.#ended) return;
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    const outcome = exitOutcome(exit);
    if (outcome.errorType !== undefined)
      this.attributes.set("error.type", outcome.errorType);
    this.#finish(outcome.status);
  }

  /** Ends a Promise-code span; idempotent. */
  finish(status: SpanStatus = "ok", cause?: unknown): void {
    if (this.#ended) return;
    if (status === "error" && cause !== undefined)
      this.attributes.set("error.type", errorType(cause));
    this.#finish(status);
  }

  #finish(status: SpanStatus) {
    this.#ended = true;
    const durationMs =
      Math.round((performance.now() - this.#startedAt) * 100) / 100;
    if (
      this.budget.recorded >= MAX_SPANS_PER_TRACE &&
      this.parentSpanId !== undefined
    ) {
      this.budget.dropped += 1;
      if (this.budget.dropped === 1) {
        safely(() =>
          traceLogger.warn("Trace span budget exhausted.", {
            event: "trace_span_budget_exhausted",
            traceId: this.traceId,
            limit: MAX_SPANS_PER_TRACE,
          }),
        );
      }
      return;
    }
    this.budget.recorded += 1;
    const kind = this.attributes.get("dx.kind");
    const finished: FinishedSpan = {
      name: this.name,
      kind:
        typeof kind === "string" && spanKinds.has(kind)
          ? (kind as SpanKind)
          : "effect",
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      startSequence: this.startSequence,
      endSequence: ++state.sequence,
      durationMs,
      status,
      attributes: sanitizeAttributes(this.attributes),
    };
    for (const sink of sinks) safely(() => sink.end(finished, this));
  }
}

/** The span new work should parent to: the running Effect span, then the async context. */
const currentParent = (): Tracer.AnySpan | undefined => {
  const fiberSpan = Fiber.getCurrent()?.cache.span;
  return fiberSpan ?? activeSpan.getStore();
};

const createSpan = (
  options: {
    readonly name: string;
    readonly parent: Option.Option<Tracer.AnySpan>;
    readonly annotations: Context.Context<never>;
    readonly links: ReadonlyArray<Tracer.SpanLink>;
    readonly startTime: bigint;
    readonly kind: Tracer.SpanKind;
    readonly sampled: boolean;
  },
  notifyStart: boolean,
) => {
  const span = new DxSpan(
    options.name,
    options.parent,
    options.annotations,
    options.links,
    options.startTime,
    options.kind,
    options.sampled,
  );
  if (notifyStart) for (const sink of sinks) safely(() => sink.start?.(span));
  return span;
};

/** Set while `installTracing` checks that Effect spans reach dx. */
let probing = false;

const dxTracer = Tracer.make({
  span: (options) =>
    createSpan(
      {
        ...options,
        // An Effect run started inside a traced request joins its trace.
        parent: Option.isSome(options.parent)
          ? options.parent
          : Option.fromNullishOr(activeSpan.getStore()),
      },
      !probing,
    ),
});

const nowNanos = () => BigInt(Date.now()) * 1_000_000n;

/**
 * Opens a Promise-code span parented to the current Effect span or async
 * context. Returns undefined if tracing itself fails. `inactive` spans open
 * on the platform now and are never activated there, for work whose
 * continuation outlives the span (a middleware phase).
 */
export const startSpan = (
  name: string,
  kind: SpanKind,
  attributes: SpanAttributes = {},
  options: { readonly inactive?: boolean } = {},
): DxSpan | undefined => {
  try {
    const span = createSpan(
      {
        name,
        parent: Option.fromNullishOr(currentParent()),
        annotations: Context.empty(),
        links: [],
        startTime: nowNanos(),
        kind:
          kind === "external" || kind === "d1" || kind === "durable-object"
            ? "client"
            : kind === "request" || kind === "invocation"
              ? "server"
              : "internal",
        sampled: true,
      },
      options.inactive === true,
    );
    span.attributes.set("dx.kind", kind);
    for (const [key, value] of Object.entries(attributes))
      if (value !== undefined) span.attributes.set(key, value);
    return span;
  } catch {
    return undefined;
  }
};

/**
 * Runs `call` with `span` as the parent of spans it opens and, unless
 * `platform` is false, as the active platform span.
 */
export const runInSpan = <A>(
  span: DxSpan | undefined,
  call: () => A,
  platform = true,
): A => {
  if (span === undefined) return activeSpan.exit(call);
  let activate: SpanSink["activate"];
  if (platform)
    for (const sink of sinks) if (sink.activate) activate = sink.activate;
  return activeSpan.run(span, () =>
    activate === undefined ? call() : activate(span, call),
  );
};

export const currentSpan = (): DxSpan | undefined => {
  const parent = currentParent();
  return isDxSpan(parent) ? parent : undefined;
};

/**
 * Traces `call` as one span and returns its result unchanged: the same
 * promise object, the same rejection. `describe` may add attributes from the
 * resolved value, such as a status code.
 */
export const observeCall = <A>(
  name: string,
  kind: SpanKind,
  attributes: SpanAttributes,
  call: (span: DxSpan | undefined) => A,
  describe?: (value: Awaited<A>) => SpanAttributes,
): A => {
  const span = startSpan(name, kind, attributes);
  if (span === undefined) return call(undefined);
  let result: A;
  try {
    result = runInSpan(span, () => call(span));
  } catch (cause) {
    span.finish("error", cause);
    throw cause;
  }
  const settle = (value: Awaited<A>) => {
    safely(() => {
      for (const [key, attribute] of Object.entries(describe?.(value) ?? {}))
        if (attribute !== undefined) span.attributes.set(key, attribute);
    });
    span.finish("ok");
  };
  if (Predicate.isPromiseLike(result))
    result.then(
      (value) => settle(value as Awaited<A>),
      (cause: unknown) => span.finish("error", cause),
    );
  else settle(result as Awaited<A>);
  return result;
};

/** Async convenience over `observeCall`. */
export const traceSpan = <A>(
  name: string,
  kind: SpanKind,
  attributes: SpanAttributes,
  call: (span: DxSpan | undefined) => Promise<A>,
): Promise<A> => observeCall(name, kind, attributes, call);

export const addSpanSink = (sink: SpanSink) => {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
};

/** Lets a test harness keep span records out of test output. */
export const muteSpanLogRecords = () => {
  state.logRecordsMuted += 1;
  return () => {
    state.logRecordsMuted = Math.max(0, state.logRecordsMuted - 1);
  };
};

/** Spans that cross a process boundary or mark where request time went. */
const loggedKinds: ReadonlySet<SpanKind> = new Set<SpanKind>([
  "request",
  "phase",
  "d1",
  "durable-object",
  "external",
]);
const roundTripKinds: ReadonlySet<SpanKind> = new Set<SpanKind>([
  "d1",
  "durable-object",
  "external",
]);

interface TraceTally {
  spans: number;
  readonly byKind: Partial<Record<SpanKind, number>>;
  sequentialRoundTrips: number;
  chainEnd: number;
}

/** Per-trace counts for the request summary; collected with the trace. */
const tallies = new WeakMap<TraceBudget, TraceTally>();

const tally = (span: FinishedSpan, budget: TraceBudget): TraceTally => {
  let counts = tallies.get(budget);
  if (counts === undefined) {
    counts = { spans: 0, byKind: {}, sequentialRoundTrips: 0, chainEnd: 0 };
    tallies.set(budget, counts);
  }
  counts.spans += 1;
  counts.byKind[span.kind] = (counts.byKind[span.kind] ?? 0) + 1;
  // Spans arrive in end order, so this is span-capture's interval
  // scheduling: the longest chain of round trips that did not overlap.
  if (roundTripKinds.has(span.kind) && span.startSequence > counts.chainEnd) {
    counts.sequentialRoundTrips += 1;
    counts.chainEnd = span.endSequence;
  }
  return counts;
};

const logSink: SpanSink = {
  end: (span, live) => {
    if (state.logRecordsMuted > 0) return;
    const counts = tally(span, live.budget);
    if (loggedKinds.has(span.kind) || span.status === "error")
      traceLogger.info("Span finished.", {
        event: "span_finished",
        span: span.name,
        kind: span.kind,
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId === undefined
          ? {}
          : { parentSpanId: span.parentSpanId }),
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
      });
    // Boundary spans that end after the root (`waitUntil` work) still log
    // individually; the summary describes the request up to its response.
    if (
      span.parentSpanId === undefined &&
      (span.kind === "request" || span.kind === "invocation")
    )
      traceLogger.info("Request traced.", {
        event: "request_summary",
        span: span.name,
        kind: span.kind,
        traceId: span.traceId,
        spanId: span.spanId,
        durationMs: span.durationMs,
        status: span.status,
        attributes: span.attributes,
        spans: counts.spans,
        byKind: { ...counts.byKind },
        sequentialRoundTrips: counts.sequentialRoundTrips,
        ...(live.budget.dropped === 0
          ? {}
          : { droppedSpans: live.budget.dropped }),
      });
  },
};

/**
 * Effect 4 has no public global tracer setting, and dx runs Effect programs
 * through `Effect.runPromise` at about 200 call sites. A fiber with no
 * explicit tracer creates its spans with `Tracer.nativeTracer`, an exported
 * plain object, so dx points that object's `span` at its own tracer. Effect
 * does not promise the object stays mutable; the probe in `installTracing`
 * opens a span through a fiber and warns when dx did not create it.
 */
const effectSpansReachDx = () => {
  probing = true;
  try {
    // The probe span never ends, so no sink records it.
    return isDxSpan(Effect.runSync(Effect.makeSpan("dx.tracer_install_check")));
  } finally {
    probing = false;
  }
};

let installed = false;

/**
 * Installs the LogTape sink once per isolate and dx's Effect tracer once per
 * copy of this module, since a reload can bring its own Effect.
 */
export const installTracing = () => {
  if (installed) return;
  installed = true;
  state.logSink ??= logSink;
  sinks.add(state.logSink);
  try {
    Object.defineProperty(Tracer.nativeTracer, "span", {
      value: dxTracer.span,
      configurable: true,
      writable: true,
    });
    if (!effectSpansReachDx())
      throw new Error("Effect spans do not reach the dx tracer.");
  } catch {
    traceLogger.warn("Effect tracer installation failed.", {
      event: "effect_tracer_install_failed",
    });
  }
};
