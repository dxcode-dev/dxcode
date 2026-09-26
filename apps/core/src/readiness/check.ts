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
    };

export async function checkReadiness(
  bindings: Bindings,
): Promise<ReadinessCheck> {
  const exit = await Effect.runPromiseExit(loadReadinessRequirements(bindings));

  if (Exit.isSuccess(exit)) return { ready: true };

  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    return { ready: false, category: error.value.category };
  }

  throw Cause.squash(exit.cause);
}
