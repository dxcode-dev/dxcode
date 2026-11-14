//! Local (stdio) MCP servers from installed plugins.
//!
//! Core sends `mcp.request` with one server's reviewed configuration and one
//! MCP request (`tools/list` or `tools/call`). This module keeps one process
//! per configuration (Core's `key`), starts it on first use, completes the
//! MCP handshake as the client, relays the request, and returns the server's
//! answer. Core decides who may use which server; this module only runs what
//! Core sent, as the Agent Plugins specification (§7.2.1, §9) describes:
//!
//! - `PLUGIN_ROOT` is the plugin's files, laid out from the package Core
//!   names (a presigned R2 URL, its size, and its SHA-256) under
//!   `~/.local/share/dx/plugins/<sha256>`, once per package.
//! - `PLUGIN_DATA` is a writable folder per plugin that survives updates:
//!   `~/.local/share/dx/plugin-data/<plugin id>`.
//! - `command` is one token: a bare name found on the login `PATH`, or a
//!   `./` path in the plugin. `args`, `env` values, and `cwd` expand only
//!   `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; `cwd` must stay inside one of
//!   them. dx sets the two names after the configured `env`.
//!
//! A server runs through a login shell (`bash -lc 'exec "$0" "$@"'`) so it
//! finds what `.agents/setup` installed, in its own process group. Its
//! stderr goes to `~/.local/state/dxd/mcp/<name>.log`. A server unused for
//! fifteen minutes, or one that times out, is stopped; the next request
//! starts it again.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_RUNNING: usize = 16;
const IDLE: Duration = Duration::from_secs(15 * 60);
/// The first start may install the server (`npx -y`, `uvx`) before it answers.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Core refuses a daemon frame over 4 MiB, so an answer stays below it.
const MAX_MESSAGE_BYTES: usize = 3 * 1024 * 1024;
/// Requests that may hold blocking-pool threads at once; Files, Changes,
/// and environment work share that pool.
const MAX_IN_FLIGHT: usize = 4;
/// The largest response frame dxd sends for one request (Core: 4 MiB).
pub const MAX_RESPONSE_FRAME_BYTES: usize = 4 * 1024 * 1024 - 4096;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const PACKAGE_MAGIC: &[u8] = b"DXPK1\n";
const PROTOCOL_VERSION: &str = "2025-06-18";
const COMPLETE_MARKER: &str = ".dx-package-complete";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvEntry {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageRef {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// One server's configuration, as the person reviewed it in the plugin.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerSpec {
    /// Core's digest of everything below; a change starts a new process.
    pub key: String,
    pub name: String,
    pub plugin_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvEntry>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub package: PackageRef,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum McpResult {
    /// The server's `result`.
    Result { result: Value },
    /// The server's JSON-RPC `error`.
    Error {
        code: i64,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    /// dx could not reach an answer: the request, package, start, or call
    /// failed. `message` says why, with the end of the server's stderr.
    Unavailable {
        reason: &'static str,
        message: String,
    },
}

fn unavailable(reason: &'static str, message: impl Into<String>) -> McpResult {
    McpResult::Unavailable {
        reason,
        message: truncate(&message.into(), 2048),
    }
}

fn truncate(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

#[derive(Clone)]
pub struct McpPaths {
    pub home: PathBuf,
    pub user: String,
    pub log_directory: PathBuf,
}

impl McpPaths {
    fn packages(&self) -> PathBuf {
        self.home.join(".local/share/dx/plugins")
    }
    fn data(&self, plugin_id: &str) -> PathBuf {
        self.home
            .join(".local/share/dx/plugin-data")
            .join(plugin_id)
    }
}

type Slot = Arc<Mutex<Option<Server>>>;

/// Every running server, shared by sessions: servers outlive a reconnect.
#[derive(Clone)]
pub struct McpServers {
    paths: McpPaths,
    slots: Arc<Mutex<HashMap<String, (Slot, Instant)>>>,
    in_flight: Arc<AtomicUsize>,
}

/// Counts one request in flight until it returns.
struct InFlight(Arc<AtomicUsize>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl McpServers {
    pub fn new(paths: McpPaths) -> Self {
        Self {
            paths,
            slots: Arc::default(),
            in_flight: Arc::default(),
        }
    }

    /// Relay one request. Blocking: run it on the blocking pool.
    pub fn request(
        &self,
        spec: &ServerSpec,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> McpResult {
        if let Err(message) = validate(spec) {
            return unavailable("invalid", message);
        }
        if method != "tools/list" && method != "tools/call" {
            return unavailable("invalid", "dx relays only tools/list and tools/call.");
        }
        let arrived = Instant::now();
        let timeout =
            Duration::from_millis(timeout_ms).clamp(Duration::from_secs(1), MAX_CALL_TIMEOUT);
        // Core waits START_TIMEOUT + timeout (and a margin) from dispatch;
        // nothing here outlives that.
        let overall = arrived + START_TIMEOUT + timeout;
        if self.in_flight.fetch_add(1, Ordering::AcqRel) >= MAX_IN_FLIGHT {
            self.in_flight.fetch_sub(1, Ordering::AcqRel);
            return unavailable(
                "busy",
                "Too many local MCP requests are running. Try again.",
            );
        }
        let _in_flight = InFlight(Arc::clone(&self.in_flight));
        let slot = self.slot(&spec.key);
        // One request at a time per server; a queued one gives up when its
        // own call budget passes rather than run after Core stopped waiting.
        let mut guard = loop {
            match slot.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    if Instant::now() >= arrived + timeout {
                        return unavailable("busy", "The server is busy with another request.");
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        };
        if guard.as_mut().is_some_and(|server| !server.running()) {
            *guard = None;
        }
        if guard.is_none() {
            match Server::start(spec, &self.paths, overall) {
                Ok(server) => *guard = Some(server),
                Err(result) => return result,
            }
        }
        let server = guard.as_mut().expect("started above");
        let result = server.call(method, params, (Instant::now() + timeout).min(overall));
        if matches!(result, McpResult::Unavailable { .. }) {
            // The process is in an unknown state: stop it so the next
            // request starts it fresh.
            *guard = None;
        }
        result
    }

    /// The slot for `key`, stopping idle servers and the least recently
    /// used one beyond the limit.
    fn slot(&self, key: &str) -> Slot {
        let mut slots = match self.slots.lock() {
            Ok(slots) => slots,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        slots.retain(|other, (_, used)| other == key || now.duration_since(*used) < IDLE);
        while slots.len() >= MAX_RUNNING && !slots.contains_key(key) {
            let oldest = slots
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(name, _)| name.clone());
            match oldest {
                Some(name) => {
                    slots.remove(&name);
                }
                None => break,
            }
        }
        let entry = slots
            .entry(key.to_owned())
            .or_insert_with(|| (Arc::default(), now));
        entry.1 = now;
        Arc::clone(&entry.0)
    }
}

fn validate(spec: &ServerSpec) -> Result<(), &'static str> {
    let hex64 = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    };
    if !hex64(&spec.key) || !hex64(&spec.package.sha256) {
        return Err("The server key or package digest is invalid.");
    }
    if spec.name.is_empty() || spec.name.chars().count() > 80 || spec.name.contains('\0') {
        return Err("The server name is invalid.");
    }
    if !(5..=68).contains(&spec.plugin_id.len())
        || !spec.plugin_id.starts_with("plg_")
        || !spec.plugin_id[4..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("The plugin id is invalid.");
    }
    let command = spec.command.as_str();
    if command.is_empty()
        || command.len() > 256
        || command.contains(char::is_whitespace)
        || command.contains('\0')
        || command.contains("${")
    {
        return Err("The command must be one executable token.");
    }
    if let Some(path) = command.strip_prefix("./") {
        if !safe_relative(path) {
            return Err("The command path leaves the plugin.");
        }
    } else if command.contains('/') {
        return Err("The command must be a bare name or a ./ path.");
    }
    if spec.args.len() > 64
        || spec
            .args
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
    {
        return Err("The arguments are invalid.");
    }
    if spec.env.len() > 32
        || spec.env.iter().any(|entry| {
            entry.name.is_empty()
                || entry.name.len() > 128
                || entry.name.as_bytes()[0].is_ascii_digit()
                || !entry
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || entry.value.len() > 4096
                || entry.value.contains('\0')
        })
    {
        return Err("The environment is invalid.");
    }
    if spec
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.len() > 512 || cwd.contains('\0'))
    {
        return Err("The working directory is invalid.");
    }
    if !spec.package.url.starts_with("https://") && !spec.package.url.starts_with("http://") {
        return Err("The package URL is invalid.");
    }
    if spec.package.size > MAX_PACKAGE_BYTES {
        return Err("The package is too large.");
    }
    Ok(())
}

/// A relative path whose every component is a plain name.
pub(crate) fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Lays out the package as `PLUGIN_ROOT` once; later starts reuse it.
pub(crate) fn prepare_package(
    package: &PackageRef,
    paths: &McpPaths,
    deadline: Instant,
) -> Result<PathBuf, McpResult> {
    let packages = paths.packages();
    let root = packages.join(&package.sha256);
    if root.join(COMPLETE_MARKER).is_file() {
        return Ok(root);
    }
    let failed = |message: String| unavailable("package", message);
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(
            DOWNLOAD_TIMEOUT.min(deadline.saturating_duration_since(Instant::now())),
        ))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent
        .get(&package.url)
        .call()
        .map_err(|error| failed(format!("dx could not download the plugin's files: {error}")))?;
    if response.status().as_u16() != 200 {
        return Err(failed(format!(
            "dx could not download the plugin's files (HTTP {}).",
            response.status().as_u16()
        )));
    }
    let mut bytes = Vec::with_capacity(package.size as usize);
    response
        .body_mut()
        .as_reader()
        .take(package.size + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| failed(format!("dx could not download the plugin's files: {error}")))?;
    if bytes.len() as u64 != package.size {
        return Err(failed(
            "The plugin's files are not the size dx recorded.".into(),
        ));
    }
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if hex != package.sha256 {
        return Err(failed(
            "The plugin's files do not match what was reviewed.".into(),
        ));
    }
    fs::create_dir_all(&packages).map_err(|error| failed(error.to_string()))?;
    let temporary = packages.join(format!(".{}.{}", package.sha256, rand::random::<u64>()));
    let laid_out = unpack(&bytes, &temporary)
        .and_then(|()| File::create(temporary.join(COMPLETE_MARKER)).map(drop));
    if let Err(error) = laid_out {
        let _ = fs::remove_dir_all(&temporary);
        return Err(failed(format!(
            "dx could not lay out the plugin's files: {error}"
        )));
    }
    if fs::rename(&temporary, &root).is_err() {
        // Another request laid out the same package first.
        let _ = fs::remove_dir_all(&temporary);
        if !root.join(COMPLETE_MARKER).is_file() {
            return Err(failed("dx could not lay out the plugin's files.".into()));
        }
    }
    Ok(root)
}

/// Writes a `DXPK1` package (see Core's `plugin-package.ts`) into `root`.
fn unpack(bytes: &[u8], root: &Path) -> io::Result<()> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "the package is malformed");
    let mut rest = bytes.strip_prefix(PACKAGE_MAGIC).ok_or_else(invalid)?;
    fs::create_dir_all(root)?;
    let mut take = |count: usize| -> io::Result<&[u8]> {
        if rest.len() < count {
            return Err(invalid());
        }
        let (head, tail) = rest.split_at(count);
        rest = tail;
        Ok(head)
    };
    let mut files = 0usize;
    while let Ok(length) = take(2) {
        let length = u16::from_be_bytes([length[0], length[1]]) as usize;
        let path = std::str::from_utf8(take(length)?)
            .map_err(|_| invalid())?
            .to_owned();
        if !safe_relative(&path) || path == COMPLETE_MARKER {
            return Err(invalid());
        }
        let flags = take(1)?[0];
        let size = take(4)?;
        let size = u32::from_be_bytes([size[0], size[1], size[2], size[3]]) as usize;
        let content = take(size)?;
        files += 1;
        if files > 5_000 {
            return Err(invalid());
        }
        let target = root.join(&path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mode = if flags & 1 == 1 { 0o755 } else { 0o644 };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&target)?;
        file.write_all(content)?;
        // The umask may have cleared bits the package asks for.
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    if rest.is_empty() {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Runs `$0` with the arguments after `--`, once each `NAME=value` before it
/// is exported again over what the login profile set.
const LAUNCH_SCRIPT: &str = r#"resolved=$(type -P -- "$0") || { printf 'dx: %s: command not found\n' "$0" >&2; exit 127; }
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export -- "$1"; shift; done
shift
exec "$resolved" "$@""#;

fn expand(value: &str, root: &Path, data: &Path) -> String {
    value
        .replace("${PLUGIN_ROOT}", &root.to_string_lossy())
        .replace("${PLUGIN_DATA}", &data.to_string_lossy())
}

/// §7.2.1: the working directory, which must stay inside the plugin root or
/// its data folder after resolution.
fn working_directory(cwd: Option<&str>, root: &Path, data: &Path) -> Result<PathBuf, String> {
    let Some(cwd) = cwd else {
        return Ok(root.to_owned());
    };
    let (base, relative) = if let Some(rest) = cwd.strip_prefix("${PLUGIN_ROOT}") {
        (root, rest)
    } else if let Some(rest) = cwd.strip_prefix("${PLUGIN_DATA}") {
        (data, rest)
    } else if let Some(rest) = cwd.strip_prefix("./") {
        (root, rest)
    } else {
        return Err(
            "cwd must be a ./ path, or start with ${PLUGIN_ROOT} or ${PLUGIN_DATA}.".into(),
        );
    };
    let relative = relative.trim_start_matches('/');
    if !relative.is_empty() && !safe_relative(relative.trim_end_matches('/')) {
        return Err("cwd leaves the plugin.".into());
    }
    let target = base.join(relative);
    if base == data {
        let _ = fs::create_dir_all(&target);
    }
    let resolved = target
        .canonicalize()
        .map_err(|_| format!("cwd {cwd} does not exist."))?;
    let inside = |folder: &Path| {
        folder
            .canonicalize()
            .is_ok_and(|folder| resolved.starts_with(folder))
    };
    if inside(root) || inside(data) {
        Ok(resolved)
    } else {
        Err("cwd leaves the plugin.".into())
    }
}

fn log_path(paths: &McpPaths, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    paths.log_directory.join(format!("{safe}.log"))
}

/// The end of the server's stderr log, for a failure message.
fn log_tail(path: &Path) -> String {
    let Ok(text) = fs::read(path) else {
        return String::new();
    };
    let start = text.len().saturating_sub(1024);
    let tail = String::from_utf8_lossy(&text[start..]).trim().to_owned();
    if tail.is_empty() {
        String::new()
    } else {
        format!(" Its stderr ended with: {tail}")
    }
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Vec<u8>>,
    next_id: u64,
    log: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let pid = self.child.id() as i32;
        // SAFETY: the server leads its own process group (`process_group(0)`)
        // and is not reaped yet, so the group id still names it.
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = self.child.wait();
    }
}

impl Server {
    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn start(spec: &ServerSpec, paths: &McpPaths, deadline: Instant) -> Result<Self, McpResult> {
        let root = prepare_package(&spec.package, paths, deadline)?;
        let data = paths.data(&spec.plugin_id);
        fs::create_dir_all(&data).map_err(|error| {
            unavailable(
                "start-failed",
                format!("dx could not create PLUGIN_DATA: {error}"),
            )
        })?;
        let command = match spec.command.strip_prefix("./") {
            Some(relative) => {
                let path = root.join(relative);
                let inside = path
                    .canonicalize()
                    .ok()
                    .zip(root.canonicalize().ok())
                    .is_some_and(|(path, root)| path.starts_with(root) && path.is_file());
                if !inside {
                    return Err(unavailable(
                        "start-failed",
                        format!("The command {} is not in the plugin.", spec.command),
                    ));
                }
                // ZIPs made on some systems lose the execute bit.
                if let Ok(metadata) = fs::metadata(&path)
                    && metadata.permissions().mode() & 0o111 == 0
                {
                    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
                }
                path.to_string_lossy().into_owned()
            }
            None => spec.command.clone(),
        };
        let cwd = working_directory(spec.cwd.as_deref(), &root, &data)
            .map_err(|message| unavailable("start-failed", message))?;
        let mut environment =
            crate::environment::base_environment_for(&BTreeMap::new(), &paths.home, &paths.user);
        for entry in &spec.env {
            environment.insert(entry.name.clone(), expand(&entry.value, &root, &data));
        }
        // §9.1: dx's names win over configured env.
        let root_text = root.to_string_lossy().into_owned();
        let data_text = data.to_string_lossy().into_owned();
        environment.insert("PLUGIN_ROOT".into(), root_text.clone());
        environment.insert("PLUGIN_DATA".into(), data_text.clone());
        // Claude Code plugins read their own names for the same folders.
        environment.insert("CLAUDE_PLUGIN_ROOT".into(), root_text);
        environment.insert("CLAUDE_PLUGIN_DATA".into(), data_text);
        fs::create_dir_all(&paths.log_directory)
            .map_err(|error| unavailable("start-failed", error.to_string()))?;
        let log = log_path(paths, &spec.name);
        if fs::metadata(&log).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
            let _ = fs::rename(&log, log.with_extension("log.1"));
        }
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&log)
            .map_err(|error| unavailable("start-failed", error.to_string()))?;
        // A login profile may reset variables such as PATH, so the shell
        // sets configured env and dx's names again (§9.1) after resolving a
        // bare command on the login PATH.
        let overlay: Vec<String> = spec
            .env
            .iter()
            .map(|entry| entry.name.as_str())
            .chain([
                "PLUGIN_ROOT",
                "PLUGIN_DATA",
                "CLAUDE_PLUGIN_ROOT",
                "CLAUDE_PLUGIN_DATA",
            ])
            .filter_map(|name| environment.get(name).map(|value| format!("{name}={value}")))
            .collect();
        let mut process = Command::new("/bin/bash");
        process
            .arg("-lc")
            .arg(LAUNCH_SCRIPT)
            .arg(&command)
            .args(overlay)
            .arg("--")
            .args(spec.args.iter().map(|arg| expand(arg, &root, &data)))
            .current_dir(&cwd)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .process_group(0);
        let mut child = process.spawn().map_err(|error| {
            unavailable(
                "start-failed",
                format!("dx could not start {}: {error}", spec.name),
            )
        })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let (sender, lines) = mpsc::sync_channel(64);
        std::thread::Builder::new()
            .name("dxd-mcp-stdout".into())
            .spawn(move || read_lines(stdout, sender))
            .map_err(|error| unavailable("start-failed", error.to_string()))?;
        let mut server = Self {
            child,
            stdin,
            lines,
            next_id: 1,
            log,
        };
        let initialized = server.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "dx", "version": crate::RELEASE },
            }),
            (Instant::now() + START_TIMEOUT).min(deadline),
        );
        match initialized {
            McpResult::Result { .. } => {}
            McpResult::Error { message, .. } => {
                return Err(unavailable(
                    "start-failed",
                    format!("{} refused to start: {message}", spec.name),
                ));
            }
            McpResult::Unavailable { message, .. } => {
                return Err(unavailable(
                    "start-failed",
                    format!("{} did not start. {message}", spec.name),
                ));
            }
        }
        server
            .send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .map_err(|_| unavailable("start-failed", format!("{} closed its input.", spec.name)))?;
        Ok(server)
    }

    fn send(&mut self, message: &Value) -> io::Result<()> {
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        self.stdin.write_all(&line)?;
        self.stdin.flush()
    }

    /// One request; answers the server's own requests while it waits.
    fn call(&mut self, method: &str, params: Value, deadline: Instant) -> McpResult {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.send(&request).is_err() {
            return unavailable(
                "exited",
                format!("The server exited.{}", log_tail(&self.log)),
            );
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    return unavailable(
                        "timeout",
                        format!(
                            "The server did not answer {method} in time.{}",
                            log_tail(&self.log)
                        ),
                    );
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return unavailable(
                        "exited",
                        format!("The server exited.{}", log_tail(&self.log)),
                    );
                }
            };
            if line.is_empty() {
                return unavailable(
                    "too-large",
                    format!("The server's answer to {method} is larger than 3 MiB."),
                );
            }
            // A login profile may print to stdout; only JSON-RPC counts.
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let Some(object) = message.as_object() else {
                continue;
            };
            if let Some(server_method) = object.get("method").and_then(Value::as_str) {
                if let Some(request_id) = object.get("id") {
                    let reply = if server_method == "ping" {
                        json!({ "jsonrpc": "2.0", "id": request_id, "result": {} })
                    } else {
                        json!({
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": { "code": -32601, "message": "dx does not support this request." },
                        })
                    };
                    let _ = self.send(&reply);
                }
                continue;
            }
            if object.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = object.get("error") {
                return McpResult::Error {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                    message: truncate(
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The server failed."),
                        2048,
                    ),
                    data: error.get("data").cloned(),
                };
            }
            return match object.get("result") {
                Some(result) if result.is_object() => McpResult::Result {
                    result: result.clone(),
                },
                _ => unavailable(
                    "invalid",
                    format!("The server's answer to {method} has no result."),
                ),
            };
        }
    }
}

