//! Read-only, chunked access to regular files anywhere in the guest.
//!
//! Workspace Files (`files.rs`) stay confined to the repository and remain the
//! only editable surface. This module lets the browser open or download a file
//! the agent referenced elsewhere in the sandbox, such as `~/notes.md` or
//! `/tmp/out.png`. It never follows symbolic links, never enters `.git`, and
//! refuses kernel pseudo-filesystems and dx's own state directories.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

/// Raw bytes per binary `DXF1` frame; must match Core's
/// `THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES`.
pub const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// Magic prefix of a binary sandbox chunk frame. Terminal frames use `DXT1`.
pub const CHUNK_FRAME_MAGIC: &[u8; 4] = b"DXF1";
const MAX_PATH_BYTES: usize = 1_024;
const GUEST_HOME: &str = "/home/user";

/// Guest paths that must never be readable, even though the agent can reach
/// some of them through bash: they hold daemon credentials or kernel state.
const DENIED_PREFIXES: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/home/user/.local/state/dxd",
    "/home/user/.local/state/dx-terminal",
];

/// How guest paths map onto this host.
#[derive(Clone)]
pub enum SandboxRoots {
    /// The daemon runs inside the guest; guest paths are host paths.
    Guest,
    /// Local development: only guest `/home/user` exists, mapped onto the
    /// Thread's checkout-owned home directory.
    Local { home: PathBuf },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SandboxReadResult {
    /// Sent as a binary `DXF1` frame, never as JSON; see [`chunk_frame`].
    SandboxChunk {
        version: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        offset: u64,
        /// Raw bytes in `[offset, offset + length)`, clamped to the file.
        #[serde(skip)]
        bytes: Vec<u8>,
    },
    Invalid,
    Missing,
    Conflict,
    Unavailable,
}

enum ReadError {
    Invalid,
    Missing,
    Conflict,
    Unavailable,
}

fn valid_guest_path(path: &str) -> bool {
    if path.len() <= 1
        || path.len() > MAX_PATH_BYTES
        || !path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return false;
    }
    if DENIED_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
    {
        return false;
    }
    path[1..].split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part != ".git"
            && !part.starts_with(".dx-files-")
    })
}

/// Resolve a validated guest path to a trusted base directory and the
/// components beneath it. Only the components are walked without following
/// links; the base itself is configuration.
fn resolve<'a>(roots: &SandboxRoots, guest: &'a str) -> Result<(PathBuf, Vec<&'a str>), ReadError> {
    match roots {
        SandboxRoots::Guest => Ok((PathBuf::from("/"), guest[1..].split('/').collect())),
        SandboxRoots::Local { home } => {
            let suffix = guest
                .strip_prefix(GUEST_HOME)
                .and_then(|rest| rest.strip_prefix('/'))
                .ok_or(ReadError::Missing)?;
            Ok((home.clone(), suffix.split('/').collect()))
        }
    }
}

fn path_error(error: io::Error) -> ReadError {
    match error.raw_os_error() {
        Some(libc::ENOENT) => ReadError::Missing,
        Some(
            libc::ELOOP
            | libc::ENOTDIR
            | libc::ENAMETOOLONG
            | libc::EINVAL
            | libc::EACCES
            | libc::EPERM,
        ) => ReadError::Invalid,
        _ => ReadError::Unavailable,
    }
}

fn open_at(directory: RawFd, name: &str, flags: libc::c_int) -> Result<OwnedFd, ReadError> {
    let name = CString::new(name).map_err(|_| ReadError::Invalid)?;
    let fd = unsafe { libc::openat(directory, name.as_ptr(), flags, 0) };
    if fd < 0 {
        Err(path_error(io::Error::last_os_error()))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// Open a regular file by walking every component without following links.
fn open_regular(base: &Path, parts: &[&str]) -> Result<(OwnedFd, libc::stat), ReadError> {
    let (name, directories) = parts.split_last().ok_or(ReadError::Invalid)?;
    let base = base.to_str().ok_or(ReadError::Unavailable)?;
    let mut current = open_at(
        libc::AT_FDCWD,
        base,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
    )
    .map_err(|error| match error {
        ReadError::Missing => ReadError::Missing,
        _ => ReadError::Unavailable,
    })?;
    for part in directories {
        current = open_at(
            current.as_raw_fd(),
            part,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )?;
    }
    let file = open_at(
        current.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )?;
    let metadata = metadata(file.as_raw_fd())?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG || metadata.st_size < 0 {
        return Err(ReadError::Invalid);
    }
    Ok((file, metadata))
}

fn metadata(fd: RawFd) -> Result<libc::stat, ReadError> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, value.as_mut_ptr()) } < 0 {
        Err(ReadError::Unavailable)
    } else {
        Ok(unsafe { value.assume_init() })
    }
}

