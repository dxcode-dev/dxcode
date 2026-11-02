import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkillFiles } from "./built-in-skills.js";

/*
 * Skills install outside the repository through a sandbox that skips Changes
 * coordination. Ways that could go wrong, each covered below:
 * 1. ~/.local/share/dx is a symbolic link into the repository, so the
 *    uncoordinated install writes repository files Changes never sees.
 * 2. An ancestor (~/.local) is that link instead.
 * 3. The guard refuses a fresh Orb, where ~/.local/share/dx does not exist yet.
 * 4. A refused install leaves the skills uninstalled instead of falling back
 *    to the coordinated sandbox, as before.
 */

const run = promisify(execFile);

/** A real bash workspace under `home`, as the Orb's `/home/user`. */
const workspace = (home: string, calls: string[], name: string): Sandbox => {
  const local = (path: string) => path.replaceAll("/home/user", home);
  return {
    readFile: (path: string) => readFile(local(path), "utf8"),
    writeFile: async (path: string, content: string) => {
      calls.push(`${name}:write`);
      await mkdir(dirname(local(path)), { recursive: true });
      await writeFile(local(path), content);
    },
    exec: async (command: string) => {
      calls.push(`${name}:exec`);
      try {
        const { stdout, stderr } = await run("bash", ["-c", local(command)], {
          env: { ...process.env, HOME: home },
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failed = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        return {
          exitCode: failed.code,
          stdout: failed.stdout,
          stderr: failed.stderr,
        };
      }
    },
  } as unknown as Sandbox;
};

const files = [{ path: "example/SKILL.md", content: "# Example\n" }];
const load = async () => ({ files, complete: true });

describe("installing skills outside the repository", () => {
  let home: string;
  let repository: string;
  let calls: string[];
  let target: { coordinated: Sandbox; outside: Sandbox };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dx-skills-home-"));
    repository = join(home, "workspace", "repo");
    await mkdir(repository, { recursive: true });
    calls = [];
    target = {
      coordinated: workspace(home, calls, "coordinated"),
      outside: workspace(home, calls, "outside"),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("installs on a fresh Orb without Changes coordination", async () => {
    await installSkillFiles(target, "skills", "v1", load);

    expect(calls).toEqual(["outside:write", "outside:exec"]);
    await expect(
      readFile(join(home, ".local/share/dx/skills/example/SKILL.md"), "utf8"),
    ).resolves.toBe("# Example\n");
  });

  it("falls back to the coordinated sandbox when ~/.local/share/dx links into the repository", async () => {
    await mkdir(join(home, ".local/share"), { recursive: true });
    await symlink(repository, join(home, ".local/share/dx"));

    await installSkillFiles(target, "skills", "v1", load);

    // The uncoordinated script refused before writing; the coordinated one,
    // whose writes Changes sees, installed the skill.
    expect(calls).toEqual([
      "outside:write",
      "outside:exec",
      "coordinated:write",
      "coordinated:exec",
    ]);
    await expect(
      readFile(join(repository, "skills/example/SKILL.md"), "utf8"),
    ).resolves.toBe("# Example\n");
  });

  it("falls back when an ancestor of ~/.local/share/dx links into the repository", async () => {
    await symlink(repository, join(home, ".local"));

    await installSkillFiles(target, "skills", "v1", load);

    expect(calls.slice(2)).toEqual(["coordinated:write", "coordinated:exec"]);
  });

  it("leaves the repository unchanged when the uncoordinated install refuses", async () => {
    await mkdir(join(home, ".local/share"), { recursive: true });
    await symlink(repository, join(home, ".local/share/dx"));
    const refusing = {
      readFile: async () => {
        throw new Error("absent");
      },
      writeFile: async () => undefined,
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "refused" }),
    } as unknown as Sandbox;

    await expect(
      installSkillFiles(
        { coordinated: refusing, outside: target.outside },
        "skills",
        "v1",
        load,
      ),
    ).rejects.toThrow("refused");
    // Its script was removed and it staged nothing.
    await expect(readdir(repository)).resolves.toEqual([]);
  });
});
