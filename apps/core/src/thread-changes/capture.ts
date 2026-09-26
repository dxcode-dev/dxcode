import {
  THREAD_CHANGES_MAX_COMMITS,
  THREAD_CHANGES_MAX_FILES,
  THREAD_CHANGES_MAX_PATCH_BYTES,
  THREAD_CHANGES_MAX_WORKTREES,
  ThreadChangedFileSchema,
  ThreadChangesCaptureId,
  ThreadChangesCommitSchema,
  ThreadChangesCommitSha,
  ThreadChangesRangeSchema,
  type ThreadChangesWorktreeId,
  ThreadChangesWorktreeSchema,
} from "@dx/api";
import { ThreadId, type ThreadId as ThreadIdType } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Schema } from "effect";
import type { ThreadChangesSource } from "./repository-d1.js";

const CAPTURE_SCHEMA_VERSION = 1 as const;
const CAPTURE_TIMEOUT_MS = 60_000;
const CAPTURE_MAX_OBJECT_BYTES = 8 * 1_024 * 1_024;

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const ThreadChangesCapturedFileSchema = Schema.Struct({
  ...ThreadChangedFileSchema.fields,
  patch: Schema.String,
});

export const ThreadChangesCapturedRangeSchema = Schema.Struct({
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  summary: Schema.Struct({
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
  }),
  files: Schema.Array(ThreadChangesCapturedFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
});

const GuestCaptureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("changed") }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    baseline: ThreadChangesCommitSha,
    head: ThreadChangesCommitSha,
    branch: Schema.NullOr(Schema.String),
    upstreamLabel: Schema.NullOr(Schema.String),
    ahead: NonNegativeInt,
    commits: Schema.Array(ThreadChangesCommitSchema).check(
      Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
    ),
    worktrees: Schema.optional(
      Schema.Array(ThreadChangesWorktreeSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
      ),
    ),
    ranges: Schema.Array(ThreadChangesCapturedRangeSchema).check(
      Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
    ),
  }),
]);

const GuestProbeSchema = Schema.Struct({
  kind: Schema.Literals(["changed", "unchanged"]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export const ThreadChangesManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CAPTURE_SCHEMA_VERSION),
  captureId: ThreadChangesCaptureId,
  threadId: ThreadId,
  generation: NonNegativeInt,
  capturedAt: Schema.String,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  repositoryName: Schema.String,
  defaultBranch: Schema.String,
  baseline: ThreadChangesCommitSha,
  head: ThreadChangesCommitSha,
  branch: Schema.optional(Schema.String),
  upstreamLabel: Schema.optional(Schema.String),
  ahead: NonNegativeInt,
  commits: Schema.Array(ThreadChangesCommitSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
  ),
  worktrees: Schema.optional(
    Schema.Array(ThreadChangesWorktreeSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
    ),
  ),
  ranges: Schema.Array(ThreadChangesCapturedRangeSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
  ),
});
export type ThreadChangesManifest = typeof ThreadChangesManifestSchema.Type;

export const ThreadChangesPatchReferenceSchema = Schema.Struct({
  offset: NonNegativeInt,
  length: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(THREAD_CHANGES_MAX_PATCH_BYTES),
  ),
});
export type ThreadChangesPatchReference =
  typeof ThreadChangesPatchReferenceSchema.Type;

export const ThreadChangesIndexedFileSchema = Schema.Struct({
  ...ThreadChangedFileSchema.fields,
  patch: ThreadChangesPatchReferenceSchema,
});

