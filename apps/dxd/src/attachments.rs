//! `dxd files get`: download a message attachment, or a file from a
//! Thread's storage, into the guest. `dxd files put` is `storage.rs`.
//!
//! A user's message names its files by URL. Those URLs need a dx session, so
//! the agent asks Core with the daemon's own Thread key instead: the request
//! goes to the endpoint the daemon already dials, and Core's Thread execution
//! object checks the key exactly as it checks a registration. The key reads
//! as the Thread's owner, so any file the owner could open in dx. Core
//! answers with a short-lived presigned R2 URL and the bytes come straight
//! from storage; the key is sent to that URL only when it is Core's own
//! (local development).

use crate::{CONFIG_PATH, Config, load_config};
use serde::Deserialize;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_ATTACHMENT_BYTES: u64 = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const USAGE: &str = "usage: dxd files get <attachment-or-storage-url | id> [-o <path>]\n       dxd files put <path>...";

/// The attachment id in a URL or a bare id: `att_` and 32 lowercase hex digits.
pub fn attachment_id(value: &str) -> Option<&str> {
    prefixed_id(value, "att_")
}

/// The Thread storage file id in a URL or a bare id: `tsf_` and 32 lowercase
/// hex digits.
pub fn storage_file_id(value: &str) -> Option<&str> {
    prefixed_id(value, "tsf_")
}

fn prefixed_id<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let bytes = value.as_bytes();
    let mut start = 0;
    while let Some(offset) = value[start..].find(prefix) {
        let begin = start + offset;
        let end = begin + 36;
        let hex = |b: &u8| b.is_ascii_digit() || (b'a'..=b'f').contains(b);
        let boundary = |index: usize| index >= bytes.len() || !bytes[index].is_ascii_alphanumeric();
        if end <= bytes.len()
            && bytes[begin + 4..end].iter().all(hex)
            && boundary(end)
            && (begin == 0 || !bytes[begin - 1].is_ascii_alphanumeric())
        {
            return Some(&value[begin..end]);
        }
        start = begin + 4;
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// `name` when it is safe as a file name in the working directory.
fn safe_file_name(name: &str) -> Option<String> {
    (!name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\0'])
        && name.len() <= 255)
        .then(|| name.to_owned())
}

/// The file name a URL's last path segment gives, when it is a safe one.
pub fn file_name_from_url(value: &str, id: &str) -> Option<String> {
    let path = value.split(['?', '#']).next().unwrap_or_default();
    let last = path.rsplit('/').next().unwrap_or_default();
    if last == id {
        return None;
    }
    safe_file_name(&percent_decode(last))
}

/// Core's description of one attachment: where to fetch it and its size.
#[derive(Deserialize)]
struct Descriptor {
    url: String,
    name: String,
    size: u64,
}

/// `https://<daemon endpoint host>`.
pub(crate) fn endpoint_origin(config: &Config) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = config.endpoint.strip_prefix("wss://") {
        ("https", rest)
    } else if let Some(rest) = config.endpoint.strip_prefix("ws://") {
        ("http", rest)
    } else {
        return None;
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())?;
    Some(format!("{scheme}://{authority}"))
}

/// `https://<daemon endpoint host>/v1/dxd/<thread>/attachments/<id>`.
pub fn download_url(config: &Config, id: &str) -> Option<String> {
    Some(format!(
        "{}/v1/dxd/{}/attachments/{id}",
        endpoint_origin(config)?,
        config.thread_id
    ))
}

pub(crate) fn config_path() -> PathBuf {
    std::env::var("DXD_CONFIG")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| PathBuf::from(CONFIG_PATH))
}

fn fail(message: &str) -> Result<(), ()> {
    eprintln!("dxd files get: {message}");
    Err(())
}

