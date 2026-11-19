import type {
  WorkspaceContextSnapshot,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import { parse } from "yaml";

/**
 * Flue's workspace-context snapshot over one guest command, shared by every
 * Orb provider whose guest runs bash and coreutils (E2B, Cloudflare
 * Containers). Moved from the E2B adapter unchanged apart from provider-
 * neutral error messages.
 */

export const WORKSPACE_CONTEXT_TIMEOUT_MS = 30_000;

/**
 * The Orb's user-level skills: dx writes its built-in skills and the
 * Thread's settings skills here, outside the repository, and Flue discovers
 * them after the repository's `.agents/skills` (a sandbox skill directory).
 * Skills the person puts here are discovered too.
 */
export const AGENT_SKILLS_DIRECTORY = "/home/user/.agents/skills";
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
 *   G <directory> <size>  a ~/.agents/skills skill's SKILL.md frontmatter
 *   Q <directory>         a ~/.agents/skills SKILL.md that could not be read
 *   E                     end of records; the contents of every I and S
 *                         record follow in record order
 *
 * Core decodes UTF-8 strictly and declines when the contents' total length
 * does not match the sizes (a file changed between `stat` and `cat`).
 *
 * `~/.agents/skills` sends each SKILL.md's frontmatter only: Flue reads the
 * catalog line from it and rereads SKILL.md on activation, so a large skill
 * neither fills the snapshot nor declines it. A symbolic link there is
 * skipped, not read. When the root is the home directory, its
 * `.agents/skills` is that directory and is read that way. The command's
 * environment names both directories (`workspaceContextEnvironment`).
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
global=\${FLUE_WORKSPACE_CONTEXT_SKILLS-}
case $global in ""|/*) ;; *) decline ;; esac
for directory in .agents .agents/skills; do
  [[ -n $global && \${root%/}/.agents/skills == "$global" ]] && break
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
if [[ -n $global && -d $global && ! -L $global && -r $global && -x $global ]]; then
  frontmatter=$(mktemp -d) || decline
  trap "rm -rf -- $frontmatter" EXIT
  cr=$(printf "\\r")
  globals=("$global"/*)
  (( \${#globals[@]} <= ${WORKSPACE_CONTEXT_SKILL_LIMIT} )) || decline
  index=0
  for skill in "\${globals[@]}"; do
    name=\${skill##*/}
    [[ $name == .* || -L $skill || ! -d $skill ]] && continue
    file=$skill/SKILL.md
    [[ -f $file && ! -L $file ]] || continue
    names+=("$name")
    if [[ -r $file && -r $skill && -x $skill ]]; then
      index=$((index + 1))
      {
        IFS= read -r line || line=
        if [[ $line == --- || $line == ---$cr ]]; then
          printf "%s\\n" "$line"
          while IFS= read -r line; do
            printf "%s\\n" "$line"
            [[ $line == --- || $line == ---$cr ]] && break
          done
        fi
      } < "$file" 2>/dev/null | head -c ${WORKSPACE_CONTEXT_FILE_LIMIT_BYTES} > "$frontmatter/$index"
      tags+=(G); files+=("$frontmatter/$index")
    else
      tags+=(Q)
    fi
  done
fi
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
    if [[ \${tags[index]} == R || \${tags[index]} == Q ]]; then
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
export const workspaceContextCommand = `bash -c '${workspaceContextGuestScript}'`;

/** The workspace-context command's environment for `root`. */
export const workspaceContextEnvironment = (root: string) => ({
  FLUE_WORKSPACE_CONTEXT_ROOT: root,
  FLUE_WORKSPACE_CONTEXT_SKILLS: AGENT_SKILLS_DIRECTORY,
});

const validDirectoryName = (value: string) =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\0");

const protocolError = (detail: string) =>
  new Error(`Workspace-context protocol ${detail}.`);

export const decodeWorkspaceContextSnapshot = (
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
    if (tag === "L" || tag === "R" || tag === "Q") {
      if (!validDirectoryName(name))
        throw protocolError("returned an invalid name");
      if (tag === "L") directoryListing.push(name);
      else records.push({ tag, name });
      continue;
    }
    if (tag !== "I" && tag !== "S" && tag !== "G")
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
    const where =
      record.tag === "G" || record.tag === "Q"
        ? { skillsDirectory: AGENT_SKILLS_DIRECTORY }
        : {};
    if (record.tag === "R" || record.tag === "Q") {
      skillFiles.push({
        kind: "read-error",
        directoryName: record.name,
        errorMessage: "workspace SKILL.md could not be read",
        ...where,
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
    else
      skillFiles.push({
        kind: "file",
        directoryName: record.name,
        content,
        ...where,
      });
  }
  const snapshot = { instructionFiles, skillFiles, directoryListing };
  if (
    utf8.encode(JSON.stringify(snapshot)).byteLength >
    WORKSPACE_CONTEXT_MANIFEST_LIMIT_BYTES
  )
    return declined;
  return snapshot;
};

const frontmatterName = (content: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null) return undefined;
  try {
    const name = parse(match[1] ?? "")?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The snapshot without repository skills whose directory or declared name is
 * reserved, so a repository can never shadow a skill dx provides itself.
 * Skills in `~/.agents/skills` are dx's own or the person's, and stay.
 */
const withoutReservedSkills = (
  snapshot: WorkspaceContextSnapshot,
  reserved: ReadonlySet<string>,
): WorkspaceContextSnapshot => ({
  ...snapshot,
  skillFiles: snapshot.skillFiles.filter((file) => {
    if (file.skillsDirectory !== undefined) return true;
    if (reserved.has(file.directoryName)) return false;
    const name =
      file.kind === "file" ? frontmatterName(file.content) : undefined;
    return name === undefined || !reserved.has(name);
  }),
});

interface SkillDiscoverySandbox {
  readonly cwd: string;
  readdir(path: string): Promise<string[]>;
  resolvePath(path: string): string;
  snapshotWorkspaceContext?(
    root: string,
  ): Promise<WorkspaceContextSnapshotResult>;
}

/**
 * The sandbox as Flue's skill discovery sees it, without repository skills
 * named in `reserved`. Flue lists repository skills from the workspace-context
 * snapshot, or from a readdir of `.agents/skills` when the snapshot declines,
 * and fails a Thread whose repository skill shares a mounted skill's name.
 */
export const withoutRepositorySkills = <Sandbox extends SkillDiscoverySandbox>(
  sandbox: Sandbox,
  reserved: ReadonlySet<string>,
): Sandbox => {
  const skillsDirectory = `${sandbox.cwd.replace(/\/$/, "")}/.agents/skills`;
  // At the home directory the workspace's skills are dx's and the person's.
  if (skillsDirectory === AGENT_SKILLS_DIRECTORY) return sandbox;
  const readdir = async (path: string) => {
    const entries = await sandbox.readdir(path);
    return sandbox.resolvePath(path) === skillsDirectory
      ? entries.filter((entry) => !reserved.has(entry))
      : entries;
  };
  const snapshotWorkspaceContext = sandbox.snapshotWorkspaceContext;
  if (snapshotWorkspaceContext === undefined) return { ...sandbox, readdir };
  return {
    ...sandbox,
    readdir,
    async snapshotWorkspaceContext(root: string) {
      const snapshot = await snapshotWorkspaceContext(root);
      return "kind" in snapshot
        ? snapshot
        : withoutReservedSkills(snapshot, reserved);
    },
  };
};