export const ThreadChangesIndexedRangeSchema = Schema.Struct({
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  summary: Schema.Struct({
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
  }),
  files: Schema.Array(ThreadChangesIndexedFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
});

export const ThreadChangesIndexSchema = Schema.Struct({
  ...ThreadChangesManifestSchema.fields,
  ranges: Schema.Array(ThreadChangesIndexedRangeSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
  ),
});
export type ThreadChangesIndex = typeof ThreadChangesIndexSchema.Type;

export class ThreadChangesCaptureUnavailable extends Schema.TaggedError<ThreadChangesCaptureUnavailable>()(
  "ThreadChangesCaptureUnavailable",
  { stage: Schema.String },
) {}

const guestFingerprintPrelude = String.raw`
import difflib, hashlib, json, os, stat, subprocess, sys

ROOT = os.environ["DX_CHANGES_ROOT"]
DEFAULT_BRANCH = os.environ["DX_CHANGES_DEFAULT_BRANCH"]
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

def git(args, allowed=(0,), binary=True, root=ROOT):
    result = subprocess.run(
        ["git", "-C", root, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=45,
        check=False,
    )
    if result.returncode not in allowed:
        raise RuntimeError("git capture command failed")
    return result.stdout if binary else result.stdout.decode("utf-8", "replace").strip()

def safe_path(value):
    return (
        value
        and len(value) <= 1024
        and not value.startswith("/")
        and not value.endswith("/")
        and "\\" not in value
        and "\x00" not in value
        and all(part not in ("", ".", "..") for part in value.split("/"))
    )

def untracked_paths(root):
    values = git(
        ["ls-files", "--others", "--exclude-standard", "-z"], root=root
    ).split(b"\0")
    return sorted(
        value.decode("utf-8", "strict")
        for value in values
        if value and safe_path(value.decode("utf-8", "strict"))
    )

def update_record(digest, tag, value):
    tag_bytes = tag.encode("ascii")
    value_bytes = value.encode("utf-8", "surrogateescape") if isinstance(value, str) else value
    digest.update(len(tag_bytes).to_bytes(4, "big"))
    digest.update(tag_bytes)
    digest.update(len(value_bytes).to_bytes(8, "big"))
    digest.update(value_bytes)

def discover_worktrees():
    lines = git(["worktree", "list", "--porcelain"]).decode("utf-8", "strict").splitlines()
    records = []
    record = {}
    for line in lines:
        if not line:
            if record:
                records.append(record)
                record = {}
            continue
        key, separator, value = line.partition(" ")
        record[key] = value if separator else True
    if record:
        records.append(record)
    primary_path = os.path.realpath(ROOT)
    candidates = []
    for item in records:
        path = item.get("worktree")
        if not isinstance(path, str) or not os.path.isabs(path):
            raise RuntimeError("invalid worktree path")
        if item.get("bare") is True or item.get("prunable") is not None:
            continue
        real_path = os.path.realpath(path)
        if not os.path.isdir(real_path):
            continue
        candidates.append(real_path)
    if primary_path not in candidates:
        raise RuntimeError("primary worktree missing")
    linked = sorted(path for path in set(candidates) if path != primary_path)
    selected = [primary_path, *linked[: ${THREAD_CHANGES_MAX_WORKTREES} - 1]]
    valid = []
    for real_path in selected:
        top = git(
            ["rev-parse", "--show-toplevel"], allowed=(0, 128), binary=False, root=real_path
        )
        if not top or os.path.realpath(top) != real_path:
            continue
        valid.append(real_path)
    if primary_path not in valid:
        raise RuntimeError("primary worktree missing")
    return [
        {
            "id": "primary" if path == primary_path else "wt_" + hashlib.sha256(
                path.encode("utf-8", "surrogateescape")
            ).hexdigest()[:16],
            "name": (os.path.basename(path) or "workspace")[:256],
            "path": path,
        }
        for path in valid
    ], len(linked) > ${THREAD_CHANGES_MAX_WORKTREES} - 1

def worktree_state(worktree):
    root = worktree["path"]
    head = git(
        ["rev-parse", "--verify", "HEAD"], allowed=(0, 128), binary=False, root=root
    ) or EMPTY_TREE
    branch = git(
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowed=(0, 1),
        binary=False,
        root=root,
    ) or None
    upstream_label = git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        allowed=(0, 128),
        binary=False,
        root=root,
    ) or None
    if upstream_label is None:
        candidate = f"origin/{DEFAULT_BRANCH}"
        verified = git(
            ["rev-parse", "--verify", candidate],
            allowed=(0, 128),
            binary=False,
            root=root,
        )
        upstream_label = candidate if verified else None
    return {
        **worktree,
        "head": head,
        "branch": branch,
        "upstreamLabel": upstream_label,
    }

def fingerprint(untracked_cache=None):
    digest = hashlib.sha256()
    worktrees, truncated = discover_worktrees()
    update_record(digest, "worktrees-truncated", "1" if truncated else "0")
    for worktree in worktrees:
        state = worktree_state(worktree)
        root = state["path"]
        upstream_label = state["upstreamLabel"]
        upstream = (
            git(["rev-parse", "--verify", upstream_label], allowed=(0, 128), root=root)
            if upstream_label is not None
            else b""
        )
        update_record(digest, "worktree", state["id"])
        update_record(digest, "head", state["head"])
        update_record(digest, "branch", state["branch"] or "")
        update_record(digest, "upstream-label", upstream_label or "")
        update_record(digest, "upstream", upstream)
        update_record(
            digest,
            "tracked-diff",
            git(
                ["diff", "--binary", "--no-ext-diff", state["head"], "--"],
                root=root,
            ),
        )
        for path in untracked_paths(root):
            entry = hashlib.sha256()
            update_record(entry, "path", path)
            absolute = os.path.join(root, path)
            info = os.lstat(absolute)
            update_record(entry, "mode", str(info.st_mode))
            if stat.S_ISREG(info.st_mode):
                content = hashlib.sha256()
                prefix = bytearray()
                binary = False
                additions = 0
                last = b""
                with open(absolute, "rb") as handle:
                    while True:
                        chunk = handle.read(65536)
                        if not chunk:
                            break
                        content.update(chunk)
                        if untracked_cache is not None and len(prefix) <= ${THREAD_CHANGES_MAX_PATCH_BYTES}:
                            prefix.extend(chunk[: ${THREAD_CHANGES_MAX_PATCH_BYTES} + 1 - len(prefix)])
                        binary = binary or b"\0" in chunk
                        additions += chunk.count(b"\n")
                        last = chunk[-1:]
                if untracked_cache is not None:
                    untracked_cache[(root, path)] = (
                        bytes(prefix), binary, additions, last
                    )
                update_record(entry, "kind", "regular")
                update_record(entry, "content", content.digest())
            elif stat.S_ISLNK(info.st_mode):
                update_record(entry, "kind", "symlink")
                update_record(entry, "target", os.readlink(absolute))
            else:
                update_record(entry, "kind", "other")
            update_record(digest, "untracked", entry.digest())
    return digest.hexdigest()
`;

const guestProbeSource = `${guestFingerprintPrelude}${`
expected = os.environ["DX_CHANGES_EXPECTED_FINGERPRINT"]
observed = fingerprint()
kind = "changed"
if observed == expected:
    confirmed = fingerprint()
    if confirmed == expected:
        kind = "unchanged"
    else:
        observed = confirmed
sys.stdout.write(json.dumps({"kind": kind, "fingerprint": observed}, separators=(",", ":")))
`}`;

const guestSource = `${guestFingerprintPrelude}${String.raw`
BASELINE = os.environ["DX_CHANGES_BASELINE"]
MAX_FILES = ${THREAD_CHANGES_MAX_FILES}
MAX_COMMITS = ${THREAD_CHANGES_MAX_COMMITS}
MAX_PATCH_BYTES = ${THREAD_CHANGES_MAX_PATCH_BYTES}
MAX_PATCH_LINES = 10000
MAX_OBJECT_BYTES = ${CAPTURE_MAX_OBJECT_BYTES}

def limited_patch(value):
    encoded = value.encode("utf-8")
    truncated = len(encoded) > MAX_PATCH_BYTES
    if truncated:
        value = encoded[:MAX_PATCH_BYTES].decode("utf-8", "ignore")
    lines = value.splitlines(keepends=True)
    if len(lines) > MAX_PATCH_LINES:
        value = "".join(lines[:MAX_PATCH_LINES])
        truncated = True
    return value, truncated

def untracked_file(root, path):
    absolute = os.path.join(root, path)
    try:
        info = os.lstat(absolute)
        if not stat.S_ISREG(info.st_mode):
            return True, 0, "", False
        captured = untracked_cache.get((root, path))
        if captured is None:
            with open(absolute, "rb") as handle:
                content = handle.read(MAX_PATCH_BYTES + 1)
                binary = b"\0" in content
                additions = content.count(b"\n")
                last = content[-1:] if content else b""
                while True:
                    chunk = handle.read(65536)
                    if not chunk:
                        break
                    binary = binary or b"\0" in chunk
                    additions += chunk.count(b"\n")
                    last = chunk[-1:]
            captured = (content, binary, additions, last)
            untracked_cache[(root, path)] = captured
    except FileNotFoundError:
        sys.stdout.write(json.dumps({"kind": "changed"}, separators=(",", ":")))
        raise SystemExit(0)
    content, binary, additions, last = captured
    if binary:
        return True, 0, "", len(content) > MAX_PATCH_BYTES
    if last and last != b"\n":
        additions += 1
    text = content.decode("utf-8", "replace")
    patch = "".join(
        difflib.unified_diff(
            [],
            text.splitlines(keepends=True),
            fromfile="/dev/null",
            tofile=f"b/{path}",
        )
    )
    patch, truncated = limited_patch(patch)
    return False, additions, patch, truncated or len(content) > MAX_PATCH_BYTES

def diff_args(base, target):
    return [base] if target is None else [base, target]

def changed_paths(root, base, target):
    values = git([
        "diff", "--name-status", "-z", "--no-renames", "--no-ext-diff",
        *diff_args(base, target), "--"
    ], root=root).split(b"\0")
    statuses = {}
    index = 0
    while index + 1 < len(values):
        status_value = values[index]
        path_value = values[index + 1]
        index += 2
        if not status_value or not path_value:
            continue
        path = path_value.decode("utf-8", "strict")
        if not safe_path(path):
            raise RuntimeError("unsafe git path")
        code = status_value.decode("ascii", "strict")[:1]
        statuses[path] = "added" if code == "A" else "deleted" if code == "D" else "modified"
    return statuses

def numstats(root, base, target):
    values = git([
        "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff",
        *diff_args(base, target), "--"
    ], root=root).split(b"\0")
    result = {}
    for value in values:
        if not value:
            continue
        parts = value.decode("utf-8", "strict").split("\t", 2)
        if len(parts) != 3 or not safe_path(parts[2]):
            continue
        binary = parts[0] == "-" or parts[1] == "-"
        result[parts[2]] = (
            0 if binary else int(parts[0]),
            0 if binary else int(parts[1]),
            binary,
        )
    return result

def capture_range(worktree, kind, base, target, include_untracked, limit):
    root = worktree["path"]
    statuses = changed_paths(root, base, target)
    stats = numstats(root, base, target)
    if include_untracked:
        for path in untracked_paths(root):
            statuses.setdefault(path, "untracked")
    paths = sorted(statuses)
    files = []
    total_additions = 0
    total_deletions = 0
    untracked = {}
    for index, path in enumerate(paths):
        status_value = statuses[path]
        if status_value == "untracked":
            captured_untracked = untracked_file(root, path)
            additions = captured_untracked[1]
            if index < limit:
                untracked[path] = captured_untracked
        else:
            additions, deletions, _ = stats.get(path, (0, 0, False))
            total_deletions += deletions
        total_additions += additions
    for path in paths[:limit]:
        status_value = statuses[path]
        if status_value == "untracked":
            binary, additions, patch, truncated = untracked[path]
            deletions = 0
        else:
            additions, deletions, binary = stats.get(path, (0, 0, False))
            raw_patch = git([
                "diff", "--no-color", "--no-ext-diff", "--unified=3", "--no-renames",
                *diff_args(base, target), "--", path
            ], root=root).decode("utf-8", "replace")
            patch, truncated = limited_patch("" if binary else raw_patch)
        files.append({
            "worktree": worktree["id"],
            "path": path,
            "status": status_value,
            "additions": additions,
            "deletions": deletions,
            "binary": binary,
            "truncated": truncated,
            "patch": patch,
        })
    return {
        "range": kind,
        "truncated": len(paths) > limit,
        "summary": {
            "additions": total_additions,
            "deletions": total_deletions,
            "files": len(paths),
        },
        "files": files,
    }

def combine_ranges(kind, states, base_for, include_untracked, worktrees_truncated):
    files = []
    additions = 0
    deletions = 0
    file_count = 0
    truncated = worktrees_truncated
    for state in states:
        captured = capture_range(
            state,
            kind,
            base_for(state),
            None,
            include_untracked,
            max(0, MAX_FILES - len(files)),
        )
        files.extend(captured["files"])
        additions += captured["summary"]["additions"]
        deletions += captured["summary"]["deletions"]
        file_count += captured["summary"]["files"]
        truncated = truncated or captured["truncated"]
    return {
        "range": kind,
        "truncated": truncated,
        "summary": {"additions": additions, "deletions": deletions, "files": file_count},
        "files": files,
    }

def commit_list(head, root=ROOT):
    commit_range = head if BASELINE == EMPTY_TREE else f"{BASELINE}..{head}"
    raw = git([
        "log", "-z", f"--max-count={MAX_COMMITS}", "--format=%H%x1f%h%x1f%s",
        commit_range
    ], root=root)
    commits = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        parts = record.decode("utf-8", "replace").split("\x1f", 2)
        if len(parts) == 3:
            commits.append({"sha": parts[0], "shortSha": parts[1], "subject": parts[2][:512] or "(no subject)"})
    return commits

def commit_parent(sha, root=ROOT):
    values = git(
        ["rev-list", "--parents", "-n", "1", sha], binary=False, root=root
    ).split()
    return values[1] if len(values) > 1 else EMPTY_TREE

def prune(result):
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) <= MAX_OBJECT_BYTES:
        return result
    patches = sorted(
        (file for item in result["ranges"] for file in item["files"]),
        key=lambda file: len(file["patch"].encode("utf-8")),
        reverse=True,
    )
    for file in patches:
        file["patch"] = ""
        file["truncated"] = True
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) <= MAX_OBJECT_BYTES:
            return result
    raise RuntimeError("capture exceeds object limit")

