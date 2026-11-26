import type { PluginCodeEvent, PluginHostKind } from "@dx/domain";
import { Data, type Effect } from "effect";

/**
 * The shared interface every plugin host implements (Worker, Orb). A host only runs code: each call still receives
 * the same `PluginHost` capability object from `worker-host/host.ts`, with
 * the same permission checks, audit rows, and secret masking, so no host
 * reaches more than the Worker host would.
 */

export type { PluginHostKind };

/** One call into a plugin's code, whichever host runs it. */
export type PluginInvocation =
  | {
      readonly kind: "event";
      readonly event: PluginCodeEvent;
      readonly payload: unknown;
    }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }
  | { readonly kind: "command"; readonly id: string }
  | {
      readonly kind: "host-call";
      readonly fn: string;
      readonly args: unknown;
      readonly from: PluginHostKind;
    }
  | {
      readonly kind: "export";
      readonly fn: string;
      readonly args: unknown;
      readonly callerPlugin: string;
    };

/** Which instance of a host a call reaches. */
export interface PluginHostTarget {
  readonly installId: string;
  readonly integrity: string;
  /** The Thread the call is for; absent for install-wide and webhook work. */
  readonly threadId?: string;
  readonly workspaceId: string;
}

export type PluginHostState = "cold" | "starting" | "running" | "stopped";

export type PluginHostStopReason =
  | "archived"
  | "uninstalled"
  | "idle"
  | "limit";

export class PluginHostError extends Data.TaggedError("PluginHostError")<{
  readonly host: PluginHostKind;
  /**
   * `not-declared`: the manifest names no entry for it;
   * `unavailable`: the deployment lacks the host; `failed`: the code threw
   * or timed out; `quota`: a storage or rate limit refused it.
   */
  readonly reason: "not-declared" | "unavailable" | "failed" | "quota";
  readonly message: string;
}> {}

export interface PluginHostRuntime {
  readonly kind: PluginHostKind;
  invoke(
    target: PluginHostTarget,
    call: PluginInvocation,
  ): Effect.Effect<unknown, PluginHostError>;
  status(
    target: PluginHostTarget,
  ): Effect.Effect<{ readonly state: PluginHostState; readonly since: number }>;
  stop(
    target: PluginHostTarget,
    reason: PluginHostStopReason,
  ): Effect.Effect<void>;
}
