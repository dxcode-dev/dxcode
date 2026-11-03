//! Files tree writes inside the Thread checkout: create, upload, move, copy,
//! and delete.
//!
//! Each path resolves like a save: through the checkout's `cap_std::fs::Dir`,
//! one component at a time, never following a symbolic link, and never
//! through `.git` or a `.dx-files-` temporary. A write never replaces an
//! existing entry: create and upload refuse one, and move and copy rename
//! with `RENAME_NOREPLACE`. Copy and delete treat a symbolic link as the link
//! itself, never its target.
//!
//! Ways a write could fail, each covered by the tests below:
//! - a path with `..`, an absolute path, `.git`, or a symbolic link on the
//!   way reaches outside the checkout;
//! - delete follows a symbolic link and removes what it points to;
//! - copy follows a symbolic link and copies outside content in;
//! - create, upload, move, or copy replaces an entry that already exists;
//! - a folder moves or copies into itself;
//! - an upload chunk lands at the wrong offset, exceeds the bound, or a
//!   finished upload replaces a file created meanwhile;
//! - a failed copy or upload leaves a partial entry behind;
//! - a copy drops a file's mode.

use crate::files::{FilesError, FilesResult, open_parent, path_error, sync_directory};
use base64::Engine as _;
use cap_std::fs::{Dir, OpenOptions};
use rand::Rng;
use serde::Deserialize;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;

/// One upload chunk, decoded; a request frame stays under its 2 MiB bound.
pub const MAX_UPLOAD_CHUNK_BYTES: usize = 1024 * 1024;
/// One uploaded file.
pub const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
/// Entries and bytes one copy may create.
const MAX_COPY_ENTRIES: usize = 10_000;
const MAX_COPY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateKind {
    File,
    Directory,
}

fn exists(parent: &Dir, name: &str) -> Result<bool, FilesError> {
    match parent.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(path_error(error)),
    }
}

fn done(parent: &Dir) -> Result<FilesResult, FilesError> {
    sync_directory(parent)?;
    Ok(FilesResult::Changed)
}

/// Rename without replacing whatever is at the destination.
fn rename_noreplace(
    from: &Dir,
    from_name: &str,
    to: &Dir,
    to_name: &str,
) -> Result<(), FilesError> {
    let from_name = std::ffi::CString::new(from_name).map_err(|_| FilesError::Invalid)?;
    let to_name = std::ffi::CString::new(to_name).map_err(|_| FilesError::Invalid)?;
    // SAFETY: both descriptors are open directories owned by `from` and `to`
    // for the call, and both names are NUL-terminated.
    // The raw system call: the static musl libc has no `renameat2` wrapper.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from.as_raw_fd(),
            from_name.as_ptr(),
            to.as_raw_fd(),
            to_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    Err(match error.raw_os_error() {
        Some(libc::EEXIST) | Some(libc::ENOTEMPTY) => FilesError::Conflict,
        // A folder into its own subtree.
        Some(libc::EINVAL) => FilesError::Invalid,
        _ => path_error(error),
    })
}

/// `path` is `ancestor` or inside it.
fn within(path: &str, ancestor: &str) -> bool {
    path == ancestor
        || path
            .strip_prefix(ancestor)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub fn create(root: &Dir, path: &str, kind: CreateKind) -> Result<FilesResult, FilesError> {
    let (parent, name) = open_parent(root, path)?;
    if exists(&parent, &name)? {
        return Err(FilesError::Conflict);
    }
    match kind {
        CreateKind::Directory => parent.create_dir(&name).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                FilesError::Conflict
            } else {
                path_error(error)
            }
        })?,
        CreateKind::File => {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let file = parent.open_with(&name, &options).map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    FilesError::Conflict
                } else {
                    path_error(error)
                }
            })?;
            file.into_std()
                .sync_all()
                .map_err(|_| FilesError::Unavailable)?;
        }
    }
    done(&parent)
}