if len(BASELINE) != 40 or any(character not in "0123456789abcdef" for character in BASELINE):
    raise RuntimeError("invalid baseline")
if BASELINE != EMPTY_TREE:
    git(["cat-file", "-e", f"{BASELINE}^{{commit}}"])
untracked_cache = {}
before = os.environ.get("DX_CHANGES_EXPECTED_FINGERPRINT") or fingerprint(untracked_cache)
if len(before) != 64 or any(character not in "0123456789abcdef" for character in before):
    raise RuntimeError("invalid expected fingerprint")
worktree_values, worktrees_truncated = discover_worktrees()
states = [worktree_state(worktree) for worktree in worktree_values]
primary = states[0]
head = primary["head"]
branch = primary["branch"]
upstream_label = primary["upstreamLabel"]
if head == EMPTY_TREE:
    ahead_value = "0"
    commits = []
else:
    ahead_base = upstream_label or BASELINE
    ahead_range = head if ahead_base == EMPTY_TREE else f"{ahead_base}..{head}"
    ahead_value = git(["rev-list", "--count", ahead_range], binary=False)
    commits = commit_list(head)
ranges_all_bases = {}
for state in states:
    if state["id"] == "primary":
        ranges_all_bases[state["id"]] = BASELINE
    elif state["head"] == EMPTY_TREE:
        ranges_all_bases[state["id"]] = EMPTY_TREE
    elif BASELINE == EMPTY_TREE:
        ranges_all_bases[state["id"]] = EMPTY_TREE
    else:
        merge_base = git(
            ["merge-base", BASELINE, state["head"]],
            allowed=(0, 1),
            binary=False,
            root=state["path"],
        )
        ranges_all_bases[state["id"]] = merge_base or EMPTY_TREE
