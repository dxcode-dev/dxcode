import { Config, ConfigProvider, Effect, type Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "../activity.js";

export const DEFAULT_E2B_TEMPLATE = "base";
export const DEFAULT_E2B_TIMEOUT_MS = 600_000;
export const MIN_E2B_TIMEOUT_MS = 60_000;
export const MAX_E2B_TIMEOUT_MS = 3_600_000;

const EnvironmentName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);

const TemplateName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

const ActiveTimeout = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({
    minimum: MIN_E2B_TIMEOUT_MS,
    maximum: MAX_E2B_TIMEOUT_MS,
  }),
);

export class ExecutionWorkspaceConfigurationError extends Schema.TaggedError<ExecutionWorkspaceConfigurationError>()(
  "ExecutionWorkspaceConfigurationError",
  {},
) {}

export interface E2BRequirements {
  readonly apiKey: Redacted.Redacted<string>;
  readonly dxEnv: string;
  readonly template: string;
  readonly timeoutMs: number;
  readonly inactivityMs: number;
}

const e2bConfiguration = Config.all({
  apiKey: Config.redacted("E2B_API_KEY"),
  dxEnv: Config.string("DX_ENV"),
  template: Config.string("DX_E2B_TEMPLATE").pipe(
    Config.withDefault(DEFAULT_E2B_TEMPLATE),
  ),
  timeoutMs: Config.number("DX_E2B_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_E2B_TIMEOUT_MS),
  ),
  inactivityMs: Config.number("DX_WORKSPACE_INACTIVITY_MS").pipe(
    Config.withDefault(DEFAULT_WORKSPACE_INACTIVITY_MS),
  ),
});

export const loadE2BRequirements = Effect.fn("loadE2BRequirements")(
  function* (bindings: Bindings, templateOverride?: string) {
    const configuration = yield* e2bConfiguration.parse(
      ConfigProvider.fromUnknown(bindings),
    );
    const dxEnv = yield* Schema.decodeEffect(EnvironmentName)(
      configuration.dxEnv,
    );
    const template = yield* Schema.decodeEffect(TemplateName)(
      configuration.template,
    );
    const timeoutMs = yield* Schema.decodeEffect(ActiveTimeout)(
      configuration.timeoutMs,
    );
    const inactivityMs = yield* Schema.decodeEffect(ActiveTimeout)(
      configuration.inactivityMs,
    );

    return {
      apiKey: configuration.apiKey,
      dxEnv,
      template: templateOverride ?? template,
      timeoutMs,
      inactivityMs,
    } satisfies E2BRequirements;
  },
  Effect.mapError(() => new ExecutionWorkspaceConfigurationError()),
);
