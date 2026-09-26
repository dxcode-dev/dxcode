use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MAX_WORKTREES: usize = 5;
pub const PRIMARY_WORKTREE: &str = "primary";

pub fn id(path: &Path) -> Option<String> {
    let value = path.to_str()?;
    Some(format!("wt_{:x}", Sha256::digest(value.as_bytes()))[..19].to_owned())
}

pub fn selected(workspace_root: &Path) -> io::Result<Vec<PathBuf>> {
    let primary = workspace_root.canonicalize()?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&primary)
        .args(["worktree", "list", "--porcelain"])
        .output()?;
    if !output.status.success() {
        return Err(io::ErrorKind::Other.into());
    }
    let value = std::str::from_utf8(&output.stdout).map_err(|_| io::ErrorKind::InvalidData)?;
    let mut candidates = value
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
    if !candidates.contains(&primary) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    candidates.sort();
    candidates.dedup();
    candidates.retain(|path| path != &primary);
    candidates.truncate(MAX_WORKTREES - 1);
    let mut selected = vec![primary.clone()];
    selected.extend(candidates.into_iter().filter_map(|path| {
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = std::str::from_utf8(&output.stdout).ok()?.trim();
        let top = PathBuf::from(value).canonicalize().ok()?;
        (top == path).then_some(top)
    }));
    Ok(selected)
}