fn valid_upload_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One chunk of an upload. The bytes collect in a hidden temporary beside the
/// destination; the last chunk renames it into place, never over a file.
pub fn upload(
    root: &Dir,
    path: &str,
    upload_id: &str,
    offset: u64,
    content: &str,
    last: bool,
) -> Result<FilesResult, FilesError> {
    if !valid_upload_id(upload_id) || content.len() > MAX_UPLOAD_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(FilesError::Invalid);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| FilesError::Invalid)?;
    if bytes.len() > MAX_UPLOAD_CHUNK_BYTES || offset + bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err(FilesError::Invalid);
    }
    let (parent, name) = open_parent(root, path)?;
    let temporary = format!(".dx-files-upload-{upload_id}");
    let fail = |error: FilesError| -> Result<FilesResult, FilesError> {
        let _ = parent.remove_file(&temporary);
        Err(error)
    };
    if exists(&parent, &name)? {
        return fail(FilesError::Conflict);
    }
    let file = if offset == 0 {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        match parent.open_with(&temporary, &options) {
            Ok(file) => file,
            Err(error) => return fail(path_error(error)),
        }
    } else {
        match parent.symlink_metadata(&temporary) {
            Ok(metadata) if metadata.is_file() && metadata.len() == offset => {}
            Ok(_) => return fail(FilesError::Conflict),
            Err(error) => return Err(path_error(error)),
        }
        match parent.open_with(&temporary, OpenOptions::new().append(true)) {
            Ok(file) => file,
            Err(error) => return fail(path_error(error)),
        }
    };
    let mut file = file.into_std();
    if file.write_all(&bytes).is_err() || (last && file.sync_all().is_err()) {
        return fail(FilesError::Unavailable);
    }
    if !last {
        return Ok(FilesResult::Changed);
    }
    if let Err(error) = rename_noreplace(&parent, &temporary, &parent, &name) {
        return fail(error);
    }
    done(&parent)
}

pub fn rename(root: &Dir, from: &str, to: &str) -> Result<FilesResult, FilesError> {
    if within(to, from) {
        return Err(FilesError::Invalid);
    }
    let (from_parent, from_name) = open_parent(root, from)?;
    if !exists(&from_parent, &from_name)? {
        return Err(FilesError::Missing);
    }
    let (to_parent, to_name) = open_parent(root, to)?;
    rename_noreplace(&from_parent, &from_name, &to_parent, &to_name)?;
    sync_directory(&from_parent)?;
    done(&to_parent)
}

struct CopyBudget {
    entries: usize,
    bytes: u64,
}

impl CopyBudget {
    fn take(&mut self, bytes: u64) -> Result<(), FilesError> {
        self.entries += 1;
        self.bytes += bytes;
        if self.entries > MAX_COPY_ENTRIES || self.bytes > MAX_COPY_BYTES {
            return Err(FilesError::Invalid);
        }
        Ok(())
    }
}

/// Copy one entry as itself: a link stays a link, never what it points to.
fn copy_entry(
    from: &Dir,
    from_name: &str,
    to: &Dir,
    to_name: &str,
    budget: &mut CopyBudget,
) -> Result<(), FilesError> {
    let metadata = from.symlink_metadata(from_name).map_err(path_error)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        budget.take(0)?;
        let target = from.read_link_contents(from_name).map_err(path_error)?;
        return to.symlink_contents(target, to_name).map_err(path_error);
    }
    if file_type.is_dir() {
        budget.take(0)?;
        to.create_dir(to_name).map_err(path_error)?;
        let source = from.open_dir_nofollow(from_name).map_err(path_error)?;
        let destination = to.open_dir_nofollow(to_name).map_err(path_error)?;
        for entry in source.entries().map_err(|_| FilesError::Unavailable)? {
            let entry = entry.map_err(|_| FilesError::Unavailable)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| FilesError::Invalid)?;
            copy_entry(&source, &name, &destination, &name, budget)?;
        }
        return Ok(());
    }
    if !file_type.is_file() {
        return Err(FilesError::Invalid);
    }
    budget.take(metadata.len())?;
    let mode = {
        use cap_std::fs::MetadataExt;
        metadata.mode() & 0o7777
    };
    let source = from
        .open_with(from_name, OpenOptions::new().read(true))
        .map_err(path_error)?;
    let opened = source.metadata().map_err(|_| FilesError::Unavailable)?;
    {
        use cap_std::fs::MetadataExt;
        // The name was swapped for something else after it was checked.
        if !opened.is_file() || opened.ino() != metadata.ino() || opened.dev() != metadata.dev() {
            return Err(FilesError::Conflict);
        }
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let destination = to.open_with(to_name, &options).map_err(path_error)?;
    let mut source = source.into_std();
    let mut destination = destination.into_std();
    let limit = MAX_COPY_BYTES - (budget.bytes - metadata.len());
    let copied = io::copy(
        &mut Read::by_ref(&mut source).take(limit + 1),
        &mut destination,
    )
    .map_err(|_| FilesError::Unavailable)?;
    if copied > limit {
        return Err(FilesError::Invalid);
    }
    {
        use std::os::unix::fs::PermissionsExt;
        destination
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|_| FilesError::Unavailable)?;
    }
    destination.sync_all().map_err(|_| FilesError::Unavailable)
}

