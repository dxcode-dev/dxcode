import { Link, type NotFoundRouteProps } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { AppFrame } from "../../shared/layout/app-frame.js";

const notFoundCode = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "code" in data &&
  (data.code === "INVALID_SETTINGS_SCOPE" ||
    data.code === "WORKSPACE_NOT_FOUND")
    ? data.code
    : "SETTINGS_SECTION_NOT_FOUND";

const copy = {
  INVALID_SETTINGS_SCOPE: {
    title: "Invalid workspace settings URL",
    detail:
      "The workspace slug in this URL is malformed. No workspace data was requested.",
  },
  WORKSPACE_NOT_FOUND: {
    title: "Workspace not found",
    detail:
      "No workspace you belong to has this short name. It may have been renamed or deleted, or you may not be a member.",
  },
  SETTINGS_SECTION_NOT_FOUND: {
    title: "Settings section not found",
    detail:
      "The URL does not match a registered settings section. No fallback section was opened.",
  },
} as const;

const focusHeading = (node: HTMLHeadingElement | null) => {
  node?.focus();
};

export function SettingsRouteNotFound({ data }: NotFoundRouteProps) {
  const code = notFoundCode(data);
  return (
    <AppFrame className="settings-stage">
      <main className="settings-shell settings-failure-shell">
        <div className="settings-route-state">
          <AlertTriangle />
          <h1 ref={focusHeading} tabIndex={-1}>
            {copy[code].title}
          </h1>
          <span>{copy[code].detail}</span>
          <code>{code}</code>
          {code === "WORKSPACE_NOT_FOUND" ? (
            // `/workspaces` opens the user's own workspace, or the create card.
            <Link
              to="/workspaces"
              state={true}
              className="settings-return-link"
            >
              <Check /> Open your workspace
            </Link>
          ) : (
            <Link to="/settings" state={true} className="settings-return-link">
              <Check /> Return to Personal settings
            </Link>
          )}
        </div>
      </main>
    </AppFrame>
  );
}
