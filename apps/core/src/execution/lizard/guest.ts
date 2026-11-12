import type {
  OrbExecOptions,
  OrbExecResult,
  OrbGuestClient,
} from "../guest/orb-guest-client.js";
import type { VmOrbBuildGuest } from "../guest/vm-orb-recipe.js";
import { type LizardApi, LizardApiError, MAX_COMMAND_MS } from "./api.js";

/** The Orb's workspace account (deploy/orb/install.sh, and the template's). */
const ORB_USER = "user";
/** An Orb command gets E2B's 5 minutes unless it asks for another limit. */
const DEFAULT_TIMEOUT_MS = 300_000;
const FILE_COMMAND_MS = 120_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One `sh` script with positional arguments, as one command line. */
const script = (body: string, ...args: ReadonlyArray<string>) =>
  ["sh", "-c", quote(body), "sh", ...args.map(quote)].join(" ");

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.trim()), (character) => character.charCodeAt(0));

/**
 * Lizard answers a command that outlived its limit with exit code -1
 * (`exec_outcome_unknown`): the Orb sees a timeout.
 */
const exitOf = (exitCode: number) => (exitCode < 0 ? 124 : exitCode);

/**
 * One Lizard sandbox as an Orb guest. Lizard runs a command line with
 * `/bin/sh -c`; every command runs as the workspace account `user` in a
 * login shell (`bash -l`, as E2B and Boat do), and every file write through
 * Lizard's file API is `user`'s too. A path `user` may not write is staged
 * in its home and copied into place with `sudo`.
 */
export const lizardGuestClient = (
  api: LizardApi,
  sandbox: string,
): OrbGuestClient => {
  const exec = async (
    command: string,
    options: OrbExecOptions = {},
  ): Promise<OrbExecResult> => {
    const lines: Array<string> = [];
    if (options.cwd !== undefined)
      lines.push(`cd -- ${quote(options.cwd)} || exit 1`);
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (!ENV_NAME.test(name))
        throw new Error(`Invalid environment variable name: ${name}`);
      lines.push(`export ${name}=${quote(value)}`);
    }
    lines.push(command);
    const result = await api.exec(
      sandbox,
      `exec bash -l -c ${quote(lines.join("\n"))}`,
      {
        user: ORB_USER,
        // Lizard needs a workdir that exists for a named user.
        workdir: "/home/user",
        timeoutMs: Math.min(
          MAX_COMMAND_MS,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ),
      },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: exitOf(result.exitCode),
      timedOut: result.exitCode < 0,
    };
  };
  const checked = async (operation: string, command: string) => {
    const result = await api.exec(sandbox, command, {
      user: ORB_USER,
      workdir: "/home/user",
      timeoutMs: FILE_COMMAND_MS,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Orb ${operation} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  };
  /**
   * Writes into the workspace account's home as `user`, then copies into
   * place as root. Not /tmp: Lizard's file API cannot write there as
   * `user` on an Orb (seen 2026-11-10).
   */
  const staged = async (path: string, content: Uint8Array) => {
    const temporary = `/home/user/.cache/dx-upload/${crypto.randomUUID()}`;
    await api.writeFile(sandbox, temporary, content, ORB_USER);
    await checked(
      "writeFile",
      `sudo -n ${script('mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" >"$2"; status=$?; rm -f -- "$1"; exit $status', temporary, path)}`,
    );
  };
  return {
    exec,
    readFile: (path) => api.readFile(sandbox, path),
    async writeFile(path, content) {
      await api
        .writeFile(sandbox, path, content, ORB_USER)
        .catch((cause: unknown) => {
          // A path `user` may not write.
          if (cause instanceof LizardApiError && cause.status === 403)
            return staged(path, content);
          throw cause;
        });
    },
    async stat(path) {
      const [link, type] = (
        await checked(
          "stat",
          script(
            'if [ -L "$1" ]; then l=1; else l=0; fi; t=$(stat -L -c %F -- "$1") || exit 1; printf "%s\\n%s" "$l" "$t"',
            path,
          ),
        )
      ).split("\n");
      return {
        isFile: type === "regular file" || type === "regular empty file",
        isDirectory: type === "directory",
        isSymbolicLink: link === "1",
      };
    },
    async readdir(path) {
      // NUL-separated names, in base64 so any name survives the JSON answer.
      const listed = await checked(
        "readdir",
        script(
          'test -d "$1" || { echo "not a directory: $1" >&2; exit 1; }; find "$1" -mindepth 1 -maxdepth 1 -printf "%f\\0" | base64 -w0',
          path,
        ),
      );
      return new TextDecoder()
        .decode(fromBase64(listed))
        .split("\0")
        .filter((name) => name.length > 0);
    },
    async exists(path) {
      const result = await api.exec(
        sandbox,
        script('test -e "$1" || test -L "$1"', path),
        { user: ORB_USER, workdir: "/home/user", timeoutMs: FILE_COMMAND_MS },
      );
      return result.exitCode === 0;
    },
    async mkdir(path) {
      await checked("mkdir", script('exec mkdir -p -- "$1"', path));
    },
    async rm(path, options) {
      const flags = `${options?.recursive === true ? "r" : ""}${options?.force === true ? "f" : ""}`;
      await checked(
        "rm",
        script(
          flags === "" ? 'exec rm -- "$1"' : `exec rm -${flags} -- "$1"`,
          path,
        ),
      );
    },
  };
};

/**
 * A sandbox preparation is building: commands as root (Lizard's default
 * user) and files written by root through the file API.
 */
export const lizardBuildGuest = (
  api: LizardApi,
  sandbox: string,
): VmOrbBuildGuest => ({
  async runAsRoot(command, timeoutMs) {
    const result = await api.exec(sandbox, command, {
      timeoutMs: Math.min(MAX_COMMAND_MS, timeoutMs),
    });
    return { stdout: result.stdout, exitCode: exitOf(result.exitCode) };
  },
  async writeFile(path, content) {
    await api.writeFile(sandbox, path, new TextEncoder().encode(content));
  },
});
