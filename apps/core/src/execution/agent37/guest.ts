import type {
  OrbExecOptions,
  OrbExecResult,
  OrbGuestClient,
} from "../guest/orb-guest-client.js";
import { type Agent37Api, MAX_COMMAND_SECONDS, quote } from "./api.js";

/** An Orb command gets E2B's 5 minutes unless it asks for another limit. */
const DEFAULT_TIMEOUT_MS = 300_000;
const FILE_COMMAND_SECONDS = 120;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Agent37 caps an exec body at 1 MB and each output stream at 512 KB, so
 * files move in base64 pieces below both.
 */
const WRITE_CHUNK_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 360 * 1024;

/** One `sh` script with positional arguments, as one command line. */
const script = (body: string, ...args: ReadonlyArray<string>) =>
  ["sh", "-c", quote(body), "sh", ...args.map(quote)].join(" ");

/** Copies staged file $1 to $2, making its folder. */
const PLACE = 'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" >"$2"';

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.trim()), (character) => character.charCodeAt(0));

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const seconds = (timeoutMs: number) =>
  Math.min(MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1_000)));

/**
 * One Agent37 instance as an Orb guest. The instance runs the dx Orb image,
 * whose default user is the workspace account `user`, so every command
 * runs as `user` in a login shell (`bash -l`, as E2B and Boat do). Agent37
 * has no file API outside its agent templates, so files move through
 * commands: base64 in pieces, staged in /tmp and moved into place, with
 * `sudo` only for a path `user` may not write.
 */
export const agent37GuestClient = (
  api: Agent37Api,
  instance: string,
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
      instance,
      `exec bash -l -c ${quote(lines.join("\n"))}`,
      { timeoutSeconds: seconds(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      // `timeout` (api.ts) ends a command at its limit with 124.
      timedOut: result.exitCode === 124,
    };
  };
  const checked = async (operation: string, command: string) => {
    const result = await api.exec(instance, command, {
      timeoutSeconds: FILE_COMMAND_SECONDS,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Orb ${operation} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  };
  return {
    exec,
    async readFile(path) {
      const size = Number(
        (
          await checked("readFile", script('exec stat -L -c %s -- "$1"', path))
        ).trim(),
      );
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error(`Orb readFile failed: no size for ${path}`);
      const content = new Uint8Array(size);
      for (let offset = 0; offset < size || offset === 0; ) {
        const piece = fromBase64(
          await checked(
            "readFile",
            script(
              'tail -c +"$2" -- "$1" | head -c "$3" | base64 -w0',
              path,
              String(offset + 1),
              String(READ_CHUNK_BYTES),
            ),
          ),
        );
        if (piece.length === 0) break;
        content.set(piece.subarray(0, size - offset), offset);
        offset += piece.length;
      }
      return content;
    },
    async writeFile(path, content) {
      const temporary = `/tmp/dx-upload-${crypto.randomUUID()}`;
      try {
        for (
          let offset = 0;
          offset < content.length || offset === 0;
          offset += WRITE_CHUNK_BYTES
        ) {
          await checked(
            "writeFile",
            script(
              `printf %s "$2" | base64 -d ${offset === 0 ? ">" : ">>"} "$1"`,
              temporary,
              toBase64(content.subarray(offset, offset + WRITE_CHUNK_BYTES)),
            ),
          );
          if (content.length === 0) break;
        }
        // Into place as `user`, else as root for a path `user` may not write.
        await checked(
          "writeFile",
          script(
            `{ ${PLACE}; } 2>/dev/null || sudo -n sh -c '${PLACE}' sh "$1" "$2"`,
            temporary,
            path,
          ),
        );
      } finally {
        await api
          .exec(instance, script('rm -f -- "$1"', temporary), {
            timeoutSeconds: FILE_COMMAND_SECONDS,
          })
          .catch(() => undefined);
      }
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
        instance,
        script('test -e "$1" || test -L "$1"', path),
        { timeoutSeconds: FILE_COMMAND_SECONDS },
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
