import { useLoaderData } from "@tanstack/react-router";
import { SettingsPage } from "./settings-page.js";

export function PersonalSettingsRoot() {
  const registration = useLoaderData({ from: "/settings" });
  return <SettingsPage scope="personal" registration={registration} />;
}

export function PersonalSettingsSection() {
  const registration = useLoaderData({ from: "/settings/$section" });
  return <SettingsPage scope="personal" registration={registration} />;
}

export function WorkspaceSettingsRoot() {
  const loaded = useLoaderData({ from: "/workspaces/$workspaceSlug" });
  return (
    <SettingsPage
      scope="workspace"
      workspaceSlug={loaded.workspaceSlug}
      registration={loaded.registration}
    />
  );
}

export function WorkspaceSettingsEmptyRoot() {
  const registration = useLoaderData({ from: "/workspaces" });
  return <SettingsPage scope="workspace" registration={registration} />;
}

export function WorkspaceSettingsSection() {
  const loaded = useLoaderData({
    from: "/workspaces/$workspaceSlug/$section",
  });
  return (
    <SettingsPage
      scope="workspace"
      workspaceSlug={loaded.workspaceSlug}
      registration={loaded.registration}
    />
  );
}
