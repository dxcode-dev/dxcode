//! The agent's workspace operations (capability `sandbox` version 1): shell
//! commands and file access anywhere the workspace user can reach, the same
//! on every Orb provider. Core sends them only for a Thread whose owner turned
//! the route on; the provider's own API then keeps bootstrap alone.
//!
//! Unlike Files (`files.rs`, `files_sandbox.rs`), nothing here is confined to
//! the worktree or refuses `.git` or links: the agent's own commands already
//! run as this user and reach the same paths.
//!
//! A command outlives the daemon. It runs in its own session under a small
//! `/bin/sh` wrapper that records its exit code in a file, with output in
//! files rather than pipes, so a background process it starts never holds the
//! command open. Its state lives under `<state>/sandbox/exec/<execId>/`: a
//! resend of the same `execId` (Core resends after a lost connection) returns
//! the recorded result, waits for the run in flight, or, after this daemon
//! restarted, attaches to the process an earlier image started. A command
//! therefore never runs twice.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Magic prefix of a Core→daemon binary frame carrying a `sandbox.write` or
/// `sandbox.stage` request and its raw bytes:
/// `DXW1 | u32 BE JSON length | JSON request frame | raw bytes`.
pub const WRITE_FRAME_MAGIC: &[u8; 4] = b"DXW1";
pub const MAX_WRITE_JSON_BYTES: usize = 64 * 1024;
pub const MAX_WRITE_PAYLOAD_BYTES: usize = 1024 * 1024;
/// Raw bytes per `sandbox.read` and `sandbox.output`; Core's chunk bound.
pub const MAX_CHUNK_BYTES: u64 = crate::files_sandbox::MAX_CHUNK_BYTES;
const MAX_PATH_BYTES: usize = 4096;
/// A stream at most this large travels inline in the `exec` answer.
const MAX_INLINE_OUTPUT_BYTES: u64 = 1024 * 1024;
/// JSON answers stay below Core's 4 MiB response frame.
const MAX_RESPONSE_BYTES: usize = 3584 * 1024;
const MAX_RUNNING: usize = 64;
const MAX_TIMEOUT_MS: u64 = 86_400_000;
/// Linux refuses a single argument above 128 KiB (`MAX_ARG_STRLEN`); a
/// longer command runs from a file instead.
const MAX_ARGUMENT_COMMAND_BYTES: usize = 96 * 1024;
const MAX_STAGED_SPEC_BYTES: u64 = 32 * 1024 * 1024;
const MAX_WRITE_BYTES: u64 = 1 << 40;
/// Finished commands' output and stale uploads are kept this long.
const RETAIN: Duration = Duration::from_secs(600);
/// A command whose supervisor vanished is forgotten after this long.
const ABANDONED: Duration = Duration::from_secs(86_400);
const KILL_GRACE: Duration = Duration::from_secs(5);
/// Core may resend a command until its own deadline (the command's limit
/// plus 30 s); a finished record outlives that by this much.
const RESEND_GRACE_MS: u64 = 120_000;
/// Each output stream keeps at most this much, Core's read limit; the rest is
/// drained and dropped, so a command (or a background process it left with
/// the output) cannot fill the disk through dxd's state.
pub const MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const FINISHED_UPLOADS: usize = 256;
const FILE_WORKERS: usize = 4;
const GARBAGE_INTERVAL: Duration = Duration::from_secs(30);

/// The command's supervisor, run as `bash <this file> <dir> <cwd> <mode>
/// <cap> <dxd>`. The command text is never in its argv (it reads
/// `$d/command`), so a `pkill -f` or `pgrep -f` pattern taken from the
/// command cannot match it; `bash -l -c` gets the text as the providers give
/// it. Each output stream goes through `dxd sandbox-output`, which keeps the
/// first `cap` bytes and drains the rest; the command and what it starts get
/// only the pipes, never the supervisor's copies (3, 4), so the streams end
/// when they do. The exit code is written once the command's output drained,
/// or after 250 ms (a background process may hold it open).
const WRAPPER: &str = r#"d=$1 cwd=$2 mode=$3 cap=$4 dxd=$5
exec 3> >(exec "$dxd" sandbox-output "$d/stdout" "$cap"); out=$!
exec 4> >(exec "$dxd" sandbox-output "$d/stderr" "$cap"); err=$!
code=1
if [ -z "$cwd" ] || cd -- "$cwd" 2>&4; then
  if [ "$mode" = file ]; then
    bash -l -- "$d/command" >&3 2>&4 3>&- 4>&- </dev/null
  else
    bash -l -c "$(cat -- "$d/command")" >&3 2>&4 3>&- 4>&- </dev/null
  fi
  code=$?
fi
exec 3>&- 4>&-
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
  if ! kill -0 "$out" 2>/dev/null && ! kill -0 "$err" 2>/dev/null; then break; fi
  sleep 0.01
done
printf '%s' "$code" >"$d/exit.tmp" && mv -f -- "$d/exit.tmp" "$d/exit"
"#;
/// Bumped with [`WRAPPER`], so a daemon never runs another release's file.
const WRAPPER_FILE: &str = "wrapper-3.sh";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum SandboxOperation {
    #[serde(rename = "sandbox.exec")]
    Exec {
        #[serde(rename = "execId")]
        exec_id: String,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Option<BTreeMap<String, String>>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        #[serde(default)]
        staged: Option<bool>,
    },
    /// Stop a running command (the agent's Stop): TERM to its process
    /// group, KILL after the grace period. Its own answer then reports 143.
    #[serde(rename = "sandbox.cancel")]
    Cancel {
        #[serde(rename = "execId")]
        exec_id: String,
    },
    #[serde(rename = "sandbox.stage")]
    Stage {
        #[serde(rename = "execId")]
        exec_id: String,
        offset: u64,
        last: bool,
    },
    #[serde(rename = "sandbox.output")]
    Output {
        #[serde(rename = "execId")]
        exec_id: String,
        stream: OutputStream,
        offset: u64,
        length: u64,
    },
    #[serde(rename = "sandbox.read")]
    Read {
        path: String,
        offset: u64,
        length: u64,
    },
    #[serde(rename = "sandbox.write")]
    Write {
        path: String,
        upload: String,
        offset: u64,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        last: bool,
    },
    #[serde(rename = "sandbox.stat")]
    Stat { path: String },
    #[serde(rename = "sandbox.readdir")]
    Readdir { path: String },
    #[serde(rename = "sandbox.mkdir")]
    Mkdir { path: String },
    #[serde(rename = "sandbox.rm")]
    Rm {
        path: String,
        recursive: bool,
        force: bool,
    },
}

