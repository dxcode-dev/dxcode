import {
  CLOUDFLARE_ORB_PROFILES,
  E2B_ORB_PROFILES,
  RunnerProfileId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeRunnerProfileCatalog,
  loadRunnerProfileCatalog,
  RunnerProfileConfigurationUnavailable,
  RunnerProfileUnavailable,
  selectRunnerProfile,
} from "./catalog.js";

const profile = {
  id: "e2b-standard",
  label: "Standard workspace",
  adapter: "e2b",
  template: "dx-standard",
  resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
  isolation: "sandbox",
  availability: "available",
  costLabel: "Deployment managed",
  capabilities: [
    "git",
    "environment-variables",
    "internet-access",
    "persistent-workspace",
    "pause-resume",
  ],
} as const;

const catalog = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    defaultProfileId: profile.id,
    profiles: [profile],
    ...overrides,
  });

describe("runner profile catalog", () => {
  it("keeps every offered E2B size mapped to its declared resources", () => {
    expect(E2B_ORB_PROFILES).toEqual([
      {
        id: "a1.tiny",
        label: "a1.tiny",
        templateSuffix: "a1-tiny",
        resources: { cpuCores: 1, memoryMb: 2048, diskGb: 20 },
      },
      {
        id: "a1.small",
        label: "a1.small",
        templateSuffix: "a1-small",
        resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
      },
      {
        id: "a1.medium",
        label: "a1.medium",
        templateSuffix: "a1-medium",
        resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
      },
    ]);
  });

  it("publishes only validated real profiles and typed adapter capability states", async () => {
    const loaded = await Effect.runPromise(
      decodeRunnerProfileCatalog(catalog()),
    );

    expect(loaded.publicCatalog).toEqual({
      version: 1,
      defaultProfileId: "e2b-standard",
      profiles: [
        {
          id: "e2b-standard",
          label: "Standard workspace",
          adapter: "e2b",
          resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
          isolation: "sandbox",
          availability: "available",
          costLabel: "Deployment managed",
          capabilities: profile.capabilities,
        },
      ],
      adapterStates: [
        { kind: "e2b", state: "available" },
        { kind: "cloudflare", state: "unavailable" },
        { kind: "local", state: "unavailable" },
        { kind: "container", state: "unavailable" },
        { kind: "kubernetes", state: "unavailable" },
        { kind: "remote", state: "unavailable" },
      ],
      providers: [
        {
          adapter: "e2b",
          displayName: "E2B",
          shortName: "E2B",
          pauseResume: "processes",
        },
      ],
    });
    expect(JSON.stringify(loaded.publicCatalog)).not.toContain("dx-standard");
  });

  it("publishes Cloudflare Containers sizes as instance types without the instance", async () => {
    const loaded = await Effect.runPromise(
      decodeRunnerProfileCatalog(
        catalog({
          profiles: [
            profile,
            ...CLOUDFLARE_ORB_PROFILES.map((size) => ({
              ...size,
              adapter: "cloudflare",
              isolation: "container",
              availability: "available",
              capabilities: profile.capabilities,
            })),
          ],
        }),
      ),
    );
    expect(
      loaded.publicCatalog.profiles
        .filter(({ adapter }) => adapter === "cloudflare")
        .map(({ id, label, resources }) => ({ id, label, resources })),
    ).toEqual(
      CLOUDFLARE_ORB_PROFILES.map(({ id, label, resources }) => ({
        id,
        label,
        resources,
      })),
    );
    expect(JSON.stringify(loaded.publicCatalog)).not.toContain('"instance"');
    expect(loaded.publicCatalog.adapterStates).toContainEqual({
      kind: "cloudflare",
      state: "available",
    });
    // Containers keeps only the filesystem across a pause.
    // The picker shows the short name; settings pages keep the long one.
    expect(loaded.publicCatalog.providers).toEqual([
      {
        adapter: "e2b",
        displayName: "E2B",
        shortName: "E2B",
        pauseResume: "processes",
      },
      {
        adapter: "cloudflare",
        displayName: "Cloudflare Containers",
        shortName: "Cloudflare",
        pauseResume: "filesystem",
      },
    ]);
    // A Cloudflare size is a container, never a sandbox, and keeps every
    // workspace trait an E2B size has.
    await expect(
      Effect.runPromise(
        decodeRunnerProfileCatalog(
          catalog({
            profiles: [
              profile,
              {
                ...CLOUDFLARE_ORB_PROFILES[0],
                adapter: "cloudflare",
                isolation: "sandbox",
                availability: "available",
                capabilities: profile.capabilities,
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "RunnerProfileConfigurationUnavailable" });
  });

  it.each([
    ["missing binding", undefined],
    ["invalid JSON", "not-json"],
    ["missing default", catalog({ defaultProfileId: "missing" })],
    [
      "unavailable default",
      catalog({ profiles: [{ ...profile, availability: "maintenance" }] }),
    ],
    [
      "duplicate profile IDs",
      catalog({ profiles: [profile, { ...profile, template: "duplicate" }] }),
    ],
    [
      "missing required capability",
      catalog({
        profiles: [
          {
            ...profile,
            capabilities: profile.capabilities.filter(
              (capability) => capability !== "environment-variables",
            ),
          },
        ],
      }),
    ],
    [
      "unsupported signing claim",
      catalog({
        profiles: [
          {
            ...profile,
            capabilities: [...profile.capabilities, "commit-signing"],
          },
        ],
      }),
    ],
    [
      "fake adapter",
      catalog({ profiles: [{ ...profile, adapter: "kubernetes" }] }),
    ],
  ])("fails closed for %s", async (_label, input) => {
    await expect(
      Effect.runPromise(
        loadRunnerProfileCatalog({ DX_RUNNER_PROFILE_CATALOG: input }),
      ),
    ).rejects.toBeInstanceOf(RunnerProfileConfigurationUnavailable);
  });

  it("rejects maintenance, deferred large, and unknown profiles at selection", async () => {
    const maintenance = {
      ...profile,
      id: "e2b-maintenance",
      availability: "maintenance",
    } as const;
    const loaded = await Effect.runPromise(
      decodeRunnerProfileCatalog(catalog({ profiles: [profile, maintenance] })),
    );
    const maintenanceId =
      Schema.decodeUnknownSync(RunnerProfileId)("e2b-maintenance");

    await expect(
      Effect.runPromise(selectRunnerProfile(loaded, maintenanceId)),
    ).rejects.toBeInstanceOf(RunnerProfileUnavailable);
    await expect(
      Effect.runPromise(selectRunnerProfile(loaded, "a1.large" as never)),
    ).rejects.toBeInstanceOf(RunnerProfileUnavailable);
    await expect(
      Effect.runPromise(selectRunnerProfile(loaded, "missing" as never)),
    ).rejects.toBeInstanceOf(RunnerProfileUnavailable);
  });
});
