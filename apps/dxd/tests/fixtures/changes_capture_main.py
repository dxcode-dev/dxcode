import difflib
import hashlib
import json
import os
import stat
import subprocess
import sys

ROOT = os.environ["DX_CHANGES_ROOT"]
BASELINE = os.environ["DX_CHANGES_BASELINE"]
DEFAULT_BRANCH = os.environ["DX_CHANGES_DEFAULT_BRANCH"]
EXPECTED = os.environ.get("DX_CHANGES_EXPECTED_FINGERPRINT")
MAX_FILES = 200
MAX_COMMITS = 50
MAX_WORKTREES = 5
MAX_PATCH_BYTES = 256 * 1024
MAX_PATCH_LINES = 10000
MAX_OBJECT_BYTES = 8 * 1024 * 1024
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
    selected = [primary_path, *linked[: MAX_WORKTREES - 1]]
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
    ], len(linked) > MAX_WORKTREES - 1


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
                        if untracked_cache is not None and len(prefix) <= MAX_PATCH_BYTES:
                            prefix.extend(chunk[: MAX_PATCH_BYTES + 1 - len(prefix)])
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
            commits.append({
                "sha": parts[0],
                "shortSha": parts[1],
                "subject": parts[2][:512] or "(no subject)",
            })
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
before = fingerprint(untracked_cache)
if EXPECTED is not None:
    if len(EXPECTED) != 64 or any(character not in "0123456789abcdef" for character in EXPECTED):
        raise RuntimeError("invalid expected fingerprint")
    if before == EXPECTED:
        confirmed = fingerprint()
        if confirmed == EXPECTED:
            sys.stdout.write(json.dumps({
                "kind": "unchanged",
                "fingerprint": confirmed,
            }, separators=(",", ":")))
            raise SystemExit(0)
        before = confirmed

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
