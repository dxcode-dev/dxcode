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

export async function checkReadiness(
  bindings: Bindings,
): Promise<ReadinessCheck> {
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
