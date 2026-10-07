//! Changes capture: the resident daemon's view of what changed in the Thread
//! checkout and its linked worktrees, computed with the user's own `git`.
//!
//! One refresh runs a handful of `git` processes instead of one per file:
//! `status --porcelain=v2` drives the fingerprint, each range uses one
//! `name-status`, one `numstat`, and one combined patch, and per-commit
//! ranges are cached by sha because commit content never changes.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A raced capture saw the tree move underneath it; its retry waits this long
/// so a burst of writes can settle first.
pub const RETRY_DELAY: Duration = Duration::from_millis(250);
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_GIT_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 200;
const MAX_COMMITS: usize = 50;
const MAX_WORKTREES: usize = 5;
const MAX_PATCH_BYTES: usize = 256 * 1024;
const MAX_PATCH_LINES: usize = 10_000;
const MAX_OBJECT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHED_COMMIT_RANGES: usize = 256;
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRequest {
    pub token: String,
    pub source: SourceContext,
    pub expected_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContext {
    pub baseline: String,
    pub default_branch: String,
}

#[derive(Clone, Debug)]
struct ScheduledRefresh {
    sequence: u64,
    request: RefreshRequest,
    ready_at: Instant,
}

#[derive(Debug)]
pub struct CompletedRefresh {
    pub sequence: u64,
    pub request: RefreshRequest,
    pub outcome: CandidateOutcome,
}

/// Newest-only refresh requests with exactly one capture in flight. A request
/// is ready at once: the observer's quiet period and Core already coalesced
/// the burst behind it, so another debounce here would only add latency.
/// Requests that arrive during a capture replace each other and the newest
/// runs as soon as that capture completes.
pub struct ChangesScheduler {
    next_sequence: u64,
    newest_sequence: u64,
    pending: Option<ScheduledRefresh>,
    in_flight: Option<u64>,
}

impl ChangesScheduler {
    pub fn new() -> Self {
        Self {
            next_sequence: 1,
            newest_sequence: 0,
            pending: None,
            in_flight: None,
        }
    }

    pub fn enqueue(&mut self, request: RefreshRequest, now: Instant) {
        self.schedule(request, now);
    }

    /// Re-run a raced request after `RETRY_DELAY` unless something newer
    /// arrives first.
    pub fn retry(&mut self, request: RefreshRequest, now: Instant) {
        self.schedule(request, now + RETRY_DELAY);
    }

    fn schedule(&mut self, request: RefreshRequest, ready_at: Instant) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.newest_sequence = sequence;
        self.pending = Some(ScheduledRefresh {
            sequence,
            request,
            ready_at,
        });
    }

    /// A capture is running on the worker.
    pub fn busy(&self) -> bool {
        self.in_flight.is_some()
    }

    /// When the pending refresh becomes ready, or `None` when nothing waits.
    pub fn next_ready_at(&self) -> Option<Instant> {
        if self.in_flight.is_some() {
            return None;
        }
        self.pending.as_ref().map(|pending| pending.ready_at)
    }

    /// Take the pending refresh if it is ready and nothing is in flight.
    pub fn take_ready(&mut self, now: Instant) -> Option<(u64, RefreshRequest)> {
        if self.in_flight.is_some()
            || self
                .pending
                .as_ref()
                .is_none_or(|pending| pending.ready_at > now)
        {
            return None;
        }
        let pending = self.pending.take().expect("pending refresh disappeared");
        self.in_flight = Some(pending.sequence);
        Some((pending.sequence, pending.request))
    }

    pub fn complete(&mut self, completed: &CompletedRefresh) -> bool {
        if self.in_flight != Some(completed.sequence) {
            return false;
        }
        self.in_flight = None;
        completed.sequence == self.newest_sequence
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteCapture {
    pub fingerprint: String,
    pub baseline: String,
    pub head: String,
    pub branch: Option<String>,
    pub upstream_label: Option<String>,
    pub ahead: u64,
    pub commits: Vec<Commit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<Worktree>>,
    pub ranges: Vec<CapturedRange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Worktree {
    pub id: String,
    pub name: String,
    pub head: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedRange {
    pub range: Range,
    pub truncated: bool,
    pub summary: Summary,
    pub files: Vec<CapturedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Range {
    All,
    Uncommitted,
    Commit { sha: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub path: String,
    pub status: FileStatus,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub truncated: bool,
    pub patch: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Untracked,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CandidateOutcome {
    Unchanged { fingerprint: String },
    Complete { capture: CompleteCapture },
    Raced,
    Unavailable { reason: UnavailableReason },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    SourceUnavailable,
    CaptureFailed,
    Timeout,
    CandidateTooLarge,
}

/// Per-commit ranges survive across refreshes: a commit's content is immutable.
#[derive(Clone, Default)]
pub struct CaptureCache {
    commit_ranges: Arc<Mutex<HashMap<String, CapturedRange>>>,
}

impl CaptureCache {
    fn get(&self, sha: &str) -> Option<CapturedRange> {
        self.commit_ranges.lock().ok()?.get(sha).cloned()
    }

    fn insert(&self, sha: String, range: CapturedRange) {
        if let Ok(mut cache) = self.commit_ranges.lock() {
            if cache.len() >= MAX_CACHED_COMMIT_RANGES {
                cache.clear();
            }
            cache.insert(sha, range);
        }
    }
}

#[derive(Debug)]
enum CaptureError {
    Git,
    Timeout,
    Changed,
    TooLarge,
}

type CaptureResult<T> = Result<T, CaptureError>;

fn git(root: &Path, arguments: &[&str], allowed: &[i32]) -> CaptureResult<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotePath=false"])
        .args(arguments)
        .env("LC_ALL", "C.UTF-8")
        // `git status` otherwise refreshes `.git/index`, which the observer
        // reports as a mutation: every capture would schedule the next one.
        .env("GIT_OPTIONAL_LOCKS", "0");
    let (status, bytes) = crate::child::run(&mut command, &[], MAX_GIT_OUTPUT_BYTES, GIT_TIMEOUT)
        .map_err(|error| match error.kind() {
        io::ErrorKind::TimedOut => CaptureError::Timeout,
        io::ErrorKind::FileTooLarge => CaptureError::TooLarge,
        _ => CaptureError::Git,
    })?;
    let code = status.code().unwrap_or(-1);
    if !allowed.contains(&code) {
        return Err(CaptureError::Git);
    }
    Ok(bytes)
}

fn git_text(root: &Path, arguments: &[&str], allowed: &[i32]) -> CaptureResult<String> {
    let bytes = git(root, arguments, allowed)?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

#[derive(Clone, Debug)]
struct WorktreeState {
    id: String,
    name: String,
    path: PathBuf,
    head: String,
    branch: Option<String>,
    upstream_label: Option<String>,
}

fn worktree_id(path: &Path) -> String {
    format!(
        "wt_{}",
        &format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))[..16]
    )
}

fn discover_worktrees(root: &Path) -> CaptureResult<(Vec<(String, String, PathBuf)>, bool)> {
    let primary = root.canonicalize().map_err(|_| CaptureError::Git)?;
    let output = git_text(root, &["worktree", "list", "--porcelain"], &[0])?;
    let mut candidates = Vec::new();
    for record in output.split("\n\n") {
        let mut path = None;
        let mut skip = false;
        for line in record.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                if !Path::new(value).is_absolute() {
                    return Err(CaptureError::Git);
                }
                path = Some(PathBuf::from(value));
            } else if line == "bare" || line.starts_with("prunable") {
                skip = true;
            }
        }
        if skip {
            continue;
        }
        if let Some(path) = path
            && let Ok(real) = path.canonicalize()
            && real.is_dir()
        {
            candidates.push(real);
        }
    }
    if !candidates.contains(&primary) {
        return Err(CaptureError::Git);
    }
    let mut linked = candidates
        .into_iter()
        .filter(|path| *path != primary)
        .collect::<Vec<_>>();
    linked.sort();
    linked.dedup();
    let truncated = linked.len() > MAX_WORKTREES - 1;
    linked.truncate(MAX_WORKTREES - 1);
    let mut selected = vec![primary.clone()];
    for path in linked {
        let top = git_text(&path, &["rev-parse", "--show-toplevel"], &[0, 128])?;
        if top.is_empty() {
            continue;
        }
        if Path::new(&top).canonicalize().ok().as_deref() == Some(path.as_path()) {
            selected.push(path);
        }
    }
    Ok((
        selected
            .into_iter()
            .map(|path| {
                let id = if path == primary {
                    "primary".to_owned()
                } else {
                    worktree_id(&path)
                };
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "workspace".to_owned());
                let name = name.chars().take(256).collect();
                (id, name, path)
            })
            .collect(),
        truncated,
    ))
}

fn worktree_state(
    (id, name, path): (String, String, PathBuf),
    default_branch: &str,
) -> CaptureResult<WorktreeState> {
    let head = git_text(&path, &["rev-parse", "--verify", "HEAD"], &[0, 128])?;
    let head = if head.is_empty() {
        EMPTY_TREE.to_owned()
    } else {
        head
    };
    let branch = git_text(
        &path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &[0, 1],
    )?;
    let branch = (!branch.is_empty()).then_some(branch);
    let mut upstream_label = git_text(
        &path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        &[0, 128],
    )?;
    if upstream_label.is_empty() {
        let candidate = format!("origin/{default_branch}");
        let verified = git_text(&path, &["rev-parse", "--verify", &candidate], &[0, 128])?;
        upstream_label = if verified.is_empty() {
            String::new()
        } else {
            candidate
        };
    }
    Ok(WorktreeState {
        id,
        name,
        path,
        head,
        branch,
        upstream_label: (!upstream_label.is_empty()).then_some(upstream_label),
    })
}

fn record(digest: &mut Sha256, tag: &str, value: &[u8]) {
    digest.update((tag.len() as u32).to_be_bytes());
    digest.update(tag.as_bytes());
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

/// Identity of the working tree as seen by `git status` plus the metadata of
/// every path with a working-tree change. Metadata (size, mode, mtime in
/// nanoseconds, ctime) changes on every write, so no file content is read.
fn fingerprint(states: &[WorktreeState], truncated: bool) -> CaptureResult<String> {
    let mut digest = Sha256::new();
    record(
        &mut digest,
        "worktrees-truncated",
        if truncated { b"1" } else { b"0" },
    );
    for state in states {
        let upstream = match &state.upstream_label {
            Some(label) => git_text(&state.path, &["rev-parse", "--verify", label], &[0, 128])?,
            None => String::new(),
        };
        record(&mut digest, "worktree", state.id.as_bytes());
        record(&mut digest, "head", state.head.as_bytes());
        record(
            &mut digest,
            "branch",
            state.branch.as_deref().unwrap_or("").as_bytes(),
        );
        record(
            &mut digest,
            "upstream-label",
            state.upstream_label.as_deref().unwrap_or("").as_bytes(),
        );
        record(&mut digest, "upstream", upstream.as_bytes());
        let status = git(
            &state.path,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--no-renames",
                "--untracked-files=all",
            ],
            &[0],
        )?;
        record(&mut digest, "status", &status);
        for entry in status.split(|byte| *byte == 0) {
            let Ok(entry) = std::str::from_utf8(entry) else {
                continue;
            };
            let Some(path) = status_entry_path(entry) else {
                continue;
            };
            record(&mut digest, "path", path.as_bytes());
            record(&mut digest, "meta", &path_metadata(&state.path.join(path)));
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// Path of a porcelain v2 entry that has a working-tree side.
fn status_entry_path(entry: &str) -> Option<&str> {
    let mut fields = entry.split(' ');
    match fields.next()? {
        // 1 XY sub mH mI mW hH hI path
        "1" => entry.splitn(9, ' ').nth(8),
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        "u" => entry.splitn(11, ' ').nth(10),
        // ? path
        "?" => entry.strip_prefix("? "),
        _ => None,
    }
}

fn path_metadata(path: &Path) -> Vec<u8> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return b"absent".to_vec();
    };
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}:{}.{}:{}.{}",
        metadata.mode(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
    .into_bytes()
}

fn limited_patch(value: &str) -> (String, bool) {
    let mut truncated = value.len() > MAX_PATCH_BYTES;
    let mut text = if truncated {
        let mut end = MAX_PATCH_BYTES;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value[..end].to_owned()
    } else {
        value.to_owned()
    };
    let line_count = text.split_inclusive('\n').count();
    if line_count > MAX_PATCH_LINES {
        text = text.split_inclusive('\n').take(MAX_PATCH_LINES).collect();
        truncated = true;
    }
    (text, truncated)
}

struct UntrackedFile {
    binary: bool,
    additions: u64,
    patch: String,
    truncated: bool,
}

fn untracked_file(root: &Path, path: &str) -> CaptureResult<UntrackedFile> {
    let absolute = root.join(path);
    let metadata = match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(CaptureError::Changed),
        Err(_) => return Err(CaptureError::Git),
    };
    if !metadata.is_file() {
        return Ok(UntrackedFile {
            binary: true,
            additions: 0,
            patch: String::new(),
            truncated: false,
        });
    }
    let mut file = match std::fs::File::open(&absolute) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(CaptureError::Changed),
        Err(_) => return Err(CaptureError::Git),
    };
    let mut prefix = Vec::with_capacity((MAX_PATCH_BYTES + 1).min(metadata.len() as usize + 1));
    Read::by_ref(&mut file)
        .take(MAX_PATCH_BYTES as u64 + 1)
        .read_to_end(&mut prefix)
        .map_err(|_| CaptureError::Git)?;
    let mut binary = prefix.contains(&0);
    let mut additions = prefix.iter().filter(|byte| **byte == b'\n').count() as u64;
    let mut last = prefix.last().copied();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| CaptureError::Git)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        binary = binary || chunk.contains(&0);
        additions += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
        last = chunk.last().copied();
    }
    let oversized = prefix.len() > MAX_PATCH_BYTES;
    if binary {
        return Ok(UntrackedFile {
            binary: true,
            additions: 0,
            patch: String::new(),
            truncated: oversized,
        });
    }
    if last.is_some_and(|byte| byte != b'\n') {
        additions += 1;
    }
    let text = String::from_utf8_lossy(&prefix);
    let lines = text.split_inclusive('\n').collect::<Vec<_>>();
    let patch = if lines.is_empty() {
        String::new()
    } else {
        let range = if lines.len() == 1 {
            "+1".to_owned()
        } else {
            format!("+1,{}", lines.len())
        };
        let mut patch = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 {range} @@\n");
        for line in lines {
            patch.push('+');
            patch.push_str(line);
        }
        patch
    };
    let (patch, truncated) = limited_patch(&patch);
    Ok(UntrackedFile {
        binary: false,
        additions,
        patch,
        truncated: truncated || oversized,
    })
}

