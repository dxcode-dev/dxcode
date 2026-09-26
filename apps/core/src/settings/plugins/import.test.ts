import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PluginImportRejected, previewPluginImport } from "./import.js";

const manifest = (version = "1.0.0") => ({
  schemaVersion: 1,
  name: "review-helper",
  displayName: "Review helper",
  description: "A bounded plugin used to verify import policy.",
  version,
  entrypoint: "main.mjs",
  tools: [{ name: "summarize", description: "Summarize reviewed input." }],
  commands: [
    {
      name: "summarize-selection",
      title: "Summarize selection",
      description: "Run the approved summarize tool.",
      tool: "summarize",
    },
  ],
  lifecycle: [{ event: "agent-start" }],
  uiSurfaces: [
    {
      id: "review-status",
      location: "settings-card",
      title: "Review status",
      description: "Validated status metadata.",
    },
  ],
  permissions: {
    tools: ["summarize"],
    commands: ["summarize-selection"],
    lifecycle: ["agent-start"],
    uiSurfaces: ["review-status"],
    networkDestinations: ["api.example.com"],
    secretNames: ["REVIEW_TOKEN"],
    filesystem: ["project-read"],
    mcpServerIds: [],
    agentCapabilities: ["thread-metadata"],
  },
});

const bundle = (input = manifest()) => ({
  source: { type: "browser-files" as const, label: "Reviewed test files" },
  files: [
    {
      path: "plugin.json",
      kind: "file" as const,
      mediaType: "application/json",
      encoding: "utf-8" as const,
      content: JSON.stringify(input),
    },
    {
      path: "main.mjs",
      kind: "file" as const,
      mediaType: "text/javascript",
      encoding: "utf-8" as const,
      content:
        "globalThis.__PLUGIN_EXECUTED__ = true; export const tools = {};",
    },
  ],
});

describe("trusted plugin import", () => {
  it("validates and hashes exact reviewed files without executing source", async () => {
    delete (globalThis as { __PLUGIN_EXECUTED__?: boolean })
      .__PLUGIN_EXECUTED__;
    const first = await Effect.runPromise(previewPluginImport(bundle()));
    const reordered = await Effect.runPromise(
      previewPluginImport({
        ...bundle(),
        files: [...bundle().files].reverse(),
      }),
    );

    expect(first.manifest.version).toBe("1.0.0");
    expect(first.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.integrity).toBe(first.integrity);
    expect(first.files).toHaveLength(2);
    expect(
      (globalThis as { __PLUGIN_EXECUTED__?: boolean }).__PLUGIN_EXECUTED__,
    ).toBeUndefined();

    const changed = bundle();
    changed.files[1] = {
      ...changed.files[1],
      content: `${changed.files[1]?.content}\n// reviewed change`,
    };
    const changedPreview = await Effect.runPromise(
      previewPluginImport(changed),
    );
    expect(changedPreview.integrity).not.toBe(first.integrity);
  });

  it("rejects undeclared permissions, traversal, symlinks, and invalid versions", async () => {
    const cases = [
      bundle({
        ...manifest(),
        permissions: { ...manifest().permissions, tools: [] },
      }),
      {
        ...bundle(),
        files: [
          ...bundle().files,
          {
            path: "../escape.mjs",
            kind: "file" as const,
            mediaType: "text/javascript",
            encoding: "utf-8" as const,
            content: "export {};",
          },
        ],
      },
      {
        ...bundle(),
        files: bundle().files.map((file) =>
          file.path === "main.mjs"
            ? { ...file, kind: "symlink" as const }
            : file,
        ),
      },
      bundle(manifest("latest")),
    ];

    for (const candidate of cases) {
      await expect(
        Effect.runPromise(previewPluginImport(candidate)),
      ).rejects.toBeInstanceOf(PluginImportRejected);
    }
  });
});
