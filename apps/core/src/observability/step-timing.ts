import type { Logger } from "@logtape/logtape";
import { Effect } from "effect";

/**
 * Wall-clock milliseconds of the named steps of one operation, logged once
 * as one event. Steps that run beside each other keep their own durations;
 * a step that runs twice adds up. Workers Logs joins the event to its
 * Thread by the fields the caller gives.
 */
export interface StepTiming {
  readonly step: <Value>(
    name: string,
    operation: () => PromiseLike<Value>,
  ) => Promise<Value>;
  readonly stepEffect: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly set: (name: string, value: string | number | boolean) => void;
  readonly log: (outcome: string) => void;
}

export const stepTiming = (
  logger: Logger,
  event: string,
  fields: Readonly<Record<string, unknown>>,
): StepTiming => {
  const startedAt = Date.now();
  const recorded: Record<string, string | number | boolean> = {};
  const add = (name: string, from: number) => {
    const key = `${name}Ms`;
    const previous = recorded[key];
    recorded[key] =
      (typeof previous === "number" ? previous : 0) + Date.now() - from;
  };
  let logged = false;
  return {
    step: async (name, operation) => {
      const from = Date.now();
      try {
        return await operation();
      } finally {
        add(name, from);
      }
    },
    stepEffect: (name, effect) =>
      Effect.suspend(() => {
        const from = Date.now();
        return effect.pipe(Effect.ensuring(Effect.sync(() => add(name, from))));
      }),
    set: (name, value) => {
      recorded[name] = value;
    },
    log: (outcome) => {
      if (logged) return;
      logged = true;
      try {
        logger.info("Step timing.", {
          event,
          ...fields,
          outcome,
          totalMs: Date.now() - startedAt,
          ...recorded,
        });
      } catch {
        // Timing never fails the operation it measures.
      }
    },
  };
};