fn remove_entry(parent: &Dir, name: &str) -> io::Result<()> {
    let metadata = parent.symlink_metadata(name)?;
    if metadata.is_dir() {
        parent.remove_dir_all(name)
    } else {
        parent.remove_file(name)
    }
}

/// Copy into a hidden temporary beside the destination, then rename it into
/// place; a failure removes the temporary.
pub fn copy(root: &Dir, from: &str, to: &str) -> Result<FilesResult, FilesError> {
    if within(to, from) {
        return Err(FilesError::Invalid);
    }
    let (from_parent, from_name) = open_parent(root, from)?;
    if !exists(&from_parent, &from_name)? {
        return Err(FilesError::Missing);
    }
    let (to_parent, to_name) = open_parent(root, to)?;
    if exists(&to_parent, &to_name)? {
        return Err(FilesError::Conflict);
    }
    let temporary = format!(".dx-files-copy-{:032x}", rand::rng().random::<u128>());
    let mut budget = CopyBudget {
        entries: 0,
        bytes: 0,
    };
    let copied = copy_entry(
        &from_parent,
        &from_name,
        &to_parent,
        &temporary,
        &mut budget,
    )
    .and_then(|()| rename_noreplace(&to_parent, &temporary, &to_parent, &to_name));
    if let Err(error) = copied {
        let _ = remove_entry(&to_parent, &temporary);
        return Err(error);
    }
    done(&to_parent)
}

/// Remove a file, a link (not what it points to), or a folder and everything
/// in it.
pub fn delete(root: &Dir, path: &str) -> Result<FilesResult, FilesError> {
    let (parent, name) = open_parent(root, path)?;
    remove_entry(&parent, &name).map_err(path_error)?;
    done(&parent)
}

trait OpenDirNofollow {
    fn open_dir_nofollow(&self, name: &str) -> io::Result<Dir>;
}

