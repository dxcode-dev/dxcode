//! The Orb plugin host: plugin code that runs as a process in the Thread's
//! Orb, supervised here.
//!
//! Core sends `plugin.invoke` with one install's reviewed process
//! description and one call into its code. This module keeps one Node
//! process per description (Core's `key`), lays out its files from the same
//! `DXPK1` package as a local MCP server ([`crate::mcp`]), installs the
//! native tools the manifest's `binaries` name, starts dx's runtime (files
//! Core sends, kept by digest), and relays the call. While a call runs, the
//! plugin's capability requests (`ctx.storage`, `ctx.log`, …) go to Core as
//! `plugin.capability` frames and Core's answers come back to the process:
//! Core decides what each may reach, exactly as for the Worker host.
//!
//! The process talks to dxd over a socketpair on fd 3, one JSON object per
//! line, so nothing the plugin prints can be mistaken for the protocol; its
//! stdout and stderr go to `~/.local/state/dxd/plugins/<install>.log`.
//!
//! Lifetime (decision D4): a process stays up while a call is in flight or
//! while a TCP connection is open to one of its pane ports (the Portal a
//! pane frames), and for a minute after the later of those. A reaper thread
//! stops the rest; `plugin.stop` stops one now.

mod binaries;
mod lease;
mod process;