ranges = [
    combine_ranges(
        {"kind": "all"}, states, lambda state: ranges_all_bases[state["id"]], True,
        worktrees_truncated,
    ),
    combine_ranges(
        {"kind": "uncommitted"}, states, lambda state: state["head"], True,
        worktrees_truncated,
    ),
]
for commit in commits:
    ranges.append(capture_range(
        primary,
        {"kind": "commit", "sha": commit["sha"]},
        commit_parent(commit["sha"]),
        commit["sha"],
        False,
        MAX_FILES,
    ))
result = {
    "kind": "complete",
    "fingerprint": before,
    "baseline": BASELINE,
    "head": head,
    "branch": branch,
    "upstreamLabel": upstream_label,
    "ahead": int(ahead_value),
    "commits": commits,
    "worktrees": [
        {
            "id": state["id"],
            "name": state["name"],
            "head": state["head"],
            "branch": state["branch"],
        }
        for state in states
    ],
    "ranges": ranges,
}
if fingerprint() != before:
    result = {"kind": "changed"}
else:
    result = prune(result)
sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
`}`;

const guestProbeCommand = `python3 -c 'import base64;exec(base64.b64decode("${btoa(
  guestProbeSource,
)}"))'`;

const guestCommand = `python3 -c 'import base64;exec(base64.b64decode("${btoa(
  guestSource,
)}"))'`;