impl SandboxOperation {
    /// `sandbox.write` and `sandbox.stage` carry bytes in a `DXW1` frame.
    pub fn takes_payload(&self) -> bool {
        matches!(self, Self::Write { .. } | Self::Stage { .. })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SandboxResult {
    Exec {
        exit_code: i32,
        timed_out: bool,
        stdout: Option<String>,
        stderr: Option<String>,
        stdout_bytes: u64,
        stderr_bytes: u64,
    },
    Staged,
    Written,
    Stat {
        is_file: bool,
        is_directory: bool,
        is_symbolic_link: bool,
        size_bytes: u64,
    },
    Missing,
    Entries {
        names: Vec<String>,
    },
    Done,
    Failure {
        code: &'static str,
        message: String,
    },
}

fn failure(code: &'static str, message: impl Into<String>) -> SandboxResult {
    SandboxResult::Failure {
        code,
        message: message.into(),
    }
}

fn io_failure(error: &io::Error) -> SandboxResult {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::NotADirectory => "not-directory",
        io::ErrorKind::IsADirectory => "is-directory",
        io::ErrorKind::AlreadyExists => "exists",
        io::ErrorKind::DirectoryNotEmpty => "not-empty",
        io::ErrorKind::PermissionDenied => "permission-denied",
        io::ErrorKind::ArgumentListTooLong | io::ErrorKind::FileTooLarge => "too-large",
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename => "invalid",
        _ => "io",
    };
    failure(code, error.to_string())
}

/// One finished operation, for whichever session is connected.
pub struct SandboxDone {
    pub request_id: String,
    pub outcome: SandboxOutcome,
}

pub enum SandboxOutcome {
    Json(SandboxResult),
    /// Sent as `DXF1` frames, like `files.readSandbox`.
    Chunk {
        version: String,
        size_bytes: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
}

/// Where commands run and how.
pub struct SandboxPaths {
    /// `<state>/sandbox`, private to this daemon.
    pub state: PathBuf,
    pub home: PathBuf,
    pub user: String,
}

struct Inner {
    paths: SandboxPaths,
    /// Commands this process supervises or attached to, by `execId`.
    runs: Mutex<HashMap<String, Arc<RunSlot>>>,
    uploads: Mutex<Uploads>,
    collected_at: Mutex<Option<Instant>>,
    /// Held while the wrapper file is checked and written, so concurrent
    /// commands never race on its temporary.
    wrapper: Mutex<()>,
    /// This daemon's binary, which copies each command's output
    /// (`dxd sandbox-output`); resolved at start, before any update.
    executable: PathBuf,
    /// Commands Core cancelled, so one cancelled before it started (or
    /// before its pid was recorded) never runs on.
    cancelled: Mutex<VecDeque<String>>,
}

#[derive(Default)]
struct Uploads {
    /// Staging file and last chunk time of each upload in progress.
    active: HashMap<String, (PathBuf, Instant)>,
    /// Uploads whose last chunk renamed the file into place, oldest first.
    finished: VecDeque<String>,
}

#[derive(Default)]
struct RunSlot {
    done: Mutex<Option<SandboxResult>>,
    ready: Condvar,
}

impl RunSlot {
    fn wait(&self) -> SandboxResult {
        let mut done = self.done.lock().unwrap();
        loop {
            if let Some(result) = done.as_ref() {
                return result.clone();
            }
            done = self.ready.wait(done).unwrap();
        }
    }

    fn finish(&self, result: SandboxResult) {
        *self.done.lock().unwrap() = Some(result);
        self.ready.notify_all();
    }
}

/// The daemon's sandbox: it outlives sessions, and so do its operations.
pub struct Sandbox {
    inner: Arc<Inner>,
    results: UnboundedSender<SandboxDone>,
    in_flight: Arc<AtomicUsize>,
    exec_threads: Arc<AtomicUsize>,
    file_permits: Arc<tokio::sync::Semaphore>,
}

impl Sandbox {
    pub fn new(paths: SandboxPaths) -> (Self, UnboundedReceiver<SandboxDone>) {
        let (results, receiver) = unbounded_channel();
        (
            Self {
                inner: Arc::new(Inner {
                    paths,
                    runs: Mutex::default(),
                    uploads: Mutex::default(),
                    collected_at: Mutex::default(),
                    wrapper: Mutex::default(),
                    executable: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("dxd")),
                    cancelled: Mutex::default(),
                }),
                results,
                in_flight: Arc::default(),
                exec_threads: Arc::default(),
                file_permits: Arc::new(tokio::sync::Semaphore::new(FILE_WORKERS)),
            },
            receiver,
        )
    }

    /// True while any operation has not been delivered: a self-update must
    /// not swap the image under a running command.
    pub fn busy(&self) -> bool {
        self.in_flight.load(Ordering::Acquire) > 0
    }

    /// The session handed one result to Core.
    pub fn delivered(&self) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
    }

