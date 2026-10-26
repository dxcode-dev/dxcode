//! Orb disk: how full the workspace's filesystem is, its largest folders,
//! and deleting a folder that can be rebuilt.
//!
//! Every heartbeat carries [`usage`], so Core sees a filling disk on any
//! provider that runs dxd. Core asks for a [`Disk::snapshot`] only while a
//! person looks at the disk notice: it measures the folders directly in the
//! Thread's home and in its checkout, within [`MEASURE_BUDGET`], on the
//! blocking pool. [`Disk::delete`] removes only a listed dependency, build,
//! or cache folder: never source, never anything Git tracks, never a
//! symlink.

use serde::Serialize;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Folders a snapshot lists, largest first.
pub const LISTED_FOLDERS: usize = 5;
/// A snapshot stops measuring after this long and reports what it has.
pub const MEASURE_BUDGET: Duration = Duration::from_secs(4);
/// Directory entries a snapshot visits at most.
const MEASURE_ENTRIES: u64 = 2_000_000;
const MAX_PATH_BYTES: usize = 512;

/// Folders whose whole content a tool regenerates: dependencies, build
/// output, and caches. Only these get a Delete.
const REBUILDABLE: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    ".npm",
    ".pnpm-store",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// Relative to the Thread's home, as `workspace/repo/node_modules`.
    pub path: String,
    pub bytes: u64,
    /// A dependency, build, or cache folder Git does not track.
    pub rebuildable: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DiskResult {
    Snapshot {
        #[serde(rename = "usedBytes")]
        used_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
        folders: Vec<FolderEntry>,
        /// The time or entry budget ran out: sizes are at least these.
        partial: bool,
    },
    Deleted,
    Refused {
        reason: &'static str,
    },
    Unavailable {
        reason: &'static str,
    },
}

/// The filesystem holding `path`: in use is what the workspace user can no
/// longer write, so blocks reserved for root count as used.
pub fn usage_of(path: &Path) -> Option<DiskUsage> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs fills the zeroed struct; the path is NUL-terminated.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    // Every supported target (x64 and arm64 Linux) has 64-bit fields.
    let unit = stats.f_frsize;
    let total = stats.f_blocks.checked_mul(unit)?;
    let available = stats.f_bavail.checked_mul(unit)?.min(total);
    (total > 0).then_some(DiskUsage {
        used_bytes: total - available,
        total_bytes: total,
    })
}

/// The Thread's home and checkout, shared by every session of this daemon.
#[derive(Clone)]
pub struct Disk {
    home: PathBuf,
    workspace: PathBuf,
    trash: PathBuf,
}

