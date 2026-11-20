import {
  MAX_SKILL_FILE_BYTES,
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
    const importedAgain = await preview(
      exportSkillVersion(version, first.resources),
    );
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
    ["binary type", file("resources/image.png", "PNG", "image/png")],
    ["archive input", file("resources/payload.zip", "PK", "application/zip")],
    ["NUL text", file("resources/data.txt", "bad\0text", "text/plain")],
    [
      "malformed text (a lone surrogate)",
      file("resources/data.txt", "bad\uD800text", "text/plain"),
    ],
  ])("rejects %s", async (_label, unsafe) => {
    await expect(rejected(bundle([unsafe]))).resolves.toBeInstanceOf(
      SkillImportRejected,
    );
  });

  // heygen-com/hyperframes quotes the replacement character a failed
  // transcript shows in references/captions.md.
  it("imports a file that quotes U+FFFD as text", async () => {
    const quoted =
      "More than 20% `\u266A` or `\uFFFD` tokens means the transcript failed.\n";
    const imported = await preview(
      bundle([file("references/captions.md", quoted)]),
    );
    expect(imported.resources.map(({ path }) => path)).toContain(
      "references/captions.md",
    );
  });

  // Popular skills.sh skills, each refused before (top 1,000, 2026-11).
  it.each([
    [
      "an unquoted colon in the description (pbakaus/impeccable/frontend-design)",
      "---\nname: frontend-design\ndescription: DEPRECATED: Run /impeccable instead.\n---\n\nUse impeccable.\n",
      {
        name: "frontend-design",
        description: "DEPRECATED: Run /impeccable instead.",
      },
    ],
    [
      "a name that is not kebab-case (google-labs-code/stitch-skills/reactcomponents)",
      "---\nname: react:components\ndescription: Converts designs into React components.\n---\n\nBuild them.\n",
      { name: "react-components" },
    ],
  ])("imports a SKILL.md with %s", async (_label, skillMd, expected) => {
    const imported = await preview({
      source: { type: "browser-files", label: "skills.sh" },
      files: [file("SKILL.md", skillMd)],
    });
    expect(imported.manifest).toMatchObject(expected);
  });

  it("shortens a description over 1,024 characters (anthropics/skills/claude-api)", async () => {
    const long = `Reference for the Claude API. ${"Trigger whenever the prompt names Claude. ".repeat(40)}`;
    const imported = await preview({
      source: { type: "browser-files", label: "skills.sh" },
      files: [
        file(
          "SKILL.md",
          `---\nname: claude-api\ndescription: |-\n  ${long}\n---\n\nUse the API.\n`,
        ),
      ],
    });
    expect(imported.manifest.description.length).toBeLessThanOrEqual(1024);
    expect(imported.manifest.description.endsWith("…")).toBe(true);
    expect(long.startsWith(imported.manifest.description.slice(0, -1))).toBe(
      true,
    );
  });

  it("imports paths of any script with spaces and a leading underscore, and refuses shell characters", async () => {
    const imported = await preview(
      bundle([
        file("demos/什么是token.html", "<p>token</p>", "text/html"),
        file("_bundled/MANIFEST.json", "{}"),
        file("references/My Notes (v2).md", "# Notes"),
      ]),
    );
    expect(imported.resources.map(({ path }) => path)).toEqual([
      "demos/什么是token.html",
      "_bundled/MANIFEST.json",
      "references/My Notes (v2).md",
    ]);
    for (const path of [
      "a$(id).md",
      "a`id`.md",
      'a".md',
      "a\\b.md",
      " lead.md",
    ])
      await expect(
        rejected(bundle([file(path, "x", "text/markdown")])),
      ).resolves.toBeInstanceOf(SkillImportRejected);
  });

  it("imports a standard SKILL.md folder with its scripts at their paths", async () => {
    const imported = await preview({
      source: { type: "browser-files", label: "pdf" },
      files: [
        file(
          "SKILL.md",
          "---\nname: pdf\ndescription: Fill PDF forms.\nlicense: MIT\n---\n\n# PDF\n\nRun scripts/check.py.\n",
        ),
        file("scripts/check.py", "print('ok')\n", "text/x-python"),
        file("FORMS.md", "# Forms\n"),
        file("LICENSE.txt", "MIT\n", "text/plain"),
      ],
    });
    expect(imported.manifest).toMatchObject({
      name: "pdf",
      description: "Fill PDF forms.",
    });
    expect(imported.instructions).toBe("# PDF\n\nRun scripts/check.py.");
    expect(
      imported.resources.map(({ path, mediaType }) => [path, mediaType]),
    ).toEqual([
      ["scripts/check.py", "text/x-python"],
      ["FORMS.md", "text/markdown"],
      ["LICENSE.txt", "text/plain"],
    ]);
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
      // A SKILL.md folder whose front matter has no name.
      {
        ...bundle(),
        files: [file("SKILL.md", "---\ndescription: No name\n---\n\nBody")],
      },
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
      file(
        "resources/large.txt",
        "x".repeat(MAX_SKILL_FILE_BYTES + 1),
        "text/plain",
      ),
    ]);
    const expanded = bundle(
      Array.from({ length: 6 }, (_, index) =>
        file(`resources/${index}.txt`, "x".repeat(1_000_000), "text/plain"),
      ),
    );
    for (const input of [tooMany, oversized, expanded]) {
      await expect(rejected(input)).resolves.toBeInstanceOf(
        SkillImportRejected,
      );
    }
  });
});
