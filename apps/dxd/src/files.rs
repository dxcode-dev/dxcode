use crate::changes::{RefreshRequest, SourceContext};
use crate::files_sandbox::{self, SandboxReadResult, SandboxRoots};
use crate::worktrees::{self, PRIMARY_WORKTREE};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

const WORK_QUEUE_CAPACITY: usize = 32;

const MAX_PATH_BYTES: usize = 1_024;
const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_TREE_PAGE_SIZE: usize = 100;
const MAX_EDITABLE_BYTES: usize = 256 * 1_024;

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

pub struct WorkerRequest {
    pub request_id: String,
    pub operation: FilesOperation,
}

pub struct CompletedOperation {
    pub request_id: String,
    pub result: FilesResult,
}

/// Files operations can traverse or read a large directory. Keep that work
/// off the connection loop, but use one bounded worker so requests and their
/// resulting responses keep their accepted order.
pub fn start_worker(
    root: &File,
    workspace_root: &Path,
    sandbox: SandboxRoots,
) -> io::Result<(SyncSender<WorkerRequest>, Receiver<CompletedOperation>)> {
    let root = root.try_clone()?;
    let workspace_root = workspace_root.to_owned();
    let (requests, receiver) = mpsc::sync_channel::<WorkerRequest>(WORK_QUEUE_CAPACITY);
    let (completed, results) = mpsc::sync_channel::<CompletedOperation>(WORK_QUEUE_CAPACITY);
    thread::spawn(move || {
        while let Ok(request) = receiver.recv() {
            if completed
                .send(CompletedOperation {
                    request_id: request.request_id,
                    result: match request.operation {
                        FilesOperation::ReadSandbox {
                            path,
                            offset,
                            length,
                            expected_version,
                        } => FilesResult::Sandbox(files_sandbox::read(
                            &sandbox,
                            &path,
                            offset,
                            length,
                            expected_version.as_deref(),
                        )),
                        operation => execute_workspace(&root, &workspace_root, operation),
                    },
                })
                .is_err()
            {
                return;
            }
        }
    });
    Ok((requests, results))
}

pub fn try_submit(
    worker: &SyncSender<WorkerRequest>,
    request: WorkerRequest,
) -> Result<(), TrySendError<WorkerRequest>> {
    worker.try_send(request)
}

pub fn next_completed(receiver: &Receiver<CompletedOperation>) -> Option<CompletedOperation> {
    match receiver.try_recv() {
        Ok(completed) => Some(completed),
        Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
    }
}

