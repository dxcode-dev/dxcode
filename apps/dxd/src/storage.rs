//! `dxd files put`: store files in this Thread's storage in dx.
//!
//! A file in the Orb lives only as long as the Orb. Stored, it lives in R2
//! with the Thread: the transcript can show it after the Orb sleeps, stops,
//! or is gone, and other Threads can fetch it with `dxd files get <url>`.
//!
//! Only this Thread writes to its storage: each request to Core carries the
//! daemon's own Thread key, which the Thread's execution object checks as it
//! checks a registration. Core answers with presigned R2 URLs, one per part,
//! each signing that part's exact length; the bytes go straight to storage
//! and the key is never sent there. The command prints each file's dx URL.
//!
//! Core also asks the daemon to move files for the agent's thread file
//! tools: `storage.export` stores guest files here as temporary files the
//! same way, and `storage.import` writes stored files into the guest the way
//! `dxd files get` does. Either way the bytes go straight between the guest
//! and R2.

use crate::attachments::{self, Kind, config_path, endpoint_origin, storage_file_id};
use crate::{Config, load_config};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PART_ATTEMPTS: usize = 3;
const USAGE: &str = "usage: dxd files put <path>...";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    id: String,
    part_size: u64,
    parts: Vec<PartTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartTarget {
    part_number: u64,
    url: String,
}