/// Identify one immutable revision of the file without hashing its bytes.
fn version_for(stat: &libc::stat) -> String {
    let identity = format!(
        "{}:{}:{}:{}.{}:{}.{}",
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime,
        stat.st_mtime_nsec,
        stat.st_ctime,
        stat.st_ctime_nsec
    );
    format!("sha256:{:x}", Sha256::digest(identity.as_bytes()))
}

fn read_range(fd: RawFd, offset: u64, length: u64) -> Result<Vec<u8>, ReadError> {
    let mut bytes = vec![0_u8; length as usize];
    let mut filled = 0_usize;
    while filled < bytes.len() {
        let read = unsafe {
            libc::pread(
                fd,
                bytes[filled..].as_mut_ptr().cast(),
                bytes.len() - filled,
                (offset + filled as u64) as libc::off_t,
            )
        };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ReadError::Unavailable);
        }
        if read == 0 {
            break;
        }
        filled += read as usize;
    }
    bytes.truncate(filled);
    Ok(bytes)
}

fn read_chunk(
    roots: &SandboxRoots,
    path: &str,
    offset: u64,
    length: u64,
    expected_version: Option<&str>,
) -> Result<SandboxReadResult, ReadError> {
    if !valid_guest_path(path) || length == 0 || length > MAX_CHUNK_BYTES {
        return Err(ReadError::Invalid);
    }
    let (base, parts) = resolve(roots, path)?;
    let (file, before) = open_regular(&base, &parts)?;
    let version = version_for(&before);
    if expected_version.is_some_and(|expected| expected != version) {
        return Err(ReadError::Conflict);
    }
    let size_bytes = before.st_size as u64;
    if offset > size_bytes {
        return Err(ReadError::Invalid);
    }
    let length = length.min(size_bytes - offset);
    let bytes = read_range(file.as_raw_fd(), offset, length)?;
    let after = metadata(file.as_raw_fd())?;
    if version_for(&after) != version || bytes.len() as u64 != length {
        return Err(ReadError::Conflict);
    }
    Ok(SandboxReadResult::SandboxChunk {
        version,
        size_bytes,
        offset,
        bytes,
    })
}

