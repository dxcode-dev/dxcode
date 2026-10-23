import { Config, ConfigProvider, Effect, type Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "../activity.js";

export const DEFAULT_E2B_TEMPLATE = "base";
// E2B pauses a sandbox this long after create or connect unless Core renews
// it. It matches the default inactivity deadline, so a workspace that nothing
// renews pauses five minutes after its last activity.
export const DEFAULT_E2B_TIMEOUT_MS = 300_000;
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

const e2bWorkspaceConfiguration = Config.all({
  dxEnv: Config.String("DX_ENV"),
  template: Config.String("DX_E2B_TEMPLATE").pipe(
    Config.withDefault(DEFAULT_E2B_TEMPLATE),
  ),
  timeoutMs: Config.Number("DX_E2B_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_E2B_TIMEOUT_MS),
  ),
  inactivityMs: Config.Number("DX_WORKSPACE_INACTIVITY_MS").pipe(
    Config.withDefault(DEFAULT_WORKSPACE_INACTIVITY_MS),
  ),
});

/**
 * Everything an E2B workspace needs except the key, which comes from the
 * Thread's account: the deployment's `E2B_API_KEY`, or a person's or
 * workspace's connection on a deployment that installed no E2B.
 */
export const loadE2BWorkspaceSettings = Effect.fn("loadE2BWorkspaceSettings")(
  function* (bindings: Bindings, templateOverride?: string) {
    const configuration = yield* e2bWorkspaceConfiguration.parse(
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
      dxEnv,
      template: templateOverride ?? template,
      timeoutMs,
      inactivityMs,
    } satisfies Omit<E2BRequirements, "apiKey">;
  },
  Effect.mapError(() => new ExecutionWorkspaceConfigurationError()),
);

/** The deployment's own E2B: its settings and `E2B_API_KEY`. */
export const loadE2BRequirements = Effect.fn("loadE2BRequirements")(
  function* (bindings: Bindings, templateOverride?: string) {
    const apiKey = yield* Config.Redacted("E2B_API_KEY").parse(
      ConfigProvider.fromUnknown(bindings),
    );
    const settings = yield* loadE2BWorkspaceSettings(
      bindings,
      templateOverride,
    );
    return { apiKey, ...settings } satisfies E2BRequirements;
  },
  Effect.mapError(() => new ExecutionWorkspaceConfigurationError()),
);
