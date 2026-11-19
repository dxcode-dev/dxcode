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
 * Skills install into ~/.agents/skills, outside the repository, through a
 * sandbox that skips Changes coordination. Ways that could go wrong, each
 * covered below:
 * 1. ~/.agents/skills is a symbolic link into the repository, so the
 *    uncoordinated install writes repository files Changes never sees.
 * 2. An ancestor (~/.agents) is that link instead.
 * 3. The guard refuses a fresh Orb, where ~/.agents does not exist yet.
 * 4. A refused install leaves the skills uninstalled instead of falling back
 *    to the coordinated sandbox.
 * 5. An install deletes a skill the person put in ~/.agents/skills.
 * 6. A skill dx installed earlier and the Thread no longer has stays, so
 *    the agent keeps offering it.
 * 7. The built-in and settings installs remove each other's skills.
 * 8. An unchanged install rewrites every file on every turn.
 * 9. The old copy under ~/.local/share/dx stays behind.
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
const skill = (name: string) => ({
  files: [{ path: `${name}/SKILL.md`, content: `# ${name}\n` }],
  complete: true,
});

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
    await installSkillFiles(target, "built-in", "v1", load);

    expect(calls).toEqual(["outside:write", "outside:exec"]);
    await expect(
      readFile(join(home, ".agents/skills/example/SKILL.md"), "utf8"),
    ).resolves.toBe("# Example\n");
  });

  it("falls back to the coordinated sandbox when ~/.agents/skills links into the repository", async () => {
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(repository, join(home, ".agents/skills"));

    await installSkillFiles(target, "built-in", "v1", load);

    // The uncoordinated script refused before writing; the coordinated one,
    // whose writes Changes sees, installed the skill.
    expect(calls).toEqual([
      "outside:write",
      "outside:exec",
      "coordinated:write",
      "coordinated:exec",
    ]);
    await expect(
      readFile(join(repository, "example/SKILL.md"), "utf8"),
    ).resolves.toBe("# Example\n");
  });

  it("falls back when an ancestor of ~/.agents/skills links into the repository", async () => {
    await symlink(repository, join(home, ".agents"));

    await installSkillFiles(target, "built-in", "v1", load);

    expect(calls.slice(2)).toEqual(["coordinated:write", "coordinated:exec"]);
  });

  it("leaves the repository unchanged when the uncoordinated install refuses", async () => {
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(repository, join(home, ".agents/skills"));
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
        "built-in",
        "v1",
        load,
      ),
    ).rejects.toThrow("refused");
    // Its script was removed and it staged nothing.
    await expect(readdir(repository)).resolves.toEqual([]);
  });

  it("keeps a skill the person put in ~/.agents/skills", async () => {
    await mkdir(join(home, ".agents/skills/mine"), { recursive: true });
    await writeFile(join(home, ".agents/skills/mine/SKILL.md"), "# Mine\n");

    await installSkillFiles(target, "settings", "v1", async () => skill("pdf"));
    await installSkillFiles(target, "settings", "v2", async () =>
      skill("docx"),
    );

    const skills = join(home, ".agents/skills");
    await expect(readFile(join(skills, "mine/SKILL.md"), "utf8")).resolves.toBe(
      "# Mine\n",
    );
    expect(
      (await readdir(skills)).filter((name) => !name.startsWith(".")).sort(),
    ).toEqual(["docx", "mine"]);
  });

  it("removes only its own group's earlier skills, never one it is told to keep", async () => {
    await installSkillFiles(target, "built-in", "v1", async () =>
      skill("guide"),
    );
    await installSkillFiles(target, "settings", "v1", async () => ({
      files: [...skill("pdf").files, ...skill("notes").files],
      complete: true,
    }));
    // The Thread drops both settings skills; "notes" becomes a built-in.
    await installSkillFiles(
      target,
      "settings",
      "v2",
      async () => skill("docx"),
      ["notes"],
    );

    const names = (await readdir(join(home, ".agents/skills")))
      .filter((name) => !name.startsWith("."))
      .sort();
    expect(names).toEqual(["docx", "guide", "notes"]);
  });

  it("reads one manifest and writes nothing when the installed version matches", async () => {
    await installSkillFiles(target, "built-in", "v1", load);
    calls.length = 0;
    let loaded = false;

    await installSkillFiles(target, "built-in", "v1", async () => {
      loaded = true;
      return { files, complete: true };
    });

    expect(loaded).toBe(false);
    expect(calls).toEqual([]);
  });

  it("removes the copies under ~/.local/share/dx that ~/.agents/skills replaced", async () => {
    for (const directory of ["skills/old", "settings-skills/old"])
      await mkdir(join(home, ".local/share/dx", directory), {
        recursive: true,
      });
    await mkdir(join(home, ".local/share/dx/empty-template"), {
      recursive: true,
    });

    await installSkillFiles(target, "built-in", "v1", load);

    await expect(readdir(join(home, ".local/share/dx"))).resolves.toEqual([
      "empty-template",
    ]);
  });
});