fn diff_args<'a>(base: &'a str, target: Option<&'a str>) -> Vec<&'a str> {
    match target {
        Some(target) => vec![base, target],
        None => vec![base],
    }
}

fn changed_paths(
    root: &Path,
    base: &str,
    target: Option<&str>,
) -> CaptureResult<BTreeMap<String, FileStatus>> {
    let mut arguments = vec![
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        "--no-ext-diff",
    ];
    arguments.extend(diff_args(base, target));
    arguments.push("--");
    let output = git(root, &arguments, &[0])?;
    let values = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut statuses = BTreeMap::new();
    let mut index = 0;
    while index + 1 < values.len() {
        let status = values[index];
        let path = values[index + 1];
        index += 2;
        if status.is_empty() || path.is_empty() {
            continue;
        }
        let path = std::str::from_utf8(path).map_err(|_| CaptureError::Git)?;
        if !safe_path(path) {
            return Err(CaptureError::Git);
        }
        let file_status = match status[0] {
            b'A' => FileStatus::Added,
            b'D' => FileStatus::Deleted,
            _ => FileStatus::Modified,
        };
        statuses.insert(path.to_owned(), file_status);
    }
    Ok(statuses)
}

fn numstats(
    root: &Path,
    base: &str,
    target: Option<&str>,
) -> CaptureResult<HashMap<String, (u64, u64, bool)>> {
    let mut arguments = vec!["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff"];
    arguments.extend(diff_args(base, target));
    arguments.push("--");
    let output = git(root, &arguments, &[0])?;
    let mut result = HashMap::new();
    for value in output.split(|byte| *byte == 0) {
        if value.is_empty() {
            continue;
        }
        let value = std::str::from_utf8(value).map_err(|_| CaptureError::Git)?;
        let parts = value.splitn(3, '\t').collect::<Vec<_>>();
        if parts.len() != 3 || !safe_path(parts[2]) {
            continue;
        }
        let binary = parts[0] == "-" || parts[1] == "-";
        let additions = if binary {
            0
        } else {
            parts[0].parse().unwrap_or(0)
        };
        let deletions = if binary {
            0
        } else {
            parts[1].parse().unwrap_or(0)
        };
        result.insert(parts[2].to_owned(), (additions, deletions, binary));
    }
    Ok(result)
}

