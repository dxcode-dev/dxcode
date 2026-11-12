import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PluginBundleRejected } from "./errors.js";
import { readPluginBundle } from "./read-bundle.js";
import { readZipArchive } from "./zip.js";
import { buildZip, type FixtureEntry } from "./zip-fixture.js";

/** A `${NAME}` placeholder, written so it is not a template slot. */
const variable = (name: string) => `\${${name}}`;

// A folder with a root plugin.json is an Agent Plugins package
// (https://agent-plugins.org, spec 1.0.0 and 1.1.0). Ways one can be
// malformed or hostile, each covered below:
// - plugin.json that is not JSON or not an object;
// - a missing or unknown `$schema`, such as a later spec version;
// - a name that breaks the spec's rules (periods are allowed);
// - a permitted field of the wrong type, or an author with extra keys;
// - unknown top-level fields, which are reported and given no meaning,
//   even when they look like component paths;
// - `extensions` that is not an object (fatal in 1.1.0, ignored in 1.0.0),
//   other clients' namespaces (never validated), and dx's own namespace;
// - a `.claude-plugin/plugin.json` or `.mcp.json` beside the root manifest,
//   which must not add to it;
// - skills deeper than `skills/<name>/`, a skill named unlike its folder,
//   and `skills` that is a file rather than a folder;
// - an mcp.json that is not JSON, has another or a mismatched `$schema`,
//   extra top-level fields, or non-object `mcpServers`: MCP is turned off
//   but skills still load;
// - server entries with no or unknown `type`, unknown fields, another
//   variant's fields, or bad `extensions`: only that server is skipped;
// - legacy SSE servers, which dx does not support;
// - URLs with user info or a fragment, plain HTTP off loopback, and
//   loopback HTTP that dx's Worker cannot reach;
// - duplicate header names that differ only in case, and literal
//   Authorization headers;
// - nothing importable at all.

const PLUGIN_1_1 = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const PLUGIN_1_0 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_1_1 = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json";
const MCP_1_0 = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const zip = async (entries: ReadonlyArray<FixtureEntry>) =>
  Effect.runPromise(
    readZipArchive(await buildZip(entries), {
      maxArchiveBytes: 10_000_000,
      maxEntries: 1000,
    }),
  );

const parse = async (
  entries: ReadonlyArray<FixtureEntry>,
  options: { readonly root?: string } = {},
) =>
  Effect.runPromise(
    Effect.result(
      readPluginBundle(await zip(entries), {
        root: options.root ?? "",
        fallbackName: "Fallback Name",
      }),
    ),
  );

const parsed = async (
  entries: ReadonlyArray<FixtureEntry>,
  options: { readonly root?: string } = {},
) => {
  const result = await parse(entries, options);
  if (result._tag !== "Success") throw result.failure;
  return result.success;
};

const rejected = async (entries: ReadonlyArray<FixtureEntry>) => {
  const result = await parse(entries);
  if (result._tag !== "Failure") throw new Error("Expected a rejection.");
  expect(result.failure).toBeInstanceOf(PluginBundleRejected);
  return (result.failure as PluginBundleRejected).reason;
};

