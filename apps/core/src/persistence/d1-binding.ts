import { Effect, Predicate, Schema } from "effect";

export class D1BindingUnavailable extends Schema.TaggedError<D1BindingUnavailable>()(
  "D1BindingUnavailable",
  {},
) {}

const isD1Database = (binding: unknown): binding is D1Database =>
  Predicate.isObject(binding) && Predicate.isFunction(binding.prepare);

export const decodeD1Binding = Effect.fn("decodeD1Binding")(function* (
  binding: unknown,
) {
  if (!isD1Database(binding)) {
    return yield* new D1BindingUnavailable();
  }
  return binding;
});
