import type {
  WorkspaceContextSnapshot,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";

/**
 * Flue's workspace-context snapshot over one guest command, shared by every
 * Orb provider whose guest runs bash and coreutils (E2B, Cloudflare
 * Containers). Moved from the E2B adapter unchanged apart from provider-
 * neutral error messages.
 */

export const WORKSPACE_CONTEXT_TIMEOUT_MS = 30_000;
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
export const workspaceContextCommand = `bash -c '${workspaceContextGuestScript}'`;

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