const skill = (name: string, description = `Use ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the ${name} thing.\n`;

const manifest = (fields: Record<string, unknown>, schema = PLUGIN_1_1) => ({
  name: "plugin.json",
  content: JSON.stringify({ $schema: schema, ...fields }),
});

const mcp = (servers: unknown, schema = MCP_1_1) => ({
  name: "mcp.json",
  content: JSON.stringify({ $schema: schema, mcpServers: servers }),
});

const aSkill = { name: "skills/review/SKILL.md", content: skill("review") };

const skippedPaths = (
  skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>,
) => skipped.map(({ path }) => path);

describe("readPluginBundle with an Agent Plugins package", () => {
  it("imports the spec's example package from a GitHub archive folder", async () => {
    const bundle = await parsed(
      [
        { name: "agent-plugins-example-main/", content: "" },
        {
          name: "agent-plugins-example-main/plugin.json",
          content: JSON.stringify({
            $schema: PLUGIN_1_0,
            name: "agent-plugins-example",
            version: "1.0.0",
            description:
              "A copyable reference package and migration guide for Agent Plugins v1.0.0.",
            license: "MIT",
            keywords: ["agent-plugins", "example", "migration", "skills"],
          }),
        },
        {
          name: "agent-plugins-example-main/skills/migrate-agent-plugin/SKILL.md",
          content:
            '---\nname: migrate-agent-plugin\ndescription: Migrate an existing client-specific agent plugin to the portable Agent Plugins v1 structure.\nlicense: MIT\nmetadata:\n  version: "1.0.0"\n---\n\n# Migrate an Agent Plugin\n\nConvert an existing plugin.\n',
        },
        {
          name: "agent-plugins-example-main/skills/migrate-agent-plugin/references/migration-guide.md",
          content: "# Migration guide\n",
        },
      ],
      { root: "" },
    );
    expect(bundle.manifest).toMatchObject({
      format: "agent-plugins",
      name: "agent-plugins-example",
      displayName: "agent-plugins-example",
      version: "1.0.0",
      skills: [{ name: "migrate-agent-plugin" }],
      mcpServers: [],
      skipped: [],
    });
    expect(bundle.skills[0]?.resources.map(({ path }) => path)).toEqual([
      "references/migration-guide.md",
    ]);
    expect(bundle.version).toMatch(/^1\.0\.0\+[0-9a-f]{12}$/);
  });

  it("imports a 1.1.0 package with a display name, a dotted name, and a remote server", async () => {
    const bundle = await parsed([
      manifest({
        name: "acme.tools",
        displayName: "Acme Tools",
        description: "Tools.",
        author: { name: "Acme", email: "a@example.com", url: "x" },
        homepage: "not a url",
        version: "not semver",
        extensions: { "com.example.client": { anything: [1, { deep: true }] } },
      }),
      aSkill,
      mcp({
        docs: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Tenant": "public" },
          extensions: { "com.example.client": { retry: 3 } },
        },
      }),
    ]);
    expect(bundle.manifest).toMatchObject({
      format: "agent-plugins",
      name: "acme.tools",
      displayName: "Acme Tools",
      version: "not semver",
      skills: [{ name: "review" }],
      mcpServers: [
        {
          name: "docs",
          endpoint: "https://mcp.example.com/mcp",
          authType: "none",
          headers: [{ name: "X-Tenant", value: "public" }],
        },
      ],
      skipped: [],
    });
    expect(bundle.version).toMatch(/^0\.0\.0\+[0-9a-f]{12}$/);
  });

  it("falls back to the name when the display name is blank", async () => {
    const bundle = await parsed([
      manifest({ name: "plain", displayName: "   " }),
      aSkill,
    ]);
    expect(bundle.manifest.displayName).toBe("plain");
  });

  it("rejects a manifest that is not a JSON object", async () => {
    expect(
      await rejected([{ name: "plugin.json", content: "{" }, aSkill]),
    ).toMatch(/plugin\.json/);
    expect(
      await rejected([{ name: "plugin.json", content: "[]" }, aSkill]),
    ).toMatch(/plugin\.json/);
  });

  it("rejects a missing or unsupported $schema", async () => {
    expect(
      await rejected([
        { name: "plugin.json", content: JSON.stringify({ name: "x" }) },
        aSkill,
      ]),
    ).toMatch(/\$schema/);
    expect(
      await rejected([
        manifest(
          { name: "x" },
          "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
        ),
        aSkill,
      ]),
    ).toMatch(/2\.0\.0|version/);
  });

  it("rejects names that break the spec's rules", async () => {
    for (const name of [
      "",
      "My-Plugin",
      "-start",
      "end.",
      "has--double",
      "too.many..dots",
      "a".repeat(65),
      7,
    ]) {
      expect(await rejected([manifest({ name }), aSkill])).toMatch(/name/);
    }
  });

  it("rejects permitted fields of the wrong type", async () => {
    for (const fields of [
      { version: 1 },
      { description: false },
      { displayName: 3 },
      { homepage: {} },
      { license: [] },
      { keywords: "one" },
      { keywords: ["one", 2] },
      { author: "Acme" },
      { author: { name: "Acme", twitter: "@acme" } },
      { author: { name: 1 } },
      { extensions: [] },
      { extensions: { "com.example.client": true } },
    ]) {
      expect(
        await rejected([manifest({ name: "p", ...fields }), aSkill]),
      ).toMatch(/plugin\.json/);
    }
  });

  it("reports unknown top-level fields and gives them no meaning", async () => {
    const bundle = await parsed([
      manifest({
        name: "p",
        skills: "./other",
        mcpServers: { sneaky: { url: "https://sneaky.example.com/mcp" } },
        commands: "./commands",
      }),
      aSkill,
      { name: "other/extra/SKILL.md", content: skill("extra") },
    ]);
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(bundle.manifest.mcpServers).toEqual([]);
    expect(skippedPaths(bundle.manifest.skipped)).toEqual(
      expect.arrayContaining([
        "plugin.json#skills",
        "plugin.json#mcpServers",
        "plugin.json#commands",
      ]),
    );
  });

  it("follows 1.0.0 for a display name and a non-object extensions", async () => {
    const bundle = await parsed([
      manifest(
        { name: "old", displayName: "Old Name", extensions: "nope" },
        PLUGIN_1_0,
      ),
      aSkill,
    ]);
    expect(bundle.manifest.displayName).toBe("old");
    expect(skippedPaths(bundle.manifest.skipped)).toEqual(
      expect.arrayContaining([
        "plugin.json#displayName",
        "plugin.json#extensions",
      ]),
    );
  });

  it("turns off only dx's code layer for a malformed dev.dxcode block, and ignores other namespaces", async () => {
    const bundle = await parsed([
      manifest({
        name: "p",
        extensions: { "dev.dxcode": { entry: "dev.dxcode/index.ts" } },
      }),
      aSkill,
      { name: "dev.dxcode/index.ts", content: "export default () => {}" },
      { name: "com.example.client/hooks/hooks.json", content: "{}" },
    ]);
    // No apiVersion: the code layer is off; the skill still loads.
    expect(skippedPaths(bundle.manifest.skipped)).toEqual([
      "plugin.json#extensions.dev.dxcode",
    ]);
    expect(bundle.manifest.code).toBeUndefined();
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["review"]);
  });

  it("reads only the root manifest and mcp.json", async () => {
    const bundle = await parsed([
      manifest({ name: "root-wins", displayName: "Root" }),
      aSkill,
      {
        name: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "claude-name", skills: ["./extra"] }),
      },
      {
        name: ".mcp.json",
        content: JSON.stringify({
          mcpServers: { other: { url: "https://other.example.com/mcp" } },
        }),
      },
      { name: "extra/SKILL.md", content: skill("extra") },
    ]);
    expect(bundle.manifest).toMatchObject({
      name: "root-wins",
      skills: [{ name: "review" }],
      mcpServers: [],
    });
  });

  it("finds skills only in direct children of skills/", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      aSkill,
      { name: "SKILL.md", content: skill("p") },
      { name: "skills/group/nested/SKILL.md", content: skill("nested") },
      { name: "skills/misnamed/SKILL.md", content: skill("other-name") },
      { name: "skills/broken/SKILL.md", content: "no front matter" },
    ]);
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(skippedPaths(bundle.manifest.skipped)).toEqual(
      expect.arrayContaining([
        "skills/misnamed/SKILL.md",
        "skills/broken/SKILL.md",
      ]),
    );
    expect(skippedPaths(bundle.manifest.skipped)).not.toContain(
      "skills/group/nested/SKILL.md",
    );
  });

  it("turns off skills when skills is a file, and keeps MCP", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      { name: "skills", content: "not a folder" },
      mcp({ docs: { type: "streamable-http", url: "https://d.example.com/" } }),
    ]);
    expect(bundle.manifest.skills).toEqual([]);
    expect(bundle.manifest.mcpServers.map(({ name }) => name)).toEqual([
      "docs",
    ]);
    expect(skippedPaths(bundle.manifest.skipped)).toContain("skills");
  });

  it("turns off MCP for a bad mcp.json and keeps skills", async () => {
    const server = {
      docs: { type: "streamable-http", url: "https://d.example.com/" },
    };
    for (const file of [
      { name: "mcp.json", content: "{" },
      {
        name: "mcp.json",
        content: JSON.stringify({ mcpServers: server }),
      },
      mcp(server, MCP_1_0),
      {
        name: "mcp.json",
        content: JSON.stringify({
          $schema: MCP_1_1,
          mcpServers: server,
          extra: true,
        }),
      },
      mcp([]),
      { name: "mcp.json/inner", content: "a folder, not a file" },
    ]) {
      const bundle = await parsed([manifest({ name: "p" }), aSkill, file]);
      expect(bundle.manifest.skills.map(({ name }) => name)).toEqual([
        "review",
      ]);
      expect(bundle.manifest.mcpServers).toEqual([]);
      expect(skippedPaths(bundle.manifest.skipped)).toContain("mcp.json");
    }
  });

  it("accepts an empty mcpServers", async () => {
    const bundle = await parsed([manifest({ name: "p" }), aSkill, mcp({})]);
    expect(bundle.manifest.skipped).toEqual([]);
  });

  it("skips only the server entries that are invalid or unsupported", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      aSkill,
      mcp({
        good: { type: "streamable-http", url: "https://good.example.com/mcp" },
        untyped: { url: "https://untyped.example.com/mcp" },
        unknownType: { type: "websocket", url: "wss://w.example.com" },
        extraField: {
          type: "streamable-http",
          url: "https://e.example.com/mcp",
          timeout: 5,
        },
        mixed: {
          type: "streamable-http",
          url: "https://m.example.com/mcp",
          command: "./bin/server",
        },
        badExtensions: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          extensions: { "com.example.client": 1 },
        },
        local: { type: "stdio", command: "./bin/server" },
        legacy: { type: "sse", url: "https://legacy.example.com/sse" },
        userinfo: {
          type: "streamable-http",
          url: "https://user:pw@u.example.com/mcp",
        },
        fragment: {
          type: "streamable-http",
          url: "https://f.example.com/mcp#x",
        },
        plain: { type: "streamable-http", url: "http://plain.example.com/mcp" },
        relative: { type: "streamable-http", url: "/mcp" },
        loopback: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
        dupHeaders: {
          type: "streamable-http",
          url: "https://h.example.com/mcp",
          headers: { "X-Key": "a", "x-key": "b" },
        },
        literalAuth: {
          type: "streamable-http",
          url: "https://auth.example.com/mcp",
          headers: { Authorization: "Bearer abc" },
        },
      }),
    ]);
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(bundle.manifest.mcpServers.map(({ name }) => name)).toEqual([
      "good",
      "literalAuth",
    ]);
    const literalAuth = bundle.manifest.mcpServers.find(
      ({ name }) => name === "literalAuth",
    );
    expect(
      literalAuth !== undefined && "headers" in literalAuth
        ? literalAuth.headers
        : undefined,
    ).toEqual([]);
    const reasons = Object.fromEntries(
      bundle.manifest.skipped.map(({ path, reason }) => [path, reason]),
    );
    for (const name of [
      "untyped",
      "unknownType",
      "extraField",
      "mixed",
      "badExtensions",
      "local",
      "legacy",
      "userinfo",
      "fragment",
      "plain",
      "relative",
      "loopback",
      "dupHeaders",
      "literalAuth",
    ]) {
      expect(reasons[`mcp.json#${name}`], name).toBeDefined();
    }
    expect(reasons["mcp.json#local"]).toMatch(/not in the plugin/);
    expect(reasons["mcp.json#legacy"]).toMatch(/SSE/);
    expect(reasons["mcp.json#literalAuth"]).toMatch(/Authorization/);
  });

  it("treats server extensions as an unknown field in 1.0.0", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }, PLUGIN_1_0),
      aSkill,
      mcp(
        {
          withExtensions: {
            type: "streamable-http",
            url: "https://w.example.com/mcp",
            extensions: { "com.example.client": {} },
          },
          plain: { type: "streamable-http", url: "https://p.example.com/mcp" },
        },
        MCP_1_0,
      ),
    ]);
    expect(bundle.manifest.mcpServers.map(({ name }) => name)).toEqual([
      "plain",
    ]);
    expect(skippedPaths(bundle.manifest.skipped)).toContain(
      "mcp.json#withExtensions",
    );
  });

  it("reads a Claude Code plugin whose root plugin.json is another tool's", async () => {
    const bundle = await parsed([
      { name: "plugin.json", content: JSON.stringify({ name: "Other Tool" }) },
      {
        name: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "claude-side" }),
      },
      aSkill,
    ]);
    expect(bundle.manifest).toMatchObject({
      format: "claude-code",
      name: "claude-side",
      skills: [{ name: "review" }],
    });
  });

  it("reads a package for both formats as Agent Plugins", async () => {
    const bundle = await parsed([
      manifest({ name: "dual" }),
      {
        name: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "claude-side" }),
      },
      aSkill,
    ]);
    expect(bundle.manifest).toMatchObject({
      format: "agent-plugins",
      name: "dual",
    });
  });

  it("still rejects an unsupported version beside Claude Code files", async () => {
    expect(
      await rejected([
        manifest(
          { name: "x" },
          "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
        ),
        { name: ".claude-plugin/plugin.json", content: "{}" },
        aSkill,
      ]),
    ).toMatch(/version/);
  });

  it("skips a skill whose name is not lowercase, even when it matches its folder", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      aSkill,
      { name: "skills/Deploy/SKILL.md", content: skill("Deploy") },
    ]);
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(skippedPaths(bundle.manifest.skipped)).toContain(
      "skills/Deploy/SKILL.md",
    );
  });

  it("skips a server whose header value holds a control character", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      aSkill,
      mcp({
        control: {
          type: "streamable-http",
          url: "https://c.example.com/mcp",
          headers: { "X-Key": "a\u0001b" },
        },
      }),
    ]);
    expect(bundle.manifest.mcpServers).toEqual([]);
    expect(skippedPaths(bundle.manifest.skipped)).toContain("mcp.json#control");
  });

  it("rejects a package with nothing dx can import", async () => {
    expect(
      await rejected([
        manifest({ name: "p" }),
        mcp({ legacy: { type: "sse", url: "https://l.example.com/sse" } }),
      ]),
    ).toMatch(/nothing dx can import/);
  });

  it("gives the same package the same integrity, and a different one for any change", async () => {
    const entries = [manifest({ name: "p" }), aSkill];
    const first = await parsed(entries);
    expect((await parsed(entries)).integrity).toBe(first.integrity);
    const changed = await parsed([
      manifest({ name: "p", description: "changed" }),
      aSkill,
    ]);
    expect(changed.integrity).not.toBe(first.integrity);
  });
});

