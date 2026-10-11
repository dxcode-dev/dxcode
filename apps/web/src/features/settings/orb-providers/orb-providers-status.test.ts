import type { OrbProviderData } from "@dx/api";
import { describe, expect, it } from "vitest";
import { orbProviderSource } from "./orb-providers-status.js";

const e2b: OrbProviderData = {
  id: "e2b",
  displayName: "E2B",
  credentialLabel: "E2B API key",
  pauseResume: "processes",
  deployment: true,
  key: null,
  workspaceKey: null,
};
const key = (
  status: "building" | "ready" | "failed" | null,
): OrbProviderData["key"] => ({
  configuredAt: "2026-10-04T00:00:00.000Z",
  account: "team-a",
  template: status === null ? null : { status, error: null },
});

describe("Orb provider rows", () => {
  it("say whose account runs the provider", () => {
    expect(orbProviderSource(e2b, "personal")).toBe(
      "Provided by this deployment",
    );
    expect(orbProviderSource({ ...e2b, key: key("ready") }, "personal")).toBe(
      "Your key · team-a",
    );
    expect(orbProviderSource({ ...e2b, key: key("ready") }, "workspace")).toBe(
      "Workspace key · team-a",
    );
    expect(
      orbProviderSource({ ...e2b, workspaceKey: key("ready") }, "personal"),
    ).toBe("Workspace key · team-a");
    expect(orbProviderSource({ ...e2b, deployment: false }, "personal")).toBe(
      "Needs an API key",
    );
    expect(
      orbProviderSource(
        {
          ...e2b,
          id: "cloudflare",
          displayName: "Cloudflare Containers",
          credentialLabel: null,
        },
        "personal",
      ),
    ).toBe("Provided by this deployment");
  });
});
