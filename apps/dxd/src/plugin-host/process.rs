//! One plugin process: `node` started directly (no login shell, so no
//! profile another program in the Orb could edit runs first) with fd 3
//! bound to a socketpair, read by one thread that routes each line to the
//! call it belongs to, and written under one lock by everyone.

use super::{
    CapabilityLane, MAX_ERROR_BYTES, MAX_MESSAGE_BYTES, PluginPaths, PluginResult, ProcessSpec,
    lock, now_ms, truncate, unavailable,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// A write to a process that stopped reading gives up after this long.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Where `node` and the plugin's tools are looked up after its own binaries.
const SYSTEM_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

pub(super) enum CallOutcome {
    Ok(Value),
    Err(String),
    Exited(String),
    TimedOut,
}

struct Call {
    done: oneshot::Sender<CallOutcome>,
    lane: CapabilityLane,
}

pub(super) struct Launch<'a> {
    pub spec: &'a ProcessSpec,
    pub paths: &'a PluginPaths,
    pub root: &'a Path,
    pub entry: &'a Path,
    pub data: &'a Path,
    pub bin: &'a Path,
    pub runtime: &'a Path,
    pub deadline: Instant,
}

struct Life {
    child: Option<Child>,
    ended_at: Option<u64>,
    last_active: Instant,
}

pub(super) struct Process {
    pub name: String,
    pub install_id: String,
    pub ports: Vec<u16>,
    pub since: u64,
    pid: i32,
    log: PathBuf,
    writer: Arc<Mutex<UnixStream>>,
    calls: Arc<Mutex<HashMap<u32, Call>>>,
    life: Arc<Mutex<Life>>,
    /// Set (under the calls lock) once the reaper chose to stop it: no new
    /// call may begin on it after that.
    retiring: AtomicBool,
}

