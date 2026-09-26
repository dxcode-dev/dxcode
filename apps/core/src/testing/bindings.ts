import { generateKeyPairSync } from "node:crypto";
import { E2B_ORB_PROFILES } from "@dx/domain";
import migrationManifest from "../../migration-manifest.json" with {
  type: "json",
};
import type { Bindings } from "../http/types.js";
import {
  SOURCE_CONTROL_SCHEMA_VERSION,
  sourceControlSchemaRows,
} from "../readiness/requirements.js";

export const TEST_API_TOKEN = "dxu_test-token-0000000000000000000";
export const TEST_E2B_API_KEY = "test-e2b-key-not-a-provider-credential";
export const TEST_USER_ID = "test-user";
export const TEST_AUTH_SECRET = "test-auth-secret-000000000000000000";
export const TEST_CONFIG_ENCRYPTION_KEYS = JSON.stringify({
  activeVersion: 1,
  keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
});
const testWorkloadIdentityKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const testWorkloadIdentityKid = "test-key-0001";
const testWorkloadIdentityPublicJwk =
  testWorkloadIdentityKeyPair.publicKey.export({
    format: "jwk",
  });
export const TEST_WORKLOAD_IDENTITY_SIGNING_KEYS = JSON.stringify({
  version: 1,
  activeKid: testWorkloadIdentityKid,
  keys: [
    {
      kid: testWorkloadIdentityKid,
      privateKeyPkcs8: testWorkloadIdentityKeyPair.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      publicJwk: {
        ...testWorkloadIdentityPublicJwk,
        use: "sig",
        alg: "RS256",
        kid: testWorkloadIdentityKid,
      },
    },
  ],
});
export const TEST_GITHUB_APP_CONFIGURATION = JSON.stringify({
  version: 1,
  appId: "12345",
  appSlug: "dx-test",
  clientId: "Iv1.test-client",
  clientSecret: "test-client-secret",
  privateKeyPem: [
    "-----BEGIN PRIVATE KEY-----",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n"),
  webhookSecret: "test-webhook-secret",
  callbackUrl: "https://dx.test/v1/integrations/github/oauth/callback",
  setupUrl: "https://dx.test/v1/integrations/github/setup",
  webhookUrl: "https://dx.test/v1/integrations/github/webhooks",
  expiringUserTokens: true,
  permissionManifestVersion: 1,
  repositoryPermissions: {
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
    workflows: "write",
  },
  organizationPermissions: { projects: "write" },
  events: ["repository"],
});
export const TEST_BITBUCKET_OAUTH_CONFIGURATION = JSON.stringify({
  version: 1,
  clientId: "test-bitbucket-client",
  clientSecret: "test-bitbucket-client-secret",
  callbackUrl: "https://dx.test/v1/integrations/bitbucket/oauth/callback",
});
export const TEST_RUNNER_PROFILE_CATALOG = JSON.stringify({
  version: 1,
  defaultProfileId: "a1.medium",
  profiles: E2B_ORB_PROFILES.map((profile) => ({
    ...profile,
    adapter: "e2b",
    template: profile.id === "a1.medium" ? "base" : `test-${profile.id}`,
    isolation: "sandbox",
    availability: "available",
    capabilities: [
      "git",
      "environment-variables",
      "internet-access",
      "persistent-workspace",
      "pause-resume",
    ],
  })),
});

export const validAgentBinding = {
  get: () => ({}),
  idFromName: () => ({}),
} as unknown as DurableObjectNamespace;

export const validAiBinding = {
  run() {
    throw new Error("Readiness must not invoke the Workers AI binding.");
  },
} as unknown as Ai;

export const validD1Binding = {
  prepare(sql: string) {
    return {
      all: async () => ({
        results: sql.includes("__alchemy_migrations")
          ? migrationManifest.d1.map(({ filename: name, sha256: hash }) => ({
              name,
              hash,
            }))
          : sourceControlSchemaRows,
        success: true,
      }),
    };
  },
} as unknown as D1Database;

export const validR2Binding = {
  head: async () => null,
} as unknown as R2Bucket;

const validEmailBinding = {
  send: async () => undefined,
} as unknown as SendEmail;

export const createTestBindings = (
  overrides: Partial<Bindings> = {},
): Bindings => ({
  DX_ENV: "test",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: "https://dx.test",
  DX_AUTH_TRUSTED_ORIGINS: "https://dx.test",
  DX_AUTH_EMAIL_FROM: "sign-in@dx.test",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INTEGRATION_GITHUB_APP: TEST_GITHUB_APP_CONFIGURATION,
  DX_INTEGRATION_BITBUCKET_OAUTH: TEST_BITBUCKET_OAUTH_CONFIGURATION,
  DX_MANAGED_SSH_SIGNING_ENABLED: "true",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_SOURCE_CONTROL_SCHEMA_VERSION: SOURCE_CONTROL_SCHEMA_VERSION,
  DX_WORKLOAD_IDENTITY_ISSUER: "https://dx.test/api/workload-identity",
  DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: JSON.stringify({
    version: 1,
    policies: [],
  }),
  DX_WORKLOAD_IDENTITY_SIGNING_KEYS: TEST_WORKLOAD_IDENTITY_SIGNING_KEYS,
  BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
  DX_E2B_TEMPLATE: "base",
  DX_E2B_TEMPLATE_BUILD_ID: "test-template-build",
  DX_E2B_TIMEOUT_MS: "600000",
  DX_DEPLOYMENT_REVISION: "a".repeat(40),
  DX_DXD_PUBLIC_URL: "https://dx.test/",
  DX_DXD_RELEASE_URL: "https://releases.test/dxd",
  DX_DXD_RELEASE_SHA256: "a".repeat(64),
  DX_MIGRATION_MANIFEST_VERSION: "1",
  E2B_API_KEY: TEST_E2B_API_KEY,
  FLUE_DX_AGENT_AGENT: validAgentBinding,
  PLUGIN_TRIGGER_DELIVERY: validAgentBinding,
  THREAD_EXECUTION: validAgentBinding,
  SUBSCRIPTION_CREDENTIAL_COORDINATOR: validAgentBinding,
  REALTIME_HUB: validAgentBinding,
  AI: validAiBinding,
  DB: validD1Binding,
  EMAIL: validEmailBinding,
  DX_STORAGE: validR2Binding,
  ...overrides,
});