export const captureKey = (
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => `threads/${threadId}/changes/v1/${captureId}.json`;

export const probeThreadChanges = async (input: {
  readonly sandbox: Sandbox;
  readonly source: ThreadChangesSource;
  readonly expectedFingerprint: string;
}) => {
  const result = await input.sandbox
    .exec(guestProbeCommand, {
      cwd: input.sandbox.cwd,
      env: {
        DX_CHANGES_ROOT: input.sandbox.cwd,
        DX_CHANGES_DEFAULT_BRANCH: input.source.defaultBranch,
        DX_CHANGES_EXPECTED_FINGERPRINT: input.expectedFingerprint,
      },
      timeoutMs: CAPTURE_TIMEOUT_MS,
    })
    .catch(() => {
      throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe" });
    });
  if (result.exitCode !== 0)
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe-decode" });
  }
  return Schema.decodeUnknownSync(GuestProbeSchema)(decoded);
};

export const captureThreadChanges = async (input: {
  readonly sandbox: Sandbox;
  readonly threadId: ThreadIdType;
  readonly source: ThreadChangesSource;
  readonly generation: number;
  readonly expectedFingerprint?: string;
}): Promise<ThreadChangesManifest | undefined> => {
  const result = await input.sandbox
    .exec(guestCommand, {
      cwd: input.sandbox.cwd,
      env: {
        DX_CHANGES_ROOT: input.sandbox.cwd,
        DX_CHANGES_BASELINE: input.source.baseline,
        DX_CHANGES_DEFAULT_BRANCH: input.source.defaultBranch,
        ...(input.expectedFingerprint === undefined
          ? {}
          : {
              DX_CHANGES_EXPECTED_FINGERPRINT: input.expectedFingerprint,
            }),
      },
      timeoutMs: CAPTURE_TIMEOUT_MS,
    })
    .catch(() => {
      throw new ThreadChangesCaptureUnavailable({ stage: "guest-command" });
    });
  if (result.exitCode !== 0)
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-command" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-decode" });
  }
  const capture = Schema.decodeUnknownSync(GuestCaptureSchema)(decoded);
  if (capture.kind === "changed") return undefined;
  const captureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
    `chg_${crypto.randomUUID()}`,
  );
  return Schema.decodeUnknownSync(ThreadChangesManifestSchema)({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId,
    threadId: input.threadId,
    generation: input.generation,
    capturedAt: new Date().toISOString(),
    fingerprint: capture.fingerprint,
    repositoryName: input.source.repositoryName,
    defaultBranch: input.source.defaultBranch,
    baseline: capture.baseline,
    head: capture.head,
    ...(capture.branch === null ? {} : { branch: capture.branch }),
    ...(capture.upstreamLabel === null
      ? {}
      : { upstreamLabel: capture.upstreamLabel }),
    ahead: capture.ahead,
    commits: capture.commits,
    ...(capture.worktrees === undefined
      ? {}
      : { worktrees: capture.worktrees }),
    ranges: capture.ranges,
  });
};

