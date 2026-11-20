use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MAX_WORKTREES: usize = 12;
pub const PRIMARY_WORKTREE: &str = "primary";

pub fn id(path: &Path) -> Option<String> {
    let value = path.to_str()?;
    Some(format!("wt_{:x}", Sha256::digest(value.as_bytes()))[..19].to_owned())
}

/// `~/workspace/repos` beside the primary checkout (`~/workspace/repo`):
/// where a Project's other repositories are cloned and where agents put
/// worktrees, so the Files and Changes panes show each one.
pub fn repositories_root(primary: &Path) -> Option<PathBuf> {
    primary.parent().map(|parent| parent.join("repos"))
}

/// Each Git checkout directly under `repositories_root`, sorted. Hidden
/// entries, such as dx's in-progress `.dx-clone-*` directories, are skipped.
pub fn repository_checkouts(primary: &Path) -> Vec<PathBuf> {
    let Some(root) = repositories_root(primary) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| entry.path().canonicalize().ok())
        .filter(|path| path.is_dir() && path.join(".git").exists() && path != primary)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

/// Whether a checkout is a linked worktree (its `.git` is a file) rather than
/// a repository of its own.
pub fn is_linked_worktree(path: &Path) -> bool {
    path.join(".git").is_file()
}

/// The checkouts shown besides the primary one, in order: those under
/// `repositories_root`, then the primary's other linked worktrees. Returns
/// at most `MAX_WORKTREES - 1` and whether more were left out.
pub fn candidates(primary: &Path, linked: Vec<PathBuf>) -> (Vec<PathBuf>, bool) {
    let mut linked = linked
        .into_iter()
        .filter(|path| path != primary)
        .collect::<Vec<_>>();
    linked.sort();
    let mut ordered = repository_checkouts(primary);
    for path in linked {
        if !ordered.contains(&path) {
            ordered.push(path);
        }
    }
    let truncated = ordered.len() > MAX_WORKTREES - 1;
    ordered.truncate(MAX_WORKTREES - 1);
    (ordered, truncated)
}

/// The path is the top of its own checkout, not a folder inside another.
fn is_toplevel(path: &Path) -> bool {
    let Ok(output) = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
    else {
        return false;
    };
    output.status.success()
        && std::str::from_utf8(&output.stdout)
            .ok()
            .and_then(|value| PathBuf::from(value.trim()).canonicalize().ok())
            .is_some_and(|top| top == path)
}

pub fn selected(workspace_root: &Path) -> io::Result<Vec<PathBuf>> {
    let primary = workspace_root.canonicalize()?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&primary)
        .args(["worktree", "list", "--porcelain"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()?;
    if !output.status.success() {
        return Err(io::ErrorKind::Other.into());
    }
    let value = std::str::from_utf8(&output.stdout).map_err(|_| io::ErrorKind::InvalidData)?;
    let linked = value
        .split("\n\n")
        .filter(|record| {
            !record
                .lines()
                .any(|line| line == "bare" || line.starts_with("prunable"))
        })
        .filter_map(|record| {
            record
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
        })
        .filter_map(|path| PathBuf::from(path).canonicalize().ok())
        .collect::<Vec<_>>();
    if !linked.contains(&primary) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let (candidates, _) = candidates(&primary, linked);
    let mut selected = vec![primary];
    selected.extend(candidates.into_iter().filter(|path| is_toplevel(path)));
    Ok(selected)
}