/// One `git diff` for every selected tracked path, split into per-file
/// patches. With renames off a patch belongs to `path` only when its header is
/// exactly `diff --git a/<path> b/<path>`; Git quotes names with control
/// characters or `"`, so those (and any other unmatched header) fall back to a
/// per-path diff. Pathspecs are literal: a name like `a*.txt` is one file.
fn tracked_patches(
    root: &Path,
    base: &str,
    target: Option<&str>,
    paths: &[&str],
) -> CaptureResult<HashMap<String, String>> {
    let diff = |pathspecs: &[&str]| {
        let mut arguments = vec![
            "--literal-pathspecs",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            "--no-renames",
        ];
        arguments.extend(diff_args(base, target));
        arguments.push("--");
        arguments.extend(pathspecs);
        git(root, &arguments, &[0])
    };
    let mut patches = HashMap::new();
    if paths.is_empty() {
        return Ok(patches);
    }
    let headers = paths
        .iter()
        .map(|path| (format!("diff --git a/{path} b/{path}\n"), *path))
        .collect::<HashMap<_, _>>();
    let output = diff(paths)?;
    let text = String::from_utf8_lossy(&output);
    let mut current: Option<(&str, String)> = None;
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if let Some((path, patch)) = current.take() {
                patches.insert(path.to_owned(), patch);
            }
            current = headers.get(line).map(|path| (*path, line.to_owned()));
        } else if let Some((_, patch)) = current.as_mut() {
            patch.push_str(line);
        }
    }
    if let Some((path, patch)) = current {
        patches.insert(path.to_owned(), patch);
    }
    for path in paths {
        if !patches.contains_key(*path) {
            let output = diff(&[path])?;
            patches.insert(
                (*path).to_owned(),
                String::from_utf8_lossy(&output).into_owned(),
            );
        }
    }
    Ok(patches)
}

