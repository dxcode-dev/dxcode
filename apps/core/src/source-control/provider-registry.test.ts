import { describe, expect, it } from "vitest";
import {
  createPrivilegedSourceControlProviderRegistry,
  type SourceControlRegistryInvalid,
  sourceControlProviderRegistry,
} from "./provider-registry.js";

const github = {
  contractVersion: 1,
  provider: "github",
  availability: "enabled",
  displayName: "GitHub",
  capabilities: ["repository-discovery"],
};

describe("privileged source-control provider registry", () => {
  it("enables GitHub and Bitbucket Cloud", () => {
    expect(
      sourceControlProviderRegistry.enabledDescriptors.map(
        (descriptor) => descriptor.provider,
      ),
    ).toEqual(["github", "bitbucket"]);
    expect(sourceControlProviderRegistry.isEnabled("gitlab")).toBe(false);
    expect(sourceControlProviderRegistry.isEnabled("forgejo")).toBe(false);
    expect(sourceControlProviderRegistry.descriptorFor("gitlab")).toMatchObject(
      {
        availability: "unavailable",
      },
    );
  });

  it.each([
    ["duplicate-provider", [github, { ...github, displayName: "Duplicate" }]],
    [
      "duplicate-capability",
      [{ ...github, capabilities: ["runtime-read", "runtime-read"] }],
    ],
    [
      "undeclared-capability",
      [{ ...github, capabilities: ["credential-export"] }],
    ],
    ["provider-not-enabled", [{ ...github, provider: "gitlab" }]],
    ["version-mismatch", [{ ...github, contractVersion: 2 }]],
  ] as const)("rejects %s registrations", (reason, descriptors) => {
    expect(() =>
      createPrivilegedSourceControlProviderRegistry(descriptors),
    ).toThrow(
      expect.objectContaining<Partial<SourceControlRegistryInvalid>>({
        reason,
      }),
    );
  });
});
