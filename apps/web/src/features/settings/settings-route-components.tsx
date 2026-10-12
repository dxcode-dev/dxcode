import { useLoaderData } from "@tanstack/react-router";
import { SettingsPage } from "./settings-page.js";

// A loader resolves no registration only when a deploy removed the settings
// chunk, and then this module cannot load either; see router.tsx.

export function PersonalSettingsRoot() {
  const registration = useLoaderData({ from: "/settings" });
  if (registration === undefined) return null;
  return <SettingsPage scope="personal" registration={registration} />;
}

export function PersonalSettingsSection() {
  const registration = useLoaderData({ from: "/settings/$section" });
  if (registration === undefined) return null;
  return <SettingsPage scope="personal" registration={registration} />;
}

export function WorkspaceSettingsRoot() {
  const loaded = useLoaderData({ from: "/workspaces/$workspaceSlug" });
  if (loaded.registration === undefined) return null;
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
  if (registration === undefined) return null;
  return <SettingsPage scope="workspace" registration={registration} />;
}

export function WorkspaceSettingsSection() {
  const loaded = useLoaderData({
    from: "/workspaces/$workspaceSlug/$section",
  });
  if (loaded.registration === undefined) return null;
  return (
    <SettingsPage
      scope="workspace"
      workspaceSlug={loaded.workspaceSlug}
      registration={loaded.registration}
    />
  );
}
