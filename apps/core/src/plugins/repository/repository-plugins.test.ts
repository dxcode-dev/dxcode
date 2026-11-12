import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginPackage } from "../../settings/plugins/bundles/plugin-package.js";
import {
  MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES,
  readRepositoryPlugins,
  repositoryPluginsCommand,
} from "./repository-plugins.js";

/**
 * Reading a repository's plugins through the real guest command, in a real
 * Git checkout. What can go wrong, and where each case is checked:
 *
 * - a plugin the agent wrote but did not commit loads ("committed only");
 * - a workspace that is no Git checkout, or has no plugin folder, fails the
 *   read instead of loading nothing ("nothing to read");
 * - one bad folder takes the others down ("a bad folder");
 * - code, skills, or the `.dx/plugins` folder are lost on the way
 *   ("committed only");
 * - a local (stdio) server runs files other than the plugin folder's
 *   committed ones, or files placed outside the plugin root ("stdio").
 */

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

const repository = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "dx-repo-plugins-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
};

const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** A sandbox over the local machine, as an Orb runs the command. */
const sandbox = (cwd: string) => ({
  cwd,
  readdir: async () => [],
  exec: async (command: string, options?: { cwd?: string }) => {
    try {
      const stdout = execFileSync("bash", ["-c", command.slice(9, -1)], {
        cwd: options?.cwd ?? cwd,
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const failed = error as { status?: number; stdout?: Buffer };
      return {
        stdout: failed.stdout?.toString() ?? "",
        stderr: "",
        exitCode: failed.status ?? 1,
      };
    }
  },
});

const manifest = (name: string, extra: object = {}) =>
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
    name,
    displayName: `${name} plugin`,
    version: "1.0.0",
    description: "From the repository.",
    ...extra,
  });

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Use ${name}.\n---\n\nDo the ${name} thing.\n`;

describe("reading a repository's plugins", () => {
  it("runs as one bash -c command", () => {
    expect(repositoryPluginsCommand.startsWith("bash -c '")).toBe(true);
    expect(repositoryPluginsCommand.endsWith("'")).toBe(true);
  });

  it("reads committed plugins only, with their skills and code, from both folders", async () => {
    const root = repository({
      ".agents/plugins/release/plugin.json": manifest("com.acme.release", {
        extensions: {
          "dev.dxcode": { apiVersion: 1, entry: "dev.dxcode/index.js" },
        },
      }),
      ".agents/plugins/release/skills/notes/SKILL.md": skill("notes"),
      ".agents/plugins/release/dev.dxcode/index.js":
        "export default (dx) => dx.registerTool({ name: 'ship', description: 'Ship.', execute: () => 'ok' });",
      ".dx/plugins/lint/plugin.json": manifest("com.acme.lint"),
      ".dx/plugins/lint/skills/lint-rules/SKILL.md": skill("lint-rules"),
      "README.md": "hello",
    });
    // Written by the agent but never committed: it must not load.
    write(root, ".agents/plugins/sneaky/plugin.json", manifest("sneaky"));
    write(root, ".agents/plugins/sneaky/skills/x/SKILL.md", skill("x"));
    // An uncommitted edit to a committed plugin doesn't load either.
    write(
      root,
      ".agents/plugins/release/dev.dxcode/index.js",
      "export default () => { throw new Error('edited'); };",
    );

    const read = await readRepositoryPlugins(sandbox(root));
    expect(read?.root.endsWith(root.slice(root.lastIndexOf("/")))).toBe(true);
    expect(read?.commit).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(read?.skipped).toEqual([]);
    expect(
      read?.plugins.map(({ folder, bundle }) => [
        folder,
        bundle.manifest.name,
        bundle.skills.map(({ manifest: m }) => m.name),
        bundle.codeModules.map(({ path, content }) => [
          path,
          content.includes("ship"),
        ]),
      ]),
    ).toEqual([
      [
        ".agents/plugins/release",
        "com.acme.release",
        ["notes"],
        [["dev.dxcode/index.js", true]],
      ],
      [".dx/plugins/lint", "com.acme.lint", ["lint-rules"], []],
    ]);
  });

  it("loads nothing from a workspace that is no Git checkout or has no plugin folder", async () => {
    const plain = mkdtempSync(join(tmpdir(), "dx-repo-plain-"));
    directories.push(plain);
    expect(await readRepositoryPlugins(sandbox(plain))).toBeUndefined();
    const empty = repository({ "README.md": "hello" });
    expect(await readRepositoryPlugins(sandbox(empty))).toBeUndefined();
  });

  it("says so instead of loading committed plugin folders over the size limit", async () => {
    const root = repository({
      ".agents/plugins/big/plugin.json": manifest("com.acme.big"),
      ".agents/plugins/big/skills/big/SKILL.md": skill("big"),
    });
    // Random bytes don't compress, so the ZIP stays over 4 MiB.
    writeFileSync(
      join(root, ".agents/plugins/big/skills/big/blob.bin"),
      randomBytes(MAX_REPOSITORY_PLUGIN_ARCHIVE_BYTES + 1024),
    );
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "big");
    const read = await readRepositoryPlugins(sandbox(root));
    expect(read?.plugins).toEqual([]);
    expect(read?.skipped[0]?.reason).toMatch(/larger than/);
  });

  it("skips a folder that is not a plugin and keeps the others", async () => {
    const root = repository({
      ".agents/plugins/broken/plugin.json": "{ not json",
      ".agents/plugins/good/plugin.json": manifest("com.acme.good"),
      ".agents/plugins/good/skills/good-skill/SKILL.md": skill("good-skill"),
    });
    const read = await readRepositoryPlugins(sandbox(root));
    expect(read?.plugins.map(({ bundle }) => bundle.manifest.name)).toEqual([
      "com.acme.good",
    ]);
    expect(read?.skipped.map(({ folder }) => folder)).toEqual([
      ".agents/plugins/broken",
    ]);
  });

  it("stdio: keeps a local server's committed files, relative to the plugin", async () => {
    const root = repository({
      ".agents/plugins/tools/plugin.json": manifest("com.acme.tools"),
      ".agents/plugins/tools/bin/server": "#!/bin/sh\necho committed\n",
      ".agents/plugins/tools/mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
        mcpServers: { local: { type: "stdio", command: "./bin/server" } },
      }),
      "README.md": "outside the plugin",
    });
    // An uncommitted edit must not reach the Orb's PLUGIN_ROOT.
    write(root, ".agents/plugins/tools/bin/server", "#!/bin/sh\necho edited\n");

    const read = await readRepositoryPlugins(sandbox(root));
    const bundle = read?.plugins[0]?.bundle;
    expect(bundle?.manifest.mcpServers).toEqual([
      {
        transport: "stdio",
        name: "local",
        command: "./bin/server",
        args: [],
        env: [],
      },
    ]);
    const files = readPluginPackage(bundle?.packageBytes ?? new Uint8Array());
    expect(files.map(({ path }) => path).sort()).toEqual([
      "bin/server",
      "mcp.json",
      "plugin.json",
    ]);
    expect(
      new TextDecoder().decode(
        files.find(({ path }) => path === "bin/server")?.content,
      ),
    ).toContain("committed");
  });
});
