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
// Base64 of the file contents (bounded by the manifest limit) plus at most
// 512 names of 255 bytes in the record headers.
const WORKSPACE_CONTEXT_OUTPUT_LIMIT_BYTES =
  Math.ceil((WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES + 512 * 1024) / 3) * 4;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Guest side of the workspace-context snapshot: bash and coreutils only (no
 * Python), one command. It walks the root without following symlinks, checks
 * every bound, and prints base64 of NUL-separated records:
 *
 *   D                     declined (Flue falls back to primitive reads)
 *   L <name>              one root directory entry
 *   I <filename> <size>   AGENTS.md or CLAUDE.md with content
 *   S <directory> <size>  a skill's SKILL.md with content
 *   R <directory>         a skill's SKILL.md that could not be read
 *   E                     end of records; the contents of every I and S
 *                         record follow in record order
 *
 * Core decodes UTF-8 strictly and declines when the contents' total length
 * does not match the sizes (a file changed between `stat` and `cat`).
 */
const workspaceContextGuestScript = `
shopt -s nullglob dotglob
decline() { printf "D\\0" | base64 -w0; exit 0; }
root=\${FLUE_WORKSPACE_CONTEXT_ROOT-}
case $root in /*) ;; *) decline ;; esac
case $root in */|*//*|*/./*|*/../*|*/.|*/..) [[ $root == / ]] || decline ;; esac
rest=\${root#/}
path=
while [[ -n $rest ]]; do
  path=$path/\${rest%%/*}
  [[ -d $path && ! -L $path ]] || decline
  [[ $rest == */* ]] && rest=\${rest#*/} || rest=
done
cd -- "$root" 2>/dev/null || decline
tags=(); names=(); files=()
for name in AGENTS.md CLAUDE.md; do
  [[ -L $name ]] && decline
  [[ -e $name ]] || continue
  [[ -f $name && -r $name ]] || decline
  tags+=(I); names+=("$name"); files+=("$name")
done
for directory in .agents .agents/skills; do
  [[ -L $directory ]] && decline
  [[ -e $directory ]] || break
  [[ -d $directory && -r $directory && -x $directory ]] || decline
  [[ $directory == .agents ]] && continue
  skills=(.agents/skills/*)
  (( \${#skills[@]} <= ${WORKSPACE_CONTEXT_SKILL_LIMIT} )) || decline
  for skill in "\${skills[@]}"; do
    [[ -L $skill ]] && decline
    [[ -d $skill ]] || continue
    [[ -r $skill && -x $skill ]] || decline
    file=$skill/SKILL.md
    [[ -L $file ]] && decline
    [[ -e $file ]] || continue
    [[ -f $file ]] || decline
    names+=("\${skill##*/}")
    if [[ -r $file ]]; then tags+=(S); files+=("$file"); else tags+=(R); fi
  done
done
listing=()
if [[ -r . ]]; then
  listing=(*)
  (( \${#listing[@]} <= ${WORKSPACE_CONTEXT_DIRECTORY_LIMIT} )) || decline
fi
sizes=()
if (( \${#files[@]} )); then
  mapfile -t sizes < <(stat -c %s -- "\${files[@]}" 2>/dev/null)
  (( \${#sizes[@]} == \${#files[@]} )) || decline
fi
total=0
for size in "\${sizes[@]}"; do
  (( size <= ${WORKSPACE_CONTEXT_FILE_LIMIT_BYTES} )) || decline
  total=$((total + size))
done
(( total <= ${WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES} )) || decline
{
  for name in "\${listing[@]}"; do printf "L\\0%s\\0" "$name"; done
  next=0
  for index in "\${!tags[@]}"; do
    if [[ \${tags[index]} == R ]]; then
      printf "R\\0%s\\0" "\${names[index]}"
    else
      printf "%s\\0%s\\0%s\\0" "\${tags[index]}" "\${names[index]}" "\${sizes[next]}"
      next=$((next + 1))
    fi
  done
  printf "E\\0"
  (( \${#files[@]} )) && cat -- "\${files[@]}"
} | base64 -w0
`;

if (workspaceContextGuestScript.includes("'"))
  throw new Error("The workspace-context script must not contain quotes.");
const workspaceContextCommand = `bash -c '${workspaceContextGuestScript}'`;

const validDirectoryName = (value: string) =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\0");

const protocolError = (detail: string) =>
  new Error(`E2B workspace-context protocol ${detail}.`);

const decodeWorkspaceContextSnapshot = (
  stdout: string,
): WorkspaceContextSnapshotResult => {
  if (stdout.length > WORKSPACE_CONTEXT_OUTPUT_LIMIT_BYTES)
    throw protocolError("exceeded its size limit");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(stdout.trim()), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw protocolError("returned invalid base64");
  }
  let offset = 0;
  const field = () => {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw protocolError("returned a truncated record");
    const value = bytes.subarray(offset, end);
    offset = end + 1;
    return value;
  };
  const text = (value: Uint8Array) => strictUtf8.decode(value);
  const declined = { kind: "declined" } as const;
  const directoryListing: string[] = [];
  const records: Array<{
    readonly tag: string;
    readonly name: string;
    readonly size?: number;
  }> = [];
  let tag = text(field());
  if (tag === "D") return declined;
  let contentBytes = 0;
  for (; tag !== "E"; tag = text(field())) {
    let name: string;
    try {
      name = text(field());
    } catch {
      return declined;
    }
    if (tag === "L" || tag === "R") {
      if (!validDirectoryName(name))
        throw protocolError("returned an invalid name");
      if (tag === "L") directoryListing.push(name);
      else records.push({ tag, name });
      continue;
    }
    if (tag !== "I" && tag !== "S")
      throw protocolError("returned an unknown record");
    const size = Number(text(field()));
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > WORKSPACE_CONTEXT_FILE_LIMIT_BYTES ||
      (tag === "I"
        ? name !== "AGENTS.md" && name !== "CLAUDE.md"
        : !validDirectoryName(name))
    )
      throw protocolError("returned an invalid file record");
    records.push({ tag, name, size });
    contentBytes += size;
  }
  if (bytes.length - offset !== contentBytes) return declined;
  if (
    directoryListing.length > WORKSPACE_CONTEXT_DIRECTORY_LIMIT ||
    records.filter((record) => record.tag !== "I").length >
      WORKSPACE_CONTEXT_SKILL_LIMIT
  )
    throw protocolError("returned too many entries");
  const instructionFiles: { "AGENTS.md"?: string; "CLAUDE.md"?: string } = {};
  const skillFiles: WorkspaceContextSnapshot["skillFiles"][number][] = [];
  for (const record of records) {
    if (record.tag === "R") {
      skillFiles.push({
        kind: "read-error",
        directoryName: record.name,
        errorMessage: "workspace SKILL.md could not be read",
      });
      continue;
    }
    const size = record.size ?? 0;
    let content: string;
    try {
      content = text(bytes.subarray(offset, offset + size));
    } catch {
      return declined;
    }
    offset += size;
    if (record.tag === "I")
      instructionFiles[record.name as "AGENTS.md" | "CLAUDE.md"] = content;
    else skillFiles.push({ kind: "file", directoryName: record.name, content });
  }
  const snapshot = { instructionFiles, skillFiles, directoryListing };
  if (
    utf8.encode(JSON.stringify(snapshot)).byteLength >
    WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES
  )
    return declined;
  return snapshot;
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
