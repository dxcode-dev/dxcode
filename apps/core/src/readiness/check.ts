import { Cause, Effect, Exit, Option } from "effect";
import type { Bindings } from "../http/types.js";
import {
  loadReadinessRequirements,
  type ReadinessError,
} from "./requirements.js";

export type ReadinessCheck =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly category: ReadinessError["category"];
      readonly check?: string;
    };

/**
 * How long one isolate reuses a readiness result. `/readyz` is public, and a
 * check imports and signs with the workload identity key and reads R2 and D1,
 * so a flood of requests runs it at most once per isolate per window.
 */
export const READINESS_CACHE_MS = 15_000;

let cached:
  | {
      readonly bindings: Bindings;
      readonly expiresAt: number;
      readonly result: Promise<ReadinessCheck>;
    }
  | undefined;

/**
 * Whether two requests see the same Worker bindings. Each request's `env` is
 * a fresh object whose `DB` wraps the same D1 binding in its own session
 * (`d1Session`), so `DB` is left out and every other binding compared.
 */
const sameBindings = (a: Bindings, b: Bindings) => {
  const keys = Object.keys(a).filter((key) => key !== "DB");
  return (
    keys.length === Object.keys(b).filter((key) => key !== "DB").length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        a[key as keyof Bindings] === b[key as keyof Bindings],
    )
  );
};

export function checkReadiness(bindings: Bindings): Promise<ReadinessCheck> {
  const now = Date.now();
  if (
    cached !== undefined &&
    now < cached.expiresAt &&
    sameBindings(cached.bindings, bindings)
  )
    return cached.result;
  const result = runReadinessCheck(bindings);
  const entry = { bindings, expiresAt: now + READINESS_CACHE_MS, result };
  cached = entry;
  // An unexpected failure is not a result: the next request checks again.
  result.catch(() => {
    if (cached === entry) cached = undefined;
  });
  return result;
}

async function runReadinessCheck(bindings: Bindings): Promise<ReadinessCheck> {
  const exit = await Effect.runPromiseExit(loadReadinessRequirements(bindings));

  if (Exit.isSuccess(exit)) return { ready: true };

  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    const { category, check } = error.value;
    return check === undefined
      ? { ready: false, category }
      : { ready: false, category, check };
  }

  throw Cause.squash(exit.cause);
}
