//! Read-only, chunked access to regular files anywhere in the guest.
//!
//! Workspace Files (`files.rs`) stay confined to the repository and remain the
//! only editable surface. This module lets the browser open or download a file
//! the agent referenced elsewhere in the sandbox, such as `~/notes.md` or
//! `/tmp/out.png`. It never follows symbolic links, never enters `.git`, and
//! refuses kernel pseudo-filesystems and dx's own state directories.

use cap_std::fs::{Dir, Metadata, OpenOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Raw bytes per sandbox read request; must match Core's
/// `THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES`.
pub const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// Raw bytes per binary `DXF1` frame. A chunk crosses the socket as several
/// frames with consecutive offsets, so Terminal and control frames can be
/// written between them instead of waiting behind 4 MiB.
pub const MAX_FRAME_PAYLOAD_BYTES: usize = 256 * 1024;
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
    match error.kind() {
        io::ErrorKind::NotFound => ReadError::Missing,
        io::ErrorKind::PermissionDenied
        | io::ErrorKind::NotADirectory
        | io::ErrorKind::InvalidInput
        | io::ErrorKind::InvalidFilename => ReadError::Invalid,
        _ => ReadError::Unavailable,
    }
}

/// Open a regular file by walking every component without following links.
fn open_regular(base: &Path, parts: &[&str]) -> Result<(cap_std::fs::File, Metadata), ReadError> {
    let (name, directories) = parts.split_last().ok_or(ReadError::Invalid)?;
    let mut current =
        Dir::open_ambient_dir(base, cap_std::ambient_authority()).map_err(|error| {
            match error.kind() {
                io::ErrorKind::NotFound => ReadError::Missing,
                _ => ReadError::Unavailable,
            }
        })?;
    for part in directories {
        let metadata = current.symlink_metadata(part).map_err(path_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ReadError::Invalid);
        }
        current = current.open_dir(part).map_err(path_error)?;
    }
    let before = current.symlink_metadata(name).map_err(path_error)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(ReadError::Invalid);
    }
    let file = current
        .open_with(name, OpenOptions::new().read(true))
        .map_err(path_error)?;
    let metadata = file.metadata().map_err(|_| ReadError::Unavailable)?;
    if !metadata.is_file() || version_for(&metadata) != version_for(&before) {
        return Err(ReadError::Conflict);
    }
    Ok((file, metadata))
}

