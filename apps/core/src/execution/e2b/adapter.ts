// flue-blueprint: sandbox/e2b@1
// Based on Flue 2.0.7 and extended with its patched workspace-context seam:
// https://github.com/withastro/flue/blob/@flue/runtime@2.0.7/blueprints/sandbox--e2b.md
/**
 * E2B adapter for Flue.
 *
 * Wraps an already-initialized E2B sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the E2B
 * SDK directly — Flue just adapts it.
 */

import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
  WorkspaceContextSnapshot,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  SandboxOperationUnsupportedError,
  sandboxFromDriver,
} from "@flue/runtime";
import type { Sandbox as E2BSandbox } from "e2b";

const WORKSPACE_CONTEXT_TIMEOUT_MS = 30_000;
const WORKSPACE_CONTEXT_FILE_LIMIT_BYTES = 64 * 1024;
// Keep one provider command bounded while allowing hundreds of ordinary skills.
const WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024;
const WORKSPACE_CONTEXT_SKILL_LIMIT = 256;
const WORKSPACE_CONTEXT_DIRECTORY_LIMIT = 256;
const utf8 = new TextEncoder();

const workspaceContextGuestSource = `
import json, os, stat, sys

FILE_LIMIT = ${WORKSPACE_CONTEXT_FILE_LIMIT_BYTES}
MANIFEST_LIMIT = ${WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES}
SKILL_LIMIT = ${WORKSPACE_CONTEXT_SKILL_LIMIT}
DIRECTORY_LIMIT = ${WORKSPACE_CONTEXT_DIRECTORY_LIMIT}
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
READ_ERROR = object()

class Declined(Exception):
    pass

def open_root(path):
    if not path.startswith("/") or os.path.normpath(path) != path:
        raise Declined()
    current = os.open("/", os.O_RDONLY | DIRECTORY)
    try:
        for component in [part for part in path.split("/") if part]:
            next_fd = os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise Declined()

def entries(directory_fd, limit):
    result = []
    with os.scandir(directory_fd) as iterator:
        for entry in iterator:
            result.append(entry.name)
            if len(result) > limit:
                raise Declined()
    return result

def open_directory(parent_fd, name, missing=False, omit_non_directory=False):
    try:
        return os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        if missing:
            return None
        raise Declined()
    except NotADirectoryError:
        try:
            info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError:
            raise Declined()
        if stat.S_ISLNK(info.st_mode):
            raise Declined()
        if omit_non_directory:
            return None
        raise Declined()
    except OSError:
        raise Declined()

def read_regular(parent_fd, name, missing=False, read_error=False):
    try:
        descriptor = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        if missing:
            return None
        raise Declined()
    except PermissionError:
        if read_error:
            return READ_ERROR
        raise Declined()
    except OSError:
        raise Declined()
    try:
        try:
            before = os.fstat(descriptor)
        except OSError:
            if read_error:
                return READ_ERROR
            raise Declined()
        if not stat.S_ISREG(before.st_mode):
            raise Declined()
        raw = b""
        while len(raw) <= FILE_LIMIT:
            try:
                chunk = os.read(descriptor, min(8192, FILE_LIMIT + 1 - len(raw)))
            except OSError:
                if read_error:
                    return READ_ERROR
                raise Declined()
            if not chunk:
                break
            raw += chunk
        try:
            after = os.fstat(descriptor)
        except OSError:
            if read_error:
                return READ_ERROR
            raise Declined()
        if len(raw) > FILE_LIMIT:
            raise Declined()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise Declined()
        try:
            return raw.decode("utf-8", "strict")
        except UnicodeDecodeError:
            raise Declined()
    finally:
        os.close(descriptor)

def snapshot(root):
    root_fd = open_root(root)
    agents_fd = None
    skills_fd = None
    try:
        instructions = {}
        for filename in ("AGENTS.md", "CLAUDE.md"):
            content = read_regular(root_fd, filename, missing=True)
            if content is not None:
                instructions[filename] = content

        skill_files = []
        agents_fd = open_directory(root_fd, ".agents", missing=True)
        if agents_fd is not None:
            skills_fd = open_directory(agents_fd, "skills", missing=True)
        if skills_fd is not None:
            for directory_name in entries(skills_fd, SKILL_LIMIT):
                skill_fd = open_directory(skills_fd, directory_name, omit_non_directory=True)
                if skill_fd is None:
                    continue
                try:
                    content = read_regular(skill_fd, "SKILL.md", missing=True, read_error=True)
                finally:
                    os.close(skill_fd)
                if content is None:
                    continue
                if content is READ_ERROR:
                    skill_files.append({"kind": "read-error", "directoryName": directory_name, "errorMessage": "workspace SKILL.md could not be read"})
                else:
                    skill_files.append({"kind": "file", "directoryName": directory_name, "content": content})

        result = {"kind": "snapshot", "version": 1, "snapshot": {"instructionFiles": instructions, "skillFiles": skill_files}}
        try:
            result["snapshot"]["directoryListing"] = entries(root_fd, DIRECTORY_LIMIT)
        except OSError:
            pass
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MANIFEST_LIMIT:
            raise Declined()
        return encoded
    finally:
        if skills_fd is not None:
            os.close(skills_fd)
        if agents_fd is not None:
            os.close(agents_fd)
        os.close(root_fd)

try:
    output = snapshot(os.environ["FLUE_WORKSPACE_CONTEXT_ROOT"])
except (Declined, KeyError):
    output = b'{"kind":"declined","version":1}'
sys.stdout.buffer.write(output)
`;

