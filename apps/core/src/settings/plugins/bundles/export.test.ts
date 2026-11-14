import {
  isStdioMcpServer,
  type PluginBundleRemoteMcpServer,
  type PluginId,
  type SkillWithVersion,
  type StoredMcpServer,
  type StoredPluginBundle,
} from "@dx/domain";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { exportPluginBundle } from "./export.js";
import { readPluginPackage } from "./plugin-package.js";
import { readPluginBundle } from "./read-bundle.js";
import { readZipArchive } from "./zip.js";
import { buildZip, type FixtureEntry } from "./zip-fixture.js";

// Export must give back a package any Agent Plugins client reads as the same
// plugin. Ways it could fail, each covered below:
// - the ZIP is not one dx's own strict reader accepts (bad CRC, offsets,
//   names, or modes);
// - plugin.json or mcp.json breaks the 1.1.0 closed schemas, so a client
//   rejects it or turns MCP off;
// - a skill loses its description, instructions, or resources, or its
//   front matter breaks on YAML-special text;
// - the re-imported plugin differs from the installed one (integrity);
// - a secret header or stored credential leaves dx;
// - the icon is dropped, or is the unsanitized original;
// - edits made after import are lost;
// - a local (stdio) server or the files it runs are dropped, or its
//   command loses its execute bit.

const PLUGIN = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json";

const read = async (bytes: Uint8Array) => {
  const archive = await Effect.runPromise(
    readZipArchive(bytes, { maxArchiveBytes: 10_000_000, maxEntries: 1000 }),
  );
  return {
    archive,
    bundle: await Effect.runPromise(
      readPluginBundle(archive, { root: "", fallbackName: "fallback" }),
    ),
  };
};

const text = async (bytes: Uint8Array, path: string) => {
  const { archive } = await read(bytes);
  const entry = archive.entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`missing ${path}`);
  const result = await Effect.runPromise(archive.readText(entry, 1_000_000));
  if (!result.ok) throw new Error(result.reason);
  return result.text;
};

const source: ReadonlyArray<FixtureEntry> = [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: PLUGIN,
      name: "acme.release-helper",
      displayName: "Release Helper",
      version: "1.2.3",
      description: "Ships releases: carefully, with #notes",
    }),
  },
  {
    name: "skills/release/SKILL.md",
    content:
      "---\nname: release\ndescription: 'Cut a release: tag, notes, and \"publish\"'\n---\n\n# Release\n\nRun scripts/release.sh.\n",
  },
  { name: "skills/release/scripts/release.sh", content: "echo release\n" },
  { name: "skills/release/reference/notes.md", content: "# Notes\n" },
  {
    name: "skills/triage/SKILL.md",
    content:
      "---\nname: triage\ndescription: Triage issues\n---\nLabel things.\n",
  },
  {
    name: "mcp.json",
    content: JSON.stringify({
      $schema: MCP,
      mcpServers: {
        Tracker: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Team": "core" },
        },
      },
    }),
  },
  {
    name: "assets/icon.svg",
    content:
      '<svg viewBox="0 0 8 8" onload="alert(1)"><script>alert(2)</script><rect width="8" height="8" fill="#0a0"/></svg>',
  },
];

/** What the stores hold after installing `parsed`, as export reads them. */
const installed = (parsed: Awaited<ReturnType<typeof read>>["bundle"]) => {
  const id = "plg_00000000-0000-4000-8000-000000000001" as PluginId;
  const bundle = {
    id,
    target: { scope: "personal", id: "usr_1" },
    name: parsed.manifest.name,
    enabled: true,
    version: parsed.version,
    manifest: parsed.manifest,
    source: { type: "zip", label: "release.zip" },
    integrity: parsed.integrity,
  } as unknown as StoredPluginBundle;
  const skills = parsed.skills.map(
    (preview) =>
      ({
        skill: { name: preview.manifest.name, pluginId: id },
        active: {
          manifest: preview.manifest,
          instructions: preview.instructions,
          resources: preview.resources,
        },
      }) as unknown as SkillWithVersion,
  );
  const mcpServers = parsed.manifest.mcpServers
    .filter(
      (server): server is PluginBundleRemoteMcpServer =>
        !isStdioMcpServer(server),
    )
    .map(
      (server) =>
        ({
          name: server.name,
          endpoint: server.endpoint,
          authType: server.authType,
          headers: [
            ...server.headers.map(({ name, value }) => ({
              name,
              value,
              secret: false,
            })),
            // A secret a person added in MCP settings.
            { name: "X-Api-Key", secret: true, value: "sk-secret" },
          ],
        }) as unknown as StoredMcpServer,
    );
  return { bundle, skills, mcpServers };
};

