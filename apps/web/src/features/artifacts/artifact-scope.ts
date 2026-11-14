import type { ThreadId } from "@dx/domain";
import type { PresenceScope } from "../../shared/realtime/presence-scope.js";

export { scopeThread } from "../../shared/realtime/presence-scope.js";

/**
 * Where an artifact's routes, caches, and presence are: the Thread it
 * belongs to, or, for a standalone artifact (no Thread, no Project),
 * `artifact:<id>`. Props named `threadId` in this feature hold one; only a
 * Thread's scope has an agent, members, and messages.
 */
export type ArtifactScope = PresenceScope;

export const standaloneScope = (artifactId: string): ArtifactScope =>
  `artifact:${artifactId}`;

/** The scope of an artifact the API returned. */
export const scopeOf = (artifact: {
  readonly id: string;
  readonly threadId: ThreadId | null;
}): ArtifactScope => artifact.threadId ?? standaloneScope(artifact.id);