fn untracked_paths(root: &Path) -> CaptureResult<Vec<String>> {
    let output = git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        &[0],
    )?;
    let mut paths = output
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| std::str::from_utf8(value).map_err(|_| CaptureError::Git))
        .collect::<CaptureResult<Vec<_>>>()?
        .into_iter()
        .filter(|path| safe_path(path))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn capture_range(
    worktree: &WorktreeState,
    kind: Range,
    base: &str,
    target: Option<&str>,
    include_untracked: bool,
    limit: usize,
) -> CaptureResult<CapturedRange> {
    let root = &worktree.path;
    let mut statuses = changed_paths(root, base, target)?;
    let stats = numstats(root, base, target)?;
    if include_untracked {
        for path in untracked_paths(root)? {
            statuses.entry(path).or_insert(FileStatus::Untracked);
        }
    }
    let paths = statuses.keys().cloned().collect::<Vec<_>>();
    let mut total_additions = 0_u64;
    let mut total_deletions = 0_u64;
    let mut untracked = HashMap::new();
    for (index, path) in paths.iter().enumerate() {
        match statuses[path] {
            FileStatus::Untracked => {
                let captured = untracked_file(root, path)?;
                total_additions += captured.additions;
                if index < limit {
                    untracked.insert(path.clone(), captured);
                }
            }
            _ => {
                let (additions, deletions, _) = stats.get(path).copied().unwrap_or((0, 0, false));
                total_additions += additions;
                total_deletions += deletions;
            }
        }
    }
    let selected = &paths[..paths.len().min(limit)];
    let tracked = selected
        .iter()
        .filter(|path| {
            statuses[*path] != FileStatus::Untracked
                && !stats.get(*path).is_some_and(|(_, _, binary)| *binary)
        })
        .map(String::as_str)
        .collect::<Vec<_>>();
    let patches = tracked_patches(root, base, target, &tracked)?;
    let mut files = Vec::with_capacity(selected.len());
    for path in selected {
        let status = statuses[path];
        let (additions, deletions, binary, patch, truncated) = match status {
            FileStatus::Untracked => {
                let captured = untracked
                    .remove(path)
                    .expect("untracked files within the limit were captured");
                (
                    captured.additions,
                    0,
                    captured.binary,
                    captured.patch,
                    captured.truncated,
                )
            }
            _ => {
                let (additions, deletions, binary) =
                    stats.get(path).copied().unwrap_or((0, 0, false));
                let raw = if binary {
                    ""
                } else {
                    patches.get(path).map(String::as_str).unwrap_or("")
                };
                let (patch, truncated) = limited_patch(raw);
                (additions, deletions, binary, patch, truncated)
            }
        };
        files.push(CapturedFile {
            worktree: Some(worktree.id.clone()),
            path: path.clone(),
            status,
            additions,
            deletions,
            binary,
            truncated,
            patch,
        });
    }
    Ok(CapturedRange {
        range: kind,
        truncated: paths.len() > limit,
        summary: Summary {
            additions: total_additions,
            deletions: total_deletions,
            files: paths.len() as u64,
        },
        files,
    })
}

fn combine_ranges(
    kind: Range,
    states: &[WorktreeState],
    base_for: impl Fn(&WorktreeState) -> String,
    include_untracked: bool,
    worktrees_truncated: bool,
) -> CaptureResult<CapturedRange> {
    let mut files = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    let mut file_count = 0;
    let mut truncated = worktrees_truncated;
    for state in states {
        let captured = capture_range(
            state,
            kind.clone(),
            &base_for(state),
            None,
            include_untracked,
            MAX_FILES.saturating_sub(files.len()),
        )?;
        files.extend(captured.files);
        additions += captured.summary.additions;
        deletions += captured.summary.deletions;
        file_count += captured.summary.files;
        truncated = truncated || captured.truncated;
    }
    Ok(CapturedRange {
        range: kind,
        truncated,
        summary: Summary {
            additions,
            deletions,
            files: file_count,
        },
        files,
    })
}

