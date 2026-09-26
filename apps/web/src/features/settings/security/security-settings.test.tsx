// @vitest-environment happy-dom

import { UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import { PersonalSecuritySettings } from "./security-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const renderSettings = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider
        value={{
          identity: {
            id: userId,
            name: "Test User",
            email: "test@example.com",
          },
          logout: () => undefined,
        }}
      >
        <PersonalSecuritySettings />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe("personal security settings", () => {
  it("registers the exact personal security route", () => {
    expect(settingsPath({ scope: "personal", section: "security" })).toBe(
      "/settings/security",
    );
    expect(
      resolveSettingsSection(settingsManifest, "personal", "security"),
    ).toMatchObject({
      found: true,
      registration: { id: "personal-security", label: "Security" },
    });
  });

  it("renders an accessible typed loading state without demo branding", () => {
    const markup = renderSettings();
    expect(markup).toContain("Control personal API access");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading…");
    expect(markup).not.toMatch(/\bAmp\b|device count|demo session/i);
  });
});