static TRASH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl Disk {
    pub fn new(home: PathBuf, workspace: PathBuf, state_directory: &Path) -> Self {
        Self {
            home,
            workspace,
            trash: state_directory.join("trash"),
        }
    }

    pub fn usage(&self) -> Option<DiskUsage> {
        usage_of(&self.home)
    }

    /// The folders directly in the checkout and in the home (beside the
    /// checkout's own ancestors), largest first.
    pub fn snapshot(&self) -> DiskResult {
        let Some(usage) = self.usage() else {
            return DiskResult::Unavailable {
                reason: "unreadable",
            };
        };
        let mut budget = Budget {
            deadline: Instant::now() + MEASURE_BUDGET,
            entries: 0,
            exhausted: false,
        };
        let device = std::fs::symlink_metadata(&self.home).map(|metadata| metadata.dev());
        let Ok(device) = device else {
            return DiskResult::Unavailable {
                reason: "unreadable",
            };
        };
        let mut folders = Vec::new();
        for parent in [&self.workspace, &self.home] {
            let Ok(entries) = std::fs::read_dir(parent) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                // The home's folder that holds the checkout is the checkout's.
                if parent == &self.home && self.workspace.starts_with(&path) {
                    continue;
                }
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_dir() || metadata.dev() != device {
                    continue;
                }
                let bytes = measure(&path, device, &mut budget);
                let Some(relative) = self.relative(&path) else {
                    continue;
                };
                folders.push((path, relative, bytes));
            }
        }
        folders.sort_by(|left, right| right.2.cmp(&left.2));
        folders.truncate(LISTED_FOLDERS);
        let folders = folders
            .into_iter()
            .map(|(path, relative, bytes)| FolderEntry {
                rebuildable: self.rebuildable(&path),
                path: relative,
                bytes,
            })
            .collect();
        DiskResult::Snapshot {
            used_bytes: usage.used_bytes,
            total_bytes: usage.total_bytes,
            folders,
            partial: budget.exhausted,
        }
    }

    /// Deletes a listed rebuildable folder. It moves out of the way at once
    /// and is removed in the background, so the answer never waits on a
    /// large `node_modules`.
    pub fn delete(&self, relative: &str) -> DiskResult {
        let Some(path) = self.listed_path(relative) else {
            return DiskResult::Refused { reason: "invalid" };
        };
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return DiskResult::Refused { reason: "invalid" },
            Err(_) => return DiskResult::Refused { reason: "missing" },
        }
        if !self.rebuildable(&path) {
            return DiskResult::Refused {
                reason: "protected",
            };
        }
        let staged = self.trash.join(format!(
            "{}-{}",
            std::process::id(),
            TRASH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        // A full disk may have no room for the trash directory itself.
        let moved =
            std::fs::create_dir_all(&self.trash).is_ok() && std::fs::rename(&path, &staged).is_ok();
        if !moved {
            return match std::fs::remove_dir_all(&path) {
                Ok(()) => DiskResult::Deleted,
                Err(_) => DiskResult::Unavailable { reason: "failed" },
            };
        }
        std::thread::spawn(move || {
            let _ = std::fs::remove_dir_all(staged);
        });
        DiskResult::Deleted
    }

    fn relative(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.home).ok()?.to_str()?;
        (!relative.is_empty() && relative.len() <= MAX_PATH_BYTES).then(|| relative.to_owned())
    }

    /// The folder `relative` names, when it is one a snapshot can list: a
    /// direct child of the checkout or of the home, by a plain name.
    fn listed_path(&self, relative: &str) -> Option<PathBuf> {
        if relative.is_empty() || relative.len() > MAX_PATH_BYTES {
            return None;
        }
        let relative = Path::new(relative);
        if !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return None;
        }
        let path = self.home.join(relative);
        let parent = path.parent()?;
        (parent == self.workspace || (parent == self.home && !self.workspace.starts_with(&path)))
            .then_some(path)
    }

    /// A rebuildable name, and, inside the checkout, nothing Git tracks.
    fn rebuildable(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        if !REBUILDABLE.contains(&name) {
            return false;
        }
        if path.parent() != Some(self.workspace.as_path()) {
            return true;
        }
        // A committed `build/` or `dist/` is source. Unknown counts as tracked.
        Command::new("git")
            .arg("-C")
            .arg(&self.workspace)
            .args(["ls-files", "-z", "--"])
            .arg(name)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success() && output.stdout.is_empty())
    }
}

struct Budget {
    deadline: Instant,
    entries: u64,
    exhausted: bool,
}

impl Budget {
    fn spend(&mut self) -> bool {
        if self.exhausted {
            return false;
        }
        self.entries += 1;
        if self.entries > MEASURE_ENTRIES
            || (self.entries % 1024 == 0 && Instant::now() >= self.deadline)
        {
            self.exhausted = true;
        }
        !self.exhausted
    }
}

/// Bytes allocated under `root`, on its own filesystem, without following
/// symlinks: what deleting it would free.
fn measure(root: &Path, device: u64, budget: &mut Budget) -> u64 {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if !budget.spend() {
                return total;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            total = total.saturating_add(metadata.blocks().saturating_mul(512));
            if metadata.is_dir() && metadata.dev() == device {
                pending.push(entry.path());
            }
        }
    }
    total
}
