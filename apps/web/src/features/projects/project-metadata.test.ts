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
});
