import { Effect, Schema } from "effect";

export const GITHUB_APP_REPOSITORY_PERMISSIONS = {
  actions: "write",
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "read",
  workflows: "write",
} as const;

export const GITHUB_APP_ORGANIZATION_PERMISSIONS = {
  // GitHub names the Projects v2 organization permission `projects`.
  projects: "write",
} as const;

export const GITHUB_APP_EVENTS = ["repository"] as const;

const NonEmpty = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
);
const Secret = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(65_536),
);
const DeploymentConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  appId: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)),
  appSlug: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
  clientId: NonEmpty,
  clientSecret: Secret,
  privateKeyPem: Secret,
  webhookSecret: Secret,
  callbackUrl: NonEmpty,
  setupUrl: NonEmpty,
  webhookUrl: NonEmpty,
  expiringUserTokens: Schema.Literal(true),
  permissionManifestVersion: Schema.Literal(1),
  repositoryPermissions: Schema.Struct({
    actions: Schema.Literal("write"),
    checks: Schema.Literal("read"),
    contents: Schema.Literal("write"),
    issues: Schema.Literal("write"),
    metadata: Schema.Literal("read"),
    pull_requests: Schema.Literal("write"),
    statuses: Schema.Literal("read"),
    workflows: Schema.Literal("write"),
  }),
  organizationPermissions: Schema.Struct({
    projects: Schema.Literal("write"),
  }),
  events: Schema.Tuple([Schema.Literal("repository")]),
});

export type GitHubAppDeploymentConfiguration =
  typeof DeploymentConfiguration.Type;

export class GitHubAppConfigurationInvalid extends Schema.TaggedError<GitHubAppConfigurationInvalid>()(
  "GitHubAppConfigurationInvalid",
  {},
) {}

const normalizedPem = (value: string) => {
  const normalized = value.replaceAll("\r\n", "\n").trim();
  const lines = normalized.split("\n");
  const header = lines[0];
  const footer = lines.at(-1);
  const matchingBoundaries =
    (header === "-----BEGIN PRIVATE KEY-----" &&
      footer === "-----END PRIVATE KEY-----") ||
    (header === "-----BEGIN RSA PRIVATE KEY-----" &&
      footer === "-----END RSA PRIVATE KEY-----");
  const base64 = lines.slice(1, -1).join("");
  if (
    !matchingBoundaries ||
    lines.length < 3 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new GitHubAppConfigurationInvalid();
  }
  return `${normalized}\n`;
};

const exactUrl = (
  value: string,
  origin: string,
  path: string,
  environment: string | undefined,
) => {
  const url = new URL(value);
  const expected = new URL(path, origin);
  const local =
    environment === "local" ||
    environment === "development" ||
    environment === "test";
  const allowedProtocol =
    url.protocol === "https:" ||
    (local &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  if (
    !allowedProtocol ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== expected.toString()
  ) {
    throw new GitHubAppConfigurationInvalid();
  }
  return url.toString();
};

export const decodeGitHubAppDeploymentConfiguration = Effect.fn(
  "decodeGitHubAppDeploymentConfiguration",
)(function* (input: unknown, expectedOrigin: string, environment?: string) {
  const decoded = yield* Schema.decodeUnknownEffect(DeploymentConfiguration, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new GitHubAppConfigurationInvalid()));
  return yield* Effect.try({
    try: () => ({
      ...decoded,
      privateKeyPem: normalizedPem(decoded.privateKeyPem),
      callbackUrl: exactUrl(
        decoded.callbackUrl,
        expectedOrigin,
        "/v1/integrations/github/oauth/callback",
        environment,
      ),
      setupUrl: exactUrl(
        decoded.setupUrl,
        expectedOrigin,
        "/v1/integrations/github/setup",
        environment,
      ),
      webhookUrl: exactUrl(
        decoded.webhookUrl,
        expectedOrigin,
        "/v1/integrations/github/webhooks",
        environment,
      ),
    }),
    catch: () => new GitHubAppConfigurationInvalid(),
  });
});
