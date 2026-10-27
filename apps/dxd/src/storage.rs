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

use crate::attachments::{config_path, endpoint_origin};
use crate::load_config;
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::Duration;

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
        match put(&agent, &storage, &config.api_key, Path::new(path), size) {
            Ok(url) => println!("{url}"),
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
) -> io::Result<String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "file".to_owned());
    let created: Created = serde_json::from_slice(&ask(
        agent,
        storage,
        key,
        json!({ "name": name, "mimeType": mime_type(&name), "size": size }).to_string(),
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
    Ok(stored.url)
}
