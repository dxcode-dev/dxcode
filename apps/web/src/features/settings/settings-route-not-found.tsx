import { Link, type NotFoundRouteProps } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { AppFrame } from "../../shared/layout/app-frame.js";

const isInvalidSettingsScope = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "code" in data &&
  data.code === "INVALID_SETTINGS_SCOPE";

const focusHeading = (node: HTMLHeadingElement | null) => {
  node?.focus();
};

export function SettingsRouteNotFound({ data }: NotFoundRouteProps) {
  const invalidScope = isInvalidSettingsScope(data);
  return (
    <AppFrame className="settings-stage">
      <main className="settings-shell settings-failure-shell">
        <div className="settings-route-state">
          <AlertTriangle />
          <h1 ref={focusHeading} tabIndex={-1}>
            {invalidScope
              ? "Invalid workspace settings URL"
              : "Settings section not found"}
          </h1>
          <span>
            {invalidScope
              ? "The workspace slug in this URL is malformed. No workspace data was requested."
              : "The URL does not match a registered settings section. No fallback section was opened."}
          </span>
          <code>
            {invalidScope
              ? "INVALID_SETTINGS_SCOPE"
              : "SETTINGS_SECTION_NOT_FOUND"}
          </code>
          <Link to="/settings" state={true} className="settings-return-link">
            <Check /> Return to Personal settings
          </Link>
        </div>
      </main>
    </AppFrame>
  );
}
