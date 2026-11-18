import type { OrbResolvedProvider } from "@dx/api";
import {
  orbAccountForProfile,
  orbProviderBetaFeature,
  orbSizeGroupKey,
  type RunnerProfile,
  type RunnerProfileCatalog,
  type RunnerProfileId,
} from "@dx/domain";

/**
 * Who bills an Orb on the account it starts on: the provider, for a person's
 * or workspace's own connection. Deployment-owned sizes use their own cost
 * label, or a provision note when the deployment supplies no price.
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
  /** The provider, or `<provider>:named` for a deployment's named sizes. */
  readonly key: string;
  /** The provider heading; absent when one set-up provider needs none. */
  readonly name?: string;
  readonly hint?: string;
  /** A beta provider on a person's or workspace's own account, or a deployment account not presented as the deployment's own Orb. */
  readonly beta?: boolean;
  readonly billing?: string;
  readonly deploymentProvided?: boolean;
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
  const groups = [...new Set(catalog.profiles.map(orbSizeGroupKey))].flatMap(
    (key) => {
      // A deployment's named sizes (a hosted offer's) are a group of their
      // own, on the deployment's account, apart from any key for the provider.
      const profiles = catalog.profiles.filter(
        (profile) => orbSizeGroupKey(profile) === key,
      );
      const first = profiles[0];
      if (first === undefined) return [];
      const adapter = first.adapter;
      const provider = catalog.providers?.find(
        (provider) => provider.adapter === adapter,
      );
      const account = orbAccountForProfile(first, resolved);
      // The deployment's own name for its account (a hosted offer), else the
      // provider's.
      const name = account?.displayName ?? provider?.displayName ?? adapter;
      if (account !== undefined) {
        const billing = orbBillingNote(
          account.scope,
          provider?.shortName ?? name,
        );
        return [
          {
            key,
            name,
            beta:
              orbProviderBetaFeature(adapter) !== undefined &&
              account.displayName === undefined,
            ...(billing === undefined ? {} : { billing }),
            deploymentProvided: account.scope === "deployment",
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
              key,
              name,
              hint: "Not available",
              beta: false,
              deploymentProvided: false,
              available: false,
              profiles: saved,
            },
          ];
    },
  );
  const labelled =
    groups.length > 1 || groups.some((group) => !group.available);
  return groups.map(({ name, ...group }) => ({
    ...group,
    ...(labelled ? { name } : {}),
    label: label(labelled ? name : undefined),
  }));
};
