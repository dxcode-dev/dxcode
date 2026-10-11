import type { RunnerProfile, RunnerProfileCatalog } from "@dx/domain";
import { describe, expect, it } from "vitest";
import { describeOrbCatalog, resolveOrbChoice } from "./agent-orbs.js";

// How turning a spoken Orb choice into a runner profile can go wrong:
// - a provider named by its display or short name is not recognized;
// - a short size ("tiny") misses its full ID, or matches another provider's;
// - a size from another provider is accepted for the named one;
// - a size under maintenance is offered or chosen;
// - a provider alone picks a size it does not own;
// - an unknown choice fails without saying what is available;
// - no choice still forces a size instead of the project's Orb.

const profile = (
  id: string,
  adapter: "e2b" | "cloudflare",
  cpuCores: number,
  memoryMb: number,
  availability: RunnerProfile["availability"] = "available",
): RunnerProfile =>
  ({
    id,
    label: id.startsWith("cf.") ? id.slice(3) : id,
    adapter,
    resources: { cpuCores, memoryMb, diskGb: 20 },
    isolation: "microvm",
    availability,
    capabilities: [],
  }) as unknown as RunnerProfile;

const catalog = {
  version: 1,
  defaultProfileId: "a1.medium",
  profiles: [
    profile("a1.tiny", "e2b", 1, 2048),
    profile("a1.small", "e2b", 2, 4096),
    profile("a1.medium", "e2b", 4, 8192),
    profile("cf.standard-1", "cloudflare", 0.5, 4096),
    profile("cf.standard-2", "cloudflare", 1, 6144),
    profile("cf.standard-4", "cloudflare", 4, 12288, "maintenance"),
  ],
  adapterStates: [],
  providers: [
    {
      adapter: "e2b",
      displayName: "E2B",
      shortName: "E2B",
      pauseResume: null,
    },
    {
      adapter: "cloudflare",
      displayName: "Cloudflare Containers",
      shortName: "Cloudflare",
      pauseResume: null,
    },
  ],
} as unknown as RunnerProfileCatalog;

describe("Orb choice for create_thread", () => {
  it("leaves the project's Orb in place when nothing is named", () => {
    expect(resolveOrbChoice(catalog, undefined, undefined)).toBeUndefined();
  });

  it("maps a provider and a short size to the provider's profile", () => {
    expect(resolveOrbChoice(catalog, "e2b", "tiny")).toBe("a1.tiny");
    expect(resolveOrbChoice(catalog, "E2B", "a1.small")).toBe("a1.small");
    expect(resolveOrbChoice(catalog, "Cloudflare", "standard-2")).toBe(
      "cf.standard-2",
    );
    expect(resolveOrbChoice(catalog, "cloudflare containers", "2")).toBe(
      "cf.standard-2",
    );
    expect(resolveOrbChoice(catalog, undefined, "tiny")).toBe("a1.tiny");
  });

  it("gives a provider alone its default size, or its smallest", () => {
    expect(resolveOrbChoice(catalog, "e2b", undefined)).toBe("a1.medium");
    expect(resolveOrbChoice(catalog, "cloudflare", undefined)).toBe(
      "cf.standard-1",
    );
  });

  it("refuses another provider's size and sizes under maintenance, listing what is available", () => {
    expect(() => resolveOrbChoice(catalog, "e2b", "standard-2")).toThrow(
      /Unknown Orb size "standard-2" for E2B\. Available Orbs:\n- e2b \(E2B\): a1\.tiny/,
    );
    expect(() => resolveOrbChoice(catalog, "cloudflare", "standard-4")).toThrow(
      /Unknown Orb size/,
    );
    expect(() => resolveOrbChoice(catalog, "fly", "tiny")).toThrow(
      /Unknown Orb provider "fly"\. Available Orbs:/,
    );
  });

  it("lists every available size per provider with its resources", () => {
    expect(describeOrbCatalog(catalog)).toBe(
      [
        "- e2b (E2B): a1.tiny (1 CPU, 2 GB), a1.small (2 CPU, 4 GB), a1.medium (4 CPU, 8 GB)",
        "- cloudflare (Cloudflare Containers): cf.standard-1 (0.5 CPU, 4 GB), cf.standard-2 (1 CPU, 6 GB)",
        "The deployment default is a1.medium; a project can choose another.",
      ].join("\n"),
    );
  });
});