/// Commits ahead of the baseline with their first parents, in one `git log`.
fn commit_list(root: &Path, baseline: &str, head: &str) -> CaptureResult<Vec<(Commit, String)>> {
    let range = if baseline == EMPTY_TREE {
        head.to_owned()
    } else {
        format!("{baseline}..{head}")
    };
    let max_count = format!("--max-count={MAX_COMMITS}");
    let output = git(
        root,
        &[
            "log",
            "-z",
            &max_count,
            "--format=%H%x1f%h%x1f%s%x1f%P",
            &range,
        ],
        &[0],
    )?;
    let mut commits = Vec::new();
    for record in output.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        let parts = text.splitn(4, '\x1f').collect::<Vec<_>>();
        if parts.len() != 4 {
            continue;
        }
        let subject = parts[2].chars().take(512).collect::<String>();
        let parent = parts[3]
            .split_whitespace()
            .next()
            .map_or_else(|| EMPTY_TREE.to_owned(), str::to_owned);
        commits.push((
            Commit {
                sha: parts[0].to_owned(),
                short_sha: parts[1].to_owned(),
                subject: if subject.is_empty() {
                    "(no subject)".to_owned()
                } else {
                    subject
                },
            },
            parent,
        ));
    }
    Ok(commits)
}

fn encoded_len(capture: &CompleteCapture) -> CaptureResult<usize> {
    serde_json::to_vec(capture)
        .map(|bytes| bytes.len())
        .map_err(|_| CaptureError::Git)
}

fn prune(mut capture: CompleteCapture) -> CaptureResult<CompleteCapture> {
    if encoded_len(&capture)? <= MAX_OBJECT_BYTES {
        return Ok(capture);
    }
    let mut order = capture
        .ranges
        .iter()
        .enumerate()
        .flat_map(|(range_index, range)| {
            range
                .files
                .iter()
                .enumerate()
                .map(move |(file_index, file)| (file.patch.len(), range_index, file_index))
        })
        .collect::<Vec<_>>();
    order.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, range_index, file_index) in order {
        let file = &mut capture.ranges[range_index].files[file_index];
        file.patch = String::new();
        file.truncated = true;
        if encoded_len(&capture)? <= MAX_OBJECT_BYTES {
            return Ok(capture);
        }
    }
    Err(CaptureError::TooLarge)
}

fn capture_inner(
    root: &Path,
    request: &RefreshRequest,
    cache: &CaptureCache,
) -> CaptureResult<CandidateOutcome> {
    let baseline = request.source.baseline.as_str();
    if baseline.len() != 40 || !baseline.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CaptureError::Git);
    }
    if baseline != EMPTY_TREE {
        let commit = format!("{baseline}^{{commit}}");
        git(root, &["cat-file", "-e", &commit], &[0])?;
    }
    let (worktrees, truncated) = discover_worktrees(root)?;
    let states = worktrees
        .into_iter()
        .map(|worktree| worktree_state(worktree, &request.source.default_branch))
        .collect::<CaptureResult<Vec<_>>>()?;
    let before = fingerprint(&states, truncated)?;
    if let Some(expected) = &request.expected_fingerprint {
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CaptureError::Git);
        }
        if *expected == before {
            return Ok(CandidateOutcome::Unchanged {
                fingerprint: before,
            });
        }
    }

    let primary = &states[0];
    let head = primary.head.clone();
    let (ahead, commits) = if head == EMPTY_TREE {
        (0, Vec::new())
    } else {
        let ahead_base = primary.upstream_label.as_deref().unwrap_or(baseline);
        let ahead_range = if ahead_base == EMPTY_TREE {
            head.clone()
        } else {
            format!("{ahead_base}..{head}")
        };
        let ahead = git_text(root, &["rev-list", "--count", &ahead_range], &[0])?
            .parse::<u64>()
            .map_err(|_| CaptureError::Git)?;
        (ahead, commit_list(root, baseline, &head)?)
    };
    let mut all_bases = HashMap::new();
    for state in &states {
        // Diff each worktree from where it forked off the Thread's starting
        // commit, so a checkout of a branch that never contained that commit
        // shows its own work rather than the reverse of the default branch.
        let base = if state.head == EMPTY_TREE || baseline == EMPTY_TREE {
            if state.id == "primary" {
                baseline.to_owned()
            } else {
                EMPTY_TREE.to_owned()
            }
        } else {
            let merge_base =
                git_text(&state.path, &["merge-base", baseline, &state.head], &[0, 1])?;
            if merge_base.is_empty() {
                EMPTY_TREE.to_owned()
            } else {
                merge_base
            }
        };
        all_bases.insert(state.id.clone(), base);
    }
    let mut ranges = vec![
        combine_ranges(
            Range::All,
            &states,
            |state| all_bases[&state.id].clone(),
            true,
            truncated,
        )?,
        combine_ranges(
            Range::Uncommitted,
            &states,
            |state| state.head.clone(),
            true,
            truncated,
        )?,
    ];
    for (commit, parent) in &commits {
        let range = match cache.get(&commit.sha) {
            Some(range) => range,
            None => {
                let range = capture_range(
                    primary,
                    Range::Commit {
                        sha: commit.sha.clone(),
                    },
                    parent,
                    Some(&commit.sha),
                    false,
                    MAX_FILES,
                )?;
                cache.insert(commit.sha.clone(), range.clone());
                range
            }
        };
        ranges.push(range);
    }
    let capture = CompleteCapture {
        fingerprint: before.clone(),
        baseline: baseline.to_owned(),
        head,
        branch: primary.branch.clone(),
        upstream_label: primary.upstream_label.clone(),
        ahead,
        commits: commits.into_iter().map(|(commit, _)| commit).collect(),
        worktrees: Some(
            states
                .iter()
                .map(|state| Worktree {
                    id: state.id.clone(),
                    name: state.name.clone(),
                    head: state.head.clone(),
                    branch: state.branch.clone(),
                })
                .collect(),
        ),
        ranges,
    };
    // The tree may have moved while patches were read; the fingerprint is
    // only valid for a capture that saw one consistent state.
    let (worktrees_after, truncated_after) = discover_worktrees(root)?;
    let states_after = worktrees_after
        .into_iter()
        .map(|worktree| worktree_state(worktree, &request.source.default_branch))
        .collect::<CaptureResult<Vec<_>>>()?;
    if fingerprint(&states_after, truncated_after)? != before {
        return Ok(CandidateOutcome::Raced);
    }
    Ok(CandidateOutcome::Complete {
        capture: prune(capture)?,
    })
}

