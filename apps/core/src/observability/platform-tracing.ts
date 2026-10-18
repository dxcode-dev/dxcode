import * as workers from "cloudflare:workers";
import { instrumentBindings } from "./boundaries.js";
import {
  addSpanSink,
  type DxSpan,
  installTracing,
  type SpanSink,
} from "./tracing.js";

/**
 * Workers custom spans (`tracing` from `cloudflare:workers`,
 * https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
 * record only when the deployment enables `observability.traces` and the
 * request is head-sampled; otherwise `isTraced` is false and nothing is
 * stored. The platform exposes no trace or span IDs yet and cannot re-enter a
 * span after its callback returns, so:
 *
 * - Promise-code spans (`observeCall`) open with `startActiveSpan`, and
 *   platform sub-spans (fetch, bindings) nest under them.
 * - Effect spans open with `startSpan`: a fiber's work interleaves across
 *   callbacks the platform cannot attribute, so they attach to the enclosing
 *   active span as siblings.
 *
 * Every platform span carries `dx.trace_id`, `dx.span_id`, and
 * `dx.parent_span_id`, the same IDs as the LogTape record, to rebuild the
 * Effect hierarchy and join the two.
 */

const MAX_NAME_BYTES = 64;

const platformTracing = (): Tracing | undefined => {
  try {
    const tracing = (workers as { readonly tracing?: Tracing }).tracing;
    return typeof tracing?.startSpan === "function" &&
      typeof tracing.startActiveSpan === "function"
      ? tracing
      : undefined;
  } catch {
    // Unit tests mock `cloudflare:workers` without `tracing`.
    return undefined;
  }
};

const workerEnv = (): Record<string, unknown> | undefined => {
  try {
    return workers.env as unknown as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
};

const spanName = (name: string) => name.slice(0, MAX_NAME_BYTES);

const cloudflareSpanSink = (tracing: Tracing): SpanSink => {
  const platformSpans = new WeakMap<DxSpan, Span>();
  const opened = new WeakSet<DxSpan>();
  const keep = (span: DxSpan, platform: Span) => {
    opened.add(span);
    if (platform.isTraced) platformSpans.set(span, platform);
    else platform.end();
  };
  return {
    start: (span) => {
      if (!opened.has(span)) keep(span, tracing.startSpan(spanName(span.name)));
    },
    activate: (span, call) => {
      if (opened.has(span)) return call();
      let called = false;
      try {
        return tracing.startActiveSpan(spanName(span.name), (platform) => {
          try {
            keep(span, platform);
          } catch {
            // Passive: run the work untraced.
          }
          called = true;
          return call();
        });
      } catch (cause) {
        // Only the work's own failure propagates; a platform failure runs it untraced.
        if (called) throw cause;
        return call();
      }
    },
    end: (finished, live) => {
      const platform = platformSpans.get(live);
      if (platform === undefined) return;
      platformSpans.delete(live);
      platform.setAttributes({
        ...finished.attributes,
        "dx.kind": finished.kind,
        "dx.trace_id": finished.traceId,
        "dx.span_id": finished.spanId,
        "dx.parent_span_id": finished.parentSpanId,
        "dx.status": finished.status,
        "dx.duration_ms": finished.durationMs,
      });
      platform.end();
    },
  };
};

let installed = false;

/**
 * Installs dx tracing for this isolate: the Effect tracer and LogTape sink,
 * D1 and Durable Object binding spans, and the Workers custom-span bridge
 * outside local mode. The Worker entry and every Durable Object share the
 * isolate, so one call covers them all; repeated calls are no-ops.
 */
export const installRuntimeTracing = () => {
  installTracing();
  if (installed) return;
  installed = true;
  const env = workerEnv();
  instrumentBindings(env);
  // Local development keeps platform tracing off (runtime-architecture.md).
  if (env?.DX_RUNTIME_MODE === "local") return;
  const tracing = platformTracing();
  if (tracing !== undefined) addSpanSink(cloudflareSpanSink(tracing));
};