#[derive(Deserialize)]
struct Stored {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct Refusal {
    error: String,
}

/// The type a file's extension suggests. Core proves image, video, audio,
/// and PDF types from the bytes, so this only names the rest.
fn mime_type(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn fail(message: &str) -> Result<(), ()> {
    eprintln!("dxd files put: {message}");
    Err(())
}

/// A path to store: an existing, non-empty regular file within the limit.
fn check(path: &str) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("cannot read {path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if metadata.len() == 0 {
        return Err(format!("{path} is empty"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("{path} is larger than 500 MB"));
    }
    Ok(metadata.len())
}

pub fn run_put(arguments: &[String]) -> Result<(), ()> {
    if arguments.is_empty() || arguments.iter().any(|argument| argument.starts_with('-')) {
        eprintln!("{USAGE}");
        return Err(());
    }
    // Every path is checked before anything is stored.
    let mut files = Vec::with_capacity(arguments.len());
    for path in arguments {
        match check(path) {
            Ok(size) => files.push((path, size)),
            Err(message) => return fail(&message),
        }
    }
    let config = match load_config(&config_path()) {
        Ok(config) => config,
        Err(_) => return fail("the Thread's daemon configuration is unavailable"),
    };
    let Some(origin) = endpoint_origin(&config) else {
        return fail("the daemon endpoint is invalid");
    };
    let storage = format!("{origin}/v1/dxd/{}/storage", config.thread_id);
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    for (path, size) in files {
        match put(
            &agent,
            &storage,
            &config.api_key,
            Path::new(path),
            size,
            false,
        ) {
            Ok(stored) => println!("{}", stored.url),
            Err(error) => return fail(&format!("{path}: {error}")),
        }
    }
    Ok(())
}

/// Ask Core, with the Thread's key; any answer but `expected` is an error.
fn ask(
    agent: &ureq::Agent,
    url: &str,
    key: &str,
    body: String,
    expected: u16,
) -> io::Result<Vec<u8>> {
    let response = agent
        .post(url)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(body)
        .map_err(|error| io::Error::other(format!("request failed: {error}")))?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .into_with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .map_err(|error| io::Error::other(format!("request failed: {error}")))?;
    if status == expected {
        return Ok(body);
    }
    Err(io::Error::other(match status {
        401 => "this Thread's daemon key was rejected".to_owned(),
        _ => match serde_json::from_slice::<Refusal>(&body) {
            Ok(refusal) => refusal.error,
            Err(_) => format!("Core answered HTTP {status}"),
        },
    }))
}

/// PUT one part to its presigned URL, without the key; returns its ETag.
/// A dropped connection or a storage error is retried; a refusal is not.
fn put_part(agent: &ureq::Agent, target: &PartTarget, bytes: &[u8]) -> io::Result<String> {
    let mut last = String::new();
    for _ in 0..PART_ATTEMPTS {
        match agent.put(&target.url).send(bytes) {
            Ok(response) => {
                let status = response.status().as_u16();
                let etag = response
                    .headers()
                    .get("etag")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let _ = response.into_body().read_to_vec();
                match (status, etag) {
                    (200, Some(etag)) => return Ok(etag),
                    (200, None) => {
                        last = format!("storage named no ETag for part {}", target.part_number)
                    }
                    (500..=599, _) => {
                        last = format!("storage failed part {} (HTTP {status})", target.part_number)
                    }
                    _ => {
                        return Err(io::Error::other(format!(
                            "storage refused part {} (HTTP {status})",
                            target.part_number
                        )));
                    }
                }
            }
            Err(error) => last = format!("part {} failed: {error}", target.part_number),
        }
    }
    Err(io::Error::other(last))
}

fn put(
    agent: &ureq::Agent,
    storage: &str,
    key: &str,
    path: &Path,
    size: u64,
    temporary: bool,
) -> io::Result<Stored> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "file".to_owned());
    let created: Created = serde_json::from_slice(&ask(
        agent,
        storage,
        key,
        if temporary {
            json!({ "name": name, "mimeType": mime_type(&name), "size": size, "temporary": true })
        } else {
            json!({ "name": name, "mimeType": mime_type(&name), "size": size })
        }
        .to_string(),
        201,
    )?)
    .map_err(|_| io::Error::other("Core answered with an invalid upload"))?;
    let part_size = created.part_size;
    let expected = size.div_ceil(part_size.max(1));
    if part_size == 0
        || created.parts.len() as u64 != expected
        || created
            .parts
            .iter()
            .enumerate()
            .any(|(index, part)| part.part_number != index as u64 + 1)
    {
        return Err(io::Error::other("Core answered with an invalid upload"));
    }
    let mut file = fs::File::open(path)?;
    let mut buffer = vec![0_u8; part_size.min(size) as usize];
    let mut parts = Vec::with_capacity(created.parts.len());
    for (index, target) in created.parts.iter().enumerate() {
        let length = (size - index as u64 * part_size).min(part_size) as usize;
        file.read_exact(&mut buffer[..length])
            .map_err(|_| io::Error::other("the file changed while it was read"))?;
        let etag = put_part(agent, target, &buffer[..length])?;
        parts.push(json!({ "partNumber": target.part_number, "etag": etag }));
    }
    let stored: Stored = serde_json::from_slice(&ask(
        agent,
        &format!("{storage}/{}/complete", created.id),
        key,
        json!({ "parts": parts }).to_string(),
        200,
    )?)
    .map_err(|_| io::Error::other("Core answered with an invalid file"))?;
    if storage_file_id(&stored.id) != Some(stored.id.as_str()) {
        return Err(io::Error::other("Core answered with an invalid file"));
    }
    Ok(stored)
}

/// The most files one transfer moves; Core sends no more.
const MAX_TRANSFER_FILES: usize = 200;
/// The longest message a skipped file carries back to Core, which accepts
/// 512 UTF-16 units.
const MAX_MESSAGE_CHARS: usize = 250;
/// How long one transfer runs. Core stops waiting after 15 minutes
/// (`STORAGE_TRANSFER_TIMEOUT_MS`); past this, a transfer starts no file and
/// puts none in place, so nothing lands after Core reports a failure.
const TRANSFER_BUDGET: Duration = Duration::from_secs(14 * 60);
/// The permission bits a transfer carries.
const MODE_BITS: u32 = 0o777;

/// One guest file `storage.export` stores.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportFile {
    pub path: String,
}

/// One file `storage.import` writes into the guest.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportFile {
    pub path: String,
    pub source: ImportSource,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ImportSource {
    /// A file in Thread storage that this Thread's owner can read.
    Stored {
        id: String,
        #[serde(default)]
        mode: Option<u32>,
    },
    /// An empty file: storage holds none.
    Empty {
        #[serde(default)]
        mode: Option<u32>,
    },
}

