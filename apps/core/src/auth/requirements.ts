import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../http/types.js";

export class AuthenticationConfigurationError extends Schema.TaggedError<AuthenticationConfigurationError>()(
  "AuthenticationConfigurationError",
  {
    reason: Schema.Literals([
      "missing_configuration",
      "invalid_auth_url",
      "invalid_trusted_origin",
      "secret_too_short",
      "local_requires_localhost",
      "deployed_requires_https",
    ]),
  },
) {}

type AuthenticationConfigurationReason =
  AuthenticationConfigurationError["reason"];

const fail = (reason: AuthenticationConfigurationReason) =>
  new AuthenticationConfigurationError({ reason });

const parseUrl = (value: string, reason: AuthenticationConfigurationReason) =>
  Effect.try({ try: () => new URL(value), catch: () => fail(reason) });

const configuration = Config.all({
  environment: Config.nonEmptyString("DX_ENV"),
  authUrl: Config.nonEmptyString("DX_AUTH_URL"),
  trustedOrigins: Config.nonEmptyString("DX_AUTH_TRUSTED_ORIGINS"),
  secret: Config.redacted("BETTER_AUTH_SECRET"),
});

export interface AuthenticationRequirements {
  readonly environment: string;
  readonly authUrl: string;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly secret: string;
}

const isLocalHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname.endsWith(".test");

export const loadAuthenticationRequirements = Effect.fn(
  "loadAuthenticationRequirements",
)(function* (bindings: Bindings) {
  const value = yield* configuration
    .parse(ConfigProvider.fromUnknown(bindings))
    .pipe(Effect.mapError(() => fail("missing_configuration")));
  const authUrl = yield* parseUrl(value.authUrl, "invalid_auth_url");
  const trustedOrigins: Array<string> = [];
  for (const origin of value.trustedOrigins.split(",")) {
    const url = yield* parseUrl(origin.trim(), "invalid_trusted_origin");
    trustedOrigins.push(url.origin);
  }
  const secret = Redacted.value(value.secret);
  if (secret.length < 32) return yield* fail("secret_too_short");
  if (value.environment === "local" && !isLocalHostname(authUrl.hostname)) {
    return yield* fail("local_requires_localhost");
  }
  if (value.environment !== "local" && authUrl.protocol !== "https:") {
    return yield* fail("deployed_requires_https");
  }
  return {
    environment: value.environment,
    authUrl: authUrl.origin,
    trustedOrigins,
    secret,
  } satisfies AuthenticationRequirements;
});
