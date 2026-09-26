import { describe, expect, it } from "vitest";
import { buildProjectMetadataChanges } from "./project-metadata.js";

describe("project metadata changes", () => {
  it("preserves an unchanged legacy name during description-only updates", () => {
    expect(
      buildProjectMetadataChanges(
        "Legacy project",
        "Legacy project",
        "Updated",
      ),
    ).toEqual({ ok: true, changes: { description: "Updated" } });
  });

  it("normalizes and validates edited names", () => {
    expect(buildProjectMetadataChanges("old", " new-name ", "")).toEqual({
      ok: true,
      changes: { name: "new-name", description: "" },
    });
    expect(buildProjectMetadataChanges("old", "new name", "").ok).toBe(false);
    expect(buildProjectMetadataChanges("old", "x".repeat(65), "").ok).toBe(
      false,
    );
  });
});
