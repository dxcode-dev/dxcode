import { RotateCw } from "lucide-react";
import { applyAppUpdate, useAppUpdateAvailable } from "./app-update.js";
import "./app-update.css";

/** The sidebar's last row while a newer dx is available; tap to load it. */
export function AppUpdateRow() {
  const available = useAppUpdateAvailable();
  if (!available) return null;
  return (
    <button
      type="button"
      className="app-update-row"
      title="Reload dx to the new version"
      onClick={applyAppUpdate}
    >
      <RotateCw aria-hidden="true" />
      <span>Update available</span>
      <span className="app-update-dot" aria-hidden="true" />
    </button>
  );
}

/** A dot on the control that opens the sidebar, while an update waits. */
export function AppUpdateDot() {
  const available = useAppUpdateAvailable();
  return available ? (
    <span className="app-update-dot" aria-hidden="true" />
  ) : null;
}