impl OpenDirNofollow for Dir {
    fn open_dir_nofollow(&self, name: &str) -> io::Result<Dir> {
        let metadata = self.symlink_metadata(name)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        self.open_dir(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::execute;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::TempDir;

    fn checkout() -> (TempDir, TempDir, Dir) {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("src/nested")).unwrap();
        fs::write(directory.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(directory.path().join("src/nested/deep.txt"), "deep").unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(outside.path(), directory.path().join("out")).unwrap();
        symlink(
            outside.path().join("secret.txt"),
            directory.path().join("secret-link"),
        )
        .unwrap();
        let root = Dir::open_ambient_dir(directory.path(), cap_std::ambient_authority()).unwrap();
        (directory, outside, root)
    }

    fn run(root: &Dir, value: serde_json::Value) -> String {
        let operation = serde_json::from_value(value).unwrap();
        serde_json::to_value(execute(root, operation)).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    const ESCAPES: [&str; 6] = [
        "../x",
        "/tmp/x",
        ".git/x",
        "out/x",
        "src/../x",
        ".dx-files-x",
    ];

    #[test]
    fn no_write_reaches_outside_the_checkout() {
        let (directory, outside, root) = checkout();
        fs::create_dir(directory.path().join(".git")).unwrap();
        for path in ESCAPES {
            assert_eq!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.create", "path": path, "kind": "file"})
                ),
                "invalid",
                "create {path}"
            );
            assert_eq!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.upload", "path": path,
                    "upload": "0".repeat(32), "offset": 0, "content": b64(b"x"), "last": true})
                ),
                "invalid",
                "upload {path}"
            );
            assert_eq!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.move", "from": "src/main.rs", "to": path})
                ),
                "invalid",
                "move to {path}"
            );
            assert_eq!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.copy", "from": "src/main.rs", "to": path})
                ),
                "invalid",
                "copy to {path}"
            );
            assert_ne!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.delete", "path": path})
                ),
                "changed",
                "delete {path}"
            );
        }
        // Moving or copying out through a link, or reading through one in.
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.move", "from": "out/secret.txt", "to": "stolen.txt"})
            ),
            "invalid"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.copy", "from": "out/secret.txt", "to": "stolen.txt"})
            ),
            "invalid"
        );
        assert!(!directory.path().join("stolen.txt").exists());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "secret"
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[test]
    fn delete_and_copy_treat_a_link_as_the_link() {
        let (directory, outside, root) = checkout();
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.copy", "from": "secret-link", "to": "copied-link"})
            ),
            "changed"
        );
        let copied = directory.path().join("copied-link");
        assert!(
            fs::symlink_metadata(&copied)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_link(&copied).unwrap(),
            outside.path().join("secret.txt")
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.delete", "path": "out"})
            ),
            "changed"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.delete", "path": "secret-link"})
            ),
            "changed"
        );
        assert!(fs::symlink_metadata(directory.path().join("out")).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn creates_moves_copies_and_deletes_without_replacing() {
        let (directory, _outside, root) = checkout();
        let at = |path: &str| directory.path().join(path);
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.create", "path": "docs", "kind": "directory"})
            ),
            "changed"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.create", "path": "docs/a.md", "kind": "file"})
            ),
            "changed"
        );
        assert_eq!(fs::read(at("docs/a.md")).unwrap(), b"");
        for kind in ["file", "directory"] {
            assert_eq!(
                run(
                    &root,
                    serde_json::json!({"operation": "files.create", "path": "src/main.rs", "kind": kind})
                ),
                "conflict"
            );
        }
        assert_eq!(
            fs::read_to_string(at("src/main.rs")).unwrap(),
            "fn main() {}\n"
        );

        fs::set_permissions(at("src/main.rs"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.copy", "from": "src", "to": "src copy"})
            ),
            "changed"
        );
        assert_eq!(
            fs::read_to_string(at("src copy/nested/deep.txt")).unwrap(),
            "deep"
        );
        assert_eq!(
            fs::metadata(at("src copy/main.rs"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.copy", "from": "src", "to": "src copy"})
            ),
            "conflict"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.copy", "from": "src", "to": "src/inner"})
            ),
            "invalid"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.move", "from": "src", "to": "src/nested/src"})
            ),
            "invalid"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.move", "from": "docs/a.md", "to": "src/main.rs"})
            ),
            "conflict"
        );
        assert_eq!(
            fs::read_to_string(at("src/main.rs")).unwrap(),
            "fn main() {}\n"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.move", "from": "docs/a.md", "to": "src/b.md"})
            ),
            "changed"
        );
        assert!(!at("docs/a.md").exists() && at("src/b.md").exists());
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.move", "from": "docs/absent", "to": "x"})
            ),
            "missing"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.delete", "path": "src copy"})
            ),
            "changed"
        );
        assert!(!at("src copy").exists());
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.delete", "path": "src copy"})
            ),
            "missing"
        );
        // No temporary is left behind.
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dx-files-")
        }));
    }

    #[test]
    fn uploads_in_order_and_never_over_a_file() {
        let (directory, _outside, root) = checkout();
        let id = "a".repeat(32);
        let chunk = |offset: u64, bytes: &[u8], last: bool| {
            run(
                &root,
                serde_json::json!({"operation": "files.upload", "path": "up.bin",
                "upload": id, "offset": offset, "content": b64(bytes), "last": last}),
            )
        };
        assert_eq!(chunk(0, b"hello ", false), "changed");
        // Not listed while it uploads.
        assert!(!directory.path().join("up.bin").exists());
        assert_eq!(chunk(3, b"world", true), "conflict");
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dx-files-")
        }));
        assert_eq!(chunk(0, b"hello ", false), "changed");
        assert_eq!(chunk(6, &[0, 1, 2], true), "changed");
        assert_eq!(
            fs::read(directory.path().join("up.bin")).unwrap(),
            b"hello \0\x01\x02"
        );
        assert_eq!(chunk(0, b"again", true), "conflict");
        assert_eq!(
            fs::read(directory.path().join("up.bin")).unwrap(),
            b"hello \0\x01\x02"
        );
        let oversized = vec![0u8; MAX_UPLOAD_CHUNK_BYTES + 1];
        assert_eq!(chunk(0, &oversized, true), "invalid");
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.upload", "path": "big.bin",
                "upload": id, "offset": MAX_UPLOAD_BYTES, "content": b64(b"x"), "last": true})
            ),
            "invalid"
        );
        assert_eq!(
            run(
                &root,
                serde_json::json!({"operation": "files.upload", "path": "bad.bin",
                "upload": "../../etc", "offset": 0, "content": b64(b"x"), "last": true})
            ),
            "invalid"
        );
    }
}
