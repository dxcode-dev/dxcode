import type {
  RunnerProfile,
  RunnerProfileCatalog,
  RunnerProfileId,
} from "@dx/domain";

const gigabytes = (megabytes: number) =>
  `${Number.isInteger(megabytes / 1024) ? megabytes / 1024 : (megabytes / 1024).toFixed(1)} GB`;

const sizeLine = (profile: RunnerProfile) =>
  `${profile.id} (${profile.resources.cpuCores} CPU, ${gigabytes(profile.resources.memoryMb)})`;

const available = (catalog: RunnerProfileCatalog) =>
  catalog.profiles.filter(({ availability }) => availability === "available");

/** Each provider the deployment offers, keyed as create_thread names it. */
const providers = (catalog: RunnerProfileCatalog) =>
  (
    catalog.providers ??
    [...new Set(catalog.profiles.map(({ adapter }) => adapter))].map(
      (adapter) => ({ adapter, displayName: adapter, shortName: adapter }),
    )
  ).map((provider) => ({
    id: provider.adapter,
    names: [provider.adapter, provider.displayName, provider.shortName ?? ""]
      .map((name) => name.toLowerCase())
      .filter((name) => name !== ""),
    displayName: provider.displayName,
    sizes: available(catalog).filter(
      ({ adapter }) => adapter === provider.adapter,
    ),
  }));

/**
 * The deployment's Orb providers and sizes, for the create_thread
 * description. A new provider or size in the catalog appears here without
 * a code change.
 */
export const describeOrbCatalog = (catalog: RunnerProfileCatalog) =>
  [
    ...providers(catalog)
      .filter(({ sizes }) => sizes.length > 0)
      .map(
        ({ id, displayName, sizes }) =>
          `- ${id} (${displayName}): ${sizes.map(sizeLine).join(", ")}`,
      ),
    `The deployment default is ${catalog.defaultProfileId}; a project can choose another.`,
  ].join("\n");

/** The listing an unknown or ambiguous Orb choice reports. */
const options = (catalog: RunnerProfileCatalog) =>
  `Available Orbs:\n${describeOrbCatalog(catalog)}`;

/**
 * The runner profile for an Orb a person or agent named, such as provider
 * "e2b" and size "tiny" (a1.tiny), or a full size ID alone. A size matches
 * its ID, its label, or the part of its ID after the last "." or "-"
 * prefix. A provider alone picks its size the deployment defaults to, or
 * its smallest. Undefined when neither is named.
 */
export const resolveOrbChoice = (
  catalog: RunnerProfileCatalog,
  provider: string | undefined,
  size: string | undefined,
): RunnerProfileId | undefined => {
  if (provider === undefined && size === undefined) return undefined;
  const all = providers(catalog);
  const chosenProvider =
    provider === undefined
      ? undefined
      : all.find(({ names }) => names.includes(provider.trim().toLowerCase()));
  if (provider !== undefined && chosenProvider === undefined)
    throw new Error(`Unknown Orb provider "${provider}". ${options(catalog)}`);
  const candidates = chosenProvider?.sizes ?? available(catalog);
  if (size === undefined) {
    const sizes = chosenProvider?.sizes ?? [];
    const chosen =
      sizes.find(({ id }) => id === catalog.defaultProfileId) ??
      sizes.toSorted(
        (left, right) =>
          left.resources.cpuCores - right.resources.cpuCores ||
          left.resources.memoryMb - right.resources.memoryMb,
      )[0];
    if (chosen === undefined)
      throw new Error(
        `${chosenProvider?.displayName ?? provider} has no available Orb sizes. ${options(catalog)}`,
      );
    return chosen.id;
  }
  const wanted = size.trim().toLowerCase();
  const matches = candidates.filter((profile) => {
    const id = profile.id.toLowerCase();
    const suffix = id.slice(id.lastIndexOf(".") + 1);
    return (
      id === wanted ||
      profile.label.toLowerCase() === wanted ||
      suffix === wanted ||
      suffix.endsWith(`-${wanted}`)
    );
  });
  const exact = matches.find(({ id }) => id.toLowerCase() === wanted);
  if (exact !== undefined) return exact.id;
  if (matches.length === 1 && matches[0] !== undefined) return matches[0].id;
  throw new Error(
    `${matches.length === 0 ? "Unknown" : "Ambiguous"} Orb size "${size}"${chosenProvider === undefined ? "" : ` for ${chosenProvider.displayName}`}. ${options(catalog)}`,
  );
};
