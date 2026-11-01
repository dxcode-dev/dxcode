import { DxLoading } from "../../shared/brand/dx-loading.js";
import { AppFrame } from "../../shared/layout/app-frame.js";

/** Shown while a workspace settings URL loads its workspace. */
export function SettingsRoutePending() {
  return (
    <AppFrame className="settings-stage">
      <main className="settings-shell settings-failure-shell">
        <DxLoading label="Loading settings…" />
      </main>
    </AppFrame>
  );
}
