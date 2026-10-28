import type { OrbProviderData } from "@dx/api";
import { describe, expect, it } from "vitest";
import { orbProviderSource } from "./orb-providers-status.js";

const e2b: OrbProviderData = {
  id: "e2b",
  displayName: "E2B",
  description: "Runs Orbs in your E2B team.",
  fields: [{ id: "apiKey", label: "E2B API key", secret: true }],
  sizes: [],
  pauseResume: "processes",
  deployment: true,
  connection: null,
  workspaceConnection: null,
};
const connection = (
  status: "preparing" | "ready" | "failed" | null,
): OrbProviderData["connection"] => ({
  configuredAt: "2026-10-04T00:00:00.000Z",
  account: "team-a",
  status,
  progress: null,
  error: null,
  updating: false,
  unavailableSizes: [],
});

describe("Orb provider rows", () => {
  it("say whose account runs the provider", () => {
    expect(orbProviderSource(e2b, "personal")).toBe(
      "Provided by this deployment",
    );
    expect(
      orbProviderSource(
        { ...e2b, connection: connection("ready") },
        "personal",
      ),
    ).toBe("Your account · team-a");
    expect(
      orbProviderSource(
        { ...e2b, connection: connection("ready") },
        "workspace",
      ),
    ).toBe("Workspace account · team-a");
    expect(
      orbProviderSource(
        { ...e2b, workspaceConnection: connection("ready") },
        "personal",
      ),
    ).toBe("Workspace account · team-a");
    expect(
      orbProviderSource(
        { ...e2b, connection: connection("preparing") },
        "personal",
      ),
    ).toBe("Preparing…");
    expect(
      orbProviderSource(
        { ...e2b, connection: connection("failed") },
        "personal",
      ),
    ).toBe("Setup failed");
    expect(orbProviderSource({ ...e2b, deployment: false }, "personal")).toBe(
      "Not connected",
    );
    expect(
      orbProviderSource(
        {
          ...e2b,
          id: "cloudflare",
          displayName: "Cloudflare Containers",
          fields: [],
        },
        "personal",
      ),
    ).toBe("Provided by this deployment");
  });
});