/// Fingerprint of the current tree without capturing, for request-scoped
/// probes by Core.
pub fn fingerprint_only(root: &Path, default_branch: &str) -> Option<String> {
    let (worktrees, truncated) = discover_worktrees(root).ok()?;
    let states = worktrees
        .into_iter()
        .map(|worktree| worktree_state(worktree, default_branch))
        .collect::<CaptureResult<Vec<_>>>()
        .ok()?;
    fingerprint(&states, truncated).ok()
}

/// `dxd changes-capture`: the same capture as the resident path, driven by
/// environment variables and printed as JSON for Core's request-scoped
/// activation and reconnect repair. Replaces the former Python script.
pub fn run_cli() -> Result<(), ()> {
    let root = PathBuf::from(std::env::var("DX_CHANGES_ROOT").map_err(|_| ())?);
    let default_branch = std::env::var("DX_CHANGES_DEFAULT_BRANCH").map_err(|_| ())?;
    let expected = std::env::var("DX_CHANGES_EXPECTED_FINGERPRINT").ok();
    if std::env::var("DX_CHANGES_PROBE").is_ok_and(|value| value == "1") {
        let expected = expected.ok_or(())?;
        let observed = fingerprint_only(&root, &default_branch).ok_or(())?;
        let (kind, fingerprint) = if observed == expected {
            let confirmed = fingerprint_only(&root, &default_branch).ok_or(())?;
            if confirmed == expected {
                ("unchanged", confirmed)
            } else {
                ("changed", confirmed)
            }
        } else {
            ("changed", observed)
        };
        println!(
            "{}",
            serde_json::json!({ "kind": kind, "fingerprint": fingerprint })
        );
        return Ok(());
    }
    // Request-scoped semantics: an expected fingerprint is the probe's
    // snapshot, so the capture must still match it; it never short-circuits.
    let request = RefreshRequest {
        token: "cli-request-token".into(),
        source: SourceContext {
            baseline: std::env::var("DX_CHANGES_BASELINE").map_err(|_| ())?,
            default_branch,
        },
        expected_fingerprint: None,
    };
    let output = match capture(&root, &request, &CaptureCache::default()) {
        CandidateOutcome::Complete { capture }
            if expected
                .as_deref()
                .is_some_and(|expected| expected != capture.fingerprint) =>
        {
            serde_json::json!({ "kind": "changed" })
        }
        CandidateOutcome::Complete { capture } => {
            let mut value = serde_json::to_value(&capture).map_err(|_| ())?;
            value
                .as_object_mut()
                .ok_or(())?
                .insert("kind".into(), serde_json::Value::String("complete".into()));
            value
        }
        CandidateOutcome::Unchanged { fingerprint } => {
            serde_json::json!({ "kind": "unchanged", "fingerprint": fingerprint })
        }
        CandidateOutcome::Raced => serde_json::json!({ "kind": "changed" }),
        CandidateOutcome::Unavailable { .. } => return Err(()),
    };
    println!("{output}");
    Ok(())
}

