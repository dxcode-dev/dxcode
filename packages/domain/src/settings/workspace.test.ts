import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceDisplayName,
  normalizeWorkspaceShortName,
  WorkspaceProfile,
  WorkspaceShortName,
} from "./workspace.js";

describe("workspace domain", () => {
  it("normalizes profile input before validating it", () => {
    expect(normalizeWorkspaceDisplayName("  DX Team  ")).toBe("DX Team");
    expect(normalizeWorkspaceShortName("  DX-Team  ")).toBe("dx-team");
  });

  it.each(["dx-team", "team-2", "abc"])(
    "accepts globally usable short name %s",
    (shortName) => {
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(WorkspaceShortName)(shortName),
        ),
      ).toBe(true);
    },
  );

  it.each(["ab", "DX-Team", "-dx-team", "dx-team-", "dx_team", "d".repeat(64)])(
    "rejects invalid or non-normalized short name %s",
    (shortName) => {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(WorkspaceShortName)(shortName),
        ),
      ).toBe(true);
    },
  );

  it("models stable identity separately from mutable names and lifecycle", () => {
    const profile = Schema.decodeUnknownSync(WorkspaceProfile)({
      id: "stable-workspace-id",
      displayName: "DX Team",
      shortName: "dx-team",
      lifecycleState: "deletion-pending",
      revision: 0,
    });

    expect(profile).toEqual({
      id: "stable-workspace-id",
      displayName: "DX Team",
      shortName: "dx-team",
      lifecycleState: "deletion-pending",
      revision: 0,
    });
  });
});
