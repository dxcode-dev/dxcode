import {
  SOURCE_CONTROL_CONTRACT_VERSION,
  SourceControlAdapterDescriptor,
  type SourceControlAdapterDescriptorType,
  type SourceControlCapability,
  type SourceControlProviderId,
} from "@dx/domain";
import { Schema } from "effect";

export class SourceControlRegistryInvalid extends Schema.TaggedError<SourceControlRegistryInvalid>()(
  "SourceControlRegistryInvalid",
  {
    reason: Schema.Literals([
      "duplicate-provider",
      "duplicate-capability",
      "provider-not-enabled",
      "undeclared-capability",
      "version-mismatch",
    ]),
  },
) {}

export interface PrivilegedSourceControlProviderRegistry {
  readonly descriptors: ReadonlyArray<SourceControlAdapterDescriptorType>;
  readonly enabledDescriptors: ReadonlyArray<SourceControlAdapterDescriptorType>;
  readonly descriptorFor: (
    provider: SourceControlProviderId,
  ) => SourceControlAdapterDescriptorType | undefined;
  readonly isEnabled: (provider: SourceControlProviderId) => boolean;
}

const descriptor = (
  provider: SourceControlProviderId,
  displayName: string,
  capabilities: ReadonlyArray<SourceControlCapability>,
  availability: "enabled" | "unavailable" = "unavailable",
) => ({
  contractVersion: SOURCE_CONTROL_CONTRACT_VERSION,
  provider,
  availability,
  displayName,
  capabilities,
});

const githubDescriptor = descriptor(
  "github",
  "GitHub",
  [
    "personal-grant",
    "workspace-installation",
    "repository-discovery",
    "repository-selection",
    "runtime-read",
    "runtime-write",
    "provider-cli",
    "lifecycle-webhooks",
  ],
  "enabled",
);

const unavailableDescriptors = [
  descriptor("gitlab", "GitLab", []),
  descriptor("forgejo", "Forgejo", []),
];

export const createPrivilegedSourceControlProviderRegistry = (
  inputs: ReadonlyArray<unknown>,
): PrivilegedSourceControlProviderRegistry => {
  const descriptors: Array<SourceControlAdapterDescriptorType> = [];
  const providers = new Set<SourceControlProviderId>();
  for (const input of inputs) {
    if (
      typeof input === "object" &&
      input !== null &&
      "contractVersion" in input &&
      input.contractVersion !== SOURCE_CONTROL_CONTRACT_VERSION
    ) {
      throw new SourceControlRegistryInvalid({ reason: "version-mismatch" });
    }
    let decoded: SourceControlAdapterDescriptorType;
    try {
      decoded = Schema.decodeUnknownSync(SourceControlAdapterDescriptor)(input);
    } catch {
      throw new SourceControlRegistryInvalid({
        reason: "undeclared-capability",
      });
    }
    if (providers.has(decoded.provider)) {
      throw new SourceControlRegistryInvalid({ reason: "duplicate-provider" });
    }
    if (new Set(decoded.capabilities).size !== decoded.capabilities.length) {
      throw new SourceControlRegistryInvalid({
        reason: "duplicate-capability",
      });
    }
    if (
      decoded.availability === "enabled" &&
      decoded.provider !== "github" &&
      decoded.provider !== "bitbucket"
    ) {
      throw new SourceControlRegistryInvalid({
        reason: "provider-not-enabled",
      });
    }
    providers.add(decoded.provider);
    descriptors.push(decoded);
  }

  const enabledDescriptors = descriptors.filter(
    (item) => item.availability === "enabled",
  );
  return {
    descriptors,
    enabledDescriptors,
    descriptorFor: (provider) =>
      descriptors.find((item) => item.provider === provider),
    isEnabled: (provider) =>
      enabledDescriptors.some((item) => item.provider === provider),
  };
};

// Privileged providers are linked here by Core. The normal plugin registry has
// no registration path to this boundary or its future credential-bearing layers.
export const sourceControlProviderRegistry =
  createPrivilegedSourceControlProviderRegistry([
    githubDescriptor,
    descriptor(
      "bitbucket",
      "Bitbucket",
      [
        "personal-grant",
        "repository-discovery",
        "repository-selection",
        "runtime-read",
        "runtime-write",
      ],
      "enabled",
    ),
    ...unavailableDescriptors,
  ]);