const workspaceContextCommand = `python3 -c 'import base64;exec(base64.b64decode("${btoa(
  workspaceContextGuestSource,
)}"))'`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown): value is string =>
  typeof value === "string" &&
  utf8.encode(value).byteLength <= WORKSPACE_CONTEXT_FILE_LIMIT_BYTES;

const validDirectoryName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\0");

const decodeWorkspaceContextSnapshot = (
  stdout: string,
): WorkspaceContextSnapshotResult => {
  if (utf8.encode(stdout).byteLength > WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES)
    throw new Error("E2B workspace-context protocol exceeded its size limit.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error("E2B workspace-context protocol returned invalid JSON.");
  }
  if (!isRecord(decoded) || decoded.version !== 1)
    throw new Error(
      "E2B workspace-context protocol returned an unknown version.",
    );
  if (decoded.kind === "declined") return { kind: "declined" };
  if (decoded.kind !== "snapshot" || !isRecord(decoded.snapshot))
    throw new Error(
      "E2B workspace-context protocol returned an invalid result.",
    );
  const value = decoded.snapshot;
  if (!isRecord(value.instructionFiles) || !Array.isArray(value.skillFiles))
    throw new Error(
      "E2B workspace-context protocol returned an invalid snapshot.",
    );
  const instructionFiles: {
    "AGENTS.md"?: string;
    "CLAUDE.md"?: string;
  } = {};
  for (const filename of ["AGENTS.md", "CLAUDE.md"] as const) {
    const content = value.instructionFiles[filename];
    if (content !== undefined && !boundedString(content))
      throw new Error(
        "E2B workspace-context protocol returned an invalid file.",
      );
    if (content !== undefined) instructionFiles[filename] = content;
  }
  if (value.skillFiles.length > WORKSPACE_CONTEXT_SKILL_LIMIT)
    throw new Error("E2B workspace-context protocol returned too many skills.");
  const skillFiles: WorkspaceContextSnapshot["skillFiles"][number][] = [];
  for (const file of value.skillFiles) {
    if (!isRecord(file) || !validDirectoryName(file.directoryName))
      throw new Error(
        "E2B workspace-context protocol returned an invalid skill.",
      );
    if (file.kind === "file" && boundedString(file.content)) {
      skillFiles.push({
        kind: "file",
        directoryName: file.directoryName,
        content: file.content,
      });
    } else if (
      file.kind === "read-error" &&
      typeof file.errorMessage === "string"
    ) {
      skillFiles.push({
        kind: "read-error",
        directoryName: file.directoryName,
        errorMessage: file.errorMessage,
      });
    } else {
      throw new Error(
        "E2B workspace-context protocol returned an invalid skill.",
      );
    }
  }
  const directoryListing = value.directoryListing;
  if (
    directoryListing !== undefined &&
    (!Array.isArray(directoryListing) ||
      directoryListing.length > WORKSPACE_CONTEXT_DIRECTORY_LIMIT ||
      !directoryListing.every(validDirectoryName))
  )
    throw new Error(
      "E2B workspace-context protocol returned an invalid listing.",
    );
  return {
    instructionFiles,
    skillFiles,
    ...(directoryListing === undefined ? {} : { directoryListing }),
  };
};

/** Implements SandboxDriver by wrapping the E2B v2 TypeScript SDK. */
class E2BSandboxDriver implements SandboxDriver {
  constructor(private sandbox: E2BSandbox) {}

  async snapshotWorkspaceContext(
    root: string,
  ): Promise<WorkspaceContextSnapshotResult> {
    const result = await this.sandbox.commands.run(workspaceContextCommand, {
      envs: { FLUE_WORKSPACE_CONTEXT_ROOT: root },
      timeoutMs: WORKSPACE_CONTEXT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new Error("E2B workspace-context operation failed.");
    return decodeWorkspaceContextSnapshot(result.stdout ?? "");
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.files.read(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.sandbox.files.read(path, { format: "bytes" });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.sandbox.files.write(path, content);
    } else {
      const ab = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      await this.sandbox.files.write(path, ab);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.sandbox.files.getInfo(path);
    const isDirectory = info.type === "dir";
    return {
      isFile: info.type === "file",
      isDirectory,
      isSymbolicLink:
        typeof info.symlinkTarget === "string" && info.symlinkTarget.length > 0,
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.sandbox.files.list(path);
    return entries.map((entry) => entry.name);
  }

  async exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(path);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    await this.sandbox.files.makeDir(path);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const unsupported = [
      options?.recursive ? "recursive" : undefined,
      options?.force ? "force" : undefined,
    ].filter((option): option is string => option !== undefined);
    if (unsupported.length > 0) {
      throw new SandboxOperationUnsupportedError({
        operation: "rm",
        provider: "E2B",
        options: unsupported,
      });
    }
    await this.sandbox.files.remove(path);
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.sandbox.commands.run(command, {
      cwd: options?.cwd,
      envs: options?.env,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  }
}

export const dxSandboxTools: NonNullable<SandboxFactory["tools"]> = (
  sandbox,
) => [
  createReadTool(sandbox),
  createWriteTool(sandbox),
  createEditTool(sandbox),
  createBashTool(sandbox),
];

/** Create a Flue sandbox factory from an initialized E2B sandbox. */
export function e2b(
  sandbox: E2BSandbox,
  sandboxCwd = "/home/user",
): SandboxFactory {
  return {
    async createSandbox(): Promise<Sandbox> {
      const driver = new E2BSandboxDriver(sandbox);
      return sandboxFromDriver(driver, sandboxCwd);
    },
    tools: dxSandboxTools,
  };
}
