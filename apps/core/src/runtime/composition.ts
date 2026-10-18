import { Effect, Schema } from "effect";
import type { Bindings } from "../http/types.js";

const RuntimeMode = Schema.Literals(["local", "deployed"]);

export type RuntimeConfiguration =
  | {
      readonly mode: "local";
      readonly modelAdapter: "fixture";
    }
  | {
      readonly mode: "deployed";
      readonly modelAdapter: "cloudflare";
    };

export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "RuntimeConfigurationError",
  {},
) {}

export const loadRuntimeConfiguration = Effect.fn("loadRuntimeConfiguration")(
  function* (bindings: Bindings) {
    const mode = yield* Schema.decodeUnknownEffect(RuntimeMode)(
      bindings.DX_RUNTIME_MODE,
    );

    switch (mode) {
      case "local":
        return {
          mode,
          modelAdapter: "fixture",
        } satisfies RuntimeConfiguration;
      case "deployed":
        return {
          mode,
          modelAdapter: "cloudflare",
        } satisfies RuntimeConfiguration;
      default: {
        const exhaustive: never = mode;
        return exhaustive;
      }
    }
  },
  Effect.mapError(() => new RuntimeConfigurationError()),
);

export interface RuntimeAdapters<ExecutionAdapter, ModelAdapter> {
  readonly local: {
    readonly execution: ExecutionAdapter;
    readonly model: ModelAdapter;
  };
  readonly deployed: {
    readonly execution: ExecutionAdapter;
    readonly model: ModelAdapter;
  };
}

export const selectRuntimeAdapters = <ExecutionAdapter, ModelAdapter>(
  runtime: RuntimeConfiguration,
  adapters: RuntimeAdapters<ExecutionAdapter, ModelAdapter>,
) => {
  switch (runtime.mode) {
    case "local":
      return adapters.local;
    case "deployed":
      return adapters.deployed;
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
};
