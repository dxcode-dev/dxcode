import {
  MAX_SKILL_FILES,
  SkillId,
  type SkillImportBundle,
  SkillVersion,
  StoredSkillVersion,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  exportSkillVersion,
  previewSkillImport,
  SkillImportRejected,
} from "./import.js";

const manifest = {
  schemaVersion: 1,
  name: "review-guidelines",
  description: "Review this repository consistently.",
  mcpServerIds: [],
};

const file = (
  path: string,
  content: string,
  mediaType = path.endsWith(".json") ? "application/json" : "text/markdown",
  kind: "file" | "symlink" = "file",
) => ({ path, content, mediaType, kind, encoding: "utf-8" as const });

const bundle = (
  resources: SkillImportBundle["files"] = [],
): SkillImportBundle => ({
  source: { type: "browser-files", label: "Reviewed browser folder" },
  files: [
    file("skill.json", JSON.stringify(manifest)),
    file("instructions.md", "Follow the project review checklist."),
    ...resources,
  ],
});

const preview = (input: unknown) =>
  Effect.runPromise(previewSkillImport(input));
const rejected = (input: unknown) =>
  Effect.runPromise(Effect.flip(previewSkillImport(input)));

describe("skill browser-file importer", () => {
  it("produces deterministic content integrity and export/import round trips", async () => {
    const input = bundle([
      file("resources/checklist.md", "# Checklist\n\n- Run tests"),
      file("resources/owners.json", '{"team":"runtime"}'),
    ]);
    const first = await preview(input);
    const reordered = await preview({
      ...input,
      files: [...input.files].reverse(),
    });
    expect(first.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(first.integrity).toBe(reordered.integrity);
    expect(first.resources.map(({ path }) => path)).toEqual([
      "resources/checklist.md",
      "resources/owners.json",
    ]);

    const version = Schema.decodeUnknownSync(StoredSkillVersion)({
      skillId: Schema.decodeUnknownSync(SkillId)(
        "skl_00000000-0000-4000-8000-000000000044",
      ),
      version: Schema.decodeUnknownSync(SkillVersion)(3),
      manifest: first.manifest,
      instructions: first.instructions,
      resources: first.resources,
      source: first.source,
      integrity: first.integrity,
      createdAt: "2026-08-23T00:00:00.000Z",
      createdByUserId: Schema.decodeUnknownSync(UserId)("skill-owner"),
    });
    const importedAgain = await preview(exportSkillVersion(version));
    expect(importedAgain.integrity).toBe(first.integrity);
    expect(importedAgain).toMatchObject({
      manifest: first.manifest,
      instructions: first.instructions,
      resources: first.resources,
    });
  });

  it.each([
    ["parent traversal", file("resources/../secret.md", "secret")],
    ["absolute path", file("/resources/secret.md", "secret")],
    ["Windows traversal", file("resources\\..\\secret.md", "secret")],
    ["encoded traversal", file("resources/%2e%2e/secret.md", "secret")],
    ["hidden segment", file("resources/.private.md", "secret")],
    [
      "symlink",
      file("resources/link.md", "target", "text/markdown", "symlink"),
    ],
    ["executable source", file("resources/tool.ts", "export {}", "text/plain")],
    ["binary type", file("resources/image.png", "PNG", "image/png")],
    ["archive input", file("resources/payload.zip", "PK", "application/zip")],
    ["NUL text", file("resources/data.txt", "bad\0text", "text/plain")],
    [
      "invalid UTF-8 replacement",
      file("resources/data.txt", "bad\uFFFDtext", "text/plain"),
    ],
  ])("rejects %s", async (_label, unsafe) => {
    await expect(rejected(bundle([unsafe]))).resolves.toBeInstanceOf(
      SkillImportRejected,
    );
  });

  it("rejects executable manifest fields instead of silently accepting them", async () => {
    const input = bundle();
    const executableManifest = {
      ...manifest,
      entrypoint: "resources/plugin.js",
    };
    const changed = {
      ...input,
      files: input.files.map((candidate) =>
        candidate.path === "skill.json"
          ? { ...candidate, content: JSON.stringify(executableManifest) }
          : candidate,
      ),
    };
    await expect(rejected(changed)).resolves.toMatchObject({
      _tag: "SkillImportRejected",
      field: "skill.json",
    });
  });

  it("rejects missing, malformed, duplicate, and misplaced required files", async () => {
    const cases: ReadonlyArray<unknown> = [
      { ...bundle(), files: bundle().files.slice(1) },
      {
        ...bundle(),
        files: bundle().files.map((candidate) =>
          candidate.path === "skill.json"
            ? { ...candidate, content: "{" }
            : candidate,
        ),
      },
      { ...bundle(), files: [...bundle().files, bundle().files[0]] },
      bundle([file("notes.md", "Must live below resources/")]),
    ];
    for (const input of cases) {
      await expect(rejected(input)).resolves.toBeInstanceOf(
        SkillImportRejected,
      );
    }
  });

  it("rejects file-count, per-file, and expanded-total bomb-like bundles", async () => {
    const tooMany = {
      ...bundle(),
      files: [
        ...bundle().files,
        ...Array.from({ length: MAX_SKILL_FILES }, (_, index) =>
          file(`resources/${index}.txt`, "x", "text/plain"),
        ),
      ],
    };
    const oversized = bundle([
      file("resources/large.txt", "x".repeat(65_537), "text/plain"),
    ]);
    const expanded = bundle(
      Array.from({ length: 5 }, (_, index) =>
        file(`resources/${index}.txt`, "x".repeat(60_000), "text/plain"),
      ),
    );
    for (const input of [tooMany, oversized, expanded]) {
      await expect(rejected(input)).resolves.toBeInstanceOf(
        SkillImportRejected,
      );
    }
  });
});
