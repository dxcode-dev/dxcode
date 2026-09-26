import { describe, expect, it } from "vitest";
import { decodeDeploymentIdentity } from "./deployment-label.js";

describe("deployment identity", () => {
  it.each([
    "Local",
    "Branch preview · ticket/324-branch-bootstrap-readiness · abcdef012345",
    "Staging · abcdef012345",
  ])("accepts the exact public label %s", async (label) => {
    await expect(decodeDeploymentIdentity({ label })).resolves.toBe(label);
  });

  it.each([
    { label: "Preview · branch · abcdef012345" },
    { label: "Branch preview · branch · ABCDEF012345" },
    { label: "Staging · abcdef012345", revision: "abcdef012345" },
    { stage: "preview", revision: "abcdef012345" },
  ])("rejects an invalid or excessive public identity %#", async (value) => {
    await expect(decodeDeploymentIdentity(value)).rejects.toThrow(
      "Deployment identity is invalid",
    );
  });
});
