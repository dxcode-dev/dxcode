import type {
  OrbExecOptions,
  OrbExecResult,
  OrbGuestClient,
} from "../guest/orb-guest-client.js";
import type { VmOrbBuildGuest } from "../guest/vm-orb-recipe.js";
import { type BoatApi, BoatApiError, MAX_COMMAND_SECONDS } from "./api.js";

/** An Orb command gets E2B's 5 minutes unless it asks for another limit. */
const DEFAULT_TIMEOUT_MS = 300_000;
const FILE_COMMAND_SECONDS = 120;
/** The file API reaches only these folders (`invalid_path` elsewhere). */
const FILE_API_ROOTS = ["/home/user/", "/tmp/"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One `sh` script with positional arguments, as one command line. */
const script = (body: string, ...args: ReadonlyArray<string>) =>
  ["sh", "-c", quote(body), "sh", ...args.map(quote)].join(" ");

const throughFileApi = (path: string) =>
  FILE_API_ROOTS.some((root) => path.startsWith(root)) &&
  !path.split("/").includes("..");

const outsideFileApi = (cause: unknown) =>
  cause instanceof BoatApiError &&
  cause.status === 400 &&
  cause.code === "invalid_path";

const seconds = (timeoutMs: number) =>
  Math.min(MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1_000)));

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.trim()), (character) => character.charCodeAt(0));

/**
 * One Boat sandbox as an Orb guest. Boat's agent runs every command as the
 * sandbox account `user` (docs.boat.dev/hosting/firewall), which is the
 * Orb's workspace account; commands run in a login shell, as E2B's do.
 * Files under /home/user and /tmp go through the file API, also as `user`;
 * anything else is staged in /tmp and copied into place by a command.
 */
export const boatGuestClient = (
  api: BoatApi,
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
    const result = await api.command(
      sandbox,
      `bash -l -c ${quote(lines.join("\n"))}`,
      seconds(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 137),
      timedOut: result.timedOut,
    };
  };
  const checked = async (operation: string, command: string) => {
    const result = await api.command(sandbox, command, FILE_COMMAND_SECONDS);
    if (result.exitCode !== 0)
      throw new Error(
        `Orb ${operation} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  };
  /** Writes through /tmp, then copies into place as `user`. */
  const staged = async (path: string, content: Uint8Array) => {
    const temporary = `/tmp/dx-upload-${crypto.randomUUID()}`;
    await api.writeFile(sandbox, temporary, content);
    await checked(
      "writeFile",
      script(
        'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" >"$2"; status=$?; rm -f -- "$1"; exit $status',
        temporary,
        path,
      ),
    );
  };
  const readThroughCommand = async (path: string) =>
    fromBase64(
      await checked("readFile", script('exec base64 -w0 -- "$1"', path)),
    );
  return {
    exec,
    async readFile(path) {
      if (!throughFileApi(path)) return readThroughCommand(path);
      return api.readFile(sandbox, path).catch((cause: unknown) => {
        if (outsideFileApi(cause)) return readThroughCommand(path);
        throw cause;
      });
    },
    async writeFile(path, content) {
      if (!throughFileApi(path)) return staged(path, content);
      await api.writeFile(sandbox, path, content).catch((cause: unknown) => {
        // A symlink that leads out of /home/user and /tmp.
        if (outsideFileApi(cause)) return staged(path, content);
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
      const result = await api.command(
        sandbox,
        script('test -e "$1" || test -L "$1"', path),
        FILE_COMMAND_SECONDS,
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
 * A sandbox preparation is building: root through the account's
 * passwordless `sudo`, and files staged in /tmp then copied into place.
 */
export const boatBuildGuest = (
  api: BoatApi,
  sandbox: string,
): VmOrbBuildGuest => ({
  async runAsRoot(command, timeoutMs) {
    const result = await api.command(
      sandbox,
      `sudo -n bash -c ${quote(command)}`,
      seconds(timeoutMs),
    );
    return { stdout: result.stdout, exitCode: result.exitCode ?? 124 };
  },
  async writeFile(path, content) {
    const temporary = `/tmp/dx-upload-${crypto.randomUUID()}`;
    await api.writeFile(sandbox, temporary, new TextEncoder().encode(content));
    const result = await api.command(
      sandbox,
      `sudo -n ${script('mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" >"$2"; status=$?; rm -f -- "$1"; exit $status', temporary, path)}`,
      FILE_COMMAND_SECONDS,
    );
    if (result.exitCode !== 0)
      throw new Error(`Writing ${path} into the sandbox failed.`);
  },
});