pub fn read(
    roots: &SandboxRoots,
    path: &str,
    offset: u64,
    length: u64,
    expected_version: Option<&str>,
) -> SandboxReadResult {
    match read_chunk(roots, path, offset, length, expected_version) {
        Ok(result) => result,
        Err(ReadError::Invalid) => SandboxReadResult::Invalid,
        Err(ReadError::Missing) => SandboxReadResult::Missing,
        Err(ReadError::Conflict) => SandboxReadResult::Conflict,
        Err(ReadError::Unavailable) => SandboxReadResult::Unavailable,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkHeader<'a> {
    generation: &'a str,
    request_id: &'a str,
    version: &'a str,
    size_bytes: u64,
    offset: u64,
}

/// Encode a chunk as `DXF1 | u32 BE header length | JSON header | raw bytes`
/// so file bytes cross the socket without base64 or JSON escaping.
pub fn chunk_frame(
    generation: &str,
    request_id: &str,
    version: &str,
    size_bytes: u64,
    offset: u64,
    bytes: &[u8],
) -> Result<Vec<u8>, serde_json::Error> {
    let header = serde_json::to_vec(&ChunkHeader {
        generation,
        request_id,
        version,
        size_bytes,
        offset,
    })?;
    let mut frame = Vec::with_capacity(8 + header.len() + bytes.len());
    frame.extend_from_slice(CHUNK_FRAME_MAGIC);
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(bytes);
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn local() -> (TempDir, SandboxRoots) {
        let directory = TempDir::new().unwrap();
        let home = directory.path().join("home");
        fs::create_dir_all(home.join("notes")).unwrap();
        (directory, SandboxRoots::Local { home })
    }

    fn json(result: SandboxReadResult) -> serde_json::Value {
        serde_json::to_value(result).unwrap()
    }

    fn home(roots: &SandboxRoots) -> &Path {
        match roots {
            SandboxRoots::Local { home } => home,
            SandboxRoots::Guest => unreachable!(),
        }
    }

    #[test]
    fn reads_bounded_chunks_outside_the_repository() {
        let (_directory, roots) = local();
        fs::write(home(&roots).join("notes/todo.bin"), [0_u8, 1, 2, 3, 4, 255]).unwrap();
        let SandboxReadResult::SandboxChunk {
            version,
            size_bytes,
            bytes,
            ..
        } = read(&roots, "/home/user/notes/todo.bin", 0, 4, None)
        else {
            panic!("expected a chunk");
        };
        assert_eq!(size_bytes, 6);
        assert_eq!(bytes, [0_u8, 1, 2, 3]);
        let SandboxReadResult::SandboxChunk { offset, bytes, .. } =
            read(&roots, "/home/user/notes/todo.bin", 4, 4, Some(&version))
        else {
            panic!("expected a chunk");
        };
        assert_eq!(offset, 4);
        assert_eq!(bytes, [4_u8, 255]);
    }

    #[test]
    fn detects_a_changed_file_between_chunks() {
        let (_directory, roots) = local();
        let path = home(&roots).join("notes/log.txt");
        fs::write(&path, "first").unwrap();
        let first = json(read(&roots, "/home/user/notes/log.txt", 0, 2, None));
        let version = first["version"].as_str().unwrap().to_owned();
        fs::write(&path, "second, longer").unwrap();
        assert_eq!(
            json(read(
                &roots,
                "/home/user/notes/log.txt",
                2,
                2,
                Some(&version)
            ))["kind"],
            "conflict"
        );
    }

    #[test]
    fn refuses_links_traversal_secrets_and_the_host_outside_local_home() {
        let (directory, roots) = local();
        let outside = directory.path().join("outside.txt");
        fs::write(&outside, "host secret").unwrap();
        std::os::unix::fs::symlink(&outside, home(&roots).join("link.txt")).unwrap();
        fs::create_dir_all(home(&roots).join("repo/.git")).unwrap();
        fs::write(home(&roots).join("repo/.git/config"), "token").unwrap();
        fs::create_dir_all(home(&roots).join(".local/state/dxd")).unwrap();
        fs::write(home(&roots).join(".local/state/dxd/config.json"), "{}").unwrap();
        for (path, kind) in [
            ("/home/user/link.txt", "invalid"),
            ("/home/user/notes/../link.txt", "invalid"),
            ("/home/user/repo/.git/config", "invalid"),
            ("/home/user/.local/state/dxd/config.json", "invalid"),
            ("/proc/self/environ", "invalid"),
            ("/etc/passwd", "missing"),
            ("relative.txt", "invalid"),
            ("/home/user/notes", "invalid"),
            ("/home/user/absent.txt", "missing"),
        ] {
            assert_eq!(
                json(read(&roots, path, 0, 16, None))["kind"],
                kind,
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_oversized_or_out_of_range_requests() {
        let (_directory, roots) = local();
        fs::write(home(&roots).join("notes/a.txt"), "abc").unwrap();
        let path = "/home/user/notes/a.txt";
        assert_eq!(json(read(&roots, path, 0, 0, None))["kind"], "invalid");
        assert_eq!(
            json(read(&roots, path, 0, MAX_CHUNK_BYTES + 1, None))["kind"],
            "invalid"
        );
        assert_eq!(json(read(&roots, path, 4, 1, None))["kind"], "invalid");
        assert!(matches!(
            read(&roots, path, 3, 8, None),
            SandboxReadResult::SandboxChunk { bytes, .. } if bytes.is_empty()
        ));
    }

    #[test]
    fn frames_chunks_as_binary_with_a_json_header() {
        let frame = chunk_frame("gen_1", "request_12345678", "sha256:ab", 6, 4, &[4, 255]).unwrap();
        assert_eq!(&frame[..4], b"DXF1");
        let length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&frame[8..8 + length]).unwrap();
        assert_eq!(
            header,
            serde_json::json!({
                "generation": "gen_1",
                "requestId": "request_12345678",
                "version": "sha256:ab",
                "sizeBytes": 6,
                "offset": 4
            })
        );
        assert_eq!(&frame[8 + length..], [4, 255]);
    }
}
