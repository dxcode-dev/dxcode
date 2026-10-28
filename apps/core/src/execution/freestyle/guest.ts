import type {
  OrbExecOptions,
  OrbExecResult,
  OrbGuestClient,
} from "../guest/orb-guest-client.js";
import type { VmOrbBuildGuest } from "../guest/vm-orb-recipe.js";
import type { FreestyleApi } from "./api.js";

/** The Orb's workspace account (deploy/orb/vm-setup.sh). */
const ORB_USER = "user";
/** Freestyle's own default is 30 s; an Orb command gets E2B's 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Files up to this size go in on the command's stdin, in one call. */
const STDIN_LIMIT = 512 * 1024;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * One Freestyle VM as an Orb guest. Commands and every write run as `user`,
 * so files land owned by the workspace account; reads go through the file
 * API, which reads a paused VM's disk without waking it.
 */
export const freestyleGuestClient = (
  api: FreestyleApi,
  vm: string,
): OrbGuestClient => {
  const exec = async (
    command: string,
    options: OrbExecOptions & { readonly stdin?: Uint8Array } = {},
  ): Promise<OrbExecResult> => {
    const result = await api.exec(vm, {
      command:
        options.cwd === undefined
          ? command
          : `cd -- ${quote(options.cwd)} || exit 1\n${command}`,
      linuxUser: ORB_USER,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.statusCode ?? 124,
      timedOut: result.statusCode === null,
    };
  };
  const checked = async (command: string, stdin?: Uint8Array) => {
    const result = await exec(command, {
      timeoutMs: 120_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim().slice(0, 300) || command);
  };
  return {
    exec,
    readFile: (path) => api.readFile(vm, path),
    async writeFile(path, content) {
      const target = quote(path);
      const directory = `mkdir -p -- ${quote(parentOf(path))}`;
      if (content.byteLength <= STDIN_LIMIT) {
        await checked(`${directory} && cat >${target}`, content);
        return;
      }
      // Larger files go through the file API, whose writes are not the
      // workspace account's, and are copied into place as `user`.
      const staged = `/tmp/dx-upload-${crypto.randomUUID()}`;
      await api.writeFile(vm, staged, content);
      await checked(
        `${directory} && cat ${staged} >${target}; status=$?; sudo -n rm -f ${staged}; exit $status`,
      );
    },
    async stat(path) {
      const stat = await api.stat(vm, path);
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymlink,
      };
    },
    readdir: (path) => api.readdir(vm, path),
    exists: (path) => api.exists(vm, path),
    mkdir: (path) => checked(`mkdir -p -- ${quote(path)}`),
    rm: (path, options) =>
      checked(
        `rm ${options?.recursive === true ? "-r " : ""}${options?.force === true ? "-f " : ""}-- ${quote(path)}`,
      ),
  };
};

/** A VM preparation is building: root commands and file writes. */
export const freestyleBuildGuest = (
  api: FreestyleApi,
  vm: string,
): VmOrbBuildGuest => ({
  async runAsRoot(command, timeoutMs) {
    const result = await api.exec(vm, {
      command,
      linuxUser: "root",
      timeoutMs,
    });
    return { stdout: result.stdout, exitCode: result.statusCode ?? 124 };
  },
  async writeFile(path, content) {
    const bytes = new TextEncoder().encode(content);
    const result = await api.exec(vm, {
      command: `mkdir -p -- ${quote(parentOf(path))} && cat >${quote(path)}`,
      linuxUser: "root",
      timeoutMs: 60_000,
      stdin: bytes,
    });
    if (result.statusCode !== 0)
      throw new Error(`Writing ${path} into the VM failed.`);
  },
});