// Local (stdio) servers, §7.2.1 and Appendix A. Ways one can be malformed or
// hostile, each covered below:
// - a command that is a shell string, holds a variable, is an absolute or
//   other path that is not `./`, or names a `./` file the package lacks,
//   one outside it, or a symlink dx would not copy;
// - control or direction characters that make the reviewed command line
//   read differently from what runs;
// - args or env of the wrong type, env that sets PLUGIN_ROOT or
//   PLUGIN_DATA, or an invalid variable name;
// - a cwd that is not `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}` rooted,
//   or that climbs out with `..`;
// - a package whose files change without its manifest changing, which must
//   still change the integrity people review;
// - a package with only remote servers, which must keep no files.
describe("readPluginBundle with local (stdio) MCP servers", () => {
  const binary = {
    name: "bin/validator",
    content: "#!/bin/sh\necho hi\n",
    executable: true,
  };

  it("imports the spec's example stdio server and keeps the plugin's files", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      binary,
      { name: "config.json", content: "{}" },
      mcp({
        "local-validator": {
          type: "stdio",
          command: "./bin/validator",
          args: ["--data", `${variable("PLUGIN_DATA")}/validator`],
          env: {
            CONFIG: `${variable("PLUGIN_ROOT")}/config.json`,
            OTHER: `${variable("HOME")}`,
          },
          cwd: `${variable("PLUGIN_ROOT")}`,
        },
        npx: { type: "stdio", command: "npx", args: ["-y", "pkg"] },
      }),
    ]);
    expect(bundle.manifest.mcpServers).toEqual([
      {
        transport: "stdio",
        name: "local-validator",
        command: "./bin/validator",
        args: ["--data", `${variable("PLUGIN_DATA")}/validator`],
        env: [
          { name: "CONFIG", value: `${variable("PLUGIN_ROOT")}/config.json` },
          // Agent Plugins expands only its two names and leaves the rest.
          { name: "OTHER", value: `${variable("HOME")}` },
        ],
        cwd: `${variable("PLUGIN_ROOT")}`,
      },
      {
        transport: "stdio",
        name: "npx",
        command: "npx",
        args: ["-y", "pkg"],
        env: [],
      },
    ]);
    expect(bundle.manifest.package?.files).toBe(4);
    expect(bundle.packageBytes).toBeDefined();
    const text = new TextDecoder().decode(bundle.packageBytes);
    expect(text.startsWith("DXPK1\n")).toBe(true);
    expect(text).toContain("bin/validator");
    expect(text).toContain("echo hi");
  });

  it("skips stdio entries that break §7.2.1, and keeps the rest", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      binary,
      aSkill,
      mcp({
        shell: { type: "stdio", command: "node server.js" },
        variable: {
          type: "stdio",
          command: `${variable("PLUGIN_ROOT")}/bin/validator`,
        },
        absolute: { type: "stdio", command: "/usr/bin/node" },
        nested: { type: "stdio", command: "bin/validator" },
        missing: { type: "stdio", command: "./bin/missing" },
        escape: { type: "stdio", command: "./../outside" },
        badArgs: { type: "stdio", command: "npx", args: "pkg" },
        badEnv: { type: "stdio", command: "npx", env: { A: 1 } },
        rootEnv: { type: "stdio", command: "npx", env: { PLUGIN_ROOT: "/" } },
        envName: { type: "stdio", command: "npx", env: { "A-B": "x" } },
        cwdHome: { type: "stdio", command: "npx", cwd: "/home/user" },
        cwdClimb: {
          type: "stdio",
          command: "npx",
          cwd: `${variable("PLUGIN_DATA")}/../x`,
        },
        cwdOther: { type: "stdio", command: "npx", cwd: `${variable("HOME")}` },
        bidi: { type: "stdio", command: "npx", args: ["safe\u202etxt.sh"] },
        control: { type: "stdio", command: "npx", env: { A: "x\u001b[2K" } },
        linked: { type: "stdio", command: "./bin/link" },
        good: { type: "stdio", command: "npx", cwd: "./bin" },
      }),
      { name: "bin/link", content: "validator", symlink: true },
    ]);
    expect(bundle.manifest.mcpServers.map(({ name }) => name)).toEqual([
      "good",
    ]);
    const skipped = skippedPaths(bundle.manifest.skipped);
    for (const name of [
      "shell",
      "variable",
      "absolute",
      "nested",
      "missing",
      "escape",
      "badArgs",
      "badEnv",
      "rootEnv",
      "envName",
      "cwdHome",
      "cwdClimb",
      "cwdOther",
      "bidi",
      "control",
      "linked",
    ]) {
      expect(skipped, name).toContain(`mcp.json#${name}`);
    }
  });

  it("changes the integrity when only a packaged file changes", async () => {
    const entries = (content: string) => [
      manifest({ name: "p" }),
      { ...binary, content },
      mcp({ v: { type: "stdio", command: "./bin/validator" } }),
    ];
    const first = await parsed(entries("one"));
    expect((await parsed(entries("one"))).integrity).toBe(first.integrity);
    expect((await parsed(entries("two"))).integrity).not.toBe(first.integrity);
  });

  it("keeps no files for a package with only remote servers", async () => {
    const bundle = await parsed([
      manifest({ name: "p" }),
      binary,
      mcp({ r: { type: "streamable-http", url: "https://r.example.com/mcp" } }),
    ]);
    expect(bundle.manifest.package).toBeUndefined();
    expect(bundle.packageBytes).toBeUndefined();
  });
});
