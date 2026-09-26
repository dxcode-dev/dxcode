import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import { PluginTriggersSettings } from "./triggers-settings.js";

const renderSettings = () =>
  renderToStaticMarkup(
    <AuthContext.Provider
      value={{
        identity: {
          id: "usr_test" as never,
          name: "Test User",
          email: "test@example.com",
        },
        logout: () => undefined,
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <PluginTriggersSettings />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );

describe("plugin trigger settings", () => {
  it("registers only the exact personal trigger route", () => {
    expect(
      resolveSettingsSection(settingsManifest, "personal", "triggers"),
    ).toMatchObject({
      found: true,
      registration: { id: "personal-triggers", label: "Triggers" },
    });
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "triggers"),
    ).toMatchObject({ found: false });
    expect(settingsPath({ scope: "personal", section: "triggers" })).toBe(
      "/settings/triggers",
    );
  });

  it("renders the authenticated durable webhook contract without stored secrets", () => {
    const markup = renderSettings();
    expect(markup).toContain("Plugin Triggers");
    expect(markup).toContain("Authenticated personal webhooks");
    expect(markup).toContain("timestamp, event, and idempotency headers");
    expect(markup).toContain("Loading plugin triggers");
    expect(markup).not.toContain("dxt_");
  });
});