export const putThreadChangesCapture = async (
  bucket: R2Bucket,
  manifest: ThreadChangesManifest,
) => {
  try {
    const encoder = new TextEncoder();
    const patches: Array<Uint8Array> = [];
    const references = new Map<string, ThreadChangesPatchReference>();
    let patchBytes = 0;
    const ranges = manifest.ranges.map((range) => ({
      ...range,
      files: range.files.map(({ patch, ...file }) => {
        let reference = references.get(patch);
        if (reference === undefined) {
          const encoded = encoder.encode(patch);
          reference = { offset: patchBytes, length: encoded.byteLength };
          references.set(patch, reference);
          patches.push(encoded);
          patchBytes += encoded.byteLength;
        }
        return { ...file, patch: reference };
      }),
    }));
    const index = Schema.decodeUnknownSync(ThreadChangesIndexSchema)(
      { ...manifest, ranges },
      { onExcessProperty: "error" },
    );
    const indexBytes = encoder.encode(JSON.stringify(index));
    const body = new Uint8Array(indexBytes.byteLength + patchBytes);
    body.set(indexBytes);
    let cursor = indexBytes.byteLength;
    for (const patch of patches) {
      body.set(patch, cursor);
      cursor += patch.byteLength;
    }
    if (body.byteLength > CAPTURE_MAX_OBJECT_BYTES)
      throw new Error("capture object exceeds storage bound");
    await bucket.put(captureKey(manifest.threadId, manifest.captureId), body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        capturedAt: manifest.capturedAt,
        schemaVersion: String(manifest.schemaVersion),
        format: "dx-thread-changes-packed-v1",
        indexLength: String(indexBytes.byteLength),
      },
    });
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "object-write" });
  }
};

