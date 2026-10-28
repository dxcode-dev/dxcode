import type { OrbProviderConnectionData, OrbProviderData } from "@dx/api";

type Scope = "personal" | "workspace";

/** What preparation is doing, with how far along it is. */
export const preparationStep = (connection: OrbProviderConnectionData) =>
  connection.progress === null
    ? "Preparing…"
    : `${connection.progress.step} (${connection.progress.done} of ${connection.progress.total})`;

const connectionState = (
  connection: OrbProviderConnectionData,
  owner: string,
  sizes: number,
) => {
  if (connection.status === null) return "Ignored locally";
  const named =
    connection.account === null ? owner : `${owner} · ${connection.account}`;
  // An update keeps the ready version serving, so the row still names it.
  if (connection.updating)
    return connection.status === "failed"
      ? `${named} · Update failed`
      : `${named} · Updating…`;
  if (connection.status === "preparing") return preparationStep(connection);
  if (connection.status === "failed") return "Setup failed";
  const refused = connection.unavailableSizes.length;
  // The account's plan refused some sizes; the dialog says which and why.
  return refused === 0 || sizes === 0
    ? named
    : `${named} · ${sizes - refused} of ${sizes} sizes`;
};

/**
 * Whose account runs this provider's Orbs for the viewer, in a few words
 * beside its name: the connection's owner and account, or its setup state.
 */
export const orbProviderSource = (
  provider: OrbProviderData,
  scope: Scope,
): string => {
  if (provider.connection !== null)
    return connectionState(
      provider.connection,
      scope === "personal" ? "Your account" : "Workspace account",
      provider.sizes.length,
    );
  if (provider.workspaceConnection !== null)
    return connectionState(
      provider.workspaceConnection,
      "Workspace account",
      provider.sizes.length,
    );
  if (provider.deployment) return "Provided by this deployment";
  return "Not connected";
};

/** Where a secret field's value comes from today, inside the empty field. */
export const orbFieldPlaceholder = (
  provider: OrbProviderData,
  field: OrbProviderData["fields"][number],
) => {
  if (provider.connection !== null)
    return field.secret ? "Saved. Enter a new value to replace it." : "";
  if (provider.workspaceConnection !== null)
    return "Using the workspace's account";
  if (provider.deployment) return "Using the deployment's account";
  return field.placeholder ?? "";
};
