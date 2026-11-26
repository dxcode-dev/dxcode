//! `dxd plugin`: draft plugins for this Thread (`load`, `reload`, `unload`,
//! `list`, `logs`). `dxd plugin load
//! <folder>` sends the folder to Core with the daemon's own Thread key, and
//! Core loads it as a draft for this Thread only: its code runs from the
//! folder, in this Orb, with this Thread's rights, and its tools reach the
//! agent from its next tool call. Nothing is installed and no other Thread
//! sees it. Core composes every line this prints, so the words live in one
//! place. `logs` reads the draft's process log from this Orb directly.

use crate::attachments::{config_path, endpoint_origin};
use crate::load_config;
use base64::Engine;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const USAGE: &str = "usage: dxd plugin load <folder> [--watch] | reload <name> | unload <name> | list | logs <name> [--follow] [--lines <n>]";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(300);
const MAX_FILES: usize = 2_000;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const SKIPPED: [&str; 3] = [".git", "node_modules", ".DS_Store"];

fn fail(message: &str) -> Result<(), ()> {
    eprintln!("dxd plugin: {message}");
    Err(())
}

pub fn run_cli(arguments: &[String]) -> Result<(), ()> {
    match arguments.first().map(String::as_str) {
        Some("load") => {
            let (folder, watch) = match &arguments[1..] {
                [folder] => (folder, false),
                [folder, flag] | [flag, folder] if flag == "--watch" => (folder, true),
                _ => return usage(),
            };
            load(folder, watch)
        }
        Some("reload") => match &arguments[1..] {
            [name] => reload(name),
            _ => usage(),
        },
        Some("unload") => match &arguments[1..] {
            [name] => {
                let session = Session::open()?;
                session.print(&json!({ "action": "unload", "name": name }))
            }
            _ => usage(),
        },
        Some("list") if arguments.len() == 1 => {
            let session = Session::open()?;
            session.print(&json!({ "action": "list" }))
        }
        Some("logs") => logs(&arguments[1..]),
        _ => usage(),
    }
}

fn usage() -> Result<(), ()> {
    eprintln!("{USAGE}");
    Err(())
}

/// This Thread's daemon configuration and an HTTP agent for Core.
struct Session {
    agent: ureq::Agent,
    url: String,
    key: String,
    state_directory: PathBuf,
}