const INDEX_INITIAL_READ_BYTES = 64 * 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

const decodeIndex = (
  bytes: ArrayBuffer,
  objectSize: number,
  indexLength: number,
) => {
  if (
    !Number.isSafeInteger(indexLength) ||
    indexLength <= 0 ||
    indexLength > objectSize ||
    bytes.byteLength !== indexLength ||
    objectSize > CAPTURE_MAX_OBJECT_BYTES
  )
    throw new Error("invalid capture index bounds");
  const index = Schema.decodeUnknownSync(ThreadChangesIndexSchema)(
    JSON.parse(decoder.decode(bytes)),
    { onExcessProperty: "error" },
  );
  for (const range of index.ranges)
    for (const file of range.files)
      if (
        file.patch.offset > objectSize - indexLength ||
        file.patch.length > objectSize - indexLength - file.patch.offset
      )
        throw new Error("invalid capture patch bounds");
  return index;
};

const readCaptureIndex = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => {
  const checkedThreadId = Schema.decodeUnknownSync(ThreadId)(threadId);
  const checkedCaptureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
    captureId,
  );
  const key = captureKey(checkedThreadId, checkedCaptureId);
  const first = await bucket.get(key, {
    range: { offset: 0, length: INDEX_INITIAL_READ_BYTES },
  });
  if (first === null)
    throw new ThreadChangesCaptureUnavailable({ stage: "object-read" });
  const prefix = await first.arrayBuffer();
  if (first.customMetadata?.format !== "dx-thread-changes-packed-v1") {
    if (first.size > CAPTURE_MAX_OBJECT_BYTES)
      throw new Error("invalid capture bounds");
    const legacy =
      first.size <= prefix.byteLength ? undefined : await bucket.get(key);
    if (legacy === null)
      throw new ThreadChangesCaptureUnavailable({ stage: "object-read" });
    const manifest = Schema.decodeUnknownSync(ThreadChangesManifestSchema)(
      legacy === undefined
        ? JSON.parse(decoder.decode(prefix))
        : await legacy.json(),
      { onExcessProperty: "error" },
    );
    return { kind: "legacy" as const, manifest };
  }
  const indexLength = Number(first.customMetadata.indexLength);
  if (!Number.isSafeInteger(indexLength) || indexLength <= 0)
    throw new Error("invalid capture index metadata");
  const bytes =
    indexLength <= INDEX_INITIAL_READ_BYTES
      ? prefix.slice(0, indexLength)
      : await (async () => {
          if (
            indexLength > first.size ||
            indexLength > CAPTURE_MAX_OBJECT_BYTES
          )
            throw new Error("invalid capture index bounds");
          const object = await bucket.get(key, {
            range: { offset: 0, length: indexLength },
          });
          if (object === null) throw new Error("capture disappeared");
          return object.arrayBuffer();
        })();
  return {
    kind: "packed" as const,
    index: decodeIndex(bytes, first.size, indexLength),
    indexLength,
    objectSize: first.size,
  };
};