    /// Start one operation. Its result arrives on the receiver `new` returned.
    /// `payload` is the `DXW1` frame's bytes; a write without one is invalid.
    pub fn submit(
        &self,
        request_id: String,
        operation: SandboxOperation,
        payload: Option<Vec<u8>>,
    ) {
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        let results = self.results.clone();
        let reply = move |request_id: String, outcome| {
            let _ = results.send(SandboxDone {
                request_id,
                outcome,
            });
        };
        if operation.takes_payload() != payload.is_some() {
            reply(
                request_id,
                SandboxOutcome::Json(failure(
                    "invalid",
                    "sandbox.write and sandbox.stage carry their bytes in a DXW1 frame",
                )),
            );
            return;
        }
        if let SandboxOperation::Exec { .. } = operation {
            // Commands run for minutes: each gets a thread of its own rather
            // than a slot of the shared blocking pool.
            if self.exec_threads.fetch_add(1, Ordering::AcqRel) >= MAX_RUNNING {
                self.exec_threads.fetch_sub(1, Ordering::AcqRel);
                reply(
                    request_id,
                    SandboxOutcome::Json(failure("busy", "too many commands are running")),
                );
                return;
            }
            let inner = Arc::clone(&self.inner);
            let threads = Arc::clone(&self.exec_threads);
            let thread_reply = reply.clone();
            let thread_request = request_id.clone();
            let spawned = std::thread::Builder::new()
                .name("dxd-exec".into())
                .stack_size(256 * 1024)
                .spawn(move || {
                    let result = inner.exec(operation);
                    threads.fetch_sub(1, Ordering::AcqRel);
                    thread_reply(thread_request, SandboxOutcome::Json(result));
                });
            if let Err(error) = spawned {
                self.exec_threads.fetch_sub(1, Ordering::AcqRel);
                reply(request_id, SandboxOutcome::Json(io_failure(&error)));
            }
            return;
        }
        let inner = Arc::clone(&self.inner);
        let permits = Arc::clone(&self.file_permits);
        tokio::spawn(async move {
            let _permit = permits.acquire_owned().await;
            let outcome =
                tokio::task::spawn_blocking(move || inner.file_operation(operation, payload))
                    .await
                    .unwrap_or_else(|_| {
                        SandboxOutcome::Json(failure("io", "the operation's worker failed"))
                    });
            reply(request_id, outcome);
        });
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= MAX_PATH_BYTES && !path.contains('\0')
}

fn valid_exec_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && !name.as_bytes()[0].is_ascii_digit()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Write `bytes` to `path` through a temporary, so readers never see a
/// partial file.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path)
}

