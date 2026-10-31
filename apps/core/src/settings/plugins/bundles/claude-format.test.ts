import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readClaudeBundle } from "./claude-format.js";
import { PluginBundleRejected } from "./errors.js";
import { readZipArchive } from "./zip.js";
import { buildZip, type FixtureEntry } from "./zip-fixture.js";

// Ways a Claude Code bundle can be malformed or hostile, each covered below:
// - no plugin at the root, or a marketplace instead of a plugin;
// - a plugin.json that is not JSON or names the plugin badly;
// - manifest paths that leave the plugin folder;
// - stdio, SSE, non-HTTPS, and variable-URL MCP servers;
// - header values read from variables, and reserved headers;
// - agents, hooks, and other components dx does not run;
// - skills without a description, oversize, or with binary resources;
// - commands, which are Claude Code only;
// - duplicate skill names;
// - nothing importable at all.

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
      readClaudeBundle(await zip(entries), {
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

const rejected = async (
  entries: ReadonlyArray<FixtureEntry>,
  options: { readonly root?: string } = {},
) => {
  const result = await parse(entries, options);
  if (result._tag !== "Failure") throw new Error("Expected a rejection.");
  expect(result.failure).toBeInstanceOf(PluginBundleRejected);
  return (result.failure as PluginBundleRejected).reason;
};

const skill = (name: string, description = `Use ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the ${name} thing.\n`;

const examplePlugin: ReadonlyArray<FixtureEntry> = [
  { name: "repo-main/", content: "" },
  {
    name: "repo-main/plugins/example/.claude-plugin/plugin.json",
    content: JSON.stringify({
      name: "example-plugin",
      displayName: "Example Plugin",
      description: "A plugin with every kind of item.",
      version: "1.2.0",
    }),
  },
  {
    name: "repo-main/plugins/example/skills/example-skill/SKILL.md",
    content: skill("example-skill"),
  },
  {
    name: "repo-main/plugins/example/skills/example-skill/reference/notes.md",
    content: "Notes.",
  },
  {
    name: "repo-main/plugins/example/skills/example-skill/scripts/run.py",
    content: "print('never run')",
  },
  {
    name: "repo-main/plugins/example/skills/example-skill/logo.png",
    content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
  },
  {
    name: "repo-main/plugins/example/commands/greet.md",
    content:
      "---\ndescription: Greet someone\nargument-hint: <name>\nallowed-tools: [Bash]\n---\n\nSay hello to $ARGUMENTS.\n",
  },
  {
    name: "repo-main/plugins/example/commands/git/status.md",
    content: "Show the git status.",
  },
  {
    name: "repo-main/plugins/example/.mcp.json",
    content: JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Client": "dx" },
        },
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        },
        local: { command: "npx", args: ["some-server"] },
        streaming: { type: "sse", url: "https://sse.example.com/sse" },
        insecure: { type: "http", url: "http://mcp.example.com/mcp" },
        templated: { type: "http", url: "https://${HOST}/mcp" },
        tokened: {
          type: "http",
          url: "https://tokened.example.com/mcp",
          headers: { "X-Api-Key": "${API_KEY}", Host: "evil.example.com" },
        },
      },
    }),
  },
  {
    name: "repo-main/plugins/example/agents/reviewer.md",
    content: "---\nname: reviewer\n---\nReview.",
  },
  {
    name: "repo-main/plugins/example/hooks/hooks.json",
    content: JSON.stringify({ hooks: { PostToolUse: [] } }),
  },
  { name: "repo-main/plugins/example/README.md", content: "# Example" },
];

