import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_MCP_REFERENCES,
  SkillImportBundle,
  SkillIntegrity,
  SkillManifest,
  SkillVersion,
} from "./skill.js";

const mcpId = (index: number) =>
  `mcp_00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("skill domain", () => {
  it("accepts only version 1 declarative manifests with bounded MCP IDs", () => {
    expect(
      Schema.decodeUnknownSync(SkillManifest)({
        schemaVersion: 1,
        name: "review-guidelines",
        description: "Review this repository consistently.",
      }),
    ).toMatchObject({ mcpServerIds: [] });
    expect(
      Schema.decodeUnknownSync(SkillManifest)({
        schemaVersion: 1,
        name: "review-guidelines",
        description: "Review this repository consistently.",
        mcpServerIds: [mcpId(1)],
      }),
    ).toMatchObject({ name: "review-guidelines", schemaVersion: 1 });

    for (const manifest of [
      {
        schemaVersion: 2,
        name: "review-guidelines",
        description: "Unsupported format.",
        mcpServerIds: [],
      },
      {
        schemaVersion: 1,
        name: "Review Guidelines",
        description: "Invalid name.",
        mcpServerIds: [],
      },
      {
        schemaVersion: 1,
        name: "too-many-dependencies",
        description: "Too many dependencies.",
        mcpServerIds: Array.from(
          { length: MAX_SKILL_MCP_REFERENCES + 1 },
          (_, index) => mcpId(index),
        ),
      },
    ]) {
      expect(
        Option.isNone(Schema.decodeUnknownOption(SkillManifest)(manifest)),
      ).toBe(true);
    }
  });

  it("requires positive immutable version numbers and SHA-256 integrity", () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        Option.isNone(Schema.decodeUnknownOption(SkillVersion)(version)),
      ).toBe(true);
    }
    expect(Schema.decodeUnknownSync(SkillVersion)(1)).toBe(1);
    expect(Schema.decodeUnknownSync(SkillIntegrity)("a".repeat(64))).toBe(
      "a".repeat(64),
    );
    for (const integrity of ["a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect(
        Option.isNone(Schema.decodeUnknownOption(SkillIntegrity)(integrity)),
      ).toBe(true);
    }
  });

  it("models only reviewed browser-file inputs, never server filesystem paths", () => {
    expect(
      Schema.decodeUnknownSync(SkillImportBundle)({
        source: { type: "browser-files", label: "Selected folder" },
        files: [
          {
            path: "skill.json",
            kind: "file",
            mediaType: "application/json",
            encoding: "utf-8",
            content: "{}",
          },
          {
            path: "instructions.md",
            kind: "file",
            mediaType: "text/markdown",
            encoding: "utf-8",
            content: "Instructions",
          },
        ],
      }).source.type,
    ).toBe("browser-files");
    expect(() =>
      Schema.decodeUnknownSync(SkillImportBundle)({
        source: { type: "filesystem", path: "/srv/skills/example" },
        files: [],
      }),
    ).toThrow();
  });
});
