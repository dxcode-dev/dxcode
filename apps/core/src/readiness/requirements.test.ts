import { readFileSync } from "node:fs";
import { CLOUDFLARE_ORB_PROFILES } from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  createTestBindings,
  TEST_AUTH_SECRET,
  validAgentBinding,
  validAiBinding,
  validD1Binding,
  validR2Binding,
} from "../testing/bindings.js";
import {
  loadReadinessRequirements,
  SOURCE_CONTROL_SCHEMA_VERSION,
  sourceControlSchemaRows,
} from "./requirements.js";

const failure = (bindings: Bindings) =>
  Effect.runPromise(Effect.flip(loadReadinessRequirements(bindings)));

describe("readiness requirements", () => {
  const localBindings = () =>
    createTestBindings({
      DX_ENV: "local",
      DX_RUNTIME_MODE: "local",
      DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
        version: 1,
        defaultProfileId: "local-default",
        profiles: [
          {
            id: "local-default",
            label: "Local workspace",
            adapter: "local",
            resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
            isolation: "process",
            availability: "available",
            capabilities: [
              "git",
              "environment-variables",
              "persistent-workspace",
            ],
          },
        ],
      }),
      DX_LOCAL_RUNTIME_URL: "http://127.0.0.1:5175/",
      DX_LOCAL_RUNTIME_TOKEN: "local-runtime-test-token-000000000000",
      DX_DXD_PUBLIC_URL: "http://127.0.0.1:5173/",
      DX_DXD_RELEASE_URL: undefined,
      DX_DXD_RELEASE_SHA256: undefined,
      DX_DEPLOYMENT_REVISION: undefined,
      DX_E2B_TEMPLATE_BUILD_ID: undefined,
      DX_AUTH_EMAIL_FROM: undefined,
      EMAIL: undefined,
      DX_MIGRATION_MANIFEST_VERSION: undefined,
      E2B_API_KEY: undefined,
      DX_E2B_TEMPLATE: undefined,
      DX_INTEGRATION_BITBUCKET_OAUTH: undefined,
      PLUGIN_TRIGGER_DELIVERY: undefined,
      SUBSCRIPTION_CREDENTIAL_COORDINATOR: undefined,
      AI: undefined,
      DX_STORAGE: { get() {}, put() {} } as unknown as R2Bucket,
      THREAD_EXECUTION: validAgentBinding,
    });

  it("reports local capability readiness without E2B or AI bindings", async () => {
    await expect(
      Effect.runPromise(loadReadinessRequirements(localBindings())),
    ).resolves.toEqual({ dxEnv: "local" });
  });

  it("accepts synchronized local GitHub URLs on a linked-worktree port", async () => {
    const bindings = localBindings();
    const origin = "http://127.0.0.1:8123";
    const github = JSON.parse(bindings.DX_INTEGRATION_GITHUB_APP ?? "{}");

    await expect(
      Effect.runPromise(
        loadReadinessRequirements({
          ...bindings,
          DX_AUTH_URL: origin,
          DX_AUTH_TRUSTED_ORIGINS: origin,
          DX_INTEGRATION_GITHUB_APP: JSON.stringify({
            ...github,
            callbackUrl: `${origin}/v1/integrations/github/oauth/callback`,
            setupUrl: `${origin}/v1/integrations/github/setup`,
            webhookUrl: `${origin}/v1/integrations/github/webhooks`,
          }),
        }),
      ),
    ).resolves.toEqual({ dxEnv: "local" });
  });

  it("fails local readiness when its loopback workspace authority is absent", async () => {
    await expect(
      failure({ ...localBindings(), DX_LOCAL_RUNTIME_URL: undefined }),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "local_workspace_configuration",
    });
  });

  it.each([
    undefined,
    "https://127.0.0.1:5173/",
    "http://provider.example.test/",
    "http://127.0.0.1:5173/path",
    "http://127.0.0.1:5173/?provider=1",
  ])(
    "fails local readiness for dxd callback root %s",
    async (DX_DXD_PUBLIC_URL) => {
      await expect(
        failure({ ...localBindings(), DX_DXD_PUBLIC_URL }),
      ).resolves.toMatchObject({
        _tag: "ReadinessError",
        category: "local_workspace_configuration",
      });
    },
  );

  it("decodes required configuration and validates the generated binding", async () => {
    await expect(
      Effect.runPromise(loadReadinessRequirements(createTestBindings())),
    ).resolves.toMatchObject({ dxEnv: "test", runtimeMode: "deployed" });
  });

  it("allows self-host password authentication without hosted email bindings", async () => {
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({
            DX_ENV: "selfhost",
            DX_AUTH_EMAIL_FROM: undefined,
            EMAIL: undefined,
          }),
        ),
      ),
    ).resolves.toMatchObject({ dxEnv: "selfhost", runtimeMode: "deployed" });
  });

  it("requires the email binding when self-host selects hosted authentication", async () => {
    await expect(
      failure(
        createTestBindings({
          DX_ENV: "selfhost",
          DX_AUTH_EMAIL_FROM: "sign-in@example.com",
          EMAIL: undefined,
        }),
      ),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "authentication_configuration",
    });
  });

  it.each([
    ["missing sender", { DX_AUTH_EMAIL_FROM: undefined }],
    ["blank sender", { DX_AUTH_EMAIL_FROM: " " }],
    ["missing email binding", { EMAIL: undefined }],
    ["malformed email binding", { EMAIL: {} as SendEmail }],
  ])("rejects deployed %s", async (_label, overrides) => {
    await expect(failure(createTestBindings(overrides))).resolves.toMatchObject(
      {
        _tag: "ReadinessError",
        category: "authentication_configuration",
      },
    );
  });

  it("uses the default E2B template when the binding is omitted", async () => {
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({ DX_E2B_TEMPLATE: undefined }),
        ),
      ),
    ).resolves.toMatchObject({ dxEnv: "test" });
  });

  it.each([undefined, ""])("rejects DX_ENV value %s", async (DX_ENV) => {
    await expect(
      failure(createTestBindings({ DX_ENV })),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "configuration",
    });
  });

  it("identifies a missing auth secret as authentication configuration", async () => {
    const bindings = createTestBindings();
    Reflect.deleteProperty(bindings, "BETTER_AUTH_SECRET");

    await expect(failure(bindings)).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "authentication_configuration",
    });
  });

  it.each([
    ["short auth secret", { BETTER_AUTH_SECRET: "short" }],
    ["insecure deployed auth URL", { DX_AUTH_URL: "http://dx.test" }],
  ])(
    "identifies %s as authentication configuration",
    async (_label, overrides) => {
      await expect(
        failure(createTestBindings(overrides)),
      ).resolves.toMatchObject({
        _tag: "ReadinessError",
        category: "authentication_configuration",
      });
    },
  );

  it.each([undefined, "", "not-json"])(
    "fails closed for encryption keyring value %s",
    async (DX_CONFIG_ENCRYPTION_KEYS) => {
      await expect(
        failure(createTestBindings({ DX_CONFIG_ENCRYPTION_KEYS })),
      ).resolves.toMatchObject({
        _tag: "ReadinessError",
        category: "config_encryption_configuration",
      });
    },
  );

  it.each([
    ["missing issuer", { DX_WORKLOAD_IDENTITY_ISSUER: undefined }],
    [
      "insecure deployed issuer",
      {
        DX_WORKLOAD_IDENTITY_ISSUER:
          "http://identity.test/api/workload-identity",
      },
    ],
    [
      "malformed audience policy",
      { DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: "not-json" },
    ],
    [
      "malformed signing keyring",
      { DX_WORKLOAD_IDENTITY_SIGNING_KEYS: "not-json" },
    ],
  ])("fails closed for %s", async (_label, overrides) => {
    await expect(failure(createTestBindings(overrides))).resolves.toMatchObject(
      {
        _tag: "ReadinessError",
        category: "workload_identity_configuration",
      },
    );
  });

  it("allows preview readiness without a branch-specific GitHub App", async () => {
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({
            DX_ENV: "preview",
            DX_INTEGRATION_GITHUB_APP: "{}",
          }),
        ),
      ),
    ).resolves.toMatchObject({ dxEnv: "preview" });
  });

  it("allows deployed readiness while GitHub integration is disabled", async () => {
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({
            DX_ENV: "staging",
            DX_INTEGRATION_GITHUB_APP: undefined,
          }),
        ),
      ),
    ).resolves.toMatchObject({ dxEnv: "staging" });
  });

  it.each([undefined, "", "{}"])(
    "allows deployed readiness while Bitbucket integration is disabled with %s",
    async (DX_INTEGRATION_BITBUCKET_OAUTH) => {
      await expect(
        Effect.runPromise(
          loadReadinessRequirements(
            createTestBindings({ DX_INTEGRATION_BITBUCKET_OAUTH }),
          ),
        ),
      ).resolves.toMatchObject({ dxEnv: "test" });
    },
  );

  it.each(["not-json", "{ }", JSON.stringify({ version: 1 })])(
    "reports malformed present Bitbucket OAuth configuration %s",
    async (DX_INTEGRATION_BITBUCKET_OAUTH) => {
      await expect(
        failure(createTestBindings({ DX_INTEGRATION_BITBUCKET_OAUTH })),
      ).resolves.toMatchObject({
        category: "bitbucket_oauth_configuration_malformed",
      });
    },
  );

  it.each([
    ["", "github_app_binding_missing"],
    ["not-json", "github_app_configuration_malformed"],
    ["{ }", "github_app_configuration_malformed"],
  ])(
    "fails closed for GitHub App configuration value %s",
    async (DX_INTEGRATION_GITHUB_APP, category) => {
      await expect(
        failure(createTestBindings({ DX_INTEGRATION_GITHUB_APP })),
      ).resolves.toMatchObject({
        _tag: "ReadinessError",
        category,
      });
    },
  );

  it.each([
    ["callbackUrl", "https://other.test/callback", "github_app_origin_drift"],
    ["expiringUserTokens", false, "github_app_expiring_token_drift"],
    ["events", ["push"], "github_app_event_drift"],
    ["permissionManifestVersion", 2, "github_app_permission_drift"],
  ])("classifies GitHub App %s drift", async (field, value, category) => {
    const input = JSON.parse(
      createTestBindings().DX_INTEGRATION_GITHUB_APP ?? "{}",
    );
    input[field] = value;
    await expect(
      failure(
        createTestBindings({
          DX_INTEGRATION_GITHUB_APP: JSON.stringify(input),
        }),
      ),
    ).resolves.toMatchObject({ _tag: "ReadinessError", category });
  });

  it("fails closed when no Execution provider resolves", async () => {
    await expect(
      failure(createTestBindings({ E2B_API_KEY: undefined })),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "execution_provider_unavailable",
    });
    await expect(
      failure(createTestBindings({ E2B_API_KEY: "  " })),
    ).resolves.toMatchObject({ category: "execution_provider_unavailable" });
  });

  it("is ready with Cloudflare Containers as the only Orb provider", async () => {
    const containers = (overrides: Partial<Bindings> = {}) =>
      createTestBindings({
        E2B_API_KEY: undefined,
        DX_E2B_TEMPLATE: undefined,
        DX_E2B_TEMPLATE_BUILD_ID: undefined,
        DX_E2B_TIMEOUT_MS: undefined,
        ORB_CONTAINER: validAgentBinding as never,
        DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
          version: 1,
          defaultProfileId: CLOUDFLARE_ORB_PROFILES[1].id,
          profiles: CLOUDFLARE_ORB_PROFILES.map((size) => ({
            ...size,
            adapter: "cloudflare",
            isolation: "container",
            availability: "available",
            capabilities: [
              "git",
              "environment-variables",
              "internet-access",
              "persistent-workspace",
              "pause-resume",
            ],
          })),
        }),
        ...overrides,
      });
    await expect(
      Effect.runPromise(loadReadinessRequirements(containers())),
    ).resolves.toMatchObject({ e2bTemplateBuildId: "" });
    // Neither provider configured: not ready.
    await expect(
      failure(containers({ ORB_CONTAINER: undefined })),
    ).resolves.toMatchObject({ category: "execution_provider_unavailable" });
    // An E2B size in the catalog without E2B installed is a broken catalog.
    const e2bCatalog = JSON.parse(
      createTestBindings().DX_RUNNER_PROFILE_CATALOG ?? "{}",
    );
    const cloudflareCatalog = JSON.parse(
      containers().DX_RUNNER_PROFILE_CATALOG ?? "{}",
    );
    await expect(
      failure(
        containers({
          DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
            ...cloudflareCatalog,
            profiles: [...cloudflareCatalog.profiles, ...e2bCatalog.profiles],
          }),
        }),
      ),
    ).resolves.toMatchObject({ category: "runner_profile_configuration" });
    // Both installed: the catalog may offer both, and either may be default.
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({
            ORB_CONTAINER: validAgentBinding as never,
            DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
              ...e2bCatalog,
              profiles: [...e2bCatalog.profiles, ...cloudflareCatalog.profiles],
            }),
          }),
        ),
      ),
    ).resolves.toBeDefined();
    // E2B installed still needs its template build identity.
    await expect(
      failure(createTestBindings({ DX_E2B_TEMPLATE_BUILD_ID: undefined })),
    ).resolves.toMatchObject({ category: "deployment_identity_configuration" });
  });

  it("requires the default runner profile to use the Execution provider", async () => {
    const catalog = JSON.parse(
      createTestBindings().DX_RUNNER_PROFILE_CATALOG ?? "{}",
    );
    await expect(
      failure(
        createTestBindings({
          DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
            ...catalog,
            defaultProfileId: "local-default",
            profiles: [
              ...catalog.profiles,
              {
                id: "local-default",
                label: "Local workspace",
                adapter: "local",
                resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
                isolation: "process",
                availability: "available",
                capabilities: [
                  "git",
                  "environment-variables",
                  "persistent-workspace",
                ],
              },
            ],
          }),
        }),
      ),
    ).resolves.toMatchObject({ category: "runner_profile_configuration" });
  });

  it("distinguishes runner template and source schema drift", async () => {
    await expect(
      failure(createTestBindings({ DX_E2B_TEMPLATE: "other" })),
    ).resolves.toMatchObject({ category: "runner_template_configuration" });
    await expect(
      failure(createTestBindings({ DX_SOURCE_CONTROL_SCHEMA_VERSION: "0047" })),
    ).resolves.toMatchObject({
      category: "source_control_schema_configuration",
    });
    await expect(
      failure(
        createTestBindings({
          DB: {
            prepare: () => ({
              all: async () => ({ results: [], success: true }),
            }),
          } as unknown as D1Database,
        }),
      ),
    ).resolves.toMatchObject({
      category: "source_control_schema_configuration",
    });
  });

  it("derives the source-control binding version from the manifest tail", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../migration-manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { d1: Array<{ filename: string }> };
    const expected = /^(\d{4})_/.exec(manifest.d1.at(-1)?.filename ?? "")?.[1];
    expect(expected).toBeDefined();
    expect(SOURCE_CONTROL_SCHEMA_VERSION).toBe(expected);
  });

  it.each([
    ["public URL", { DX_DXD_PUBLIC_URL: "https://other.test/" }],
    [
      "workers.dev public URL path",
      { DX_DXD_PUBLIC_URL: "https://dx-app-dxd.example.workers.dev/v1/" },
    ],
    [
      "public URL credentials",
      { DX_DXD_PUBLIC_URL: "https://user:pass@dx.test/" },
    ],
    ["public URL query", { DX_DXD_PUBLIC_URL: "https://dx.test/?debug=1" }],
    ["public URL fragment", { DX_DXD_PUBLIC_URL: "https://dx.test/#debug" }],
    ["release URL", { DX_DXD_RELEASE_URL: "http://releases.test/dxd" }],
    ["release checksum", { DX_DXD_RELEASE_SHA256: "not-a-checksum" }],
  ])("rejects dxd %s drift", async (_label, overrides) => {
    await expect(failure(createTestBindings(overrides))).resolves.toMatchObject(
      {
        category: "dxd_release_configuration",
      },
    );
  });

  it("rejects deployment revision and migration manifest drift", async () => {
    await expect(
      failure(createTestBindings({ DX_DEPLOYMENT_REVISION: "short" })),
    ).resolves.toMatchObject({ category: "deployment_identity_configuration" });
    await expect(
      failure(createTestBindings({ DX_MIGRATION_MANIFEST_VERSION: "0" })),
    ).resolves.toMatchObject({ category: "migration_configuration" });
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
    ["missing get", { idFromName() {} }],
  ])("rejects a %s generated binding", async (_label, binding) => {
    await expect(
      failure({
        ...createTestBindings(),
        FLUE_DX_AGENT_AGENT: binding as DurableObjectNamespace | undefined,
      }),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "agent_binding",
    });
  });

  it.each([
    "PLUGIN_TRIGGER_DELIVERY",
    "THREAD_EXECUTION",
    "SUBSCRIPTION_CREDENTIAL_COORDINATOR",
  ] as const)("rejects a missing %s Durable Object binding", async (name) => {
    await expect(
      failure(createTestBindings({ [name]: undefined })),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "durable_object_binding",
    });
  });

  it("rejects an unavailable R2 binding", async () => {
    await expect(
      failure(
        createTestBindings({
          DX_STORAGE: {
            head: async () => {
              throw new Error("unavailable");
            },
          } as unknown as R2Bucket,
        }),
      ),
    ).resolves.toMatchObject({ category: "r2_binding" });
  });

  it("rejects migration history that differs from the canonical manifest", async () => {
    await expect(
      failure(
        createTestBindings({
          DB: {
            prepare: (sql: string) => ({
              all: async () => ({
                results: sql.includes("__alchemy_migrations")
                  ? []
                  : sourceControlSchemaRows,
              }),
            }),
          } as unknown as D1Database,
        }),
      ),
    ).resolves.toMatchObject({ category: "migration_configuration" });
  });

  it("rejects a missing workload identity audit schema object", async () => {
    await expect(
      failure(
        createTestBindings({
          DB: {
            prepare: (sql: string) => ({
              all: async () => ({
                results: sql.includes("sqlite_master")
                  ? sourceControlSchemaRows.filter(
                      ({ name }) => name !== "workload_identity_issuance_audit",
                    )
                  : [],
              }),
            }),
          } as unknown as D1Database,
        }),
      ),
    ).resolves.toMatchObject({
      category: "workload_identity_schema_configuration",
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])("rejects a %s Workers AI binding", async (_label, binding) => {
    await expect(
      failure(createTestBindings({ AI: binding as Ai | undefined })),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "ai_binding",
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])("rejects a %s D1 binding", async (_label, binding) => {
    await expect(
      failure(createTestBindings({ DB: binding as D1Database | undefined })),
    ).resolves.toMatchObject({
      _tag: "ReadinessError",
      category: "d1_binding",
    });
  });

  it("classifies bound D1 schema query failure as a D1 binding failure", async () => {
    await expect(
      failure(
        createTestBindings({
          DB: {
            prepare: () => ({
              all: async () => {
                throw new Error("unavailable");
              },
            }),
          } as unknown as D1Database,
        }),
      ),
    ).resolves.toMatchObject({ category: "d1_binding" });
  });

  it("uses only cheap binding checks without E2B connect or AI inference", async () => {
    const agentGet = vi.fn();
    const agentIdFromName = vi.fn();
    const aiRun = vi.fn();
    const d1Prepare = vi.fn(validD1Binding.prepare.bind(validD1Binding));
    const r2Head = vi.fn(validR2Binding.head.bind(validR2Binding));

    await Effect.runPromise(
      loadReadinessRequirements(
        createTestBindings({
          FLUE_DX_AGENT_AGENT: {
            ...validAgentBinding,
            get: agentGet,
            idFromName: agentIdFromName,
          } as unknown as DurableObjectNamespace,
          AI: { ...validAiBinding, run: aiRun } as unknown as Ai,
          DB: {
            ...validD1Binding,
            prepare: d1Prepare,
          } as unknown as D1Database,
          DX_STORAGE: { head: r2Head } as unknown as R2Bucket,
        }),
      ),
    );

    expect(agentGet).toHaveBeenCalledOnce();
    expect(agentIdFromName).toHaveBeenCalledExactlyOnceWith("dx-readiness");
    expect(aiRun).not.toHaveBeenCalled();
    expect(r2Head).toHaveBeenCalledExactlyOnceWith("__dx_readiness__");
    expect(d1Prepare).toHaveBeenCalledTimes(2);
    expect(d1Prepare).toHaveBeenCalledWith(
      expect.stringContaining("sqlite_master"),
    );
    expect(d1Prepare).toHaveBeenCalledWith(expect.stringContaining("'view'"));
    expect(d1Prepare).toHaveBeenCalledWith(
      expect.stringContaining("__alchemy_migrations"),
    );
    expect(TEST_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("has no E2B client or sandbox operation in the readiness implementation", () => {
    const source = readFileSync(
      new URL("./requirements.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      'from "e2b"',
      "ApiClient",
      "Sandbox.create",
      "Sandbox.connect",
      ".run(",
    ])
      expect(source).not.toContain(forbidden);
  });
});