impl Process {
    pub(super) fn start(launch: Launch<'_>) -> Result<Self, PluginResult> {
        let spec = launch.spec;
        let failed = |message: String| unavailable("start", message);
        fs::create_dir_all(&launch.paths.log_directory)
            .map_err(|error| failed(error.to_string()))?;
        let log = launch
            .paths
            .log_directory
            .join(format!("{}.log", spec.install_id));
        if fs::metadata(&log).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
            let _ = fs::write(&log, b"");
        }
        let output = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&log)
            .map_err(|error| failed(error.to_string()))?;
        let errors = output
            .try_clone()
            .map_err(|error| failed(error.to_string()))?;
        let (parent, child_end) = UnixStream::pair().map_err(|error| failed(error.to_string()))?;
        let child_fd = child_end.as_raw_fd();
        let mut environment = crate::environment::base_environment_for(
            &BTreeMap::new(),
            &launch.paths.home,
            &launch.paths.user,
        );
        let text = |path: &Path| path.to_string_lossy().into_owned();
        // The plugin's binaries first, then the system's, then the daemon's.
        let mut search = vec![launch.bin.to_path_buf()];
        search.extend(std::env::split_paths(SYSTEM_PATH));
        if let Some(own) = std::env::var_os("PATH") {
            search.extend(std::env::split_paths(&own));
        }
        let path = std::env::join_paths(&search).map_err(|error| failed(error.to_string()))?;
        let node = search
            .iter()
            .map(|folder| folder.join("node"))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| failed("Node.js is not installed in this Orb.".into()))?;
        environment.insert("PATH".into(), path.to_string_lossy().into_owned());
        for (name, value) in [
            ("PLUGIN_ROOT", text(launch.root)),
            ("PLUGIN_DATA", text(launch.data)),
            ("DX_PLUGIN_ENTRY", text(launch.entry)),
            ("DX_PLUGIN_BIN", text(launch.bin)),
            ("DX_PLUGIN_NAME", spec.name.clone()),
            ("DX_PLUGIN_RUNTIME", text(launch.runtime)),
        ] {
            environment.insert(name.into(), value);
        }
        let mut command = Command::new(node);
        command
            .arg(launch.runtime.join("main.mjs"))
            .current_dir(launch.data)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(output)
            .stderr(errors)
            .process_group(0);
        // SAFETY: between fork and exec only async-signal-safe calls run:
        // dup2 and fcntl on a descriptor this process owns.
        unsafe {
            command.pre_exec(move || {
                if child_fd == 3 {
                    let flags = libc::fcntl(3, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(child_fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|error| failed(format!("dx could not start {}: {error}", spec.name)))?;
        drop(child_end);
        let pid = child.id() as i32;
        let reader = parent
            .try_clone()
            .map_err(|error| failed(error.to_string()))?;
        parent
            .set_write_timeout(Some(WRITE_TIMEOUT))
            .map_err(|error| failed(error.to_string()))?;
        let calls: Arc<Mutex<HashMap<u32, Call>>> = Arc::default();
        let life = Arc::new(Mutex::new(Life {
            child: Some(child),
            ended_at: None,
            last_active: Instant::now(),
        }));
        let process = Self {
            name: spec.name.clone(),
            install_id: spec.install_id.clone(),
            ports: spec.ports.clone(),
            since: now_ms(),
            pid,
            log,
            writer: Arc::new(Mutex::new(parent)),
            calls: Arc::clone(&calls),
            life: Arc::clone(&life),
            retiring: AtomicBool::new(false),
        };
        let (ready, started) = mpsc::sync_channel(1);
        let writer = Arc::clone(&process.writer);
        let log = process.log.clone();
        std::thread::Builder::new()
            .name("dxd-plugin-reader".into())
            .spawn(move || read(reader, writer, calls, life, ready, log))
            .map_err(|error| failed(error.to_string()))?;
        let remaining = launch.deadline.saturating_duration_since(Instant::now());
        match started.recv_timeout(remaining) {
            Ok(()) => Ok(process),
            Err(RecvTimeoutError::Timeout) => {
                process.stop();
                Err(unavailable(
                    "start",
                    format!(
                        "{} did not start in time.{}",
                        spec.name,
                        log_tail(&process.log)
                    ),
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                process.stop();
                Err(unavailable(
                    "start",
                    format!(
                        "{} exited while starting.{}",
                        spec.name,
                        log_tail(&process.log)
                    ),
                ))
            }
        }
    }

    /// Whether the process still runs. A child of the plugin (an adb
    /// server, say) can hold fd 3 open after the plugin exits, so this also
    /// asks the kernel, and fails the calls left when it has exited.
    pub(super) fn alive(&self) -> bool {
        if self.retiring.load(Ordering::Acquire) {
            return false;
        }
        let mut life = lock(&self.life);
        if life.ended_at.is_some() {
            return false;
        }
        let exited = life
            .child
            .as_mut()
            .is_some_and(|child| !matches!(child.try_wait(), Ok(None)));
        if !exited {
            return true;
        }
        life.ended_at = Some(now_ms());
        drop(life);
        let message = self.exit_message();
        for (_, call) in lock(&self.calls).drain() {
            let _ = call.done.send(CallOutcome::Exited(message.clone()));
        }
        // A child of the plugin that kept the channel open loses it now.
        let _ = lock(&self.writer).shutdown(std::net::Shutdown::Both);
        false
    }

    pub(super) fn ended_at(&self) -> u64 {
        lock(&self.life).ended_at.unwrap_or(0)
    }

    pub(super) fn touch(&self) {
        lock(&self.life).last_active = Instant::now();
    }

    pub(super) fn last_active(&self) -> Instant {
        lock(&self.life).last_active
    }

    pub(super) fn calls_in_flight(&self) -> usize {
        lock(&self.calls).len()
    }

    /// Registers call `id` before it is written, so its answer and its
    /// capability requests have somewhere to go.
    pub(super) fn begin(
        &self,
        id: u32,
        lane: CapabilityLane,
        maximum: usize,
    ) -> Result<oneshot::Receiver<CallOutcome>, PluginResult> {
        if !self.alive() {
            return Err(unavailable("exited", self.exit_message()));
        }
        let mut calls = lock(&self.calls);
        // The reaper decides under this lock, so a call either begins
        // before it looks (and keeps the process) or sees it retiring.
        if self.retiring.load(Ordering::Acquire) {
            return Err(unavailable("exited", self.exit_message()));
        }
        if calls.len() >= maximum {
            return Err(unavailable(
                "busy",
                format!("{} is busy with {maximum} calls. Try again.", self.name),
            ));
        }
        let (done, receiver) = oneshot::channel();
        calls.insert(id, Call { done, lane });
        drop(calls);
        self.touch();
        Ok(receiver)
    }

    /// The reaper's decision, made under the calls lock: true (and no call
    /// may begin after) when nothing runs, no connection holds a port, and
    /// it has been idle for `idle`. The caller then stops it.
    pub(super) fn retire_if_idle(&self, idle: Duration, leased: bool) -> bool {
        let calls = lock(&self.calls);
        if !calls.is_empty() || leased {
            drop(calls);
            self.touch();
            return false;
        }
        if self.last_active().elapsed() < idle {
            return false;
        }
        self.retiring.store(true, Ordering::Release);
        true
    }

    pub(super) fn forget(&self, id: u32) {
        lock(&self.calls).remove(&id);
    }

    pub(super) fn write(&self, message: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(message)?;
        if line.len() > MAX_MESSAGE_BYTES {
            return Err(std::io::Error::other("message too large"));
        }
        line.push(b'\n');
        let mut writer = lock(&self.writer);
        writer.write_all(&line)?;
        writer.flush()
    }

    pub(super) fn exit_message(&self) -> String {
        format!("{} exited.{}", self.name, log_tail(&self.log))
    }

    /// SIGTERM to the process group, SIGKILL after two seconds. Blocking.
    pub(super) fn stop(&self) {
        let child = lock(&self.life).child.take();
        let Some(mut child) = child else {
            return;
        };
        // SAFETY: the process leads its own group (`process_group(0)`) and
        // is not reaped yet, so the group id still names it.
        unsafe {
            libc::kill(-self.pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above; the group may hold children of the plugin.
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
        if !exited {
            let _ = child.wait();
        }
        let _ = lock(&self.writer).shutdown(std::net::Shutdown::Both);
        let mut life = lock(&self.life);
        life.ended_at.get_or_insert_with(now_ms);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Reads the process's lines until it closes fd 3, then fails what is left.
fn read(
    stream: UnixStream,
    writer: Arc<Mutex<UnixStream>>,
    calls: Arc<Mutex<HashMap<u32, Call>>>,
    life: Arc<Mutex<Life>>,
    ready: mpsc::SyncSender<()>,
    log: PathBuf,
) {
    let mut reader = BufReader::new(stream);
    let mut ready = Some(ready);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader)
            .take(MAX_MESSAGE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line);
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_MESSAGE_BYTES => break,
            Ok(_) => {}
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        match message["t"].as_str() {
            Some("ready") => {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(());
                }
            }
            Some("result") => {
                let Some(id) = message["id"].as_u64().and_then(|id| u32::try_from(id).ok()) else {
                    continue;
                };
                let Some(call) = lock(&calls).remove(&id) else {
                    continue;
                };
                let outcome = if message["ok"] == Value::Bool(true) {
                    CallOutcome::Ok(message.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    CallOutcome::Err(truncate(
                        message["error"].as_str().unwrap_or("The plugin failed."),
                        MAX_ERROR_BYTES,
                    ))
                };
                let _ = call.done.send(outcome);
            }
            Some("host") => {
                let (Some(id), Some(cid)) = (
                    message["id"].as_u64().and_then(|id| u32::try_from(id).ok()),
                    message["cid"]
                        .as_u64()
                        .and_then(|id| u32::try_from(id).ok()),
                ) else {
                    continue;
                };
                let method = message["method"].as_str().unwrap_or("");
                let valid_method = !method.is_empty()
                    && method.len() <= 64
                    && method.as_bytes()[0].is_ascii_alphabetic()
                    && method.bytes().all(|b| b.is_ascii_alphanumeric());
                let args = message
                    .get("args")
                    .cloned()
                    .unwrap_or(Value::Array(Vec::new()));
                // Core reads only a list; anything else would cost the
                // whole connection there, so it stops here.
                let valid_args = args.is_array();
                let lane = lock(&calls).get(&id).map(|call| call.lane.clone());
                let refusal = match lane {
                    None => Some("The call this belongs to has ended."),
                    Some(_) if !valid_method => Some("dx has no capability by that name."),
                    Some(_) if !valid_args => Some("Capability arguments must be a list."),
                    Some(lane) if !lane.send(cid, method, &args) => {
                        Some("The capability request is too large or Core is not connected.")
                    }
                    Some(_) => None,
                };
                if let Some(error) = refusal {
                    let mut answer = serde_json::to_vec(
                        &serde_json::json!({"t": "host-result", "cid": cid, "ok": false, "error": error}),
                    )
                    .unwrap_or_default();
                    answer.push(b'\n');
                    // The same lock as calls and answers: a refusal never
                    // lands inside another line.
                    let mut writer = lock(&writer);
                    let _ = writer.write_all(&answer).and_then(|()| writer.flush());
                }
            }
            _ => {}
        }
    }
    // The process closed its channel: it exited or is exiting. While
    // `stop` holds the child it reaps it and records the end itself.
    // `ended_at` is set even when the child still runs (it closed fd 3 and
    // kept going): such a process can never answer, so it counts as ended,
    // and dropping it (outside any registry lock) kills its group.
    {
        let mut life = lock(&life);
        if let Some(child) = life.child.as_mut() {
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(20));
            }
            life.ended_at.get_or_insert_with(now_ms);
        }
    }
    let message = format!("The plugin's process exited.{}", log_tail(&log));
    for (_, call) in lock(&calls).drain() {
        let _ = call.done.send(CallOutcome::Exited(message.clone()));
    }
}

/// The end of the process's log, for a failure message.
pub(super) fn log_tail(path: &Path) -> String {
    let Ok(text) = fs::read(path) else {
        return String::new();
    };
    let start = text.len().saturating_sub(1024);
    let tail = String::from_utf8_lossy(&text[start..]).trim().to_owned();
    if tail.is_empty() {
        String::new()
    } else {
        format!(" Its log ended with: {tail}")
    }
}
