import type { OrbProviderData, OrbProviderKeyData } from "@dx/api";

type Scope = "personal" | "workspace";

const keyState = (key: OrbProviderKeyData, owner: string) =>
  key.template === null
    ? "Ignored locally"
    : key.template.status === "building"
      ? "Building template…"
      : key.template.status === "failed"
        ? "Template failed"
        : key.account === null
          ? owner
          : `${owner} · ${key.account}`;

/**
 * Whose account runs this provider's Orbs for the viewer, in a few words
 * beside its name: the key's owner and E2B team, or its template state.
 */
export const orbProviderSource = (
  provider: OrbProviderData,
  scope: Scope,
): string => {
  if (provider.key !== null)
    return keyState(
      provider.key,
      scope === "personal" ? "Your key" : "Workspace key",
    );
  if (provider.workspaceKey !== null)
    return keyState(provider.workspaceKey, "Workspace key");
  if (provider.deployment) return "Provided by this deployment";
  return "Needs an API key";
};

/** Where the key comes from today, inside the empty key field. */
export const orbKeyPlaceholder = (provider: OrbProviderData) => {
  if (provider.key !== null) return "Key saved. Enter a new key to replace it.";
  if (provider.workspaceKey !== null) return "Using the workspace key";
  if (provider.deployment) return "Using the deployment key";
  return "Paste an API key";
};
