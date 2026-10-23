import type { OrbProviderConnectionData, OrbProviderData } from "@dx/api";

type Scope = "personal" | "workspace";

const connectionState = (
  connection: OrbProviderConnectionData,
  owner: string,
) => {
  if (connection.status === null) return "Ignored locally";
  const named =
    connection.account === null ? owner : `${owner} · ${connection.account}`;
  // An update keeps the ready version serving, so the row still names it.
  if (connection.updating)
    return connection.status === "failed"
      ? `${named} · Update failed`
      : `${named} · Updating…`;
  return connection.status === "preparing"
    ? "Preparing…"
    : connection.status === "failed"
      ? "Setup failed"
      : named;
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
    );
  if (provider.workspaceConnection !== null)
    return connectionState(provider.workspaceConnection, "Workspace account");
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