/// Identify one immutable revision of the file without hashing its bytes.
fn version_for(metadata: &Metadata) -> String {
    use cap_std::fs::MetadataExt;
    let identity = format!(
        "{}:{}:{}:{}.{}:{}.{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    );
    format!("sha256:{:x}", Sha256::digest(identity.as_bytes()))
}

fn read_range(file: &mut std::fs::File, offset: u64, length: u64) -> Result<Vec<u8>, ReadError> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| ReadError::Unavailable)?;
    let mut bytes = vec![0_u8; length as usize];
    let mut filled = 0_usize;
    while filled < bytes.len() {
        match file.read(&mut bytes[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ReadError::Unavailable),
        }
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
    let size_bytes = before.len();
    if offset > size_bytes {
        return Err(ReadError::Invalid);
    }
    let length = length.min(size_bytes - offset);
    let mut file = file.into_std();
    let bytes = read_range(&mut file, offset, length)?;
    let after = Metadata::from_just_metadata(file.metadata().map_err(|_| ReadError::Unavailable)?);
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

/// Encode a chunk as one `DXF1` frame per [`MAX_FRAME_PAYLOAD_BYTES`] slice,
/// each carrying its own offset. An empty chunk is one frame without bytes.
pub fn chunk_frames(
    generation: &str,
    request_id: &str,
    version: &str,
    size_bytes: u64,
    offset: u64,
    bytes: &[u8],
) -> Result<Vec<Vec<u8>>, serde_json::Error> {
    if bytes.is_empty() {
        return Ok(vec![chunk_frame(
            generation, request_id, version, size_bytes, offset, bytes,
        )?]);
    }
    bytes
        .chunks(MAX_FRAME_PAYLOAD_BYTES)
        .enumerate()
        .map(|(index, slice)| {
            chunk_frame(
                generation,
                request_id,
                version,
                size_bytes,
                offset + (index * MAX_FRAME_PAYLOAD_BYTES) as u64,
                slice,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn local(home: &Path) -> SandboxRoots {
        SandboxRoots::Local {
            home: home.to_owned(),
        }
    }

    #[test]
    fn validates_guest_paths_and_denied_prefixes() {
        for valid in [
            "/home/user/notes.md",
            "/tmp/out.png",
            "/home/user/.config/x",
        ] {
            assert!(valid_guest_path(valid), "{valid}");
        }
        for invalid in [
            "/",
            "relative",
            "/home/user/",
            "/home/user/../etc",
            "/home/user/./x",
            "/proc/self/status",
            "/sys/kernel",
            "/dev/null",
            "/run/x",
            "/home/user/.local/state/dxd/config.json",
            "/home/user/.local/state/dx-terminal/history",
            "/home/user/repo/.git/config",
            "/home/user/.dx-files-abc",
            "/home\\user",
        ] {
            assert!(!valid_guest_path(invalid), "{invalid}");
        }
    }

    #[test]
    fn reads_bounded_chunks_with_a_stable_version_and_refuses_links() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("docs")).unwrap();
        let content = (0..10_000_u32)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(home.path().join("docs/data.bin"), &content).unwrap();
        let roots = local(home.path());
        let SandboxReadResult::SandboxChunk {
            version,
            size_bytes,
            offset,
            bytes,
        } = read(&roots, "/home/user/docs/data.bin", 100, 4_000, None)
        else {
            panic!("expected chunk")
        };
        assert_eq!(size_bytes, 10_000);
        assert_eq!(offset, 100);
        assert_eq!(bytes, content[100..4_100]);
        let SandboxReadResult::SandboxChunk { bytes: tail, .. } = read(
            &roots,
            "/home/user/docs/data.bin",
            9_000,
            MAX_CHUNK_BYTES,
            Some(&version),
        ) else {
            panic!("expected tail chunk")
        };
        assert_eq!(tail, content[9_000..]);
        assert!(matches!(
            read(
                &roots,
                "/home/user/docs/data.bin",
                0,
                10,
                Some("sha256:stale")
            ),
            SandboxReadResult::Conflict
        ));
        assert!(matches!(
            read(&roots, "/home/user/docs/data.bin", 10_001, 10, None),
            SandboxReadResult::Invalid
        ));
        assert!(matches!(
            read(&roots, "/home/user/docs/absent", 0, 10, None),
            SandboxReadResult::Missing
        ));
        assert!(matches!(
            read(&roots, "/tmp/outside-home", 0, 10, None),
            SandboxReadResult::Missing
        ));
        assert!(matches!(
            read(&roots, "/home/user/docs", 0, 10, None),
            SandboxReadResult::Invalid
        ));
        {
            std::os::unix::fs::symlink("data.bin", home.path().join("docs/link.bin")).unwrap();
            assert!(matches!(
                read(&roots, "/home/user/docs/link.bin", 0, 10, None),
                SandboxReadResult::Invalid
            ));
        }
    }

    #[test]
    fn chunk_frame_carries_raw_bytes_after_a_json_header() {
        let frame = chunk_frame("gen", "req", "sha256:v", 3, 0, &[0, 255, 10]).unwrap();
        assert_eq!(&frame[..4], b"DXF1");
        let header_length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        let header: serde_json::Value =
            serde_json::from_slice(&frame[8..8 + header_length]).unwrap();
        assert_eq!(header["requestId"], "req");
        assert_eq!(header["sizeBytes"], 3);
        assert_eq!(&frame[8 + header_length..], &[0, 255, 10]);
    }

    #[test]
    fn chunk_frames_split_a_chunk_at_consecutive_offsets() {
        let decode = |frame: &[u8]| {
            let header_length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
            let header: serde_json::Value =
                serde_json::from_slice(&frame[8..8 + header_length]).unwrap();
            (header, frame[8 + header_length..].to_vec())
        };
        let bytes = (0..MAX_FRAME_PAYLOAD_BYTES * 2 + 5)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let frames = chunk_frames("gen", "req", "sha256:v", 10_000_000, 1_000, &bytes).unwrap();
        assert_eq!(frames.len(), 3);
        let mut joined = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            let (header, payload) = decode(frame);
            assert_eq!(header["requestId"], "req");
            assert_eq!(header["sizeBytes"], 10_000_000);
            assert_eq!(
                header["offset"],
                1_000 + (index * MAX_FRAME_PAYLOAD_BYTES) as u64
            );
            assert!(payload.len() <= MAX_FRAME_PAYLOAD_BYTES);
            joined.extend_from_slice(&payload);
        }
        assert_eq!(joined, bytes);
        let empty = chunk_frames("gen", "req", "sha256:v", 7, 7, &[]).unwrap();
        assert_eq!(empty.len(), 1);
        let (header, payload) = decode(&empty[0]);
        assert_eq!(header["offset"], 7);
        assert!(payload.is_empty());
    }
}
