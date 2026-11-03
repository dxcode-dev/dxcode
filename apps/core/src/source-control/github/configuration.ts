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
  /**
   * A branch preview's App reaches it through a relay origin; OAuth and
   * setup states then name `host`, this deployment's, for the relay.
   */
  readonly relay?: { readonly origin: string; readonly host: string };
}

const encodedConfiguration = Config.Redacted("DX_INTEGRATION_GITHUB_APP");

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
  const { relayOrigin, ...decoded } =
    yield* decodeGitHubAppDeploymentConfiguration(
      input,
      origin,
      bindings.DX_ENV,
      bindings.DX_DEPLOYMENT_TARGET,
    );
  return {
    ...decoded,
    ...(relayOrigin === undefined
      ? {}
      : { relay: { origin: relayOrigin, host: new URL(origin).host } }),
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
