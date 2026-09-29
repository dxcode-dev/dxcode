import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
  GITHUB_CLI_WRAPPER_MARKER,
  GITHUB_CLI_WRAPPER_PATH,
  githubCliWrapper,
} from "./cli-wrapper.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const executable = (path: string, content: string) => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

/** Real wrapper, fake `git` credential helper result, and fake real `gh`. */
const workspace = (password: string | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "dx-gh-wrapper-"));
  directories.push(root);
  const wrapperDirectory = join(root, "local-bin");
  const systemDirectory = join(root, "usr-bin");
  mkdirSync(wrapperDirectory);
  mkdirSync(systemDirectory);
  executable(
    join(wrapperDirectory, "gh"),
    githubCliWrapper("owner/repository"),
  );
  executable(
    join(systemDirectory, "git"),
    `#!/bin/sh
test "$1 $2" = "credential fill" || exit 2
input=$(cat)
printf '%s' "$input" > "${root}/credential-request"
printf '%s' "$GIT_TERMINAL_PROMPT:$GIT_CONFIG_GLOBAL" > "${root}/git-environment"
${password === undefined ? "echo 'fatal: could not read Username' >&2; exit 128" : `printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=${password}\\n'`}
`,
  );
  executable(
    join(systemDirectory, "gh"),
    `#!/bin/sh
printf 'token=%s args=%s\\n' "\${GH_TOKEN-}" "$*"
`,
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(join(wrapperDirectory, "gh"), args, {
      encoding: "utf8",
      env: {
        PATH: `${wrapperDirectory}:${systemDirectory}:/usr/bin:/bin`,
        ...env,
      },
    });
  return { root, run };
};

describe("GitHub CLI wrapper", () => {
  it("authenticates the real gh with the helper credential for the bound repository", () => {
    const { root, run } = workspace("ghs_synthetic");
    const result = run(["pr", "create", "--fill"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("token=ghs_synthetic args=pr create --fill\n");
    expect(
      spawnSync("cat", [join(root, "credential-request")], {
        encoding: "utf8",
      }).stdout,
    ).toBe("protocol=https\nhost=github.com\npath=owner/repository.git");
    expect(
      spawnSync("cat", [join(root, "git-environment")], { encoding: "utf8" })
        .stdout,
    ).toBe("0:/home/user/.local/state/dx-terminal/gitconfig");
  });

  it("does not request a credential for version or help output", () => {
    const { root, run } = workspace("ghs_synthetic");
    for (const args of [["--version"], ["help"], []])
      expect(run(args).stdout).toBe(`token= args=${args.join(" ")}\n`);
    expect(
      spawnSync("test", ["-e", join(root, "credential-request")]).status,
    ).toBe(1);
  });

  it("respects an explicitly configured token", () => {
    const { run } = workspace("ghs_synthetic");
    expect(run(["repo", "view"], { GITHUB_TOKEN: "user" }).stdout).toBe(
      "token= args=repo view\n",
    );
    expect(run(["repo", "view"], { GH_TOKEN: "user" }).stdout).toBe(
      "token=user args=repo view\n",
    );
  });

  it("runs unauthenticated with one diagnostic when no credential is available", () => {
    const result = workspace(undefined).run(["auth", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("token= args=auth status\n");
    expect(result.stderr).toBe(
      "dx: GitHub credentials for owner/repository are unavailable; gh is not authenticated.\n",
    );
  });

  it("keeps Git's dx credential helper in place", () => {
    const { run } = workspace("ghs_synthetic");
    const setup = run(["auth", "setup-git"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toBe("");
    const login = run(["auth", "login"]);
    expect(login.status).toBe(1);
    expect(login.stdout).toBe("");
  });

  it("installs idempotently and never replaces a user's gh", () => {
    const install = (existing: string | undefined, repository: string) => {
      const root = mkdtempSync(join(tmpdir(), "dx-gh-install-"));
      directories.push(root);
      const target = join(root, "bin", "gh");
      if (existing !== undefined) {
        mkdirSync(join(root, "bin"));
        writeFileSync(target, existing);
      }
      // E2B runs guest commands as `bash -l -c`, so the dx terminal profile's
      // EXIT trap is inherited; it fails while its history directory is absent.
      const result = spawnSync(
        "bash",
        [
          "-c",
          `trap false EXIT\n${GITHUB_CLI_WRAPPER_INSTALL_COMMAND.replaceAll(
            GITHUB_CLI_WRAPPER_PATH.slice(0, -"/gh".length),
            join(root, "bin"),
          )}`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            DX_GH_WRAPPER: githubCliWrapper(repository),
          },
        },
      );
      expect(result.status).toBe(0);
      expect(
        spawnSync("ls", ["-A", join(root, "bin")], { encoding: "utf8" }).stdout,
      ).toBe("gh\n");
      return {
        content: spawnSync("cat", [target], { encoding: "utf8" }).stdout,
        executable: spawnSync("test", ["-x", target]).status === 0,
      };
    };
    const current = githubCliWrapper("owner/repository");
    expect(install(undefined, "owner/repository")).toEqual({
      content: current,
      executable: true,
    });
    expect(
      install(githubCliWrapper("owner/previous"), "owner/repository").content,
    ).toBe(current);
    expect(install(current, "owner/repository").content).toBe(current);
    // A current but nonexecutable wrapper is repaired.
    expect(install(current, "owner/repository").executable).toBe(true);
    expect(install("#!/bin/sh\necho mine\n", "owner/repository").content).toBe(
      "#!/bin/sh\necho mine\n",
    );
  });

  it("marks the generated file and rejects unsafe repository names", () => {
    expect(githubCliWrapper("owner/repository").split("\n")[1]).toBe(
      GITHUB_CLI_WRAPPER_MARKER,
    );
    for (const repository of ["owner/repo'; id; '", "owner", "a/b/c"])
      expect(() => githubCliWrapper(repository)).toThrow("invalid");
  });
});