describe("exportPluginBundle", () => {
  it("round-trips an installed plugin through an Agent Plugins ZIP", async () => {
    const original = await read(await buildZip(source));
    expect(original.bundle.manifest.icon?.mediaType).toBe("image/svg+xml");

    const exported = await exportPluginBundle(installed(original.bundle));
    expect(exported.filename).toBe("acme.release-helper.zip");

    const again = await read(exported.bytes);
    expect(again.bundle.manifest).toEqual(original.bundle.manifest);
    expect(again.bundle.integrity).toBe(original.bundle.integrity);
    expect(again.bundle.version).toBe(original.bundle.version);
    expect(again.bundle.manifest.skipped).toEqual([]);
    expect(
      again.bundle.skills.map(({ manifest, resources }) => [
        manifest.name,
        resources.map(({ path }) => path).sort(),
      ]),
    ).toEqual([
      ["release", ["reference/notes.md", "scripts/release.sh"]],
      ["triage", []],
    ]);

    expect(JSON.parse(await text(exported.bytes, "plugin.json"))).toEqual({
      $schema: PLUGIN,
      name: "acme.release-helper",
      displayName: "Release Helper",
      version: "1.2.3",
      description: "Ships releases: carefully, with #notes",
    });
    const mcp = await text(exported.bytes, "mcp.json");
    expect(JSON.parse(mcp)).toEqual({
      $schema: MCP,
      mcpServers: {
        Tracker: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Team": "core" },
        },
      },
    });
    expect(mcp).not.toContain("sk-secret");
    const icon = await text(exported.bytes, "assets/icon.svg");
    expect(icon).not.toContain("alert");
    expect(icon).toContain('<rect width="8" height="8" fill="#0a0"/>');
  });

  it("exports what dx runs now, not what was imported", async () => {
    const original = await read(await buildZip(source));
    const state = installed(original.bundle);
    const [first, ...rest] = state.skills;
    const edited = {
      ...first,
      active: { ...first?.active, instructions: "Edited after import." },
    } as unknown as SkillWithVersion;
    const exported = await exportPluginBundle({
      ...state,
      skills: [edited, ...rest],
    });
    expect(await text(exported.bytes, "skills/release/SKILL.md")).toContain(
      "Edited after import.",
    );
    expect((await read(exported.bytes)).bundle.integrity).not.toBe(
      original.bundle.integrity,
    );
  });

  it.each([
    [{ host: { durable: "dev.dxcode/live.js" } }],
    [{ entry: "dev.dxcode/index.js", host: { durable: "dev.dxcode/live.js" } }],
    [{ entry: "dev.dxcode/index.js" }],
  ])("round-trips the code layer's host form %j", async (dx) => {
    const modules = [
      { path: "dev.dxcode/index.js", content: "export default () => {};\n" },
      { path: "dev.dxcode/live.js", content: "export default () => {};\n" },
    ];
    const original = await read(
      await buildZip([
        {
          name: "plugin.json",
          content: JSON.stringify({
            $schema: PLUGIN,
            name: "acme.hosts",
            extensions: { "dev.dxcode": { apiVersion: 1, ...dx } },
          }),
        },
        ...source.filter(({ name }) => name.startsWith("skills/triage")),
        ...modules.map(({ path, content }) => ({ name: path, content })),
      ]),
    );
    expect(original.bundle.manifest.code).toBeDefined();
    const exported = await exportPluginBundle({
      ...installed(original.bundle),
      codeModules: modules,
    });
    const again = await read(exported.bytes);
    expect(again.bundle.manifest.code).toEqual(original.bundle.manifest.code);
    expect(again.bundle.integrity).toBe(original.bundle.integrity);
  });

  it("keeps a PNG icon byte for byte, and refuses one that is not a PNG", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250, 0,
    ]);
    const withPng = source
      .filter(({ name }) => name !== "assets/icon.svg")
      .concat({ name: "assets/icon.png", content: png, method: 0 });
    const original = await read(await buildZip(withPng));
    expect(original.bundle.manifest.icon?.mediaType).toBe("image/png");
    const exported = await exportPluginBundle(installed(original.bundle));
    const { archive } = await read(exported.bytes);
    const entry = archive.entries.find(
      ({ path }) => path === "assets/icon.png",
    );
    if (entry === undefined) throw new Error("no icon");
    const bytes = await Effect.runPromise(archive.readBytes(entry, 1000));
    expect(bytes.ok && [...bytes.bytes]).toEqual([...png]);

    const fake = source
      .filter(({ name }) => name !== "assets/icon.svg")
      .concat({ name: "assets/icon.png", content: "<svg/>" });
    const parsed = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(
          readZipArchive(await buildZip(fake), {
            maxArchiveBytes: 10_000_000,
            maxEntries: 1000,
          }),
          (archive) =>
            readPluginBundle(archive, { root: "", fallbackName: "x" }),
        ),
      ),
    );
    if (!Result.isSuccess(parsed)) throw new Error("rejected");
    expect(parsed.success.manifest.icon).toBeUndefined();
    expect(parsed.success.manifest.skipped).toContainEqual({
      path: "assets/icon.png",
      reason: "The icon is not a PNG image.",
    });
  });

  it("keeps a local (stdio) server and the files it runs", async () => {
    const variable = (name: string) => `\${${name}}`;
    const original = await read(
      await buildZip([
        {
          name: "plugin.json",
          content: JSON.stringify({ $schema: PLUGIN, name: "local-tools" }),
        },
        {
          name: "bin/server",
          content: "#!/bin/sh\necho hi\n",
          executable: true,
        },
        {
          name: "mcp.json",
          content: JSON.stringify({
            $schema: MCP,
            mcpServers: {
              db: {
                type: "stdio",
                command: "./bin/server",
                args: ["--data", `${variable("PLUGIN_DATA")}/db`],
                env: { MODE: "fast" },
                cwd: variable("PLUGIN_ROOT"),
              },
            },
          }),
        },
      ]),
    );
    const bytes = original.bundle.packageBytes;
    if (bytes === undefined) throw new Error("no package");
    const exported = await exportPluginBundle({
      ...installed(original.bundle),
      packageFiles: readPluginPackage(bytes),
    });
    const again = await read(exported.bytes);
    expect(again.bundle.manifest.mcpServers).toEqual(
      original.bundle.manifest.mcpServers,
    );
    const server = again.archive.entries.find(
      ({ path }) => path === "bin/server",
    );
    expect(server?.executable).toBe(true);
    expect(again.bundle.manifest.package?.files).toBe(3);
  });
});
