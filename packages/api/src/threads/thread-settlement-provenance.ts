import { Option, Schema } from "effect";

const SettlementExecutionFailureEnvelopeSchema = Schema.Struct({
  meta: Schema.Struct({
    dxExecutionFailure: Schema.Unknown,
  }),
});

const ExecutionFailureProvenanceSchema = Schema.Struct({
  version: Schema.Literal(1),
  code: Schema.String,
  abortSource: Schema.NullOr(Schema.String),
});

const NativeUserStopSettlementErrorSchema = Schema.Struct({
  type: Schema.Literal("submission_aborted"),
});

export type ThreadSettlementProvenance = "user-stop" | "non-user";

export const threadSettlementProvenance = (
  error: unknown,
): ThreadSettlementProvenance => {
  const envelope = Option.getOrUndefined(
    Schema.decodeUnknownOption(SettlementExecutionFailureEnvelopeSchema)(error),
  );
  if (envelope !== undefined) {
    const failure = Option.getOrUndefined(
      Schema.decodeUnknownOption(ExecutionFailureProvenanceSchema)(
        envelope.meta.dxExecutionFailure,
      ),
    );
    return failure?.code === "cancelled" && failure.abortSource === "user"
      ? "user-stop"
      : "non-user";
  }
  return Option.isSome(
    Schema.decodeUnknownOption(NativeUserStopSettlementErrorSchema)(error),
  )
    ? "user-stop"
    : "non-user";
};
