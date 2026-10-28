import type {
  OrbExecOptions,
  OrbExecResult,
  OrbGuestClient,
} from "../guest/orb-guest-client.js";
import type { DockerSandboxEndpoint } from "./api.js";

/** The Orb's workspace account (deploy/orb/Dockerfile). */
export const ORB_USER = "user";
/** An Orb command gets E2B's 5 minutes unless it asks for another limit. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** The request outlives the command's own `timeout` by this much. */
const REQUEST_GRACE_MS = 30_000;
/**
 * Exec takes no stdin, so a file up to this size goes in base64 as one
 * argument (Linux caps one at 128 KiB); a larger one through the file API.
 */
const ARGUMENT_LIMIT = 64 * 1024;
/** `timeout` exits with this when the command ran out of time. */
const TIMED_OUT = 124;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const missing = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: "ENOENT",
  });

/**
 * One Docker sandbox as an Orb guest. Commands and every write run as
 * `user`, so files land owned by the workspace account. Exec has no
 * timeout of its own, so each command runs under coreutils `timeout`.
 */
export const dockerGuestClient = (
  endpoint: DockerSandboxEndpoint,
): OrbGuestClient => {
  const exec = async (
    command: string,
    options: OrbExecOptions = {},
  ): Promise<OrbExecResult> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const script =
      options.cwd === undefined
        ? command
        : `cd -- ${quote(options.cwd)} || exit 1\n${command}`;
    const result = await endpoint
      .exec({
        cmd: [
          "timeout",
          "--kill-after=5",
          `${Math.max(1, Math.ceil(timeoutMs / 1_000))}`,
          "/bin/bash",
          "-c",
          script,
        ],
        user: ORB_USER,
        ...(options.env === undefined ? {} : { env: options.env }),
        timeoutMs: timeoutMs + REQUEST_GRACE_MS,
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "TimeoutError")
          return undefined;
        throw cause;
      });
    if (result === undefined)
      return { stdout: "", stderr: "", exitCode: TIMED_OUT, timedOut: true };
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.exitCode === TIMED_OUT,
    };
  };
  const checked = async (command: string) => {
    const result = await exec(command, { timeoutMs: 120_000 });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim().slice(0, 300) || command);
  };
  return {
    exec,
    readFile: (path) => endpoint.readFile(path),
    async writeFile(path, content) {
      const target = quote(path);
      const directory = `mkdir -p -- ${quote(parentOf(path))}`;
      if (content.byteLength <= ARGUMENT_LIMIT) {
        await checked(
          `${directory} && printf %s ${base64(content)} | base64 -d >${target}`,
        );
        return;
      }
      // The file API's writes need not be the workspace account's, so a
      // large file is staged and copied into place as `user`.
      const staged = `/tmp/dx-upload-${crypto.randomUUID()}`;
      await endpoint.writeFile(staged, content);
      await checked(
        `${directory} && cat ${staged} >${target}; status=$?; rm -f ${staged} 2>/dev/null || sudo -n rm -f ${staged}; exit $status`,
      );
    },
    async stat(path) {
      const stat = await endpoint.stat(path);
      if (stat === undefined) throw missing(path);
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymlink,
      };
    },
    readdir: (path) => endpoint.list(path),
    exists: async (path) => (await endpoint.stat(path)) !== undefined,
    mkdir: (path) => checked(`mkdir -p -- ${quote(path)}`),
    rm: (path, options) =>
      checked(
        `rm ${options?.recursive === true ? "-r " : ""}${options?.force === true ? "-f " : ""}-- ${quote(path)}`,
      ),
  };
};