describe("readClaudeBundle", () => {
  it("imports skills and remote MCP servers, and lists what it skips", async () => {
    const bundle = await parsed(examplePlugin, { root: "plugins/example" });
    expect(bundle.manifest).toMatchObject({
      format: "claude-code",
      name: "example-plugin",
      displayName: "Example Plugin",
      description: "A plugin with every kind of item.",
      version: "1.2.0",
      skills: [{ name: "example-skill", description: "Use example-skill." }],
      mcpServers: [
        {
          name: "docs",
          endpoint: "https://mcp.example.com/mcp",
          authType: "none",
          headers: [{ name: "X-Client", value: "dx" }],
        },
        {
          name: "github",
          endpoint: "https://api.githubcopilot.com/mcp/",
          authType: "bearer",
          headers: [],
        },
        {
          name: "tokened",
          endpoint: "https://tokened.example.com/mcp",
          authType: "none",
          headers: [],
        },
      ],
    });
    expect(bundle.manifest.skipped).toEqual(
      expect.arrayContaining([
        { path: "agents/", reason: "Agents are not supported yet." },
        {
          path: "commands/",
          reason:
            "Commands are Claude Code only; dx imports skills and MCP servers.",
        },
        { path: "hooks/hooks.json", reason: "Hooks are not supported yet." },
        {
          path: ".mcp.json#local",
          reason: "Local (stdio) MCP servers are not supported.",
        },
        {
          path: ".mcp.json#streaming",
          reason: "dx connects to MCP servers over streamable HTTP only.",
        },
        {
          path: ".mcp.json#insecure",
          reason: "dx connects only to https:// MCP servers on port 443.",
        },
        {
          path: ".mcp.json#templated",
          reason: "The server URL reads a variable.",
        },
        {
          path: ".mcp.json#tokened",
          reason:
            "Header X-Api-Key reads a variable; set it in MCP server settings.",
        },
        {
          path: ".mcp.json#tokened",
          reason: "Header Host is reserved.",
        },
        {
          path: "skills/example-skill/logo.png",
          reason: "The file is not a text resource.",
        },
      ]),
    );
    expect(bundle.skills).toHaveLength(1);
    expect(bundle.skills[0]?.instructions).toBe(
      "# example-skill\n\nDo the example-skill thing.",
    );
    expect(bundle.skills[0]?.resources.map(({ path }) => path)).toEqual([
      "reference/notes.md",
      "scripts/run.py",
    ]);
    expect(bundle.manifest).not.toHaveProperty("commands");
    expect(bundle.version).toMatch(/^1\.2\.0\+[0-9a-f]{12}$/);
    expect(bundle.integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has an integrity that is stable and changes with any content", async () => {
    const first = await parsed(examplePlugin, { root: "plugins/example" });
    const again = await parsed(examplePlugin, { root: "plugins/example" });
    expect(again.integrity).toBe(first.integrity);
    const edited = examplePlugin.map((entry) =>
      entry.name.endsWith("notes.md")
        ? { ...entry, content: "Other notes." }
        : entry,
    );
    const changed = await parsed(edited, { root: "plugins/example" });
    expect(changed.integrity).not.toBe(first.integrity);
  });

  it("names a plugin without a manifest after its folder, and loads a root SKILL.md", async () => {
    const bundle = await parsed([
      { name: "My Tool/SKILL.md", content: skill("my-tool") },
    ]);
    expect(bundle.manifest.name).toBe("fallback-name");
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["my-tool"]);
  });

  it("points at plugin folders when given a marketplace", async () => {
    const reason = await rejected([
      {
        name: "market-main/.claude-plugin/marketplace.json",
        content: JSON.stringify({
          name: "market",
          plugins: [
            { name: "one", source: "./plugins/one" },
            { name: "two", source: { source: "github", repo: "o/two" } },
          ],
        }),
      },
      { name: "market-main/plugins/one/SKILL.md", content: skill("one") },
    ]);
    expect(reason).toMatch(/marketplace/);
    expect(reason).toMatch(/plugins\/one/);
  });

  it("rejects a folder with no plugin", async () => {
    expect(
      await rejected([{ name: "repo-main/src/index.ts", content: "x" }]),
    ).toMatch(/No Claude Code plugin/);
    expect(await rejected(examplePlugin, { root: "plugins/missing" })).toMatch(
      /No Claude Code plugin/,
    );
  });

  it("rejects a plugin.json that is not JSON or names the plugin badly", async () => {
    expect(
      await rejected([
        { name: ".claude-plugin/plugin.json", content: "{" },
        { name: "SKILL.md", content: skill("x") },
      ]),
    ).toMatch(/plugin.json/);
    expect(
      await rejected([
        {
          name: ".claude-plugin/plugin.json",
          content: JSON.stringify({ name: "Bad Name!" }),
        },
        { name: "SKILL.md", content: skill("x") },
      ]),
    ).toMatch(/kebab-case/);
  });

  it("skips manifest paths that leave the plugin folder", async () => {
    const bundle = await parsed(
      [
        {
          name: "p/.claude-plugin/plugin.json",
          content: JSON.stringify({
            name: "p",
            skills: ["../outside/"],
            commands: "/etc/",
            mcpServers: "../../.mcp.json",
          }),
        },
        { name: "p/skills/inside/SKILL.md", content: skill("inside") },
        { name: "outside/SKILL.md", content: skill("outside") },
      ],
      { root: "p" },
    );
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["inside"]);
    expect(bundle.manifest.skipped).toEqual(
      expect.arrayContaining([
        { path: "../outside/", reason: "The path leaves the plugin folder." },
        {
          path: "plugin.json#commands",
          reason:
            "Commands are Claude Code only; dx imports skills and MCP servers.",
        },
        {
          path: "../../.mcp.json",
          reason: "The path leaves the plugin folder.",
        },
      ]),
    );
  });

  it("skips skills without a description, oversize skills, and duplicate names", async () => {
    const bundle = await parsed([
      { name: "skills/good/SKILL.md", content: skill("good") },
      { name: "skills/dupe/SKILL.md", content: skill("good") },
      {
        name: "skills/bare/SKILL.md",
        content: "---\nname: bare\n---\nNo description.",
      },
      {
        name: "skills/huge/SKILL.md",
        content: `${skill("huge")}${"x".repeat(40_000)}`,
      },
      { name: "commands/run.md", content: "Run." },
      { name: "commands/RUN.md", content: "Run again." },
    ]);
    expect(bundle.manifest.skills.map(({ name }) => name)).toEqual(["good"]);
    expect(bundle.manifest.skipped).toEqual(
      expect.arrayContaining([
        {
          path: "skills/dupe/SKILL.md",
          reason: "Another skill is already named good.",
        },
        {
          path: "skills/bare/SKILL.md",
          reason: "SKILL.md has no description.",
        },
        {
          path: "skills/huge/SKILL.md",
          reason: "The instructions are longer than 32,768 bytes.",
        },
      ]),
    );
  });

  it("rejects a bundle with nothing dx can import", async () => {
    expect(
      await rejected([
        {
          name: ".mcp.json",
          content: JSON.stringify({ local: { command: "server" } }),
        },
      ]),
    ).toMatch(/nothing dx can import/);
  });
});
