import type { Bindings } from "../http/types.js";

/**
 * Cloudflare's Clef on Workers AI: a decision model that answers typed
 * questions (a score on dx's rubric, or one of dx's choices) about a state.
 * It writes no text, so whatever a feature shows from its answer is dx's.
 * Its answer is untrusted: callers keep only in-range answers to the
 * questions they asked.
 */

export type ClefCall =
  | { readonly ok: true; readonly answers: Record<string, unknown> }
  | { readonly ok: false };

const CALL_TIMEOUT_MS = 60_000;

/** Whether the deployment can call Clef: its Workers AI binding, not turned off. */
export const clefAvailable = (bindings: Bindings) =>
  bindings.AI !== undefined && bindings.DX_MODEL_WORKERS_AI_ENABLED !== "false";

/**
 * One Clef call. Rejects when Workers AI fails or does not answer within a
 * minute, so each caller logs it as its own event.
 */
export const runClef = async (input: {
  readonly bindings: Bindings;
  /** The Workers AI model, such as `@cf/cloudflare/clef-flash`. */
  readonly model: string;
  /** Clef's own name for it, such as `clef-flash`. */
  readonly selector: string;
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
}): Promise<ClefCall> => {
  const { bindings, model, selector, state, questions } = input;
  if (bindings.AI === undefined) return { ok: false };
  const run = bindings.AI.run as (
    model: string,
    input: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    run.call(bindings.AI, model, { model: selector, state, questions }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Clef did not answer in time.")),
        CALL_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const answers =
    typeof response === "object" && response !== null
      ? (response as { answers?: unknown }).answers
      : undefined;
  return typeof answers === "object" && answers !== null
    ? { ok: true, answers: answers as Record<string, unknown> }
    : { ok: false };
};
