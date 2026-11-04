import type { OrbResolvedProvider } from "@dx/api";
import type {
  RunnerProfile,
  RunnerProfileCatalog,
  RunnerProfileId,
} from "@dx/domain";

/**
 * Who bills an Orb on the account it starts on: the provider, for a person's
 * or workspace's own connection. The deployment's account has no note; its
 * sizes show the deployment's own cost label.
 */
const orbBillingNote = (
  scope: OrbResolvedProvider["scope"],
  providerName: string,
) =>
  scope === "deployment"
    ? undefined
    : `Billed by ${providerName} to ${
        scope === "workspace" ? "the workspace's" : "your"
      } account, paused when inactive`;

export type SetUpOrbSizeGroup = {
  readonly key: RunnerProfile["adapter"];
  /** The provider heading; absent when one set-up provider needs none. */
  readonly name?: string;
  readonly hint?: string;
  readonly billing?: string;
  readonly label: string;
  /** False for a saved size whose provider is no longer set up. */
  readonly available: boolean;
  readonly profiles: ReadonlyArray<RunnerProfile>;
};

/**
 * The Orb sizes a person can choose, grouped by provider in catalog order:
 * only providers in the resolved set (the providers set up for them, which
 * the new-Thread Orb picker offers too). A saved size on any other provider
 * keeps a group holding just that size, marked "Not available", so it is not
 * silently lost. One available provider needs no heading.
 */
export const setUpOrbSizeGroups = (
  catalog: RunnerProfileCatalog,
  resolved: ReadonlyArray<OrbResolvedProvider>,
  savedProfileId: RunnerProfileId,
  label: (providerName: string | undefined) => string,
): ReadonlyArray<SetUpOrbSizeGroup> => {
  const groups = [
    ...new Set(catalog.profiles.map(({ adapter }) => adapter)),
  ].flatMap((adapter) => {
    const provider = catalog.providers?.find(
      (provider) => provider.adapter === adapter,
    );
    const name = provider?.displayName ?? adapter;
    const profiles = catalog.profiles.filter(
      (profile) => profile.adapter === adapter,
    );
    const account = resolved.find(({ providerId }) => providerId === adapter);
    if (account !== undefined) {
      const billing = orbBillingNote(
        account.scope,
        provider?.shortName ?? name,
      );
      return [
        {
          key: adapter,
          name,
          ...(billing === undefined ? {} : { billing }),
          available: true,
          profiles,
        },
      ];
    }
    const saved = profiles.filter(({ id }) => id === savedProfileId);
    return saved.length === 0
      ? []
      : [
          {
            key: adapter,
            name,
            hint: "Not available",
            available: false,
            profiles: saved,
          },
        ];
  });
  const labelled =
    groups.length > 1 || groups.some((group) => !group.available);
  return groups.map(({ name, ...group }) => ({
    ...group,
    ...(labelled ? { name } : {}),
    label: label(labelled ? name : undefined),
  }));
};