impl Session {
    fn open() -> Result<Self, ()> {
        let Ok(config) = load_config(&config_path()) else {
            fail("the Thread's daemon configuration is unavailable")?;
            return Err(());
        };
        let Some(origin) = endpoint_origin(&config) else {
            fail("the daemon endpoint is invalid")?;
            return Err(());
        };
        Ok(Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(REQUEST_TIMEOUT))
                .http_status_as_error(false)
                .build()
                .new_agent(),
            url: format!("{origin}/v1/dxd/{}/plugin-draft", config.thread_id),
            key: config.api_key.clone(),
            state_directory: config.local_runtime.as_ref().map_or_else(
                || PathBuf::from(crate::STATE_DIR),
                |local| PathBuf::from(&local.state_directory),
            ),
        })
    }

    /// Sends one request; Core's answer as JSON.
    fn send(&self, body: String) -> Result<serde_json::Value, String> {
        let response = self
            .agent
            .post(&self.url)
            .header("Authorization", &format!("Bearer {}", self.key))
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
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(answer) if answer.get("message").is_some() => Ok(answer),
            _ => Err(format!("dx answered HTTP {status}")),
        }
    }

    /// Sends one request and prints Core's message; fails unless Core says
    /// it is done.
    fn print(&self, request: &serde_json::Value) -> Result<(), ()> {
        match self.send(request.to_string()) {
            Ok(answer) => report(&answer),
            Err(message) => fail(&message),
        }
    }

    fn drafts(&self) -> Result<Vec<serde_json::Value>, String> {
        let answer = self.send(json!({ "action": "list" }).to_string())?;
        Ok(answer
            .get("drafts")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// The draft whose name or short name is `name`.
    fn draft(&self, name: &str) -> Result<serde_json::Value, String> {
        let drafts = self.drafts()?;
        let field = |draft: &serde_json::Value, key: &str| {
            draft
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        drafts
            .iter()
            .find(|draft| field(draft, "name") == name)
            .or_else(|| {
                drafts.iter().find(|draft| {
                    field(draft, "name").rsplit('.').next() == Some(name)
                        || field(draft, "displayName") == name
                })
            })
            .cloned()
            .ok_or_else(|| {
                let loaded = drafts
                    .iter()
                    .map(|draft| field(draft, "name"))
                    .collect::<Vec<_>>();
                if loaded.is_empty() {
                    format!("no draft named {name} is loaded in this Thread")
                } else {
                    format!(
                        "no draft named {name} is loaded in this Thread; loaded: {}",
                        loaded.join(", ")
                    )
                }
            })
    }
}

/// Prints Core's message (stdout when done, stderr when refused).
fn report(answer: &serde_json::Value) -> Result<(), ()> {
    let message = answer
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if answer.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        println!("{message}");
        Ok(())
    } else {
        eprintln!("{message}");
        Err(())
    }
}

fn plugin_folder(folder: &str) -> Result<PathBuf, String> {
    let path = match fs::canonicalize(folder) {
        Ok(path) if path.is_dir() => path,
        Ok(path) => return Err(format!("{} is not a folder", path.display())),
        Err(error) => return Err(format!("cannot read {folder}: {error}")),
    };
    if !path.join("plugin.json").is_file() && !path.join(".claude-plugin").is_dir() {
        return Err(format!("{} has no plugin.json", path.display()));
    }
    Ok(path)
}

fn load(folder: &str, watch: bool) -> Result<(), ()> {
    let folder = match plugin_folder(folder) {
        Ok(folder) => folder,
        Err(message) => return fail(&message),
    };
    let session = Session::open()?;
    let send = |files: &[(String, PathBuf)]| -> bool {
        match body_of(&folder, files, "load") {
            Ok(body) => match session.send(body) {
                Ok(answer) => report(&answer).is_ok(),
                Err(message) => fail(&message).is_ok(),
            },
            Err(message) => fail(&message).is_ok(),
        }
    };
    let mut seen = match snapshot(&folder) {
        Ok(snapshot) => snapshot,
        Err(message) => return fail(&message),
    };
    let first = send(&seen.files);
    if !watch {
        return if first { Ok(()) } else { Err(()) };
    }
    eprintln!("dxd plugin: watching {} (Ctrl-C stops)", folder.display());
    loop {
        seen = next_change(&folder, seen);
        send(&seen.files);
    }
}

fn reload(name: &str) -> Result<(), ()> {
    let session = Session::open()?;
    let draft = match session.draft(name) {
        Ok(draft) => draft,
        Err(message) => return fail(&message),
    };
    let Some(folder) = draft.get("folder").and_then(serde_json::Value::as_str) else {
        return fail("dx did not say where the draft's folder is");
    };
    let folder = match plugin_folder(folder) {
        Ok(folder) => folder,
        Err(message) => return fail(&message),
    };
    let files = match snapshot(&folder) {
        Ok(snapshot) => snapshot.files,
        Err(message) => return fail(&message),
    };
    match body_of(&folder, &files, "load").and_then(|body| session.send(body)) {
        Ok(answer) => report(&answer),
        Err(message) => fail(&message),
    }
}

/// The draft's process log: what its code printed, and why it stopped.
fn logs(arguments: &[String]) -> Result<(), ()> {
    let mut name = None;
    let mut follow = false;
    let mut lines = 100usize;
    let mut rest = arguments.iter();
    while let Some(argument) = rest.next() {
        match argument.as_str() {
            "-f" | "--follow" => follow = true,
            "-n" | "--lines" => match rest.next().and_then(|value| value.parse().ok()) {
                Some(value) => lines = value,
                None => return usage(),
            },
            other if name.is_none() && !other.starts_with('-') => name = Some(other.to_owned()),
            _ => return usage(),
        }
    }
    let Some(name) = name else { return usage() };
    let session = Session::open()?;
    let install_id = match session.draft(&name) {
        Ok(draft) => draft
            .get("installId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| draft_install_id(&name)),
        Err(message) => return fail(&message),
    };
    let path = session
        .state_directory
        .join("plugins")
        .join(format!("{install_id}.log"));
    let text = fs::read(&path).unwrap_or_default();
    if text.is_empty() && !follow {
        println!("{name} has not logged anything yet: its code starts on its first call.");
        return Ok(());
    }
    let text = String::from_utf8_lossy(&text);
    let all = text.lines().collect::<Vec<_>>();
    for line in &all[all.len().saturating_sub(lines)..] {
        println!("{line}");
    }
    if !follow {
        return Ok(());
    }
    let mut offset = fs::metadata(&path).map_or(0, |metadata| metadata.len());
    loop {
        std::thread::sleep(POLL);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() < offset {
            offset = 0; // a new process started a new log
        }
        if metadata.len() == offset {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let start = (offset as usize).min(bytes.len());
        print!("{}", String::from_utf8_lossy(&bytes[start..]));
        use std::io::Write;
        let _ = std::io::stdout().flush();
        offset = bytes.len() as u64;
    }
}

/// The install id Core gives a draft: `plg_draft-` and 12 hex digits of the
/// SHA-256 of its name. Its process log is `<state>/plugins/<id>.log`.
pub(crate) fn draft_install_id(name: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(name.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("plg_draft-{}", &hex[..12])
}

/// Waits until the folder changed and stopped changing.
fn next_change(folder: &Path, seen: Snapshot) -> Snapshot {
    loop {
        std::thread::sleep(POLL);
        let Ok(now) = snapshot(folder) else { continue };
        if now.fingerprint == seen.fingerprint {
            continue;
        }
        // An editor saves in steps; send once the folder stops changing.
        std::thread::sleep(SETTLE);
        let Ok(settled) = snapshot(folder) else {
            continue;
        };
        if settled.fingerprint == now.fingerprint {
            return settled;
        }
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

/// `{ action, folder, files: [{ path, content }] }`, each file under the
/// folder's own name, as a plugin ZIP holds it.
fn body_of(root: &Path, files: &[(String, PathBuf)], action: &str) -> Result<String, String> {
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
    Ok(json!({ "action": action, "folder": root.to_string_lossy(), "files": encoded }).to_string())
}
