//! Files inside the Thread checkout: list, read, and compare-and-swap save.
//!
//! Every operation is confined to the checkout root through a `cap_std::fs::Dir`
//! and walks path components one at a time without following symbolic links.

use crate::changes::{RefreshRequest, SourceContext};
use crate::files_sandbox::{self, SandboxReadResult, SandboxRoots};
use crate::worktrees::{self, PRIMARY_WORKTREE};
use cap_std::fs::{Dir, Metadata, OpenOptions};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{Receiver, Sender, channel};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_PATH_BYTES: usize = 1_024;
pub const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_EDITABLE_BYTES: usize = 256 * 1_024;
/// Editor requests (list, read, save) admitted at once, queued or running.
const EDITOR_ADMITTED: usize = 32;
/// Editor requests running at once, so a small read never waits for a large
/// listing to finish.
const EDITOR_WORKERS: usize = 4;
/// Sandbox reads admitted at once. Each holds up to one 4 MiB chunk until the
/// socket writer has sent it, which bounds that memory to 8 chunks.
const STREAMING_ADMITTED: usize = 8;
const STREAMING_WORKERS: usize = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListCursor {
    version: String,
    index: usize,
}

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum FilesOperation {
    #[serde(rename = "files.list")]
    List {
        #[serde(default)]
        worktree: Option<String>,
        path: Option<String>,
        #[serde(default)]
        cursor: Option<ListCursor>,
    },
    #[serde(rename = "files.read")]
    Read {
        #[serde(default)]
        worktree: Option<String>,
        path: String,
    },
    #[serde(rename = "files.save")]
    Save {
        #[serde(default)]
        worktree: Option<String>,
        path: String,
        #[serde(rename = "expectedVersion")]
        expected_version: String,
        content: String,
        #[serde(default)]
        refresh: Option<SaveRefresh>,
    },
    /// Read-only byte range of any regular file in the guest, by absolute path.
    #[serde(rename = "files.readSandbox")]
    ReadSandbox {
        path: String,
        offset: u64,
        length: u64,
        #[serde(rename = "expectedVersion", default)]
        expected_version: Option<String>,
    },
}

