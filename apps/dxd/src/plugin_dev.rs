//! `dxd plugin dev <folder> [--watch]`: reload one of the Thread owner's
//! personal plugins from a folder in this Orb (the personal-dev
//! tier).
//!
//! The folder is sent to Core with the daemon's own Thread key; Core updates
//! the owner's personal install of the same name, so the next plugin call in
//! any of the owner's Threads, this one included, runs the new code. Core
//! applies only a version that asks for nothing the installed one doesn't:
//! the first install, and any wider version, are reviewed on the Plugins
//! page. With `--watch` it sends the folder again each time a file changes.

use crate::attachments::{config_path, endpoint_origin};
use crate::load_config;
use base64::Engine;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: dxd plugin dev <folder> [--watch]";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(300);
const MAX_FILES: usize = 2_000;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const SKIPPED: [&str; 3] = [".git", "node_modules", ".DS_Store"];

fn fail(message: &str) -> Result<(), ()> {
    eprintln!("dxd plugin dev: {message}");
    Err(())
}

pub fn run_cli(arguments: &[String]) -> Result<(), ()> {
    let (folder, watch) = match arguments {
        [command, folder] if command == "dev" => (folder, false),
        [command, folder, flag] if command == "dev" && flag == "--watch" => (folder, true),
        [command, flag, folder] if command == "dev" && flag == "--watch" => (folder, true),
        _ => {
            eprintln!("{USAGE}");
            return Err(());
        }
    };
    let folder = match fs::canonicalize(folder) {
        Ok(path) if path.is_dir() => path,
        Ok(path) => return fail(&format!("{} is not a folder", path.display())),
        Err(error) => return fail(&format!("cannot read {folder}: {error}")),
    };
    if !folder.join("plugin.json").is_file() && !folder.join(".claude-plugin").is_dir() {
        return fail("the folder has no plugin.json");
    }
    let config = match load_config(&config_path()) {
        Ok(config) => config,
        Err(_) => return fail("the Thread's daemon configuration is unavailable"),
    };
    let Some(origin) = endpoint_origin(&config) else {
        return fail("the daemon endpoint is invalid");
    };
    let url = format!("{origin}/v1/dxd/{}/plugin-dev", config.thread_id);
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let send = |files: &[(String, PathBuf)]| -> Result<bool, ()> {
        let body = match body_of(&folder, files) {
            Ok(body) => body,
            Err(message) => {
                eprintln!("dxd plugin dev: {message}");
                return Ok(false);
            }
        };
        match post(&agent, &url, &config.api_key, body) {
            Ok((ok, line)) => {
                println!("{line}");
                Ok(ok)
            }
            Err(message) => {
                eprintln!("dxd plugin dev: {message}");
                Ok(false)
            }
        }
    };
    let mut seen = match snapshot(&folder) {
        Ok(snapshot) => snapshot,
        Err(message) => return fail(&message),
    };
    let first = send(&seen.files)?;
    if !watch {
        return if first { Ok(()) } else { Err(()) };
    }
    eprintln!(
        "dxd plugin dev: watching {} (Ctrl-C stops)",
        folder.display()
    );
    loop {
        std::thread::sleep(POLL);
        let Ok(now) = snapshot(&folder) else { continue };
        if now.fingerprint == seen.fingerprint {
            continue;
        }
        // An editor saves in steps; send once the folder stops changing.
        std::thread::sleep(SETTLE);
        let Ok(settled) = snapshot(&folder) else {
            continue;
        };
        if settled.fingerprint != now.fingerprint {
            continue;
        }
        seen = settled;
        let _ = send(&seen.files)?;
    }
}

struct Snapshot {
    fingerprint: Vec<(String, u64, u128)>,
    files: Vec<(String, PathBuf)>,
}

/// Every file under the folder, by relative path, with size and mtime.
fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let mut fingerprint = Vec::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("cannot read {}: {error}", dir.display()))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if SKIPPED.contains(&name.as_str()) {
                continue;
            }
            // Symlinks are left out, as plugin imports leave them out.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                let metadata = entry.metadata().map_err(|error| error.to_string())?;
                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let relative = relative.to_string_lossy().replace('\\', "/");
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_nanos());
                total += metadata.len();
                fingerprint.push((relative.clone(), metadata.len(), modified));
                files.push((relative, path));
            }
        }
        if files.len() > MAX_FILES {
            return Err(format!("the folder has more than {MAX_FILES} files"));
        }
        if total > MAX_TOTAL_BYTES {
            return Err("the folder is larger than 8 MB".to_owned());
        }
    }
    fingerprint.sort();
    files.sort();
    Ok(Snapshot { fingerprint, files })
}

/// `{ folder, files: [{ path, content }] }`, each file under the folder's
/// own name, as a plugin ZIP holds it.
fn body_of(root: &Path, files: &[(String, PathBuf)]) -> Result<String, String> {
    let base = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "plugin".to_owned());
    let mut encoded = Vec::with_capacity(files.len());
    for (relative, path) in files {
        let bytes = fs::read(path).map_err(|error| format!("cannot read {relative}: {error}"))?;
        encoded.push(json!({
            "path": format!("{base}/{relative}"),
            "content": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    Ok(json!({ "folder": root.to_string_lossy(), "files": encoded }).to_string())
}

/// Sends the folder; the line to print, and whether Core applied it.
fn post(agent: &ureq::Agent, url: &str, key: &str, body: String) -> Result<(bool, String), String> {
    let response = agent
        .post(url)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(body)
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .into_with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .map_err(|error| format!("request failed: {error}"))?;
    if status == 401 {
        return Err("this Thread's daemon key was rejected".to_owned());
    }
    let answer: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
    let field = |name: &str| {
        answer
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    Ok(match field("outcome") {
        "reloaded" => (
            true,
            format!(
                "[{stamp}] reloaded {} {} ({})",
                field("plugin"),
                field("version"),
                field("tier")
            ),
        ),
        "unchanged" => (true, format!("[{stamp}] {} is unchanged", field("plugin"))),
        "" => (false, format!("[{stamp}] Core answered HTTP {status}")),
        outcome => (false, format!("[{stamp}] {outcome}: {}", field("error"))),
    })
}
