import {
  decodeGitHubAppDeploymentConfiguration,
  GitHubAppConfigurationInvalid,
  type GitHubAppDeploymentConfiguration,
} from "@dx/domain";
import { Config, ConfigProvider, Effect, Option, Redacted } from "effect";
import type { Bindings } from "../../http/types.js";

export interface GitHubAppConfiguration
  extends Omit<
    GitHubAppDeploymentConfiguration,
    "clientSecret" | "privateKeyPem" | "webhookSecret"
  > {
  readonly clientSecret: Redacted.Redacted<string>;
  readonly privateKeyPem: Redacted.Redacted<string>;
  readonly webhookSecret: Redacted.Redacted<string>;
}

const encodedConfiguration = Config.redacted("DX_INTEGRATION_GITHUB_APP");

export const loadGitHubAppConfiguration = Effect.fn(
  "loadGitHubAppConfiguration",
)(function* (bindings: Bindings) {
  const encoded = yield* encodedConfiguration
    .parse(ConfigProvider.fromUnknown(bindings))
    .pipe(Effect.mapError(() => new GitHubAppConfigurationInvalid()));
  const input = yield* Effect.try({
    try: () => JSON.parse(Redacted.value(encoded)) as unknown,
    catch: () => new GitHubAppConfigurationInvalid(),
  });
  const origin = bindings.DX_AUTH_URL;
  if (origin === undefined) return yield* new GitHubAppConfigurationInvalid();
  const decoded = yield* decodeGitHubAppDeploymentConfiguration(
    input,
    origin,
    bindings.DX_ENV,
  );
  return {
    ...decoded,
    clientSecret: Redacted.make(decoded.clientSecret),
    privateKeyPem: Redacted.make(decoded.privateKeyPem),
    webhookSecret: Redacted.make(decoded.webhookSecret),
  } satisfies GitHubAppConfiguration;
});

export const loadGitHubAppConfigurationSync = (
  bindings: Bindings,
): GitHubAppConfiguration | undefined =>
  Option.getOrUndefined(
    Effect.runSync(Effect.option(loadGitHubAppConfiguration(bindings))),
  );