impl FilesOperation {
    /// Sandbox streaming reads have their own budget so a media stream never
    /// delays an editor read or save.
    pub fn is_streaming(&self) -> bool {
        matches!(self, Self::ReadSandbox { .. })
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RefreshMessageType {
    ChangesRefresh,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRefresh {
    #[serde(rename = "type")]
    message_type: RefreshMessageType,
    token: String,
    source: SourceContext,
    expected_fingerprint: Option<String>,
}

impl FilesOperation {
    pub fn refresh(&self) -> Option<RefreshRequest> {
        match self {
            Self::Save {
                refresh: Some(refresh),
                ..
            } => {
                let RefreshMessageType::ChangesRefresh = refresh.message_type;
                Some(RefreshRequest {
                    token: refresh.token.clone(),
                    source: refresh.source.clone(),
                    expected_fingerprint: refresh.expected_fingerprint.clone(),
                })
            }
            Self::List { .. }
            | Self::Read { .. }
            | Self::ReadSandbox { .. }
            | Self::Save { refresh: None, .. } => None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    name: String,
    kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadonlyReason {
    Binary,
    Encoding,
    TooLarge,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FilesResult {
    Tree {
        version: String,
        entries: Vec<TreeEntry>,
        #[serde(rename = "nextIndex", skip_serializing_if = "Option::is_none")]
        next_index: Option<usize>,
    },
    Editable {
        version: String,
        content: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Saved {
        version: String,
    },
    Readonly {
        reason: ReadonlyReason,
        content: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Invalid,
    Missing,
    Conflict,
    Unavailable,
    #[serde(untagged)]
    Sandbox(SandboxReadResult),
}

enum FilesError {
    Invalid,
    Missing,
    Conflict,
    Unavailable,
}

impl From<FilesError> for FilesResult {
    fn from(error: FilesError) -> Self {
        match error {
            FilesError::Invalid => Self::Invalid,
            FilesError::Missing => Self::Missing,
            FilesError::Conflict => Self::Conflict,
            FilesError::Unavailable => Self::Unavailable,
        }
    }
}

/// Everything a Files worker needs; shared by every running operation.
pub struct FilesContext {
    pub root: Dir,
    pub workspace_root: std::path::PathBuf,
    pub sandbox: SandboxRoots,
    /// Saves run one at a time so compare-and-swap holds between concurrent
    /// requests: two saves with the same expected version cannot both win.
    save: Mutex<()>,
}

impl FilesContext {
    pub fn open(workspace_root: &Path, sandbox: SandboxRoots) -> io::Result<Self> {
        let root = Dir::open_ambient_dir(workspace_root, cap_std::ambient_authority())?;
        Ok(Self {
            root,
            workspace_root: workspace_root.to_owned(),
            sandbox,
            save: Mutex::new(()),
        })
    }

    pub fn execute(&self, operation: FilesOperation) -> FilesResult {
        match operation {
            FilesOperation::ReadSandbox {
                path,
                offset,
                length,
                expected_version,
            } => FilesResult::Sandbox(files_sandbox::read(
                &self.sandbox,
                &path,
                offset,
                length,
                expected_version.as_deref(),
            )),
            operation @ FilesOperation::Save { .. } => {
                let _serialized = self
                    .save
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                execute_workspace(&self.root, &self.workspace_root, operation)
            }
            operation => execute_workspace(&self.root, &self.workspace_root, operation),
        }
    }
}

/// A finished request. `admission` stays held until the result has left the
/// daemon, so queued sandbox chunks count against their lane's bound.
pub struct FilesDone {
    pub request_id: String,
    pub result: FilesResult,
    pub admission: OwnedSemaphorePermit,
}

struct Lane {
    admitted: Arc<Semaphore>,
    workers: Arc<Semaphore>,
}

impl Lane {
    fn new(admitted: usize, workers: usize) -> Self {
        Self {
            admitted: Arc::new(Semaphore::new(admitted)),
            workers: Arc::new(Semaphore::new(workers)),
        }
    }
}

/// Runs Files operations concurrently on blocking threads with a bounded
/// budget per lane. Work continues across reconnects; results are delivered
/// to whichever session is current.
pub struct FilesWorkers {
    context: Arc<FilesContext>,
    editor: Lane,
    streaming: Lane,
    results: Sender<FilesDone>,
}

impl FilesWorkers {
    pub fn new(context: FilesContext) -> (Self, Receiver<FilesDone>) {
        let (results, receiver) = channel(EDITOR_ADMITTED + STREAMING_ADMITTED);
        (
            Self {
                context: Arc::new(context),
                editor: Lane::new(EDITOR_ADMITTED, EDITOR_WORKERS),
                streaming: Lane::new(STREAMING_ADMITTED, STREAMING_WORKERS),
                results,
            },
            receiver,
        )
    }

    /// Start one request; false when its lane is full.
    pub fn submit(&self, request_id: String, operation: FilesOperation) -> bool {
        let lane = if operation.is_streaming() {
            &self.streaming
        } else {
            &self.editor
        };
        let Ok(admission) = Arc::clone(&lane.admitted).try_acquire_owned() else {
            return false;
        };
        let workers = Arc::clone(&lane.workers);
        let context = Arc::clone(&self.context);
        let results = self.results.clone();
        tokio::spawn(async move {
            let Ok(_worker) = workers.acquire_owned().await else {
                return;
            };
            let result = tokio::task::spawn_blocking(move || context.execute(operation))
                .await
                .unwrap_or(FilesResult::Unavailable);
            let _ = results
                .send(FilesDone {
                    request_id,
                    result,
                    admission,
                })
                .await;
        });
        true
    }
}

pub fn execute(root: &Dir, operation: FilesOperation) -> FilesResult {
    let result = match operation {
        FilesOperation::List { path, cursor, .. } => list(root, path.as_deref(), cursor),
        FilesOperation::Read { path, .. } => read(root, &path),
        FilesOperation::Save {
            path,
            expected_version,
            content,
            ..
        } => save(root, &path, &expected_version, content.as_bytes()),
        FilesOperation::ReadSandbox { .. } => Err(FilesError::Invalid),
    };
    result.unwrap_or_else(FilesResult::from)
}

fn operation_worktree(operation: &FilesOperation) -> Option<&str> {
    match operation {
        FilesOperation::List { worktree, .. }
        | FilesOperation::Read { worktree, .. }
        | FilesOperation::Save { worktree, .. } => worktree.as_deref(),
        FilesOperation::ReadSandbox { .. } => None,
    }
}

fn valid_worktree_id(value: &str) -> bool {
    value.len() == 19
        && value.starts_with("wt_")
        && value[3..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn open_linked_worktree(workspace_root: &Path, requested: &str) -> Result<Dir, FilesError> {
    if !valid_worktree_id(requested) {
        return Err(FilesError::Invalid);
    }
    let selected = worktrees::selected(workspace_root).map_err(|_| FilesError::Unavailable)?;
    let path = selected
        .iter()
        .skip(1)
        .find(|path| worktrees::id(path).as_deref() == Some(requested))
        .ok_or(FilesError::Missing)?;
    Dir::open_ambient_dir(path, cap_std::ambient_authority()).map_err(|_| FilesError::Unavailable)
}

fn execute_workspace(root: &Dir, workspace_root: &Path, operation: FilesOperation) -> FilesResult {
    let selected = match operation_worktree(&operation) {
        None | Some(PRIMARY_WORKTREE) => root.try_clone().map_err(|_| FilesError::Unavailable),
        Some(worktree) => open_linked_worktree(workspace_root, worktree),
    };
    match selected {
        Ok(selected) => execute(&selected, operation),
        Err(error) => error.into(),
    }
}

pub fn valid_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return false;
    }
    path.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part != ".git"
            && !part.starts_with(".dx-files-")
    })
}

fn valid_version(version: &str) -> bool {
    version.len() == 71
        && version.starts_with("sha256:")
        && version[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn path_error(error: io::Error) -> FilesError {
    match error.kind() {
        io::ErrorKind::NotFound => FilesError::Missing,
        io::ErrorKind::PermissionDenied
        | io::ErrorKind::NotADirectory
        | io::ErrorKind::InvalidInput
        | io::ErrorKind::InvalidFilename => FilesError::Invalid,
        _ => FilesError::Unavailable,
    }
}

/// Open one child directory without following a symbolic link at that name.
fn open_child_dir(parent: &Dir, name: &str) -> Result<Dir, FilesError> {
    let metadata = parent.symlink_metadata(name).map_err(path_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(FilesError::Invalid);
    }
    parent.open_dir(name).map_err(path_error)
}

fn open_parent(root: &Dir, path: &str) -> Result<(Dir, String), FilesError> {
    if !valid_path(path) {
        return Err(FilesError::Invalid);
    }
    let parts = path.split('/').collect::<Vec<_>>();
    let mut current = root.try_clone().map_err(|_| FilesError::Unavailable)?;
    for part in &parts[..parts.len() - 1] {
        current = open_child_dir(&current, part)?;
    }
    Ok((current, parts[parts.len() - 1].to_owned()))
}

fn open_directory(root: &Dir, path: Option<&str>) -> Result<Dir, FilesError> {
    let Some(path) = path else {
        return root.try_clone().map_err(|_| FilesError::Unavailable);
    };
    let (parent, name) = open_parent(root, path)?;
    open_child_dir(&parent, &name)
}

fn scan(directory: &Dir) -> Result<Vec<TreeEntry>, FilesError> {
    let mut entries = Vec::new();
    for entry in directory.entries().map_err(|_| FilesError::Unavailable)? {
        let entry = entry.map_err(|_| FilesError::Unavailable)?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == "." || name == ".." || !valid_path(&name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(path_error(error)),
        };
        let file_type = metadata.file_type();
        let (kind, size_bytes) = if file_type.is_symlink() {
            (EntryKind::Symlink, None)
        } else if file_type.is_dir() {
            (EntryKind::Directory, None)
        } else if file_type.is_file() {
            (EntryKind::File, Some(metadata.len()))
        } else {
            continue;
        };
        entries.push(TreeEntry {
            name,
            kind,
            size_bytes,
        });
        if entries.len() > MAX_TREE_ENTRIES {
            return Err(FilesError::Invalid);
        }
    }
    entries.sort_by(|left, right| {
        let folded = left.name.to_lowercase().cmp(&right.name.to_lowercase());
        if folded == Ordering::Equal {
            left.name.cmp(&right.name)
        } else {
            folded
        }
    });
    Ok(entries)
}

fn version_for(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// One response carries the whole directory. A cursor from an older page-based
/// client is still honoured: it selects the suffix starting at `index` when its
/// version matches the current listing.
fn list(
    root: &Dir,
    path: Option<&str>,
    cursor: Option<ListCursor>,
) -> Result<FilesResult, FilesError> {
    let entries = scan(&open_directory(root, path)?)?;
    let encoded = serde_json::to_vec(&entries).map_err(|_| FilesError::Unavailable)?;
    let version = version_for(&encoded);
    let start = match cursor {
        None => 0,
        Some(cursor) => {
            if !valid_version(&cursor.version)
                || cursor.index == 0
                || cursor.index > MAX_TREE_ENTRIES
            {
                return Err(FilesError::Invalid);
            }
            if cursor.version != version {
                return Err(FilesError::Conflict);
            }
            cursor.index
        }
    };
    if start > entries.len() {
        return Err(FilesError::Conflict);
    }
    Ok(FilesResult::Tree {
        version,
        entries: entries[start..].to_vec(),
        next_index: None,
    })
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn read_regular(parent: &Dir, name: &str) -> Result<(Vec<u8>, Metadata), FilesError> {
    let before = parent.symlink_metadata(name).map_err(path_error)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(FilesError::Invalid);
    }
    let file = parent
        .open_with(name, OpenOptions::new().read(true))
        .map_err(path_error)?;
    let opened = file.metadata().map_err(|_| FilesError::Unavailable)?;
    if !same_file(&before, &opened) {
        return Err(FilesError::Conflict);
    }
    let mut file = file.into_std();
    let mut bytes = Vec::with_capacity((before.len() as usize).min(MAX_EDITABLE_BYTES + 1));
    Read::by_ref(&mut file)
        .take((MAX_EDITABLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| FilesError::Unavailable)?;
    let after = file.metadata().map_err(|_| FilesError::Unavailable)?;
    let after = Metadata::from_just_metadata(after);
    if !same_file(&before, &after)
        || (bytes.len() <= MAX_EDITABLE_BYTES && bytes.len() as u64 != before.len())
    {
        return Err(FilesError::Conflict);
    }
    Ok((bytes, before))
}

fn read(root: &Dir, path: &str) -> Result<FilesResult, FilesError> {
    let (parent, name) = open_parent(root, path)?;
    let (bytes, before) = read_regular(&parent, &name)?;
    let size_bytes = before.len();
    if bytes.len() > MAX_EDITABLE_BYTES || size_bytes > MAX_EDITABLE_BYTES as u64 {
        return Ok(FilesResult::Readonly {
            reason: ReadonlyReason::TooLarge,
            content: String::new(),
            size_bytes,
        });
    }
    if bytes.contains(&0) {
        return Ok(FilesResult::Readonly {
            reason: ReadonlyReason::Binary,
            content: String::new(),
            size_bytes,
        });
    }
    let version = version_for(&bytes);
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FilesResult::Editable {
            version,
            content,
            size_bytes,
        }),
        Err(_) => Ok(FilesResult::Readonly {
            reason: ReadonlyReason::Encoding,
            content: String::new(),
            size_bytes,
        }),
    }
}

fn sync_directory(directory: &Dir) -> Result<(), FilesError> {
    // The Dir handle itself is a path-only descriptor; fsync needs a readable one.
    let file = directory
        .open_with(".", OpenOptions::new().read(true))
        .map_err(|_| FilesError::Unavailable)?
        .into_std();
    file.sync_all().map_err(|_| FilesError::Unavailable)
}

fn save(
    root: &Dir,
    path: &str,
    expected_version: &str,
    content: &[u8],
) -> Result<FilesResult, FilesError> {
    if !valid_version(expected_version)
        || content.len() > MAX_EDITABLE_BYTES
        || content.contains(&0)
    {
        return Err(FilesError::Invalid);
    }
    let (parent, name) = open_parent(root, path)?;
    let (current, before) = read_regular(&parent, &name)?;
    if current.len() > MAX_EDITABLE_BYTES {
        return Err(FilesError::Invalid);
    }
    if version_for(&current) != expected_version {
        return Err(FilesError::Conflict);
    }

    let temporary = format!(".dx-files-{:032x}", rand::rng().random::<u128>());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    {
        use cap_std::fs::{MetadataExt, OpenOptionsExt};
        options.mode(before.mode() & 0o7777);
    }
    let file = parent.open_with(&temporary, &options).map_err(path_error)?;
    let write_result = (|| {
        let mut file = file.into_std();
        file.write_all(content)
            .map_err(|_| FilesError::Unavailable)?;
        {
            use cap_std::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(before.mode() & 0o7777))
                .map_err(|_| FilesError::Unavailable)?;
        }
        file.sync_all().map_err(|_| FilesError::Unavailable)
    })();
    if let Err(error) = write_result {
        let _ = parent.remove_file(&temporary);
        return Err(error);
    }
    // The target was verified unchanged above; rename is atomic, and the
    // temporary carries the original mode.
    if let Err(error) = parent.rename(&temporary, &parent, &name) {
        let _ = parent.remove_file(&temporary);
        return Err(path_error(error));
    }
    sync_directory(&parent)?;
    Ok(FilesResult::Saved {
        version: version_for(content),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn root() -> (TempDir, Dir) {
        let directory = tempfile::tempdir().unwrap();
        let root = Dir::open_ambient_dir(directory.path(), cap_std::ambient_authority()).unwrap();
        (directory, root)
    }

    fn operation(value: serde_json::Value) -> FilesOperation {
        serde_json::from_value(value).unwrap()
    }

    fn json(result: FilesResult) -> serde_json::Value {
        serde_json::to_value(result).unwrap()
    }

    fn git(root: &Path, arguments: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(arguments)
                .output()
                .unwrap()
                .status
                .success()
        );
    }

    fn save_operation(path: &str, expected_version: &str, content: &str) -> FilesOperation {
        operation(serde_json::json!({
            "operation": "files.save",
            "path": path,
            "expectedVersion": expected_version,
            "content": content,
        }))
    }

    #[test]
    fn confines_traversal_and_lists_but_never_follows_symlinks() {
        let (directory, root) = root();
        fs::create_dir_all(directory.path().join("src/nested")).unwrap();
        fs::write(directory.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(directory.path().join("src/nested/deep.txt"), "deep").unwrap();
        {
            std::os::unix::fs::symlink("/etc", directory.path().join("src/link")).unwrap();
            std::os::unix::fs::symlink("main.rs", directory.path().join("src/alias.rs")).unwrap();
        }
        let listed = json(execute(
            &root,
            operation(serde_json::json!({"operation": "files.list", "path": "src"})),
        ));
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"main.rs"));
        assert!(names.contains(&"nested"));
        assert!(listed["nextIndex"].is_null());
        {
            assert!(
                listed["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["name"] == "link" && entry["kind"] == "symlink")
            );
            assert_eq!(
                json(execute(
                    &root,
                    operation(
                        serde_json::json!({"operation": "files.read", "path": "src/alias.rs"})
                    )
                ))["kind"],
                "invalid"
            );
            assert_eq!(
                json(execute(
                    &root,
                    operation(serde_json::json!({"operation": "files.list", "path": "src/link"}))
                ))["kind"],
                "invalid"
            );
        }
        for path in [
            "../etc",
            "src/../src",
            "/src",
            ".git/config",
            "src//main.rs",
        ] {
            assert_eq!(
                json(execute(
                    &root,
                    operation(serde_json::json!({"operation": "files.read", "path": path}))
                ))["kind"],
                "invalid",
                "{path}"
            );
        }
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({"operation": "files.read", "path": "src/absent.rs"}))
            ))["kind"],
            "missing"
        );
    }

    #[test]
    fn lists_whole_directories_sorted_and_versioned() {
        let (directory, root) = root();
        for index in 0..250 {
            fs::write(directory.path().join(format!("f{index:03}.txt")), "x").unwrap();
        }
        fs::write(directory.path().join("B.txt"), "x").unwrap();
        fs::write(directory.path().join("a.txt"), "x").unwrap();
        let listed = json(execute(
            &root,
            operation(serde_json::json!({"operation": "files.list", "path": null})),
        ));
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 252);
        assert_eq!(entries[0]["name"], "a.txt");
        assert_eq!(entries[1]["name"], "B.txt");
        assert!(listed["nextIndex"].is_null());
        let version = listed["version"].as_str().unwrap().to_owned();
        let suffix = json(execute(
            &root,
            operation(serde_json::json!({
                "operation": "files.list",
                "path": null,
                "cursor": {"version": version, "index": 250},
            })),
        ));
        assert_eq!(suffix["entries"].as_array().unwrap().len(), 2);
        fs::write(directory.path().join("z.txt"), "x").unwrap();
        let stale = json(execute(
            &root,
            operation(serde_json::json!({
                "operation": "files.list",
                "path": null,
                "cursor": {"version": version, "index": 1},
            })),
        ));
        assert_eq!(stale["kind"], "conflict");
    }

    #[test]
    fn classifies_complete_bounded_reads() {
        let (directory, root) = root();
        fs::write(directory.path().join("text.txt"), "hello\n").unwrap();
        fs::write(directory.path().join("binary.bin"), [0, 1, 2]).unwrap();
        fs::write(directory.path().join("latin1.txt"), [0xff, 0xfe]).unwrap();
        fs::write(
            directory.path().join("large.txt"),
            vec![b'a'; MAX_EDITABLE_BYTES + 1],
        )
        .unwrap();
        let read = |path: &str| {
            json(execute(
                &root,
                operation(serde_json::json!({"operation": "files.read", "path": path})),
            ))
        };
        let text = read("text.txt");
        assert_eq!(text["kind"], "editable");
        assert_eq!(text["content"], "hello\n");
        assert_eq!(text["sizeBytes"], 6);
        assert_eq!(text["version"], version_for(b"hello\n"));
        assert_eq!(read("binary.bin")["reason"], "binary");
        assert_eq!(read("latin1.txt")["reason"], "encoding");
        let large = read("large.txt");
        assert_eq!(large["reason"], "too-large");
        assert_eq!(large["sizeBytes"], MAX_EDITABLE_BYTES + 1);
    }

    #[test]
    fn atomically_saves_the_expected_regular_file_and_preserves_its_mode() {
        let (directory, root) = root();
        let path = directory.path().join("script.sh");
        fs::write(&path, "old\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let saved = json(execute(
            &root,
            save_operation("script.sh", &version_for(b"old\n"), "new\n"),
        ));
        assert_eq!(saved["kind"], "saved");
        assert_eq!(saved["version"], version_for(b"new\n"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dx-files-")
        }));
    }

    #[test]
    fn conflicts_without_replacement_when_the_expected_content_is_stale() {
        let (directory, root) = root();
        let path = directory.path().join("notes.md");
        fs::write(&path, "current\n").unwrap();
        let conflict = json(execute(
            &root,
            save_operation("notes.md", &version_for(b"stale\n"), "new\n"),
        ));
        assert_eq!(conflict["kind"], "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "current\n");
    }

    #[test]
    fn concurrent_saves_with_one_expected_version_have_exactly_one_winner() {
        let (directory, _) = root();
        fs::write(directory.path().join("race.txt"), "base\n").unwrap();
        let context =
            std::sync::Arc::new(FilesContext::open(directory.path(), SandboxRoots::Guest).unwrap());
        let expected = version_for(b"base\n");
        let outcomes = (0..8)
            .map(|index| {
                let context = std::sync::Arc::clone(&context);
                let expected = expected.clone();
                std::thread::spawn(move || {
                    json(context.execute(save_operation(
                        "race.txt",
                        &expected,
                        &format!("writer {index}\n"),
                    )))["kind"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
            })
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|kind| *kind == "saved").count(), 1);
        assert_eq!(
            outcomes.iter().filter(|kind| *kind == "conflict").count(),
            7
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_small_read_finishes_while_large_listings_run_and_lanes_stay_bounded() {
        let (directory, _) = root();
        fs::create_dir(directory.path().join("big")).unwrap();
        for index in 0..MAX_TREE_ENTRIES - 1 {
            fs::write(directory.path().join(format!("big/{index:05}")), "").unwrap();
        }
        fs::write(directory.path().join("small.txt"), "small\n").unwrap();
        let (workers, mut results) =
            FilesWorkers::new(FilesContext::open(directory.path(), SandboxRoots::Guest).unwrap());
        let list = || operation(serde_json::json!({"operation": "files.list", "path": "big"}));
        for index in 0..3 {
            assert!(workers.submit(format!("list-{index}"), list()));
        }
        assert!(workers.submit(
            "read".into(),
            operation(serde_json::json!({"operation": "files.read", "path": "small.txt"}))
        ));
        let first = results.recv().await.unwrap();
        assert_eq!(first.request_id, "read", "the read waited behind a listing");
        assert_eq!(json(first.result)["content"], "small\n");
        drop(first.admission);
        for _ in 0..3 {
            let listed = results.recv().await.unwrap();
            assert_eq!(
                json(listed.result)["entries"].as_array().unwrap().len(),
                MAX_TREE_ENTRIES - 1
            );
        }

        // Admission is bounded, and a permit held by an undelivered result
        // keeps its slot taken.
        let sandbox = |index: u64| {
            operation(serde_json::json!({
                "operation": "files.readSandbox", "path": "/proc/self/status",
                "offset": index, "length": 1,
            }))
        };
        for index in 0..STREAMING_ADMITTED as u64 {
            assert!(workers.submit(format!("sandbox-{index}"), sandbox(index)));
        }
        assert!(!workers.submit("overflow".into(), sandbox(99)));
        let held = results.recv().await.unwrap();
        assert!(!workers.submit("still-full".into(), sandbox(99)));
        drop(held);
        assert!(workers.submit("admitted".into(), sandbox(99)));
    }

    #[test]
    fn rejects_symlinks_invalid_versions_and_oversized_content_before_saving() {
        let (directory, root) = root();
        fs::write(directory.path().join("real.txt"), "x\n").unwrap();
        {
            std::os::unix::fs::symlink("real.txt", directory.path().join("link.txt")).unwrap();
            assert_eq!(
                json(execute(
                    &root,
                    save_operation("link.txt", &version_for(b"x\n"), "y\n")
                ))["kind"],
                "invalid"
            );
        }
        assert_eq!(
            json(execute(
                &root,
                save_operation("real.txt", "sha256:short", "y\n")
            ))["kind"],
            "invalid"
        );
        let oversized = "a".repeat(MAX_EDITABLE_BYTES + 1);
        assert_eq!(
            json(execute(
                &root,
                save_operation("real.txt", &version_for(b"x\n"), &oversized)
            ))["kind"],
            "invalid"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("real.txt")).unwrap(),
            "x\n"
        );
    }

    #[test]
    fn lists_reads_and_saves_only_selected_linked_worktrees() {
        let (directory, _) = root();
        let primary = directory.path().join("primary");
        fs::create_dir_all(&primary).unwrap();
        git(&primary, &["init", "-q", "-b", "main"]);
        git(&primary, &["config", "user.email", "a@b.c"]);
        git(&primary, &["config", "user.name", "a"]);
        fs::write(primary.join("README.md"), "primary\n").unwrap();
        git(&primary, &["add", "README.md"]);
        git(&primary, &["commit", "-q", "-m", "init"]);
        let linked = directory.path().join("linked");
        git(
            &primary,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        fs::write(linked.join("README.md"), "linked\n").unwrap();
        let context = FilesContext::open(&primary, SandboxRoots::Guest).unwrap();
        let linked_id = worktrees::id(&linked.canonicalize().unwrap()).unwrap();
        let read = json(context.execute(operation(serde_json::json!({
            "operation": "files.read",
            "worktree": linked_id,
            "path": "README.md",
        }))));
        assert_eq!(read["content"], "linked\n");
        let primary_read = json(context.execute(operation(serde_json::json!({
            "operation": "files.read",
            "worktree": "primary",
            "path": "README.md",
        }))));
        assert_eq!(primary_read["content"], "primary\n");
        assert_eq!(
            json(context.execute(operation(serde_json::json!({
                "operation": "files.read",
                "worktree": "wt_0000000000000000",
                "path": "README.md",
            }))))["kind"],
            "missing"
        );
        assert_eq!(
            json(context.execute(operation(serde_json::json!({
                "operation": "files.read",
                "worktree": "../linked",
                "path": "README.md",
            }))))["kind"],
            "invalid"
        );
    }

    #[test]
    fn enforces_path_and_cursor_bounds() {
        let (_directory, root) = root();
        let long = "a".repeat(MAX_PATH_BYTES + 1);
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({"operation": "files.read", "path": long}))
            ))["kind"],
            "invalid"
        );
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({
                    "operation": "files.list",
                    "path": null,
                    "cursor": {"version": format!("sha256:{}", "a".repeat(64)), "index": 10001},
                }))
            ))["kind"],
            "invalid"
        );
    }
}