const loadedIndexes = new WeakMap<
  ThreadChangesIndex,
  Awaited<ReturnType<typeof readCaptureIndex>>
>();

/** Loads capture metadata and patch byte references using a bounded prefix read. */
export const loadThreadChangesIndex = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
): Promise<ThreadChangesIndex> => {
  try {
    const stored = await readCaptureIndex(bucket, threadId, captureId);
    const index =
      stored.kind === "packed"
        ? stored.index
        : (() => {
            const encoder = new TextEncoder();
            let offset = 0;
            return {
              ...stored.manifest,
              ranges: stored.manifest.ranges.map((range) => ({
                ...range,
                files: range.files.map(({ patch, ...file }) => {
                  const length = encoder.encode(patch).byteLength;
                  const result = { ...file, patch: { offset, length } };
                  offset += length;
                  return result;
                }),
              })),
            };
          })();
    if (index.threadId !== threadId || index.captureId !== captureId)
      throw new Error("capture identity mismatch");
    loadedIndexes.set(index, stored);
    return index;
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};

/** Loads one patch. Packed captures issue a bounded ranged GET for its UTF-8 bytes. */
export const loadThreadChangesPatch = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
  range: ThreadChangesManifest["ranges"][number]["range"],
  path: string,
  worktree: ThreadChangesWorktreeId,
  index?: ThreadChangesIndex,
): Promise<string> => {
  try {
    const stored =
      (index === undefined ? undefined : loadedIndexes.get(index)) ??
      (await readCaptureIndex(bucket, threadId, captureId));
    const metadata = stored.kind === "packed" ? stored.index : stored.manifest;
    if (metadata.threadId !== threadId || metadata.captureId !== captureId)
      throw new Error("capture identity mismatch");
    const selectedRange =
      stored.kind === "packed" ? stored.index.ranges : stored.manifest.ranges;
    const selected = selectedRange.find(
      (candidate) => JSON.stringify(candidate.range) === JSON.stringify(range),
    );
    const file = selected?.files.find(
      (candidate) =>
        candidate.path === path &&
        (candidate.worktree ?? "primary") === worktree,
    );
    if (file === undefined) throw new Error("capture selection not found");
    if (stored.kind === "legacy") return file.patch as string;
    const reference = file.patch as ThreadChangesPatchReference;
    if (reference.length === 0) return "";
    const object = await bucket.get(captureKey(threadId, captureId), {
      range: {
        offset: stored.indexLength + reference.offset,
        length: reference.length,
      },
    });
    if (object === null) throw new Error("capture disappeared");
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== reference.length)
      throw new Error("short capture patch read");
    return decoder.decode(bytes);
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};

export const loadThreadChangesCapture = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => {
  try {
    const stored = await readCaptureIndex(bucket, threadId, captureId);
    if (stored.kind === "legacy") {
      if (
        stored.manifest.threadId !== threadId ||
        stored.manifest.captureId !== captureId
      )
        throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
      return stored.manifest;
    }
    const patchRegionLength = stored.objectSize - stored.indexLength;
    const patchRegion =
      patchRegionLength === 0
        ? new ArrayBuffer(0)
        : await (async () => {
            const object = await bucket.get(captureKey(threadId, captureId), {
              range: {
                offset: stored.indexLength,
                length: patchRegionLength,
              },
            });
            if (object === null) throw new Error("capture disappeared");
            const bytes = await object.arrayBuffer();
            if (bytes.byteLength !== patchRegionLength)
              throw new Error("short capture patch region read");
            return bytes;
          })();
    const manifest = Schema.decodeUnknownSync(ThreadChangesManifestSchema)({
      ...stored.index,
      ranges: stored.index.ranges.map((range) => ({
        ...range,
        files: range.files.map((file) => ({
          ...file,
          patch: decoder.decode(
            patchRegion.slice(
              file.patch.offset,
              file.patch.offset + file.patch.length,
            ),
          ),
        })),
      })),
    });
    if (manifest.threadId !== threadId || manifest.captureId !== captureId)
      throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
    return manifest;
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};