/// Create `path` and any missing parents with mode 0755 (this daemon's own
/// umask is 077, so the mode is set explicitly).
fn create_dirs(path: &Path) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        match fs::metadata(current) {
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => return Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(current.to_owned());
                match current.parent() {
                    Some(parent) => current = parent,
                    None => break,
                }
            }
            Err(error) => return Err(error),
        }
    }
    for directory in missing.iter().rev() {
        match fs::create_dir(directory) {
            Ok(()) => fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && directory.is_dir() => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// The file a write lands in: a symbolic link is followed to its target, as
/// `cat >` follows it, so the link survives the rename.
fn write_target(path: &Path) -> PathBuf {
    let mut current = path.to_owned();
    for _ in 0..40 {
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => match fs::read_link(&current) {
                Ok(target) if target.is_absolute() => current = target,
                Ok(target) => {
                    current = current
                        .parent()
                        .map_or_else(|| target.clone(), |parent| parent.join(&target))
                }
                Err(_) => return current,
            },
            _ => return current,
        }
    }
    current
}

/// Identify one revision of a file without hashing its bytes.
fn version_for(metadata: &fs::Metadata) -> String {
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

/// Read up to `length` bytes at `offset`, stopping at end of file.
fn read_range(file: &mut File, offset: u64, length: u64) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(length.min(MAX_CHUNK_BYTES) as usize);
    file.take(length).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Start time of a process in clock ticks since boot (`/proc/<pid>/stat`
/// field 22), which tells a process from a later one reusing its PID.
fn process_start(pid: i32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = &stat[stat.rfind(')')? + 2..];
    after_name.split(' ').nth(19)?.parse().ok()
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecMeta {
    pid: i32,
    start_ticks: Option<u64>,
    deadline_unix_ms: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecRecord {
    exit_code: i32,
    timed_out: bool,
    stdout_bytes: u64,
    stderr_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedSpec {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<BTreeMap<String, String>>,
}

/// How a supervised command ended.
enum Ended {
    Exited,
    TimedOut,
    Lost,
}

/// Wait until `pid` exits or `deadline` (wall clock, ms) passes. Returns
/// true when it exited. Uses a pidfd when the kernel has one, else polls.
fn wait_exit(pid: i32, deadline_unix_ms: u64, reap: bool) -> bool {
    // SAFETY: pidfd_open takes a pid and flags and returns a new descriptor.
    #[cfg(target_os = "linux")]
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    // No pidfd off Linux (a runner on macOS): the loop polls instead.
    #[cfg(not(target_os = "linux"))]
    let pidfd = -1;
    let close = || {
        if pidfd >= 0 {
            // SAFETY: closing the descriptor opened above, once.
            unsafe { libc::close(pidfd) };
        }
    };
    // Only this process's own child can be reaped; another process's (a
    // daemon that restarted) is watched until it is gone.
    let mut reap = reap;
    let mut sleep = Duration::from_millis(1);
    loop {
        if reap {
            let mut status = 0;
            // SAFETY: waitpid on one pid with WNOHANG.
            let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if reaped == pid {
                close();
                return true;
            }
            if reaped == -1 {
                reap = false;
                continue;
            }
        } else if !alive(pid) {
            close();
            return true;
        }
        let now = unix_ms();
        if now >= deadline_unix_ms {
            close();
            return false;
        }
        let remaining = (deadline_unix_ms - now).min(1000) as i32;
        if pidfd >= 0 {
            let mut poll = libc::pollfd {
                fd: pidfd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd and a bounded timeout.
            unsafe { libc::poll(&mut poll, 1, remaining.max(1)) };
            if poll.revents != 0 && !reap {
                // The process exited; a zombie of another parent is gone
                // once that parent reaps it.
                sleep = Duration::from_millis(1);
                std::thread::sleep(sleep);
            }
        } else {
            std::thread::sleep(sleep.min(Duration::from_millis(remaining.max(1) as u64)));
            sleep = (sleep * 2).min(Duration::from_millis(20));
        }
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe {
        libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// End a timed-out command: TERM to its whole process group, KILL after the
/// grace period. Processes it moved to their own session are not touched.
fn kill_group(pid: i32, reap: bool) {
    // SAFETY: signalling the process group the command leads (setsid).
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    if !wait_exit(pid, unix_ms() + KILL_GRACE.as_millis() as u64, reap) {
        // SAFETY: as above.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        wait_exit(pid, unix_ms() + KILL_GRACE.as_millis() as u64, reap);
    }
    // Stragglers in the group that ignored TERM.
    // SAFETY: as above; ESRCH when none are left.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
}

impl Inner {
    fn exec_root(&self) -> PathBuf {
        self.paths.state.join("exec")
    }

    fn stage_path(&self, exec_id: &str) -> PathBuf {
        self.paths
            .state
            .join("stage")
            .join(format!("{exec_id}.spec"))
    }

    fn exec(&self, operation: SandboxOperation) -> SandboxResult {
        let SandboxOperation::Exec {
            exec_id,
            command,
            cwd,
            env,
            timeout_ms,
            staged,
        } = operation
        else {
            return failure("invalid", "not a command");
        };
        if !valid_exec_id(&exec_id) || !(1..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
            return failure("invalid", "invalid execId or timeoutMs");
        }
        let dir = self.exec_root().join(&exec_id);
        let (slot, role) = {
            let mut runs = self.runs.lock().unwrap();
            if let Some(slot) = runs.get(&exec_id) {
                (Arc::clone(slot), None)
            } else if let Ok(record) = fs::read(dir.join("result.json")) {
                drop(runs);
                return match serde_json::from_slice::<ExecRecord>(&record) {
                    Ok(record) => answer(&dir, &record),
                    Err(error) => failure("io", error.to_string()),
                };
            } else {
                let slot = Arc::new(RunSlot::default());
                runs.insert(exec_id.clone(), Arc::clone(&slot));
                let attach = dir.exists();
                (slot, Some(attach))
            }
        };
        let Some(attach) = role else {
            return slot.wait();
        };
        let result = if attach {
            self.attach(&dir)
        } else {
            let spec = if staged == Some(true) {
                if command.is_some() || cwd.is_some() || env.is_some() {
                    Err(failure("invalid", "a staged command carries no command"))
                } else {
                    self.staged_spec(&exec_id)
                }
            } else {
                match command {
                    Some(command) => Ok(StagedSpec { command, cwd, env }),
                    None => Err(failure("invalid", "no command")),
                }
            };
            // Stopped before it started: it never runs.
            let spec = if self.was_cancelled(&exec_id) {
                Err(SandboxResult::Exec {
                    exit_code: 143,
                    timed_out: false,
                    stdout: Some(String::new()),
                    stderr: Some(String::new()),
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                })
            } else {
                spec
            };
            match spec {
                Ok(spec) => {
                    self.collect_garbage();
                    let result = self.run(&dir, &spec, timeout_ms);
                    let _ = fs::remove_file(self.stage_path(&exec_id));
                    result
                }
                Err(result) => result,
            }
        };
        slot.finish(result.clone());
        self.runs.lock().unwrap().remove(&exec_id);
        result
    }

    fn staged_spec(&self, exec_id: &str) -> Result<StagedSpec, SandboxResult> {
        let bytes = fs::read(self.stage_path(exec_id)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                failure("upload-missing", "no staged command for this execId")
            } else {
                io_failure(&error)
            }
        })?;
        serde_json::from_slice(&bytes).map_err(|error| failure("invalid", error.to_string()))
    }

    fn run(&self, dir: &Path, spec: &StagedSpec, timeout_ms: u64) -> SandboxResult {
        if spec.command.contains('\0')
            || spec.cwd.as_deref().is_some_and(|cwd| !valid_path(cwd))
            || spec.env.as_ref().is_some_and(|env| {
                env.iter()
                    .any(|(name, value)| !valid_env_name(name) || value.contains('\0'))
            })
        {
            return failure("invalid", "invalid command, cwd, or environment");
        }
        // Everything the command needs exists before it starts. When any of
        // it cannot be written (a full disk), the command never ran, and Core
        // may run it on the provider instead.
        let wrapper = self.paths.state.join(WRAPPER_FILE);
        let prepared = (|| -> io::Result<()> {
            fs::create_dir_all(dir)?;
            fs::write(dir.join("command"), &spec.command)?;
            for name in ["stdout", "stderr"] {
                OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(dir.join(name))?;
            }
            let _held = self.wrapper.lock().unwrap();
            if fs::read(&wrapper).ok().as_deref() != Some(WRAPPER.as_bytes()) {
                write_atomically(&wrapper, WRAPPER.as_bytes())?;
            }
            Ok(())
        })();
        if let Err(error) = prepared {
            let _ = fs::remove_dir_all(dir);
            return failure("not-started", error.to_string());
        }
        let from_file = spec.command.len() > MAX_ARGUMENT_COMMAND_BYTES;
        let mut environment = crate::environment::base_environment_for(
            &BTreeMap::new(),
            &self.paths.home,
            &self.paths.user,
        );
        if let Some(env) = &spec.env {
            environment.extend(env.clone());
        }
        let mut command = Command::new("/bin/bash");
        command
            .arg(&wrapper)
            .arg(dir)
            .arg(spec.cwd.as_deref().unwrap_or(""))
            .arg(if from_file { "file" } else { "argument" })
            .arg(MAX_OUTPUT_BYTES.to_string())
            .arg(&self.executable)
            .current_dir(&self.paths.home)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: setsid and umask are async-signal-safe and touch no parent
        // state. The command leads its own session, so it outlives this
        // daemon and a timeout can signal its whole group; it creates files
        // as the workspace user's shell would (022), not with dxd's 077.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                libc::umask(0o022);
                Ok(())
            });
        }
        let started = unix_ms();
        let deadline_unix_ms = started.saturating_add(timeout_ms);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_dir_all(dir);
                return failure("not-started", error.to_string());
            }
        };
        let pid = child.id() as i32;
        let meta = ExecMeta {
            pid,
            start_ticks: process_start(pid),
            deadline_unix_ms,
        };
        if let Ok(bytes) = serde_json::to_vec(&meta) {
            let _ = write_atomically(&dir.join("meta.json"), &bytes);
        }
        // A cancel that arrived before the pid was recorded.
        if dir
            .file_name()
            .is_some_and(|id| self.was_cancelled(&id.to_string_lossy()))
        {
            let _ = fs::write(dir.join("cancelled"), b"");
            // SAFETY: signalling the process group just started (setsid).
            unsafe { libc::kill(-pid, libc::SIGTERM) };
        }
        // The child is reaped through waitpid below, not `Child`.
        std::mem::forget(child);
        let ended = if wait_exit(pid, deadline_unix_ms, true) {
            Ended::Exited
        } else {
            kill_group(pid, true);
            Ended::TimedOut
        };
        self.finish(dir, ended)
    }

    /// A command an earlier daemon process started: wait for its wrapper's
    /// exit file, enforcing the deadline it recorded.
    fn attach(&self, dir: &Path) -> SandboxResult {
        if dir.join("exit").exists() {
            return self.finish(dir, Ended::Exited);
        }
        let Some(meta) = fs::read(dir.join("meta.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ExecMeta>(&bytes).ok())
        else {
            return self.finish(dir, Ended::Lost);
        };
        let pid = meta.pid;
        // The wrapper records its exit code before it exits, so the file is
        // checked first: a wrapper whose new parent has not reaped it yet
        // still looks alive.
        loop {
            if dir.join("exit").exists() {
                return self.finish(dir, Ended::Exited);
            }
            // An image this process re-executed into keeps the wrapper as
            // its child; reaping it here keeps it from staying a zombie.
            let mut status = 0;
            // SAFETY: waitpid on one pid with WNOHANG; ECHILD when another
            // process is its parent.
            let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } == pid;
            let same_process = meta.start_ticks.is_none() || process_start(pid) == meta.start_ticks;
            if reaped || !alive(pid) || !same_process {
                let ended = if dir.join("exit").exists() {
                    Ended::Exited
                } else {
                    Ended::Lost
                };
                return self.finish(dir, ended);
            }
            if unix_ms() >= meta.deadline_unix_ms {
                kill_group(pid, true);
                return self.finish(dir, Ended::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Record how the command ended and answer from that record.
    fn finish(&self, dir: &Path, ended: Ended) -> SandboxResult {
        let size = |name: &str| fs::metadata(dir.join(name)).map_or(0, |metadata| metadata.len());
        let exit_code = fs::read_to_string(dir.join("exit"))
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok());
        let (exit_code, timed_out) = match (ended, exit_code) {
            // The wrapper finished just as the deadline passed.
            (_, Some(code)) => (code, false),
            (Ended::TimedOut, None) => (124, true),
            // Core cancelled it (`sandbox.cancel`): the shell's SIGTERM code.
            (_, None) if dir.join("cancelled").exists() => (143, false),
            (Ended::Exited | Ended::Lost, None) => {
                return failure(
                    "lost",
                    "the command's process ended without recording its exit code",
                );
            }
        };
        let record = ExecRecord {
            exit_code,
            timed_out,
            stdout_bytes: size("stdout"),
            stderr_bytes: size("stderr"),
        };
        if let Ok(bytes) = serde_json::to_vec(&record)
            && let Err(error) = write_atomically(&dir.join("result.json"), &bytes)
        {
            return io_failure(&error);
        }
        answer(dir, &record)
    }

    /// Drop finished commands' state and staged specs past retention, and
    /// commands whose supervisor vanished long ago. Runs at most once every
    /// [`GARBAGE_INTERVAL`], so a busy agent does not rescan every command.
    fn collect_garbage(&self) {
        {
            let mut last = self.collected_at.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < GARBAGE_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        let now = SystemTime::now();
        let older_than = |path: &Path, age: Duration| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| {
                    now.duration_since(modified)
                        .is_ok_and(|elapsed| elapsed > age)
                })
        };
        let running: Vec<String> = self.runs.lock().unwrap().keys().cloned().collect();
        if let Ok(entries) = fs::read_dir(self.exec_root()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if running.contains(&name) {
                    continue;
                }
                let path = entry.path();
                let result = path.join("result.json");
                // Core resends a command until its deadline plus 30 s.
                let resendable = fs::read(path.join("meta.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<ExecMeta>(&bytes).ok())
                    .is_some_and(|meta| {
                        unix_ms() < meta.deadline_unix_ms.saturating_add(RESEND_GRACE_MS)
                    });
                if (result.exists() && older_than(&result, RETAIN) && !resendable)
                    || (!result.exists() && older_than(&path, ABANDONED))
                {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
        if let Ok(entries) = fs::read_dir(self.paths.state.join("stage")) {
            for entry in entries.flatten() {
                if older_than(&entry.path(), RETAIN) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn file_operation(
        &self,
        operation: SandboxOperation,
        payload: Option<Vec<u8>>,
    ) -> SandboxOutcome {
        let json = SandboxOutcome::Json;
        match operation {
            SandboxOperation::Exec { .. } => json(failure("invalid", "not a file operation")),
            SandboxOperation::Cancel { exec_id } => json(self.cancel(&exec_id)),
            SandboxOperation::Stage {
                exec_id,
                offset,
                last,
            } => json(self.stage(&exec_id, offset, last, &payload.unwrap_or_default())),
            SandboxOperation::Output {
                exec_id,
                stream,
                offset,
                length,
            } => self.output(&exec_id, stream, offset, length),
            SandboxOperation::Read {
                path,
                offset,
                length,
            } => read(&path, offset, length),
            SandboxOperation::Write {
                path,
                upload,
                offset,
                size_bytes,
                last,
            } => json(self.write(
                &path,
                &upload,
                offset,
                size_bytes,
                last,
                &payload.unwrap_or_default(),
            )),
            SandboxOperation::Stat { path } => json(stat(&path)),
            SandboxOperation::Readdir { path } => json(readdir(&path)),
            SandboxOperation::Mkdir { path } => json(mkdir(&path)),
            SandboxOperation::Rm {
                path,
                recursive,
                force,
            } => json(rm(&path, recursive, force)),
        }
    }

    fn was_cancelled(&self, exec_id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == exec_id)
    }

    fn cancel(&self, exec_id: &str) -> SandboxResult {
        if !valid_exec_id(exec_id) {
            return failure("invalid", "invalid execId");
        }
        {
            let mut cancelled = self.cancelled.lock().unwrap();
            cancelled.push_back(exec_id.to_owned());
            if cancelled.len() > FINISHED_UPLOADS {
                cancelled.pop_front();
            }
        }
        let dir = self.exec_root().join(exec_id);
        if dir.join("result.json").exists() || dir.join("exit").exists() {
            return SandboxResult::Done;
        }
        let Some(meta) = fs::read(dir.join("meta.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ExecMeta>(&bytes).ok())
        else {
            return SandboxResult::Done;
        };
        if meta.start_ticks.is_some() && process_start(meta.pid) != meta.start_ticks {
            return SandboxResult::Done;
        }
        let _ = fs::write(dir.join("cancelled"), b"");
        let pid = meta.pid;
        // SAFETY: signalling the process group the command leads (setsid).
        unsafe { libc::kill(-pid, libc::SIGTERM) };
        // The supervising thread reaps the wrapper; stragglers that ignored
        // TERM get KILL after the grace period, while it is still the same
        // process group.
        let start_ticks = meta.start_ticks;
        let _ = std::thread::Builder::new()
            .name("dxd-cancel".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                std::thread::sleep(KILL_GRACE);
                if start_ticks.is_none() || process_start(pid) == start_ticks || !alive(pid) {
                    // SAFETY: as above; ESRCH once the group is gone.
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                }
            });
        SandboxResult::Done
    }

    /// One chunk of a command too large for a request frame. The last chunk
    /// trims anything an earlier, longer attempt left past its end.
    fn stage(&self, exec_id: &str, offset: u64, last: bool, bytes: &[u8]) -> SandboxResult {
        if !valid_exec_id(exec_id) {
            return failure("invalid", "invalid execId");
        }
        if offset.saturating_add(bytes.len() as u64) > MAX_STAGED_SPEC_BYTES {
            return failure("too-large", "the staged command is too large");
        }
        let path = self.stage_path(exec_id);
        if let Some(parent) = path.parent()
            && let Err(error) = fs::create_dir_all(parent)
        {
            return io_failure(&error);
        }
        let file = OpenOptions::new()
            .write(true)
            .create(offset == 0)
            .mode(0o600)
            .open(&path);
        match file {
            Ok(file) => match file.write_all_at(bytes, offset).and_then(|()| {
                if last {
                    file.set_len(offset + bytes.len() as u64)
                } else {
                    Ok(())
                }
            }) {
                Ok(()) => SandboxResult::Staged,
                Err(error) => io_failure(&error),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => failure(
                "upload-missing",
                "the staged command's first chunk is missing",
            ),
            Err(error) => io_failure(&error),
        }
    }

    fn output(
        &self,
        exec_id: &str,
        stream: OutputStream,
        offset: u64,
        length: u64,
    ) -> SandboxOutcome {
        let json = |result| SandboxOutcome::Json(result);
        if !valid_exec_id(exec_id) || length == 0 || length > MAX_CHUNK_BYTES {
            return json(failure("invalid", "invalid execId or length"));
        }
        let dir = self.exec_root().join(exec_id);
        let Some(record) = fs::read(dir.join("result.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ExecRecord>(&bytes).ok())
        else {
            return json(failure("not-found", "no finished command with this execId"));
        };
        let (name, size_bytes) = match stream {
            OutputStream::Stdout => ("stdout", record.stdout_bytes),
            OutputStream::Stderr => ("stderr", record.stderr_bytes),
        };
        if offset > size_bytes {
            return json(failure("invalid", "offset past the end of the output"));
        }
        let mut file = match File::open(dir.join(name)) {
            Ok(file) => file,
            Err(error) => return json(io_failure(&error)),
        };
        match read_range(&mut file, offset, length.min(size_bytes - offset)) {
            Ok(bytes) => SandboxOutcome::Chunk {
                version: format!(
                    "sha256:{:x}",
                    Sha256::digest(format!("{exec_id}:{name}:{size_bytes}").as_bytes())
                ),
                size_bytes,
                offset,
                bytes,
            },
            Err(error) => json(io_failure(&error)),
        }
    }

    fn write(
        &self,
        path: &str,
        upload: &str,
        offset: u64,
        size_bytes: u64,
        last: bool,
        bytes: &[u8],
    ) -> SandboxResult {
        if !valid_path(path)
            || upload.len() != 32
            || !upload
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || size_bytes > MAX_WRITE_BYTES
            || offset.saturating_add(bytes.len() as u64) > size_bytes
            || (last && offset + bytes.len() as u64 != size_bytes)
        {
            return failure("invalid", "invalid path, upload, or range");
        }
        // A resent last chunk after its rename: the file is written.
        if self
            .uploads
            .lock()
            .unwrap()
            .finished
            .iter()
            .any(|done| done == upload)
        {
            return SandboxResult::Written;
        }
        let target = write_target(Path::new(path));
        let (Some(parent), Some(_)) = (target.parent(), target.file_name()) else {
            return failure("invalid", "a write needs a file name");
        };
        let parent = parent.to_owned();
        // The Files tree hides `.dx-files-` temporaries.
        let staging = parent.join(format!(".dx-files-sandbox-{upload}"));
        if offset == 0 {
            self.drop_stale_uploads();
            sweep_stale_staging(&parent);
            if fs::metadata(&target).is_ok_and(|metadata| metadata.is_dir()) {
                return failure("is-directory", format!("{path} is a directory"));
            }
            if let Err(error) = create_dirs(&parent) {
                return io_failure(&error);
            }
        }
        let file = OpenOptions::new()
            .write(true)
            .create(offset == 0)
            .mode(0o600)
            .open(&staging);
        let file = match file {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound && offset > 0 => {
                return failure("upload-missing", "the upload's earlier chunks are missing");
            }
            Err(error) => return io_failure(&error),
        };
        self.uploads
            .lock()
            .unwrap()
            .active
            .insert(upload.to_owned(), (staging.clone(), Instant::now()));
        if let Err(error) = file.write_all_at(bytes, offset) {
            return io_failure(&error);
        }
        if !last {
            return SandboxResult::Staged;
        }
        let mode =
            fs::metadata(&target).map_or(0o644, |metadata| metadata.permissions().mode() & 0o7777);
        let placed = file
            .set_len(size_bytes)
            .and_then(|()| fs::set_permissions(&staging, fs::Permissions::from_mode(mode)))
            .and_then(|()| fs::rename(&staging, &target));
        drop(file);
        let mut uploads = self.uploads.lock().unwrap();
        uploads.active.remove(upload);
        if let Err(error) = placed {
            let _ = fs::remove_file(&staging);
            return io_failure(&error);
        }
        uploads.finished.push_back(upload.to_owned());
        if uploads.finished.len() > FINISHED_UPLOADS {
            uploads.finished.pop_front();
        }
        SandboxResult::Written
    }

    /// Delete the staging files of uploads Core abandoned.
    fn drop_stale_uploads(&self) {
        let mut uploads = self.uploads.lock().unwrap();
        uploads.active.retain(|_, (staging, touched)| {
            let keep = touched.elapsed() < RETAIN;
            if !keep {
                let _ = fs::remove_file(staging);
            }
            keep
        });
    }
}

/// `dxd sandbox-output <file> <cap>`: copy standard input into `file` as it
/// arrives, unbuffered, up to `cap` bytes, then read and drop the rest, so a
/// writer is never killed by a closed pipe and never fills the disk.
pub fn run_output_cli(arguments: &[String]) -> Result<(), ()> {
    use std::io::{Read, Write};
    let [path, cap] = arguments else {
        return Err(());
    };
    // Not a process named `dxd`: whatever stops the daemon by name
    // (`pkill -x dxd`) must not cut a running command's output.
    // SAFETY: PR_SET_NAME reads a NUL-terminated name of at most 16 bytes.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"dxd-output".as_ptr())
    };
    let mut remaining: u64 = cap.parse().map_err(|_| ())?;
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .ok();
    let mut input = io::stdin().lock();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = match input.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(()),
        };
        if remaining > 0
            && let Some(output) = file.as_mut()
        {
            let kept = (read as u64).min(remaining) as usize;
            // A failed write (a full disk) stops the copy, never the drain.
            if output.write_all(&buffer[..kept]).is_err() {
                file = None;
            }
            remaining -= kept as u64;
        }
    }
}

/// Delete `.dx-files-sandbox-*` staging files in `parent` older than
/// [`RETAIN`]: uploads a restarted daemon or a fallback abandoned, which
/// this process no longer tracks.
fn sweep_stale_staging(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".dx-files-sandbox-")
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|elapsed| elapsed > RETAIN)
            });
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The `exec` answer from a finished command's record: each stream inline
/// when it is small enough and the answer still fits Core's frame.
fn answer(dir: &Path, record: &ExecRecord) -> SandboxResult {
    let inline = |name: &str, size: u64| {
        if size > MAX_INLINE_OUTPUT_BYTES {
            return None;
        }
        let mut file = File::open(dir.join(name)).ok()?;
        let bytes = read_range(&mut file, 0, size).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    };
    let mut stdout = inline("stdout", record.stdout_bytes);
    let mut stderr = inline("stderr", record.stderr_bytes);
    let build = |stdout: &Option<String>, stderr: &Option<String>| SandboxResult::Exec {
        exit_code: record.exit_code,
        timed_out: record.timed_out,
        stdout: stdout.clone(),
        stderr: stderr.clone(),
        stdout_bytes: record.stdout_bytes,
        stderr_bytes: record.stderr_bytes,
    };
    let fits = |result: &SandboxResult| {
        serde_json::to_string(result).is_ok_and(|text| text.len() <= MAX_RESPONSE_BYTES)
    };
    // JSON escaping can multiply control characters six times over: move
    // the larger stream out of the answer first, then the other.
    for _ in 0..2 {
        if fits(&build(&stdout, &stderr)) {
            break;
        }
        let stdout_size = stdout.as_ref().map_or(0, String::len);
        let stderr_size = stderr.as_ref().map_or(0, String::len);
        if stdout_size >= stderr_size {
            stdout = None;
        } else {
            stderr = None;
        }
    }
    build(&stdout, &stderr)
}

fn read(path: &str, offset: u64, length: u64) -> SandboxOutcome {
    let json = SandboxOutcome::Json;
    if !valid_path(path) || length == 0 || length > MAX_CHUNK_BYTES {
        return json(failure("invalid", "invalid path or length"));
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return json(io_failure(&error)),
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return json(io_failure(&error)),
    };
    if metadata.is_dir() {
        return json(failure("is-directory", format!("{path} is a directory")));
    }
    if !metadata.is_file() {
        return json(failure("invalid", format!("{path} is not a regular file")));
    }
    // Kernel files (`/proc`, `/sys`) report a size of 0 or a page: read to
    // the end instead of trusting it.
    match read_range(&mut file, offset, length) {
        Ok(bytes) => {
            let end = offset + bytes.len() as u64;
            let size_bytes = if (bytes.len() as u64) < length {
                end
            } else {
                metadata.len().max(end)
            };
            if bytes.is_empty() && offset > metadata.len() {
                return json(failure("invalid", "offset past the end of the file"));
            }
            SandboxOutcome::Chunk {
                version: version_for(&metadata),
                size_bytes,
                offset,
                bytes,
            }
        }
        Err(error) => json(io_failure(&error)),
    }
}

fn stat(path: &str) -> SandboxResult {
    if !valid_path(path) {
        return failure("invalid", "invalid path");
    }
    let link = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return SandboxResult::Missing;
        }
        Err(error) => return io_failure(&error),
    };
    let is_symbolic_link = link.file_type().is_symlink();
    let target = if is_symbolic_link {
        fs::metadata(path).ok()
    } else {
        Some(link)
    };
    SandboxResult::Stat {
        is_file: target.as_ref().is_some_and(fs::Metadata::is_file),
        is_directory: target.as_ref().is_some_and(fs::Metadata::is_dir),
        is_symbolic_link,
        size_bytes: target.as_ref().map_or(0, fs::Metadata::len),
    }
}

fn readdir(path: &str) -> SandboxResult {
    if !valid_path(path) {
        return failure("invalid", "invalid path");
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => return io_failure(&error),
    };
    let mut names = Vec::new();
    // Each name costs at least its bytes and quotes in the answer.
    let mut bytes = 64_usize;
    for entry in entries {
        match entry {
            Ok(entry) => {
                let name = entry.file_name().to_string_lossy().into_owned();
                bytes += name.len() + 3;
                if bytes > MAX_RESPONSE_BYTES {
                    return failure("too-large", format!("{path} has too many entries"));
                }
                names.push(name);
            }
            Err(error) => return io_failure(&error),
        }
    }
    let result = SandboxResult::Entries { names };
    if serde_json::to_string(&result).is_ok_and(|text| text.len() > MAX_RESPONSE_BYTES) {
        return failure("too-large", format!("{path} has too many entries"));
    }
    result
}

fn mkdir(path: &str) -> SandboxResult {
    if !valid_path(path) {
        return failure("invalid", "invalid path");
    }
    match create_dirs(Path::new(path)) {
        Ok(()) => SandboxResult::Done,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            failure("exists", format!("{path} exists and is not a directory"))
        }
        Err(error) => io_failure(&error),
    }
}

fn rm(path: &str, recursive: bool, force: bool) -> SandboxResult {
    if !valid_path(path) {
        return failure("invalid", "invalid path");
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if force
                && matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
        {
            return SandboxResult::Done;
        }
        Err(error) => return io_failure(&error),
    };
    let removed = if metadata.is_dir() {
        if !recursive {
            return failure("is-directory", format!("{path} is a directory"));
        }
        // Never follows a link inside the tree.
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match removed {
        Ok(()) => SandboxResult::Done,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => SandboxResult::Done,
        Err(error) => io_failure(&error),
    }
}

/// True when a binary frame is a `DXW1` sandbox write.
pub fn is_write_frame(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && &bytes[..4] == WRITE_FRAME_MAGIC
}

/// Split a `DXW1` frame into its JSON request frame and raw bytes. `None`
/// for a malformed frame, which ends the session.
pub fn split_write_frame(bytes: &[u8]) -> Option<(&str, &[u8])> {
    if !is_write_frame(bytes) {
        return None;
    }
    let length = u32::from_be_bytes(bytes[4..8].try_into().ok()?) as usize;
    if !(2..=MAX_WRITE_JSON_BYTES).contains(&length) || 8 + length > bytes.len() {
        return None;
    }
    let payload = &bytes[8 + length..];
    if payload.len() > MAX_WRITE_PAYLOAD_BYTES {
        return None;
    }
    let json = std::str::from_utf8(&bytes[8..8 + length]).ok()?;
    Some((json, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner(state: &Path) -> Inner {
        Inner {
            paths: SandboxPaths {
                state: state.to_owned(),
                home: state.to_owned(),
                user: "user".into(),
            },
            runs: Mutex::default(),
            uploads: Mutex::default(),
            collected_at: Mutex::default(),
            wrapper: Mutex::default(),
            executable: PathBuf::from("dxd"),
            cancelled: Mutex::default(),
        }
    }

    /// A finished command, its result written `age` ago, with a deadline.
    fn finished(root: &Path, id: &str, age: &str, deadline_unix_ms: u64) -> PathBuf {
        let dir = root.join("exec").join(id);
        fs::create_dir_all(&dir).unwrap();
        let meta = ExecMeta {
            pid: 1,
            start_ticks: None,
            deadline_unix_ms,
        };
        fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();
        fs::write(dir.join("result.json"), b"{}").unwrap();
        assert!(
            Command::new("touch")
                .args(["-d", age])
                .arg(dir.join("result.json"))
                .status()
                .unwrap()
                .success()
        );
        dir
    }

    #[test]
    fn a_record_outlives_every_resend_core_may_still_make() {
        let state = tempfile::tempdir().unwrap();
        let inner = inner(state.path());
        // Finished 20 minutes ago, but Core may resend it for another hour
        // (a long command's deadline plus 30 s).
        let resendable = finished(
            state.path(),
            "exec-long-deadline-01",
            "20 minutes ago",
            unix_ms() + 3_600_000,
        );
        let past = finished(
            state.path(),
            "exec-past-deadline-01",
            "20 minutes ago",
            unix_ms() - 600_000,
        );
        let recent = finished(
            state.path(),
            "exec-recent-result-01",
            "1 minute ago",
            unix_ms() - 600_000,
        );
        inner.collect_garbage();
        assert!(resendable.exists(), "a resendable record was dropped");
        assert!(!past.exists(), "an expired record was kept");
        assert!(recent.exists(), "a record within retention was dropped");
    }

    #[test]
    fn write_frames_split_and_reject_bad_headers() {
        let json = br#"{"type":"request"}"#;
        let mut frame = WRITE_FRAME_MAGIC.to_vec();
        frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
        frame.extend_from_slice(json);
        frame.extend_from_slice(&[0, 255, 1]);
        let (text, payload) = split_write_frame(&frame).unwrap();
        assert_eq!(text, r#"{"type":"request"}"#);
        assert_eq!(payload, &[0, 255, 1]);
        let mut short = frame.clone();
        short[4..8].copy_from_slice(&(10_000_u32).to_be_bytes());
        assert!(split_write_frame(&short).is_none(), "length past the frame");
        let mut zero = frame.clone();
        zero[4..8].copy_from_slice(&0_u32.to_be_bytes());
        assert!(split_write_frame(&zero).is_none(), "empty JSON");
        assert!(split_write_frame(b"DXW1").is_none(), "no header");
    }

    #[test]
    fn answers_keep_core_field_names() {
        let text = serde_json::to_string(&SandboxResult::Exec {
            exit_code: 3,
            timed_out: false,
            stdout: Some("a".into()),
            stderr: None,
            stdout_bytes: 1,
            stderr_bytes: 0,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"kind":"exec","exitCode":3,"timedOut":false,"stdout":"a","stderr":null,"stdoutBytes":1,"stderrBytes":0}"#
        );
        let stat = serde_json::to_string(&SandboxResult::Stat {
            is_file: true,
            is_directory: false,
            is_symbolic_link: true,
            size_bytes: 2,
        })
        .unwrap();
        assert_eq!(
            stat,
            r#"{"kind":"stat","isFile":true,"isDirectory":false,"isSymbolicLink":true,"sizeBytes":2}"#
        );
        assert_eq!(
            serde_json::to_string(&failure("not-found", "x")).unwrap(),
            r#"{"kind":"failure","code":"not-found","message":"x"}"#
        );
    }

    #[test]
    fn create_dirs_sets_0755_despite_the_daemon_umask() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("a/b/c");
        create_dirs(&nested).unwrap();
        for directory in ["a", "a/b", "a/b/c"] {
            let mode = fs::metadata(root.path().join(directory))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755, "{directory}");
        }
        fs::write(root.path().join("file"), "x").unwrap();
        assert_eq!(
            create_dirs(&root.path().join("file")).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
    }

    #[test]
    fn writes_follow_links_to_their_targets() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("real"), "x").unwrap();
        std::os::unix::fs::symlink("real", root.path().join("relative")).unwrap();
        std::os::unix::fs::symlink(root.path().join("relative"), root.path().join("chain"))
            .unwrap();
        assert_eq!(
            write_target(&root.path().join("chain")),
            root.path().join("real")
        );
        assert_eq!(
            write_target(&root.path().join("new")),
            root.path().join("new")
        );
    }
}
