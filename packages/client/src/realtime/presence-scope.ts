import type { ThreadId } from "@dx/domain";

/**
 * What someone has open, for presence and live drawing: a Thread, or a
 * standalone artifact (`artifact:<id>`), which has no Thread.
 */
export type PresenceScope = ThreadId | `artifact:${string}`;

/** The realtime hub's topic for a scope. */
export type PresenceTopic = `thread:${ThreadId}` | `artifact:${string}`;

export const presenceTopic = (scope: PresenceScope): PresenceTopic =>
  scope.startsWith("artifact:")
    ? (scope as `artifact:${string}`)
    : `thread:${scope as ThreadId}`;

/** A topic's scope; a topic decoded from the hub has an unbranded id. */
export const presenceScope = (
  topic: `thread:${string}` | `artifact:${string}`,
): PresenceScope =>
  topic.startsWith("thread:")
    ? (topic.slice("thread:".length) as ThreadId)
    : (topic as `artifact:${string}`);

/** The Thread a scope is, or undefined for a standalone artifact. */
export const scopeThread = (scope: PresenceScope): ThreadId | undefined =>
  scope.startsWith("artifact:") ? undefined : (scope as ThreadId);
