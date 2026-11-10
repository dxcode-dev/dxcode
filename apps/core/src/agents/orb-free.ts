/**
 * Whether a Thread's agent runs with no Orb. Every Orb decision for the
 * agent reads this one predicate: the early activation in
 * `DxAgent.resolvePromptData`, the sandbox the render mounts, the Orb a new
 * Thread's first message starts, and the Orb release on archive or delete.
 *
 * The answer is the Thread's execution mode (`threads.execution_mode`,
 * wiki/runtime-architecture.md#execution-modes): `executor` runs with no
 * Orb. It is the server's, read from D1, never the creation data a client
 * sends. The kind rides along because the Spaces gate reads it from the same
 * cache; it does not decide the Orb.
 */
export interface OrbThreadState {
  readonly kind: "thread" | "space";
  readonly executionMode: "orb" | "executor";
}

export const runsWithoutOrb = (thread: Pick<OrbThreadState, "executionMode">) =>
  thread.executionMode === "executor";

const states = new Map<string, OrbThreadState>();

const stateOf = (
  kind: string | null | undefined,
  executionMode: string | null | undefined,
): OrbThreadState => ({
  kind: kind === "space" ? "space" : "thread",
  executionMode: executionMode === "executor" ? "executor" : "orb",
});

const remember = (threadId: string, state: OrbThreadState) => {
  if (states.size > 5_000) states.clear();
  states.set(threadId, state);
};

/**
 * Records a Thread's kind and execution mode read elsewhere, such as in a
 * Thread list, so a later `readOrbThreadState` in this isolate (the Spaces
 * gate's, when that Thread opens) needs no read of its own. Neither ever
 * changes for a Thread.
 */
export const rememberThreadKind = (
  threadId: string,
  kind: string | null | undefined,
  executionMode?: string | null,
) => {
  if (kind !== "thread" && kind !== "space") return;
  if (states.has(threadId)) return;
  remember(threadId, stateOf(kind, executionMode));
};

/**
 * The Thread's Orb-relevant state from D1. A Thread's kind and execution
 * mode never change, so each isolate reads them once per Thread.
 */
export const readOrbThreadState = async (
  db: D1Database,
  threadId: string,
): Promise<OrbThreadState> => {
  const cached = states.get(threadId);
  if (cached !== undefined) return cached;
  const row = await db
    .prepare("SELECT kind, execution_mode FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ kind: string; execution_mode: string }>();
  const state = stateOf(row?.kind, row?.execution_mode);
  if (row !== null) remember(threadId, state);
  return state;
};
