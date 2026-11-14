/**
 * How tier resolution could go wrong, each covered below:
 * - a repository plugin gets above sandboxed without the repository trusted
 * - a personal plugin keeps personal-dev in a Thread its owner doesn't own
 * - a workspace plugin reaches verified without a trusted signature
 * - a manifest `tier` above the scope's grant raises it instead of capping it
 * - an absent `tier` is read as sandboxed instead of "no ceiling"
 * - the admin cap is ignored, or raises a tier below it
 * - the reason names the wrong limit
 */
import { describe, expect, it } from "vitest";
import {
  type PluginTierInput,
  resolvePluginTier,
  viewerPaneTier,
} from "./resolve-tier.js";

const base: PluginTierInput = {
  scope: "workspace",
  signedByTrustedKey: false,
  repositoryTrusted: false,
  workspaceCap: "verified",
  callerOwnsThread: true,
};
const resolve = (input: Partial<PluginTierInput>) =>
  resolvePluginTier({ ...base, ...input });

describe("resolvePluginTier", () => {
  it("keeps repository plugins sandboxed until the repository is trusted", () => {
    expect(resolve({ scope: "repository", requested: "verified" })).toEqual({
      tier: "sandboxed",
      reason: "scope",
    });
    expect(resolve({ scope: "repository", repositoryTrusted: true })).toEqual({
      tier: "workspace-trusted",
      reason: "scope",
    });
    expect(
      resolve({
        scope: "repository",
        repositoryTrusted: true,
        signedByTrustedKey: true,
      }),
    ).toEqual({ tier: "workspace-trusted", reason: "scope" });
  });

  it("gives personal installs personal-dev only in the owner's Threads", () => {
    expect(resolve({ scope: "personal" })).toEqual({
      tier: "personal-dev",
      reason: "scope",
    });
    expect(resolve({ scope: "personal", callerOwnsThread: false })).toEqual({
      tier: "sandboxed",
      reason: "not-owner",
    });
    expect(resolve({ scope: "personal", signedByTrustedKey: true }).tier).toBe(
      "personal-dev",
    );
  });

  it("raises workspace installs to verified only with a trusted signature", () => {
    expect(resolve({})).toEqual({ tier: "workspace-trusted", reason: "scope" });
    expect(resolve({ signedByTrustedKey: true })).toEqual({
      tier: "verified",
      reason: "signature",
    });
  });

  it("treats the manifest tier as a ceiling, never a raise", () => {
    expect(resolve({ requested: "sandboxed" })).toEqual({
      tier: "sandboxed",
      reason: "requested",
    });
    expect(resolve({ requested: "verified" })).toEqual({
      tier: "workspace-trusted",
      reason: "scope",
    });
    expect(resolve({ requested: undefined }).tier).toBe("workspace-trusted");
  });

  it("applies the admin cap last and only downward", () => {
    expect(
      resolve({ signedByTrustedKey: true, workspaceCap: "workspace-trusted" }),
    ).toEqual({
      tier: "workspace-trusted",
      reason: "cap",
    });
    expect(resolve({ scope: "personal", workspaceCap: "sandboxed" })).toEqual({
      tier: "sandboxed",
      reason: "cap",
    });
    expect(
      resolve({
        scope: "repository",
        repositoryTrusted: false,
        workspaceCap: "verified",
      }),
    ).toEqual({ tier: "sandboxed", reason: "scope" });
    // Both lower it: the cap is the admin's word, so it names the reason.
    expect(
      resolve({ requested: "sandboxed", workspaceCap: "sandboxed" }),
    ).toEqual({
      tier: "sandboxed",
      reason: "cap",
    });
  });
});

/**
 * A pane or view runs in the viewer's browser. Ways it could go wrong:
 * a contributor viewing the owner's Thread gets the owner's personal-dev
 * powers; a workspace install loses its tier for other members; a viewer
 * check raises a tier instead of only lowering it.
 */
describe("viewerPaneTier", () => {
  it("gives a personal install's pane personal-dev only for its owner", () => {
    expect(viewerPaneTier("personal-dev", "personal", "usr_a", "usr_a")).toBe(
      "personal-dev",
    );
    expect(viewerPaneTier("personal-dev", "personal", "usr_a", "usr_b")).toBe(
      "sandboxed",
    );
    expect(viewerPaneTier("personal-dev", "personal", "usr_a", undefined)).toBe(
      "sandboxed",
    );
  });

  it("keeps workspace and repository tiers for every member, never raising", () => {
    expect(viewerPaneTier("verified", "workspace", "ws_1", "usr_b")).toBe(
      "verified",
    );
    expect(
      viewerPaneTier("workspace-trusted", "repository", "prj_1", "usr_b"),
    ).toBe("workspace-trusted");
    expect(viewerPaneTier("sandboxed", "personal", "usr_a", "usr_a")).toBe(
      "sandboxed",
    );
  });
});