/// Run one capture on the current (blocking) thread.
pub fn capture(root: &Path, request: &RefreshRequest, cache: &CaptureCache) -> CandidateOutcome {
    if !root.is_absolute() || !root.is_dir() {
        return CandidateOutcome::Unavailable {
            reason: UnavailableReason::SourceUnavailable,
        };
    }
    match capture_inner(root, request, cache) {
        Ok(outcome) => outcome,
        Err(CaptureError::Changed) => CandidateOutcome::Raced,
        Err(CaptureError::Timeout) => CandidateOutcome::Unavailable {
            reason: UnavailableReason::Timeout,
        },
        Err(CaptureError::TooLarge) => CandidateOutcome::Unavailable {
            reason: UnavailableReason::CandidateTooLarge,
        },
        Err(CaptureError::Git) => CandidateOutcome::Unavailable {
            reason: UnavailableReason::CaptureFailed,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_ok(root: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn repository() -> (tempfile::TempDir, PathBuf, String) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]);
        git_ok(&root, &["config", "user.email", "a@b.c"]);
        git_ok(&root, &["config", "user.name", "a"]);
        fs::write(root.join("README.md"), "one\ntwo\n").unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        git_ok(&root, &["add", "."]);
        git_ok(&root, &["commit", "-q", "-m", "init"]);
        let baseline = git_ok(&root, &["rev-parse", "HEAD"]);
        (directory, root, baseline)
    }

    fn request(baseline: &str, expected: Option<&str>) -> RefreshRequest {
        RefreshRequest {
            token: "token-0123456789abcdef".into(),
            source: SourceContext {
                baseline: baseline.into(),
                default_branch: "main".into(),
            },
            expected_fingerprint: expected.map(str::to_owned),
        }
    }

    #[test]
    fn scheduler_runs_at_once_newest_only_with_one_in_flight() {
        let mut scheduler = ChangesScheduler::new();
        let now = Instant::now();
        scheduler.enqueue(request("a", None), now);
        assert_eq!(scheduler.next_ready_at(), Some(now));
        let (sequence, taken) = scheduler.take_ready(now).unwrap();
        assert_eq!(taken.source.baseline, "a");
        // Requests during a capture replace each other and wait for it.
        scheduler.enqueue(request("b", None), now);
        scheduler.enqueue(request("c", None), now);
        assert_eq!(scheduler.next_ready_at(), None, "one in flight");
        assert!(scheduler.take_ready(now).is_none());
        let stale = CompletedRefresh {
            sequence,
            request: taken,
            outcome: CandidateOutcome::Raced,
        };
        assert!(!scheduler.complete(&stale), "superseded by newer request");
        let (sequence, taken) = scheduler.take_ready(now).unwrap();
        assert_eq!(taken.source.baseline, "c");
        let raced = CompletedRefresh {
            sequence,
            request: taken,
            outcome: CandidateOutcome::Raced,
        };
        assert!(scheduler.complete(&raced));
        // A raced capture retries after a delay; a newer request preempts it.
        scheduler.retry(raced.request, now);
        assert!(scheduler.take_ready(now).is_none());
        assert_eq!(scheduler.next_ready_at(), Some(now + RETRY_DELAY));
        scheduler.enqueue(request("d", None), now);
        assert_eq!(scheduler.take_ready(now).unwrap().1.source.baseline, "d");
    }

    #[test]
    fn capture_never_rewrites_the_index_the_observer_watches() {
        let (_directory, root, baseline) = repository();
        fs::write(root.join("keep.txt"), "keep\nmore\n").unwrap();
        fs::write(root.join("untracked.txt"), "u\n").unwrap();
        let index = root.join(".git/index");
        let stale = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        fs::File::options()
            .write(true)
            .open(&index)
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let before = fs::read(&index).unwrap();
        let CandidateOutcome::Complete { .. } =
            capture(&root, &request(&baseline, None), &CaptureCache::default())
        else {
            panic!("expected a complete capture")
        };
        assert!(fingerprint_only(&root, "main").is_some());
        assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), stale);
        assert_eq!(fs::read(&index).unwrap(), before);
    }

    #[test]
    fn captures_commits_modifications_and_untracked_files_with_the_python_shape() {
        let (_directory, root, baseline) = repository();
        fs::write(root.join("README.md"), "one\ntwo\nthree\n").unwrap();
        git_ok(&root, &["commit", "-q", "-am", "add three"]);
        fs::write(root.join("new.txt"), "n1\nn2\n").unwrap();
        git_ok(&root, &["add", "new.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "add new"]);
        fs::write(root.join("keep.txt"), "keep\nmore\n").unwrap();
        fs::write(root.join("untracked.txt"), "u1\nu2").unwrap();
        fs::write(root.join("blob.bin"), [0, 1, 2, 3]).unwrap();
        let cache = CaptureCache::default();
        let CandidateOutcome::Complete { capture } =
            capture(&root, &request(&baseline, None), &cache)
        else {
            panic!("expected a complete capture")
        };
        assert_eq!(capture.baseline, baseline);
        assert_eq!(capture.branch.as_deref(), Some("main"));
        assert_eq!(capture.upstream_label, None);
        assert_eq!(capture.ahead, 2);
        assert_eq!(capture.commits.len(), 2);
        assert_eq!(capture.commits[0].subject, "add new");
        assert_eq!(capture.commits[1].subject, "add three");
        assert_eq!(capture.worktrees.as_ref().unwrap()[0].id, "primary");
        assert_eq!(capture.ranges.len(), 4);
        let all = &capture.ranges[0];
        assert_eq!(all.range, Range::All);
        let paths = all
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status))
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                ("README.md", FileStatus::Modified),
                ("blob.bin", FileStatus::Untracked),
                ("keep.txt", FileStatus::Modified),
                ("new.txt", FileStatus::Added),
                ("untracked.txt", FileStatus::Untracked),
            ]
        );
        assert_eq!(all.summary.files, 5);
        assert_eq!(all.summary.additions, 1 + 1 + 2 + 2);
        assert_eq!(all.summary.deletions, 0);
        let readme = &all.files[0];
        assert!(
            readme
                .patch
                .starts_with("diff --git a/README.md b/README.md\n")
        );
        assert!(readme.patch.contains("+three\n"));
        assert!(readme.worktree.as_deref() == Some("primary"));
        let blob = &all.files[1];
        assert!(blob.binary);
        assert_eq!(blob.patch, "");
        let untracked = &all.files[4];
        assert_eq!(untracked.additions, 2);
        assert_eq!(
            untracked.patch,
            "--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1,2 @@\n+u1\n+u2"
        );
        let uncommitted = &capture.ranges[1];
        assert_eq!(uncommitted.range, Range::Uncommitted);
        assert_eq!(
            uncommitted
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["blob.bin", "keep.txt", "untracked.txt"]
        );
        let newest = &capture.ranges[2];
        assert_eq!(
            newest.range,
            Range::Commit {
                sha: capture.commits[0].sha.clone()
            }
        );
        assert_eq!(newest.files.len(), 1);
        assert_eq!(newest.files[0].path, "new.txt");
        assert_eq!(newest.files[0].status, FileStatus::Added);
        assert_eq!(newest.files[0].additions, 2);
        let encoded = serde_json::to_value(&capture).unwrap();
        assert_eq!(encoded["ranges"][0]["range"]["kind"], "all");
        assert_eq!(encoded["ranges"][2]["range"]["kind"], "commit");
        assert_eq!(encoded["ranges"][0]["files"][4]["status"], "untracked");
        assert_eq!(
            encoded["commits"][0]["shortSha"],
            capture.commits[0].short_sha
        );

        // The same fingerprint short-circuits; an edit invalidates it; commit
        // ranges come from the cache on the second pass.
        let unchanged = capture_inner(
            &root,
            &request(&baseline, Some(&capture.fingerprint)),
            &cache,
        )
        .unwrap();
        assert_eq!(
            unchanged,
            CandidateOutcome::Unchanged {
                fingerprint: capture.fingerprint.clone()
            }
        );
        assert_eq!(cache.commit_ranges.lock().unwrap().len(), 2);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(root.join("untracked.txt"), "u1\nu2\nu3\n").unwrap();
        let CandidateOutcome::Complete { capture: second } = capture_inner(
            &root,
            &request(&baseline, Some(&capture.fingerprint)),
            &cache,
        )
        .unwrap() else {
            panic!("expected a new capture after an edit")
        };
        assert_ne!(second.fingerprint, capture.fingerprint);
        assert_eq!(second.ranges[0].files[4].additions, 3);
    }

    #[test]
    fn diffs_a_diverged_branch_from_its_fork_point_with_the_baseline() {
        let (_directory, root, fork) = repository();
        fs::write(root.join("README.md"), "one\ntwo\nmain-only\n").unwrap();
        git_ok(&root, &["commit", "-q", "-am", "main only"]);
        let baseline = git_ok(&root, &["rev-parse", "HEAD"]);
        git_ok(&root, &["checkout", "-q", "-b", "feature", &fork]);
        fs::write(root.join("feature.txt"), "f\n").unwrap();
        git_ok(&root, &["add", "feature.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "feature"]);
        let CandidateOutcome::Complete { capture } =
            capture(&root, &request(&baseline, None), &CaptureCache::default())
        else {
            panic!("expected a complete capture")
        };
        let paths = capture.ranges[0]
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status))
            .collect::<Vec<_>>();
        assert_eq!(paths, [("feature.txt", FileStatus::Added)]);
    }

    #[test]
    fn diffs_unrelated_history_from_the_empty_tree() {
        let (_directory, root, baseline) = repository();
        git_ok(&root, &["checkout", "-q", "--orphan", "unrelated"]);
        git_ok(&root, &["rm", "-r", "-q", "--cached", "."]);
        fs::remove_file(root.join("README.md")).unwrap();
        fs::remove_file(root.join("keep.txt")).unwrap();
        fs::write(root.join("other.txt"), "o\n").unwrap();
        git_ok(&root, &["add", "other.txt"]);
        git_ok(&root, &["commit", "-q", "-m", "unrelated"]);
        let CandidateOutcome::Complete { capture } =
            capture(&root, &request(&baseline, None), &CaptureCache::default())
        else {
            panic!("expected a complete capture")
        };
        let paths = capture.ranges[0]
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status))
            .collect::<Vec<_>>();
        assert_eq!(paths, [("other.txt", FileStatus::Added)]);
    }

    #[test]
    fn empty_tree_baseline_serves_projectless_repositories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]);
        fs::write(root.join("a.txt"), "a\n").unwrap();
        let CandidateOutcome::Complete { capture } =
            capture(&root, &request(EMPTY_TREE, None), &CaptureCache::default())
        else {
            panic!("expected a capture")
        };
        assert_eq!(capture.head, EMPTY_TREE);
        assert_eq!(capture.ahead, 0);
        assert!(capture.commits.is_empty());
        assert_eq!(capture.ranges[0].files[0].status, FileStatus::Untracked);
    }

    #[test]
    fn reports_unavailable_outside_a_repository_and_for_unknown_baselines() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            capture(
                directory.path(),
                &request(&"a".repeat(40), None),
                &CaptureCache::default()
            ),
            CandidateOutcome::Unavailable {
                reason: UnavailableReason::CaptureFailed
            }
        );
        assert_eq!(
            capture(
                Path::new("relative"),
                &request(EMPTY_TREE, None),
                &CaptureCache::default()
            ),
            CandidateOutcome::Unavailable {
                reason: UnavailableReason::SourceUnavailable
            }
        );
    }

    #[test]
    fn limits_patches_by_bytes_and_lines() {
        let long = "x".repeat(MAX_PATCH_BYTES + 10);
        let (patch, truncated) = limited_patch(&long);
        assert!(truncated);
        assert_eq!(patch.len(), MAX_PATCH_BYTES);
        let many = "l\n".repeat(MAX_PATCH_LINES + 5);
        let (patch, truncated) = limited_patch(&many);
        assert!(truncated);
        assert_eq!(patch.lines().count(), MAX_PATCH_LINES);
        assert_eq!(limited_patch("small"), ("small".to_owned(), false));
    }

    #[test]
    fn status_entry_paths_follow_porcelain_v2() {
        assert_eq!(
            status_entry_path("1 .M N... 100644 100644 100644 abc def src/a b.txt"),
            Some("src/a b.txt")
        );
        assert_eq!(status_entry_path("? new file.txt"), Some("new file.txt"));
        assert_eq!(status_entry_path("# branch.head main"), None);
    }
}