use crate::proxy::Outbound;
use process::{CallOutcome, Process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;

const MAX_PROCESSES: usize = 8;
const MAX_CALLS_PER_PROCESS: usize = 8;
/// Starting covers the package, native tools (an apt install), and the
/// runtime loading the plugin.
const START_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CALL_TIMEOUT_MS: u64 = 300_000;
/// The largest line either side writes on fd 3.
pub(crate) const MAX_MESSAGE_BYTES: usize = 3 * 1024 * 1024;
/// The largest capability frame dxd sends Core.
pub const MAX_CAPABILITY_FRAME_BYTES: usize = 1024 * 1024;
const IDLE: Duration = Duration::from_secs(60);
const REAP_EVERY: Duration = Duration::from_secs(10);
const MAX_RUNTIME_FILES: usize = 8;
const MAX_RUNTIME_BYTES: usize = 512 * 1024;
const RUNTIME_COMPLETE: &str = ".dx-runtime-complete";
/// The runtime's file paths in Core's order, one per line: its digest is
/// recomputed from them before every start.
const RUNTIME_ORDER: &str = ".dx-runtime-order";

/// Core's runtime digest: SHA-256 over each file's `path\0content\0`, in order.
fn runtime_digest<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> String {
    use sha2::Digest;
    let mut hash = sha2::Sha256::new();
    for (path, content) in files {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(content);
        hash.update([0]);
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether a written runtime still is what Core named: anything in the
/// Orb running as the same user could have edited it since.
fn runtime_intact(folder: &Path, sha256: &str) -> bool {
    let Ok(order) = fs::read_to_string(folder.join(RUNTIME_ORDER)) else {
        return false;
    };
    let mut files = Vec::new();
    for path in order.lines() {
        if !crate::mcp::safe_relative(path) {
            return false;
        }
        match fs::read(folder.join(path)) {
            Ok(content) => files.push((path, content)),
            Err(_) => return false,
        }
    }
    !files.is_empty()
        && runtime_digest(
            files
                .iter()
                .map(|(path, content)| (*path, content.as_slice())),
        ) == sha256
}
const MAX_ERROR_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRef {
    pub sha256: String,
    #[serde(default)]
    pub files: Option<Vec<RuntimeFile>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binary {
    pub name: String,
    #[serde(default)]
    pub apt: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

/// One install's process, as Core describes it; `key` digests the rest.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSpec {
    pub key: String,
    pub install_id: String,
    pub name: String,
    pub integrity: String,
    pub package: crate::mcp::PackageRef,
    pub entry: String,
    pub runtime: RuntimeRef,
    #[serde(default)]
    pub binaries: Vec<Binary>,
    #[serde(default)]
    pub ports: Vec<u16>,
}

/// One call into the plugin's code: the runtime's method, its arguments
/// (all but the capability object), and who it runs for.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallSpec {
    pub method: String,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub info: Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginResult {
    Result {
        value: Value,
    },
    Error {
        message: String,
    },
    Unavailable {
        reason: &'static str,
        message: String,
    },
    Status {
        state: &'static str,
        since: u64,
    },
    Stopped {
        count: usize,
    },
}

pub(crate) fn unavailable(reason: &'static str, message: impl Into<String>) -> PluginResult {
    PluginResult::Unavailable {
        reason,
        message: truncate(&message.into(), 2048),
    }
}

pub(crate) fn truncate(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Where this host keeps its files.
#[derive(Clone)]
pub struct PluginPaths {
    pub home: PathBuf,
    pub user: String,
    pub log_directory: PathBuf,
}

impl PluginPaths {
    fn share(&self) -> PathBuf {
        self.home.join(".local/share/dx")
    }
    fn runtime(&self, sha256: &str) -> PathBuf {
        self.share().join("plugin-runtime").join(sha256)
    }
    fn data(&self, install_id: &str) -> PathBuf {
        self.share().join("plugin-data").join(install_id)
    }
    pub(crate) fn binaries(&self) -> PathBuf {
        self.share().join("plugin-bin")
    }
    fn mcp(&self) -> crate::mcp::McpPaths {
        crate::mcp::McpPaths {
            home: self.home.clone(),
            user: self.user.clone(),
            log_directory: self.log_directory.clone(),
        }
    }
}

/// Where a call's capability requests go: the session that sent it.
#[derive(Clone)]
pub struct CapabilityLane {
    pub sender: UnboundedSender<Outbound>,
    pub generation: String,
    pub request_id: String,
}

impl CapabilityLane {
    /// Sends one capability request to Core; false when it cannot go.
    pub(crate) fn send(&self, call_id: u32, method: &str, args: &Value) -> bool {
        let frame = crate::protocol::ClientMessage::PluginCapability {
            generation: &self.generation,
            request_id: &self.request_id,
            call_id,
            method,
            args,
        };
        match serde_json::to_string(&frame) {
            Ok(text) if text.len() <= MAX_CAPABILITY_FRAME_BYTES => {
                self.sender.send(Outbound::Text(text)).is_ok()
            }
            _ => false,
        }
    }
}

/// What a key last did, for `plugin.status`.
enum Known {
    Starting(u64),
    Running(Arc<Process>),
    Stopped(u64),
}

struct Inner {
    paths: PluginPaths,
    idle: Duration,
    known: Mutex<HashMap<String, Known>>,
    /// One start per key at a time.
    starts: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// `plugin.invoke` request id → the process its capability answers go to.
    routes: Mutex<HashMap<String, Arc<Process>>>,
    next_call: AtomicU32,
    reaper: Once,
    start_permits: tokio::sync::Semaphore,
}

/// Every plugin process, shared by sessions: processes outlive a reconnect.
#[derive(Clone)]
pub struct PluginHosts {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn token(value: &str, minimum: usize, maximum: usize, extra: &[u8]) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

/// Loopback http serves tests and local development; anything else https.
/// The host is parsed, not prefix-matched: no user info, and plain http only
/// when the host is exactly a loopback name.
pub(crate) fn allowed_url(url: &str) -> bool {
    if url.len() > 2048 || url.bytes().any(|b| b.is_ascii_control() || b == b' ') {
        return false;
    }
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', '\\']) {
        return false;
    }
    let host = if authority.starts_with('[') {
        match authority.find(']') {
            Some(end)
                if authority[end + 1..].is_empty() || authority[end + 1..].starts_with(':') =>
            {
                &authority[..=end]
            }
            _ => return false,
        }
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let port = &authority[host.len()..];
    if !(port.is_empty() || (port.len() > 1 && port[1..].bytes().all(|b| b.is_ascii_digit()))) {
        return false;
    }
    if host.is_empty() {
        return false;
    }
    secure || matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn validate(spec: &ProcessSpec) -> Result<(), &'static str> {
    if !token(&spec.key, 8, 128, b"_-") {
        return Err("The process key is invalid.");
    }
    if !token(&spec.install_id, 1, 128, b"_-") {
        return Err("The install id is invalid.");
    }
    if !token(&spec.name, 1, 128, b"._-") {
        return Err("The plugin name is invalid.");
    }
    if spec.integrity.is_empty() || spec.integrity.len() > 256 {
        return Err("The integrity is invalid.");
    }
    if !hex64(&spec.package.sha256)
        || !allowed_url(&spec.package.url)
        || spec.package.size > 32 * 1024 * 1024
    {
        return Err("The package is invalid.");
    }
    if !crate::mcp::safe_relative(&spec.entry) {
        return Err("The entry module leaves the plugin.");
    }
    if !hex64(&spec.runtime.sha256) {
        return Err("The runtime digest is invalid.");
    }
    if spec.ports.len() > 8 || spec.ports.contains(&0) {
        return Err("The ports are invalid.");
    }
    binaries::validate(&spec.binaries)
}

impl PluginHosts {
    pub fn new(paths: PluginPaths) -> Self {
        // Tests shorten the idle period; the reaper checks at least as often.
        let idle = std::env::var("DXD_PLUGIN_IDLE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map_or(IDLE, Duration::from_millis);
        Self {
            inner: Arc::new(Inner {
                paths,
                idle,
                known: Mutex::default(),
                starts: Mutex::default(),
                routes: Mutex::default(),
                next_call: AtomicU32::new(1),
                reaper: Once::new(),
                start_permits: tokio::sync::Semaphore::new(2),
            }),
        }
    }

    /// Runs one call: starts the process when needed (blocking work runs on
    /// the blocking pool), then waits for its answer without holding a
    /// thread.
    pub async fn invoke(
        &self,
        spec: ProcessSpec,
        call: CallSpec,
        timeout_ms: u64,
        lane: CapabilityLane,
    ) -> PluginResult {
        if let Err(message) = validate(&spec) {
            return unavailable("invalid", message);
        }
        if !token(&call.method, 1, 32, b"") {
            return unavailable("invalid", "The call names no runtime method.");
        }
        let timeout = Duration::from_millis(timeout_ms.clamp(1, MAX_CALL_TIMEOUT_MS));
        // The start limit counts from arrival, queueing for a permit included.
        let arrived = Instant::now();
        let spec = Arc::new(spec);
        let request_id = lane.request_id.clone();
        let id = self.inner.next_call.fetch_add(1, Ordering::Relaxed);
        let mut attempts = 0;
        let (process, receiver) = loop {
            attempts += 1;
            let process = match self.running(&spec.key) {
                Some(process) => process,
                None => {
                    // A start may install packages for minutes on the blocking
                    // pool, which Files and Changes share: two at a time.
                    let Ok(_permit) = self.inner.start_permits.acquire().await else {
                        return unavailable("start", "The plugin host is shutting down.");
                    };
                    let hosts = self.clone();
                    let spec = Arc::clone(&spec);
                    match tokio::task::spawn_blocking(move || hosts.ensure(&spec, arrived)).await {
                        Ok(Ok(process)) => process,
                        Ok(Err(result)) => return result,
                        Err(_) => {
                            return unavailable("start", "The plugin's process did not start.");
                        }
                    }
                }
            };
            match process.begin(id, lane.clone(), MAX_CALLS_PER_PROCESS) {
                Ok(receiver) => break (process, receiver),
                // The reaper retired it (or it exited) the moment before:
                // start a fresh one once.
                Err(PluginResult::Unavailable {
                    reason: "exited", ..
                }) if attempts < 2 => {}
                Err(result) => return result,
            }
        };
        lock(&self.inner.routes).insert(request_id.clone(), Arc::clone(&process));
        let line = serde_json::json!({
            "t": "call",
            "id": id,
            "method": call.method,
            "args": call.args,
            "info": call.info,
        });
        let written = {
            let process = Arc::clone(&process);
            tokio::task::spawn_blocking(move || process.write(&line)).await
        };
        let outcome = if !matches!(written, Ok(Ok(()))) {
            process.forget(id);
            CallOutcome::Exited(process.exit_message())
        } else {
            match tokio::time::timeout(timeout, receiver).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => CallOutcome::Exited(process.exit_message()),
                Err(_) => {
                    process.forget(id);
                    CallOutcome::TimedOut
                }
            }
        };
        lock(&self.inner.routes).remove(&request_id);
        process.touch();
        match outcome {
            CallOutcome::Ok(value) => PluginResult::Result { value },
            CallOutcome::Err(message) => PluginResult::Error {
                message: truncate(&message, MAX_ERROR_BYTES),
            },
            CallOutcome::Exited(message) => unavailable("exited", message),
            CallOutcome::TimedOut => unavailable(
                "timeout",
                format!(
                    "{} did not answer {} within {} seconds.",
                    process.name,
                    call.method,
                    timeout.as_secs_f32()
                ),
            ),
        }
    }

    /// Core's answer to one capability request, for the process that asked.
    pub fn answer(&self, request_id: &str, call_id: u32, ok: bool, value: Value, error: String) {
        let process = lock(&self.inner.routes).get(request_id).cloned();
        if let Some(process) = process {
            let line = if ok {
                serde_json::json!({"t": "host-result", "cid": call_id, "ok": true, "value": value})
            } else {
                serde_json::json!({"t": "host-result", "cid": call_id, "ok": false, "error": truncate(&error, MAX_ERROR_BYTES)})
            };
            // Off the connection loop: a process that stopped reading would
            // hold it until the write timeout.
            tokio::task::spawn_blocking(move || {
                let _ = process.write(&line);
            });
        }
    }

    pub fn status(&self, key: &str) -> PluginResult {
        let known = lock(&self.inner.known);
        match known.get(key) {
            Some(Known::Starting(since)) => PluginResult::Status {
                state: "starting",
                since: *since,
            },
            Some(Known::Running(process)) if process.alive() => PluginResult::Status {
                state: "running",
                since: process.since,
            },
            Some(Known::Running(process)) => PluginResult::Status {
                state: "stopped",
                since: process.ended_at(),
            },
            Some(Known::Stopped(since)) => PluginResult::Status {
                state: "stopped",
                since: *since,
            },
            None => PluginResult::Status {
                state: "cold",
                since: 0,
            },
        }
    }

    /// Stops the process for `key`, or every process of `install_id`.
    /// Blocking: it waits up to two seconds per process.
    pub fn stop(&self, key: Option<&str>, install_id: Option<&str>) -> PluginResult {
        let count = self.stop_where(|other, process| {
            key.is_some_and(|key| key == other)
                || install_id.is_some_and(|id| id == process.install_id)
        });
        PluginResult::Stopped { count }
    }

    /// Stops every running process the filter picks, outside the registry
    /// lock; returns how many were alive.
    fn stop_where(&self, pick: impl Fn(&str, &Process) -> bool) -> usize {
        let matching: Vec<(String, Arc<Process>)> = lock(&self.inner.known)
            .iter()
            .filter_map(|(other, known)| match known {
                Known::Running(process) if pick(other, process) => {
                    Some((other.clone(), Arc::clone(process)))
                }
                _ => None,
            })
            .collect();
        let mut count = 0;
        for (key, process) in matching {
            if process.alive() {
                count += 1;
            }
            process.stop();
            self.set_known(&key, Known::Stopped(now_ms()));
        }
        count
    }

    /// Records what a key does now. The value it replaces is dropped after
    /// the lock is released: dropping the last handle to a process stops it,
    /// which may wait seconds.
    fn set_known(&self, key: &str, value: Known) {
        let replaced = lock(&self.inner.known).insert(key.to_owned(), value);
        drop(replaced);
    }

    /// The running process for the spec's key, started if needed.
    fn ensure(&self, spec: &ProcessSpec, arrived: Instant) -> Result<Arc<Process>, PluginResult> {
        if let Some(process) = self.running(&spec.key) {
            return Ok(process);
        }
        let start = Arc::clone(
            lock(&self.inner.starts)
                .entry(spec.key.clone())
                .or_default(),
        );
        let _starting = lock(&start);
        if let Some(process) = self.running(&spec.key) {
            return Ok(process);
        }
        let runtime = self.prepare_runtime(&spec.runtime)?;
        // Another version of the install must not fight this one over its
        // ports and PLUGIN_DATA: it stops first.
        self.stop_where(|other, process| {
            other != spec.key && process.install_id == spec.install_id
        });
        self.make_room(&spec.key)?;
        self.set_known(&spec.key, Known::Starting(now_ms()));
        let started = self.start(spec, &runtime, arrived + START_TIMEOUT);
        match started {
            Ok(process) => {
                self.set_known(&spec.key, Known::Running(Arc::clone(&process)));
                self.start_reaper();
                Ok(process)
            }
            Err(result) => {
                self.set_known(&spec.key, Known::Stopped(now_ms()));
                Err(result)
            }
        }
    }

    fn start(
        &self,
        spec: &ProcessSpec,
        runtime: &Path,
        deadline: Instant,
    ) -> Result<Arc<Process>, PluginResult> {
        let paths = &self.inner.paths;
        let root = crate::mcp::prepare_package(&spec.package, &paths.mcp(), deadline).map_err(
            |result| match result {
                crate::mcp::McpResult::Unavailable { message, .. } => {
                    unavailable("package", message)
                }
                _ => unavailable("package", "dx could not lay out the plugin's files."),
            },
        )?;
        let entry = root.join(&spec.entry);
        if !entry.is_file() {
            return Err(unavailable(
                "start",
                format!("The entry module {} is not in the plugin.", spec.entry),
            ));
        }
        let bin = binaries::install(paths, spec, &root, deadline)?;
        let data = paths.data(&spec.install_id);
        fs::create_dir_all(&data).map_err(|error| {
            unavailable("start", format!("dx could not create PLUGIN_DATA: {error}"))
        })?;
        Process::start(process::Launch {
            spec,
            paths,
            root: &root,
            entry: &entry,
            data: &data,
            bin: &bin,
            runtime,
            deadline,
        })
        .map(Arc::new)
    }

    fn running(&self, key: &str) -> Option<Arc<Process>> {
        match lock(&self.inner.known).get(key) {
            Some(Known::Running(process)) if process.alive() => Some(Arc::clone(process)),
            _ => None,
        }
    }

    /// Stops the least recently used idle process when eight already run.
    fn make_room(&self, key: &str) -> Result<(), PluginResult> {
        let victim = {
            let known = lock(&self.inner.known);
            let running: Vec<(&String, &Arc<Process>)> = known
                .iter()
                .filter_map(|(other, known)| match known {
                    Known::Running(process) if process.alive() && other != key => {
                        Some((other, process))
                    }
                    _ => None,
                })
                .collect();
            if running.len() < MAX_PROCESSES {
                return Ok(());
            }
            running
                .into_iter()
                .filter(|(_, process)| process.calls_in_flight() == 0)
                .min_by_key(|(_, process)| process.last_active())
                .map(|(key, process)| (key.clone(), Arc::clone(process)))
        };
        match victim {
            Some((key, process)) => {
                process.stop();
                self.set_known(&key, Known::Stopped(now_ms()));
                Ok(())
            }
            None => Err(unavailable(
                "busy",
                format!("{MAX_PROCESSES} plugin processes are busy in this Orb. Try again."),
            )),
        }
    }

    /// The runtime's folder, written from the files Core sent the first
    /// time; without them, `unavailable/runtime` asks Core to send them.
    fn prepare_runtime(&self, runtime: &RuntimeRef) -> Result<PathBuf, PluginResult> {
        let folder = self.inner.paths.runtime(&runtime.sha256);
        if folder.join(RUNTIME_COMPLETE).is_file() {
            if runtime_intact(&folder, &runtime.sha256) {
                return Ok(folder);
            }
            // Edited since it was written (or written before this check):
            // it is replaced from Core's files, never run.
            let _ = fs::remove_dir_all(&folder);
        }
        let Some(files) = &runtime.files else {
            return Err(unavailable(
                "runtime",
                "This Orb does not have the plugin runtime yet.",
            ));
        };
        let total: usize = files.iter().map(|file| file.content.len()).sum();
        if files.is_empty()
            || files.len() > MAX_RUNTIME_FILES
            || total > MAX_RUNTIME_BYTES
            || files.iter().any(|file| {
                !crate::mcp::safe_relative(&file.path)
                    || file.path == RUNTIME_COMPLETE
                    || file.path == RUNTIME_ORDER
            })
            || runtime_digest(
                files
                    .iter()
                    .map(|file| (file.path.as_str(), file.content.as_bytes())),
            ) != runtime.sha256
        {
            return Err(unavailable("invalid", "The runtime's files are invalid."));
        }
        let parent = folder.parent().map(Path::to_owned).unwrap_or_default();
        let failed = |error: std::io::Error| {
            unavailable(
                "runtime",
                format!("dx could not write the runtime: {error}"),
            )
        };
        fs::create_dir_all(&parent).map_err(failed)?;
        let temporary = parent.join(format!(".{}.{}", runtime.sha256, rand::random::<u64>()));
        let written = (|| -> std::io::Result<()> {
            for file in files {
                let target = temporary.join(&file.path);
                if let Some(directory) = target.parent() {
                    fs::create_dir_all(directory)?;
                }
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o644)
                    .open(&target)?
                    .write_all(file.content.as_bytes())?;
            }
            let order: String = files
                .iter()
                .map(|file| format!("{}\n", file.path))
                .collect();
            fs::write(temporary.join(RUNTIME_ORDER), order)?;
            fs::File::create(temporary.join(RUNTIME_COMPLETE)).map(drop)
        })();
        if let Err(error) = written {
            let _ = fs::remove_dir_all(&temporary);
            return Err(failed(error));
        }
        if fs::rename(&temporary, &folder).is_err() {
            let _ = fs::remove_dir_all(&temporary);
            if !folder.join(RUNTIME_COMPLETE).is_file() {
                return Err(unavailable("runtime", "dx could not write the runtime."));
            }
        }
        Ok(folder)
    }

    fn start_reaper(&self) {
        let inner = Arc::downgrade(&self.inner);
        self.inner.reaper.call_once(|| {
            let _ = std::thread::Builder::new()
                .name("dxd-plugin-reaper".into())
                .spawn(move || reap(inner));
        });
    }
}

/// Stops processes nothing has used for the idle period: no call in flight
/// and no connection open to one of their ports.
fn reap(inner: std::sync::Weak<Inner>) {
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let every = REAP_EVERY
            .min(inner.idle / 2)
            .max(Duration::from_millis(50));
        let running: Vec<(String, Arc<Process>)> = lock(&inner.known)
            .iter()
            .filter_map(|(key, known)| match known {
                Known::Running(process) => Some((key.clone(), Arc::clone(process))),
                _ => None,
            })
            .collect();
        let ports: Vec<u16> = running
            .iter()
            .flat_map(|(_, process)| process.ports.iter().copied())
            .collect();
        let leased = lease::established(&ports);
        // Replaces the key's entry only while it still holds this process: a
        // call may have started a new one meanwhile, which must stay. The
        // replaced value is dropped after the lock is released.
        let set_if_same = |key: &str, process: &Arc<Process>, value: Known| {
            let mut known = lock(&inner.known);
            let same = matches!(
                known.get(key),
                Some(Known::Running(current)) if Arc::ptr_eq(current, process)
            );
            let replaced = if same {
                known.insert(key.to_owned(), value)
            } else {
                None
            };
            drop(known);
            drop(replaced);
        };
        for (key, process) in running {
            // Held across retire, stop, and record: a call for this key waits
            // in `ensure` until the old process is gone, so the new one never
            // overlaps its SIGTERM grace on the same ports.
            let start = Arc::clone(lock(&inner.starts).entry(key.clone()).or_default());
            let _starting = lock(&start);
            if !process.alive() {
                set_if_same(&key, &process, Known::Stopped(process.ended_at()));
                continue;
            }
            let held = process.ports.iter().any(|port| leased.contains(port));
            // Decided under the process's calls lock, so a call that begins
            // now either keeps it or sees it retiring and starts a new one.
            if process.retire_if_idle(inner.idle, held) {
                process.stop();
                set_if_same(&key, &process, Known::Stopped(now_ms()));
            }
        }
        drop(inner);
        std::thread::sleep(every);
    }
}

#[cfg(test)]
mod tests {
    use super::allowed_url;

    // Ways the rule could fail: a prefix match letting another host pass
    // as loopback, user info hiding the real host, plain http to a real
    // host, a malformed port or bracket, or control characters.
    #[test]
    fn downloads_are_https_or_exactly_loopback_http() {
        for good in [
            "https://github.com/a/b",
            "https://example.com:8443/x?y#z",
            "http://localhost:8080/r2/pkg",
            "http://127.0.0.1/x",
            "http://[::1]:9/x",
        ] {
            assert!(allowed_url(good), "{good}");
        }
        for bad in [
            "http://localhost.evil.com/x",
            "http://127.0.0.1.evil.com/x",
            "http://127.0.0.1@evil.com/x",
            "https://user@github.com/x",
            "http://example.com/x",
            "ftp://example.com/x",
            "https://",
            "https://host:port/x",
            "http://[::1]evil/x",
            "https://example.com/a b",
            "https://example.com/\n",
        ] {
            assert!(!allowed_url(bad), "{bad}");
        }
    }
}