pub fn run_cli(arguments: &[String]) -> Result<(), ()> {
    if arguments.first().map(String::as_str) == Some("put") {
        return crate::storage::run_put(&arguments[1..]);
    }
    let (source, output) = match arguments {
        [command, source] if command == "get" => (source, None),
        [command, source, flag, output]
            if command == "get" && (flag == "-o" || flag == "--output") =>
        {
            (source, Some(output))
        }
        [command, flag, output, source]
            if command == "get" && (flag == "-o" || flag == "--output") =>
        {
            (source, Some(output))
        }
        _ => {
            eprintln!("{USAGE}");
            return Err(());
        }
    };
    // A stored file is asked for through this Thread's own storage route;
    // Core decides whether this Thread's owner can open it.
    let (id, kind) = match (attachment_id(source), storage_file_id(source)) {
        (Some(id), _) => (id, Kind::Attachment),
        (None, Some(id)) => (id, Kind::Stored),
        (None, None) => {
            return fail("the argument is not a dx attachment or Thread storage URL or id");
        }
    };
    let config = match load_config(&config_path()) {
        Ok(config) => config,
        Err(_) => return fail("the Thread's daemon configuration is unavailable"),
    };
    let url = match kind {
        Kind::Attachment => download_url(&config, id),
        Kind::Stored => endpoint_origin(&config)
            .map(|origin| format!("{origin}/v1/dxd/{}/storage/{id}", config.thread_id)),
    };
    let (Some(url), Some(origin)) = (url, endpoint_origin(&config)) else {
        return fail("the daemon endpoint is invalid");
    };
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let descriptor = match describe(&agent, &url, &config.api_key, kind) {
        Ok(descriptor) => descriptor,
        Err(error) => return fail(&error.to_string()),
    };
    let output = match output {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(
            file_name_from_url(source, id)
                .or_else(|| safe_file_name(&descriptor.name))
                .unwrap_or_else(|| id.to_owned()),
        ),
    };
    match download(&agent, &descriptor, &origin, &config.api_key, &output, kind) {
        Ok(path) => {
            println!("{}", path.display());
            Ok(())
        }
        Err(error) => fail(&error.to_string()),
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Attachment,
    Stored,
}

fn status_error(status: u16, kind: Kind) -> io::Error {
    match (status, kind) {
        (401, _) => io::Error::other("this Thread's daemon key was rejected"),
        (404, Kind::Attachment) => {
            io::Error::other("no such attachment, or this Thread's owner cannot open it")
        }
        (404, Kind::Stored) => {
            io::Error::other("no such stored file, or this Thread's owner cannot open it")
        }
        (status, _) => io::Error::other(format!("the download answered HTTP {status}")),
    }
}

/// Ask Core where the attachment is.
fn describe(agent: &ureq::Agent, url: &str, key: &str, kind: Kind) -> io::Result<Descriptor> {
    let response = agent
        .get(url)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Accept", "application/json")
        .call()
        .map_err(|error| io::Error::other(format!("request failed: {error}")))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(status_error(status, kind));
    }
    let body = response
        .into_body()
        .into_with_config()
        .limit(64 * 1024)
        .read_to_vec()
        .map_err(|error| io::Error::other(format!("request failed: {error}")))?;
    let descriptor: Descriptor = serde_json::from_slice(&body)
        .map_err(|_| io::Error::other("Core answered with an invalid description"))?;
    if descriptor.size > MAX_ATTACHMENT_BYTES {
        return Err(io::Error::other("the attachment exceeds its size limit"));
    }
    Ok(descriptor)
}

fn download(
    agent: &ureq::Agent,
    descriptor: &Descriptor,
    origin: &str,
    key: &str,
    output: &Path,
    kind: Kind,
) -> io::Result<PathBuf> {
    // A path is Core's own route (local development): it needs the key. A
    // presigned R2 URL carries its own signature and never gets the key.
    let url = if descriptor.url.starts_with('/') {
        format!("{origin}{}", descriptor.url)
    } else {
        descriptor.url.clone()
    };
    let mut request = agent.get(&url);
    if url.starts_with(&format!("{origin}/")) {
        request = request.header("Authorization", &format!("Bearer {key}"));
    }
    let response = request
        .call()
        .map_err(|error| io::Error::other(format!("download failed: {error}")))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(status_error(status, kind));
    }
    let directory = match output.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    fs::create_dir_all(&directory)?;
    let temporary = directory.join(format!(".dxd-download-{}", rand::random::<u64>()));
    let mut body = response
        .into_body()
        .into_with_config()
        .limit(MAX_ATTACHMENT_BYTES + 1)
        .reader();
    let mut file = fs::File::create(&temporary)?;
    let result = (|| {
        let mut buffer = vec![0_u8; 256 * 1024];
        let mut total = 0_u64;
        loop {
            let read = body.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > MAX_ATTACHMENT_BYTES {
                return Err(io::Error::other("the attachment exceeds its size limit"));
            }
            file.write_all(&buffer[..read])?;
        }
        if total != descriptor.size {
            return Err(io::Error::other("the download ended early"));
        }
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, output).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })?;
    Ok(fs::canonicalize(output).unwrap_or_else(|_| output.to_path_buf()))
}