pub fn execute(root: &File, operation: FilesOperation) -> FilesResult {
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
    match result {
        Ok(result) => result,
        Err(FilesError::Invalid) => FilesResult::Invalid,
        Err(FilesError::Missing) => FilesResult::Missing,
        Err(FilesError::Conflict) => FilesResult::Conflict,
        Err(FilesError::Unavailable) => FilesResult::Unavailable,
    }
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
    value == PRIMARY_WORKTREE
        || value.strip_prefix("wt_").is_some_and(|digest| {
            digest.len() == 16
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn worktree_id(path: &Path) -> Result<String, FilesError> {
    worktrees::id(path).ok_or(FilesError::Unavailable)
}

fn linked_worktrees(workspace_root: &Path) -> Result<Vec<PathBuf>, FilesError> {
    Ok(worktrees::selected(workspace_root)
        .map_err(|_| FilesError::Unavailable)?
        .into_iter()
        .skip(1)
        .collect())
}

fn open_linked_worktree(workspace_root: &Path, requested: &str) -> Result<File, FilesError> {
    if !valid_worktree_id(requested) || requested == PRIMARY_WORKTREE {
        return Err(FilesError::Invalid);
    }
    let path = linked_worktrees(workspace_root)?
        .into_iter()
        .find(|path| worktree_id(path).is_ok_and(|id| id == requested))
        .ok_or(FilesError::Missing)?;
    File::open(path).map_err(|_| FilesError::Unavailable)
}

fn execute_workspace(root: &File, workspace_root: &Path, operation: FilesOperation) -> FilesResult {
    let selected = match operation_worktree(&operation) {
        None | Some(PRIMARY_WORKTREE) => root.try_clone().map_err(|_| FilesError::Unavailable),
        Some(worktree) => open_linked_worktree(workspace_root, worktree),
    };
    match selected {
        Ok(selected) => execute(&selected, operation),
        Err(FilesError::Invalid) => FilesResult::Invalid,
        Err(FilesError::Missing) => FilesResult::Missing,
        Err(FilesError::Conflict) => FilesResult::Conflict,
        Err(FilesError::Unavailable) => FilesResult::Unavailable,
    }
}

fn valid_path(path: &str) -> bool {
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

fn duplicate(fd: RawFd) -> Result<OwnedFd, FilesError> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        Err(FilesError::Unavailable)
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
    }
}

fn open_at(directory: RawFd, name: &str, flags: libc::c_int) -> Result<OwnedFd, FilesError> {
    let name = CString::new(name).map_err(|_| FilesError::Invalid)?;
    let fd = unsafe { libc::openat(directory, name.as_ptr(), flags, 0) };
    if fd < 0 {
        Err(path_error(io::Error::last_os_error()))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn create_at(
    directory: RawFd,
    name: &str,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<OwnedFd, FilesError> {
    let name = CString::new(name).map_err(|_| FilesError::Invalid)?;
    let fd = unsafe { libc::openat(directory, name.as_ptr(), flags, mode) };
    if fd < 0 {
        Err(path_error(io::Error::last_os_error()))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn path_error(error: io::Error) -> FilesError {
    match error.raw_os_error() {
        Some(libc::ENOENT) => FilesError::Missing,
        Some(
            libc::ELOOP
            | libc::ENOTDIR
            | libc::ENAMETOOLONG
            | libc::EINVAL
            | libc::EACCES
            | libc::EPERM,
        ) => FilesError::Invalid,
        _ => FilesError::Unavailable,
    }
}

fn open_parent(root: &File, path: &str) -> Result<(OwnedFd, String), FilesError> {
    if !valid_path(path) {
        return Err(FilesError::Invalid);
    }
    let parts = path.split('/').collect::<Vec<_>>();
    let mut current = duplicate(root.as_raw_fd())?;
    for part in &parts[..parts.len() - 1] {
        current = open_at(
            current.as_raw_fd(),
            part,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )?;
    }
    Ok((current, parts[parts.len() - 1].to_owned()))
}

fn open_directory(root: &File, path: Option<&str>) -> Result<OwnedFd, FilesError> {
    let Some(path) = path else {
        return open_at(
            root.as_raw_fd(),
            ".",
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        );
    };
    let (parent, name) = open_parent(root, path)?;
    open_at(
        parent.as_raw_fd(),
        &name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn scan(directory: OwnedFd) -> Result<Vec<TreeEntry>, FilesError> {
    let stream_fd = duplicate(directory.as_raw_fd())?;
    let stream = unsafe { libc::fdopendir(stream_fd.as_raw_fd()) };
    if stream.is_null() {
        return Err(FilesError::Unavailable);
    }
    std::mem::forget(stream_fd);
    let stream = DirectoryStream(stream);
    let mut entries = Vec::new();
    loop {
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let errno = unsafe { *libc::__errno_location() };
            if errno != 0 {
                return Err(FilesError::Unavailable);
            }
            break;
        }
        let name_bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        let Ok(name) = std::str::from_utf8(name_bytes) else {
            continue;
        };
        if name == "." || name == ".." || !valid_path(name) {
            continue;
        }
        let name_c = CString::new(name).map_err(|_| FilesError::Invalid)?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        let status = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name_c.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if status < 0 {
            return Err(path_error(io::Error::last_os_error()));
        }
        let metadata = unsafe { metadata.assume_init() };
        let (kind, size_bytes) = match metadata.st_mode & libc::S_IFMT {
            libc::S_IFLNK => (EntryKind::Symlink, None),
            libc::S_IFDIR => (EntryKind::Directory, None),
            libc::S_IFREG if metadata.st_size >= 0 => {
                (EntryKind::File, Some(metadata.st_size as u64))
            }
            libc::S_IFREG => return Err(FilesError::Unavailable),
            _ => continue,
        };
        entries.push(TreeEntry {
            name: name.to_owned(),
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

fn list(
    root: &File,
    path: Option<&str>,
    cursor: Option<ListCursor>,
) -> Result<FilesResult, FilesError> {
    let entries = scan(open_directory(root, path)?)?;
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
    let end = (start + MAX_TREE_PAGE_SIZE).min(entries.len());
    Ok(FilesResult::Tree {
        version,
        entries: entries[start..end].to_vec(),
        next_index: (end < entries.len()).then_some(end),
    })
}

fn file_metadata(fd: RawFd) -> Result<libc::stat, FilesError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } < 0 {
        Err(FilesError::Unavailable)
    } else {
        Ok(unsafe { metadata.assume_init() })
    }
}

fn same_file(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode == right.st_mode
        && left.st_size == right.st_size
        && left.st_mtime == right.st_mtime
        && left.st_mtime_nsec == right.st_mtime_nsec
        && left.st_ctime == right.st_ctime
        && left.st_ctime_nsec == right.st_ctime_nsec
}

fn read_regular(parent: RawFd, name: &str) -> Result<(Vec<u8>, libc::stat), FilesError> {
    let descriptor = open_at(
        parent,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )?;
    let before = file_metadata(descriptor.as_raw_fd())?;
    if before.st_mode & libc::S_IFMT != libc::S_IFREG || before.st_size < 0 {
        return Err(FilesError::Invalid);
    }
    let mut file = File::from(descriptor);
    let mut bytes = Vec::with_capacity((before.st_size as usize).min(MAX_EDITABLE_BYTES + 1));
    Read::by_ref(&mut file)
        .take((MAX_EDITABLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| FilesError::Unavailable)?;
    let after = file_metadata(file.as_raw_fd())?;
    if !same_file(&before, &after)
        || (bytes.len() <= MAX_EDITABLE_BYTES && bytes.len() as i64 != before.st_size)
    {
        return Err(FilesError::Conflict);
    }
    Ok((bytes, before))
}

fn read(root: &File, path: &str) -> Result<FilesResult, FilesError> {
    let (parent, name) = open_parent(root, path)?;
    let (bytes, before) = read_regular(parent.as_raw_fd(), &name)?;
    let size_bytes = before.st_size as u64;
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

fn unlink_at(directory: RawFd, name: &str) {
    if let Ok(name) = CString::new(name) {
        unsafe {
            libc::unlinkat(directory, name.as_ptr(), 0);
        }
    }
}

fn exchange_at(directory: RawFd, source: &str, target: &str) -> Result<(), FilesError> {
    let source = CString::new(source).map_err(|_| FilesError::Invalid)?;
    let target = CString::new(target).map_err(|_| FilesError::Invalid)?;
    if unsafe {
        libc::renameat2(
            directory,
            source.as_ptr(),
            directory,
            target.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    } < 0
    {
        Err(path_error(io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn save(
    root: &File,
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
    let (current, before) = read_regular(parent.as_raw_fd(), &name)?;
    if current.len() > MAX_EDITABLE_BYTES {
        return Err(FilesError::Invalid);
    }
    if version_for(&current) != expected_version {
        return Err(FilesError::Conflict);
    }

    let temporary = format!(".dx-files-{:032x}", rand::rng().random::<u128>());
    let mode = (before.st_mode & 0o7777) as libc::mode_t;
    let descriptor = create_at(
        parent.as_raw_fd(),
        &temporary,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        mode,
    )?;
    let write_result = (|| {
        let mut file = File::from(descriptor);
        file.write_all(content)
            .map_err(|_| FilesError::Unavailable)?;
        if unsafe { libc::fchmod(file.as_raw_fd(), mode) } < 0 {
            return Err(FilesError::Unavailable);
        }
        file.sync_all().map_err(|_| FilesError::Unavailable)
    })();
    if let Err(error) = write_result {
        unlink_at(parent.as_raw_fd(), &temporary);
        return Err(error);
    }

    if let Err(error) = exchange_at(parent.as_raw_fd(), &temporary, &name) {
        unlink_at(parent.as_raw_fd(), &temporary);
        return Err(error);
    }
    let replaced = read_regular(parent.as_raw_fd(), &temporary);
    let replacement_error = match &replaced {
        Ok((bytes, _))
            if bytes.len() <= MAX_EDITABLE_BYTES && version_for(bytes) == expected_version =>
        {
            None
        }
        Ok(_) | Err(FilesError::Invalid | FilesError::Missing | FilesError::Conflict) => {
            Some(FilesError::Conflict)
        }
        Err(FilesError::Unavailable) => Some(FilesError::Unavailable),
    };
    if let Some(error) = replacement_error {
        if exchange_at(parent.as_raw_fd(), &temporary, &name).is_err() {
            return Err(FilesError::Unavailable);
        }
        unlink_at(parent.as_raw_fd(), &temporary);
        if unsafe { libc::fsync(parent.as_raw_fd()) } < 0 {
            return Err(FilesError::Unavailable);
        }
        return Err(error);
    }
    unlink_at(parent.as_raw_fd(), &temporary);
    if unsafe { libc::fsync(parent.as_raw_fd()) } < 0 {
        return Err(FilesError::Unavailable);
    }
    Ok(FilesResult::Saved {
        version: version_for(content),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::TempDir;

    fn root() -> (TempDir, File) {
        let directory = TempDir::new().unwrap();
        let root = File::open(directory.path()).unwrap();
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
                .args(["-c", "commit.gpgsign=false"])
                .arg("-C")
                .arg(root)
                .args(arguments)
                .status()
                .unwrap()
                .success()
        );
    }

    fn save_operation(path: &str, expected_version: &str, content: &str) -> FilesOperation {
        operation(serde_json::json!({
            "operation": "files.save",
            "path": path,
            "expectedVersion": expected_version,
            "content": content,
            "refresh": {
                "type": "changes-refresh",
                "token": "opaque-refresh-token",
                "source": {
                    "baseline": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "defaultBranch": "main"
                },
                "expectedFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            }
        }))
    }

    #[test]
    fn confines_traversal_and_lists_but_never_follows_symlinks() {
        let (workspace, root) = root();
        let outside = TempDir::new().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        fs::write(workspace.path().join("src/file.ts"), "inside").unwrap();
        fs::write(outside.path().join("secret"), "outside").unwrap();
        symlink(outside.path(), workspace.path().join("outside")).unwrap();
        symlink(
            outside.path().join("secret"),
            workspace.path().join("secret-link"),
        )
        .unwrap();

        let listed = json(execute(
            &root,
            operation(serde_json::json!({"operation":"files.list","path":null})),
        ));
        assert_eq!(listed["kind"], "tree");
        assert!(
            listed["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| { entry["name"] == "outside" && entry["kind"] == "symlink" })
        );
        for input in [
            serde_json::json!({"operation":"files.list","path":"outside"}),
            serde_json::json!({"operation":"files.read","path":"secret-link"}),
            serde_json::json!({"operation":"files.read","path":"../secret"}),
            serde_json::json!({"operation":"files.read","path":".git/config"}),
        ] {
            assert_eq!(json(execute(&root, operation(input)))["kind"], "invalid");
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "outside"
        );
    }

    #[test]
    fn sorts_versions_and_paginates_one_bounded_directory() {
        let (workspace, root) = root();
        for index in (0..101).rev() {
            fs::write(
                workspace.path().join(format!("file-{index:03}.txt")),
                index.to_string(),
            )
            .unwrap();
        }
        let first = json(execute(
            &root,
            operation(serde_json::json!({"operation":"files.list","path":null})),
        ));
        assert_eq!(first["entries"].as_array().unwrap().len(), 100);
        assert_eq!(first["entries"][0]["name"], "file-000.txt");
        assert_eq!(first["nextIndex"], 100);

        let second = json(execute(
            &root,
            operation(serde_json::json!({
                "operation":"files.list",
                "path":null,
                "cursor":{"version":first["version"],"index":first["nextIndex"]}
            })),
        ));
        assert_eq!(second["entries"].as_array().unwrap().len(), 1);
        assert_eq!(second["entries"][0]["name"], "file-100.txt");
        assert!(second.get("nextIndex").is_none());

        fs::write(workspace.path().join("changed.txt"), "changed").unwrap();
        let stale = json(execute(
            &root,
            operation(serde_json::json!({
                "operation":"files.list",
                "path":null,
                "cursor":{"version":first["version"],"index":100}
            })),
        ));
        assert_eq!(stale["kind"], "conflict");
    }

    #[test]
    #[ignore = "local performance benchmark"]
    fn benchmarks_paginated_large_directory() {
        const ENTRIES: usize = 1_000;
        const SAMPLES: usize = 30;

        let (workspace, root) = root();
        fs::create_dir(workspace.path().join("files")).unwrap();
        for index in 0..ENTRIES {
            fs::write(
                workspace
                    .path()
                    .join("files")
                    .join(format!("entry-{index:04}.txt")),
                [],
            )
            .unwrap();
        }

        let elapsed_micros = |operation: &mut dyn FnMut()| {
            let started_at = Instant::now();
            operation();
            started_at.elapsed().as_micros() as u64
        };
        let mut first_page = Vec::with_capacity(SAMPLES);
        let mut all_pages = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            first_page.push(elapsed_micros(&mut || {
                assert!(matches!(
                    list(&root, Some("files"), None).unwrap_or_else(|_| panic!("list failed")),
                    FilesResult::Tree { .. }
                ));
            }));
            all_pages.push(elapsed_micros(&mut || {
                let mut cursor = None;
                let mut entries = 0;
                loop {
                    let FilesResult::Tree {
                        version,
                        entries: page,
                        next_index,
                    } = list(&root, Some("files"), cursor)
                        .unwrap_or_else(|_| panic!("list failed"))
                    else {
                        panic!("list did not return a tree");
                    };
                    entries += page.len();
                    let Some(index) = next_index else { break };
                    cursor = Some(ListCursor { version, index });
                }
                assert_eq!(entries, ENTRIES);
            }));
        }
        first_page.sort_unstable();
        all_pages.sort_unstable();
        let percentile = |samples: &[u64], numerator: usize, denominator: usize| {
            samples[(samples.len() * numerator).div_ceil(denominator) - 1]
        };
        println!(
            "files_large_directory entries={ENTRIES} samples={SAMPLES} first_page_us={{min:{},p50:{},p95:{},max:{}}} all_pages_us={{min:{},p50:{},p95:{},max:{}}}",
            first_page[0],
            percentile(&first_page, 50, 100),
            percentile(&first_page, 95, 100),
            first_page[SAMPLES - 1],
            all_pages[0],
            percentile(&all_pages, 50, 100),
            percentile(&all_pages, 95, 100),
            all_pages[SAMPLES - 1],
        );
    }

    #[test]
    fn completes_files_work_on_the_bounded_worker_with_its_request_id() {
        let (workspace, root) = root();
        let (worker, results) = start_worker(&root, workspace.path(), SandboxRoots::Guest).unwrap();
        try_submit(
            &worker,
            WorkerRequest {
                request_id: "files-request-01".into(),
                operation: operation(serde_json::json!({
                    "operation": "files.list",
                    "path": null
                })),
            },
        )
        .unwrap();
        let completed = results.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(completed.request_id, "files-request-01");
        assert!(matches!(completed.result, FilesResult::Tree { .. }));
    }

    #[test]
    fn serves_sandbox_reads_on_the_worker_with_the_sandbox_wire_shape() {
        let (workspace, root) = root();
        let home = TempDir::new().unwrap();
        std::fs::write(home.path().join("notes.txt"), "hello").unwrap();
        let (worker, results) = start_worker(
            &root,
            workspace.path(),
            SandboxRoots::Local {
                home: home.path().to_owned(),
            },
        )
        .unwrap();
        try_submit(
            &worker,
            WorkerRequest {
                request_id: "files-request-02".into(),
                operation: operation(serde_json::json!({
                    "operation": "files.readSandbox",
                    "path": "/home/user/notes.txt",
                    "offset": 0,
                    "length": 1024
                })),
            },
        )
        .unwrap();
        let completed = results.recv_timeout(Duration::from_secs(1)).unwrap();
        let FilesResult::Sandbox(SandboxReadResult::SandboxChunk {
            version,
            size_bytes,
            offset,
            bytes,
        }) = completed.result
        else {
            panic!("expected a sandbox chunk");
        };
        assert_eq!((size_bytes, offset), (5, 0));
        assert_eq!(bytes, b"hello");
        assert!(version.starts_with("sha256:"));
        assert_eq!(
            json(FilesResult::Sandbox(SandboxReadResult::Missing)),
            serde_json::json!({"kind":"missing"})
        );
    }

    #[test]
    fn lists_reads_and_saves_only_selected_linked_worktrees() {
        let workspace = TempDir::new().unwrap();
        let linked_parent = TempDir::new().unwrap();
        git(workspace.path(), &["init", "-b", "main"]);
        git(workspace.path(), &["config", "user.name", "dx test"]);
        git(
            workspace.path(),
            &["config", "user.email", "dx-test@example.test"],
        );
        fs::write(workspace.path().join("primary.txt"), "primary\n").unwrap();
        git(workspace.path(), &["add", "primary.txt"]);
        git(workspace.path(), &["commit", "-m", "baseline"]);
        let mut linked = Vec::new();
        for index in 0..worktrees::MAX_WORKTREES {
            let path = linked_parent.path().join(format!("linked-{index}"));
            git(
                workspace.path(),
                &[
                    "worktree",
                    "add",
                    "-b",
                    &format!("linked-{index}"),
                    path.to_str().unwrap(),
                ],
            );
            fs::write(path.join("linked.txt"), format!("linked {index}\n")).unwrap();
            linked.push(path);
        }
        let root = File::open(workspace.path()).unwrap();
        let selected = linked[0].canonicalize().unwrap();
        let selected_id = worktree_id(&selected).ok().unwrap();
        let omitted_id = worktree_id(&linked[worktrees::MAX_WORKTREES - 1].canonicalize().unwrap())
            .ok()
            .unwrap();

        let listed = json(execute_workspace(
            &root,
            workspace.path(),
            operation(serde_json::json!({
                "operation": "files.list",
                "worktree": selected_id,
                "path": null
            })),
        ));
        assert!(
            listed["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| { entry["name"] == "linked.txt" && entry["kind"] == "file" })
        );
        let read = json(execute_workspace(
            &root,
            workspace.path(),
            operation(serde_json::json!({
                "operation": "files.read",
                "worktree": selected_id,
                "path": "linked.txt"
            })),
        ));
        assert_eq!(read["content"], "linked 0\n");
        let saved = json(execute_workspace(
            &root,
            workspace.path(),
            operation(serde_json::json!({
                "operation": "files.save",
                "worktree": selected_id,
                "path": "linked.txt",
                "expectedVersion": read["version"],
                "content": "saved in linked\n"
            })),
        ));
        assert_eq!(saved["kind"], "saved");
        assert_eq!(
            fs::read_to_string(selected.join("linked.txt")).unwrap(),
            "saved in linked\n"
        );
        assert_eq!(
            json(execute_workspace(
                &root,
                workspace.path(),
                operation(serde_json::json!({
                    "operation": "files.read",
                    "worktree": omitted_id,
                    "path": "linked.txt"
                })),
            ))["kind"],
            "missing"
        );
    }

    #[test]
    fn preserves_submission_order_across_the_files_worker() {
        let (workspace, root) = root();
        let (worker, results) = start_worker(&root, workspace.path(), SandboxRoots::Guest).unwrap();
        for index in 0..WORK_QUEUE_CAPACITY {
            try_submit(
                &worker,
                WorkerRequest {
                    request_id: format!("files-request-{index:02}"),
                    operation: operation(serde_json::json!({
                        "operation": "files.list",
                        "path": null
                    })),
                },
            )
            .unwrap();
        }
        for index in 0..WORK_QUEUE_CAPACITY {
            let completed = results.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(completed.request_id, format!("files-request-{index:02}"));
        }
    }

    #[test]
    fn classifies_complete_bounded_reads() {
        let (workspace, root) = root();
        fs::write(
            workspace.path().join("limit.txt"),
            vec![b'a'; MAX_EDITABLE_BYTES],
        )
        .unwrap();
        fs::write(workspace.path().join("binary"), [1, 0, 2]).unwrap();
        fs::write(workspace.path().join("invalid"), [0xc3, 0x28]).unwrap();
        fs::write(
            workspace.path().join("large"),
            vec![b'a'; MAX_EDITABLE_BYTES + 1],
        )
        .unwrap();

        let read = |path| {
            json(execute(
                &root,
                operation(serde_json::json!({"operation":"files.read","path":path})),
            ))
        };
        let editable = read("limit.txt");
        assert_eq!(editable["kind"], "editable");
        assert_eq!(editable["sizeBytes"], MAX_EDITABLE_BYTES);
        assert_eq!(
            editable["content"].as_str().unwrap().len(),
            MAX_EDITABLE_BYTES
        );
        assert_eq!(read("binary")["reason"], "binary");
        assert_eq!(read("invalid")["reason"], "encoding");
        let large = read("large");
        assert_eq!(large["reason"], "too-large");
        assert_eq!(large["content"], "");
        assert_eq!(large["sizeBytes"], MAX_EDITABLE_BYTES + 1);
    }

    #[test]
    fn atomically_saves_the_expected_regular_file_and_preserves_its_mode() {
        let (workspace, root) = root();
        let path = workspace.path().join("editable.txt");
        fs::write(&path, "before\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let expected = version_for(b"before\n");

        let saved = json(execute(
            &root,
            save_operation("editable.txt", &expected, "after\n"),
        ));

        assert_eq!(saved["kind"], "saved");
        assert_eq!(saved["version"], version_for(b"after\n"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "after\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(fs::read_dir(workspace.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dx-files-")
        }));
    }

    #[test]
    fn conflicts_without_replacement_when_the_expected_content_is_stale() {
        let (workspace, root) = root();
        let path = workspace.path().join("editable.txt");
        fs::write(&path, "newer\n").unwrap();

        let saved = json(execute(
            &root,
            save_operation("editable.txt", &version_for(b"older\n"), "mine\n"),
        ));

        assert_eq!(saved["kind"], "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "newer\n");
        assert!(fs::read_dir(workspace.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dx-files-")
        }));
    }

    #[test]
    fn rejects_symlinks_invalid_refreshes_and_oversized_content_before_saving() {
        let (workspace, root) = root();
        let outside = TempDir::new().unwrap();
        let outside_path = outside.path().join("outside.txt");
        fs::write(&outside_path, "outside\n").unwrap();
        symlink(&outside_path, workspace.path().join("linked.txt")).unwrap();
        let expected = version_for(b"outside\n");

        assert_eq!(
            json(execute(
                &root,
                save_operation("linked.txt", &expected, "changed\n")
            ))["kind"],
            "invalid"
        );
        assert_eq!(fs::read_to_string(&outside_path).unwrap(), "outside\n");
        assert!(
            serde_json::from_value::<FilesOperation>(serde_json::json!({
                "operation": "files.save",
                "path": "linked.txt",
                "expectedVersion": expected,
                "content": "changed\n",
                "refresh": {
                    "type": "shell",
                    "token": "opaque-refresh-token",
                    "source": {
                        "baseline": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "defaultBranch": "main"
                    }
                }
            }))
            .is_err()
        );
        assert_eq!(
            json(execute(
                &root,
                save_operation("linked.txt", &expected, &"x".repeat(MAX_EDITABLE_BYTES + 1))
            ))["kind"],
            "invalid"
        );
    }

    #[test]
    fn enforces_path_cursor_and_directory_entry_bounds() {
        let (workspace, root) = root();
        let overlong = "a".repeat(MAX_PATH_BYTES + 1);
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({"operation":"files.read","path":overlong})),
            ))["kind"],
            "invalid"
        );
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({
                    "operation":"files.list",
                    "path":null,
                    "cursor":{"version":format!("sha256:{}", "a".repeat(64)),"index":10001}
                })),
            ))["kind"],
            "invalid"
        );

        for index in 0..=MAX_TREE_ENTRIES {
            fs::write(workspace.path().join(format!("entry-{index:05}")), []).unwrap();
        }
        assert_eq!(
            json(execute(
                &root,
                operation(serde_json::json!({"operation":"files.list","path":null})),
            ))["kind"],
            "invalid"
        );
    }
}