impl ImportSource {
    fn mode(&self) -> Option<u32> {
        match self {
            Self::Stored { mode, .. } | Self::Empty { mode } => mode.map(|mode| mode & MODE_BITS),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TransferResult {
    Exported { files: Vec<ExportOutcome> },
    Imported { files: Vec<ImportOutcome> },
    Unavailable { reason: &'static str },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ExportOutcome {
    Stored {
        id: String,
        size: u64,
        mode: u32,
    },
    Empty {
        mode: u32,
    },
    Skipped {
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImportOutcome {
    Written {
        path: String,
        size: u64,
    },
    Skipped {
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

/// What a transfer needs from the daemon's configuration.
pub struct Transfer {
    origin: String,
    thread_id: String,
    key: String,
    workspace_root: PathBuf,
}

impl Transfer {
    pub fn new(config: &Config) -> Option<Self> {
        Some(Self {
            origin: endpoint_origin(config)?,
            thread_id: config.thread_id.clone(),
            key: config.api_key.clone(),
            workspace_root: PathBuf::from(&config.workspace_root),
        })
    }

    /// An agent whose every request ends by the transfer's deadline; `None`
    /// once it has passed.
    fn agent(deadline: Instant) -> Option<ureq::Agent> {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        Some(
            ureq::Agent::config_builder()
                .timeout_global(Some(remaining.min(REQUEST_TIMEOUT)))
                .http_status_as_error(false)
                .build()
                .new_agent(),
        )
    }

    /// Store each file in this Thread's storage as a temporary file.
    pub fn export(&self, files: &[ExportFile], max_bytes: u64) -> TransferResult {
        if files.is_empty()
            || files.len() > MAX_TRANSFER_FILES
            || max_bytes == 0
            || max_bytes > MAX_FILE_BYTES
            || files.iter().any(|file| !valid_path(&file.path))
        {
            return TransferResult::Unavailable { reason: "invalid" };
        }
        let deadline = Instant::now() + TRANSFER_BUDGET;
        let storage = format!("{}/v1/dxd/{}/storage", self.origin, self.thread_id);
        let outcomes = files
            .iter()
            .map(|file| {
                let Some(agent) = Self::agent(deadline) else {
                    return skipped_export("timeout", "the transfer ran out of time");
                };
                let path = resolve(&self.workspace_root, &file.path);
                let metadata = match fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        return skipped_export("missing", "no such file");
                    }
                    Err(error) => return skipped_export("unreadable", &error.to_string()),
                };
                if !metadata.is_file() {
                    return skipped_export("not-file", "not a regular file");
                }
                let mode = metadata.permissions().mode() & MODE_BITS;
                if metadata.len() == 0 {
                    return ExportOutcome::Empty { mode };
                }
                if metadata.len() > max_bytes {
                    return skipped_export(
                        "too-large",
                        &format!(
                            "{} bytes is over the {max_bytes}-byte limit",
                            metadata.len()
                        ),
                    );
                }
                match put(&agent, &storage, &self.key, &path, metadata.len(), true) {
                    Ok(stored) => ExportOutcome::Stored {
                        id: stored.id,
                        size: metadata.len(),
                        mode,
                    },
                    Err(error) => skipped_export("failed", &error.to_string()),
                }
            })
            .collect();
        TransferResult::Exported { files: outcomes }
    }

    /// Write each stored file into the guest, downloading it straight from
    /// storage as this Thread's owner.
    pub fn import(
        &self,
        files: &[ImportFile],
        overwrite: bool,
        create_parents: bool,
    ) -> TransferResult {
        if files.is_empty()
            || files.len() > MAX_TRANSFER_FILES
            || files.iter().any(|file| {
                !valid_path(&file.path)
                    || matches!(&file.source, ImportSource::Stored { id, .. } if storage_file_id(id) != Some(id.as_str()))
            })
        {
            return TransferResult::Unavailable { reason: "invalid" };
        }
        let deadline = Instant::now() + TRANSFER_BUDGET;
        let outcomes = files
            .iter()
            .map(|file| self.import_one(deadline, file, overwrite, create_parents))
            .collect();
        TransferResult::Imported { files: outcomes }
    }

    /// Write one file: fill a temporary file beside the destination, give it
    /// its mode, then put it in place in one step. Without `overwrite`, it
    /// takes its name only if nothing holds it then; with it, the rename
    /// replaces a file or a symlink, never a symlink's target.
    fn import_one(
        &self,
        deadline: Instant,
        file: &ImportFile,
        overwrite: bool,
        create_parents: bool,
    ) -> ImportOutcome {
        let Some(agent) = Self::agent(deadline) else {
            return skipped_import("timeout", "the transfer ran out of time");
        };
        let path = resolve(&self.workspace_root, &file.path);
        let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            return skipped_import("invalid", "the destination names no file");
        };
        if !parent.is_dir() {
            if !create_parents {
                return skipped_import(
                    "no-parent",
                    &format!("{} does not exist", parent.display()),
                );
            }
            if let Err(error) = fs::create_dir_all(parent) {
                return skipped_import("failed", &error.to_string());
            }
        }
        // An overwritten regular file keeps its mode unless the source
        // names one.
        let existing_mode = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                return skipped_import("invalid", "the destination is a directory");
            }
            Ok(_) if !overwrite => {
                return skipped_import("exists", "the destination exists");
            }
            Ok(metadata) => metadata
                .is_file()
                .then(|| metadata.permissions().mode() & MODE_BITS),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return skipped_import("failed", &error.to_string()),
        };
        let filled = match &file.source {
            ImportSource::Empty { .. } => {
                attachments::temporary_file(parent).and_then(|(temporary, written)| {
                    match written.sync_all() {
                        Ok(()) => Ok((temporary, 0)),
                        Err(error) => {
                            let _ = fs::remove_file(&temporary);
                            Err(error)
                        }
                    }
                })
            }
            ImportSource::Stored { id, .. } => {
                let url = format!("{}/v1/dxd/{}/storage/{id}", self.origin, self.thread_id);
                attachments::describe(&agent, &url, &self.key, Kind::Stored).and_then(
                    |descriptor| {
                        attachments::fetch(
                            &agent,
                            &descriptor,
                            &self.origin,
                            &self.key,
                            parent,
                            Kind::Stored,
                        )
                        .map(|temporary| (temporary, descriptor.size))
                    },
                )
            }
        };
        let (temporary, size) = match filled {
            Ok(filled) => filled,
            Err(error) => return skipped_import("failed", &error.to_string()),
        };
        let placed = match file.source.mode().or(existing_mode) {
            Some(mode) => fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)),
            None => Ok(()),
        }
        .and_then(|()| {
            if Instant::now() >= deadline {
                Err(io::Error::from(io::ErrorKind::TimedOut))
            } else if overwrite {
                fs::rename(&temporary, &path)
            } else {
                // A hard link fails if the name is taken, with no window in
                // which a file created meanwhile is replaced.
                fs::hard_link(&temporary, &path).map(|()| {
                    let _ = fs::remove_file(&temporary);
                })
            }
        });
        if let Err(error) = placed {
            let _ = fs::remove_file(&temporary);
            return match error.kind() {
                io::ErrorKind::TimedOut => {
                    skipped_import("timeout", "the transfer ran out of time")
                }
                io::ErrorKind::AlreadyExists => skipped_import("exists", "the destination exists"),
                _ => skipped_import("failed", &error.to_string()),
            };
        }
        ImportOutcome::Written {
            path: fs::canonicalize(&path)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned(),
            size,
        }
    }
}

/// An absolute path, or one relative to `base`.
fn resolve(base: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.contains('\0')
}

fn bounded(message: &str) -> Option<String> {
    Some(message.chars().take(MAX_MESSAGE_CHARS).collect())
}

fn skipped_export(reason: &'static str, message: &str) -> ExportOutcome {
    ExportOutcome::Skipped {
        reason,
        message: bounded(message),
    }
}

fn skipped_import(reason: &'static str, message: &str) -> ImportOutcome {
    ImportOutcome::Skipped {
        reason,
        message: bounded(message),
    }
}