/// Newline-delimited messages from the server; a line beyond the limit ends
/// the stream, which stops the server.
fn read_lines(stdout: impl Read, sender: mpsc::SyncSender<Vec<u8>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = Vec::new();
        match (&mut reader)
            .take(MAX_MESSAGE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.len() > MAX_MESSAGE_BYTES {
            // An empty line never comes from the server: it marks this.
            let _ = sender.send(Vec::new());
            return;
        }
        if sender.send(line).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut bytes = PACKAGE_MAGIC.to_vec();
        for (path, content, executable) in files {
            bytes.extend_from_slice(&(path.len() as u16).to_be_bytes());
            bytes.extend_from_slice(path.as_bytes());
            bytes.push(u8::from(*executable));
            bytes.extend_from_slice(&(content.len() as u32).to_be_bytes());
            bytes.extend_from_slice(content);
        }
        bytes
    }

    #[test]
    fn unpack_writes_files_and_refuses_escapes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("ok");
        unpack(
            &package(&[("bin/run", b"#!/bin/sh\n", true), ("a.json", b"{}", false)]),
            &root,
        )
        .unwrap();
        assert_eq!(fs::read(root.join("a.json")).unwrap(), b"{}");
        let mode = fs::metadata(root.join("bin/run"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
        for path in ["../x", "/etc/x", "a/../../x", "", COMPLETE_MARKER] {
            let target = directory.path().join("bad");
            let _ = fs::remove_dir_all(&target);
            assert!(
                unpack(&package(&[(path, b"x", false)]), &target).is_err(),
                "{path}"
            );
        }
        let mut truncated = package(&[("a", b"abc", false)]);
        truncated.pop();
        assert!(unpack(&truncated, &directory.path().join("short")).is_err());
    }

    #[test]
    fn working_directory_stays_inside_root_or_data() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let data = directory.path().join("data");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&data).unwrap();
        assert_eq!(working_directory(None, &root, &data).unwrap(), root);
        assert!(working_directory(Some("./sub"), &root, &data).is_ok());
        assert!(working_directory(Some("${PLUGIN_ROOT}/sub"), &root, &data).is_ok());
        assert!(working_directory(Some("${PLUGIN_DATA}/cache"), &root, &data).is_ok());
        assert!(working_directory(Some("${PLUGIN_ROOT}/../data"), &root, &data).is_err());
        assert!(working_directory(Some("/tmp"), &root, &data).is_err());
        std::os::unix::fs::symlink("/", root.join("escape")).unwrap();
        assert!(working_directory(Some("./escape"), &root, &data).is_err());
    }
}
