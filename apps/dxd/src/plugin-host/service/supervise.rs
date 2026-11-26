//! One install's running service: a supervisor thread lays out its files,
//! runs `setup` once per key, then keeps `run` and each listener up, each
//! with `bash -lc` in its own session, restarting one that exits.

use super::super::{lock, now_ms, truncate};
use super::log::{self, MAX_LINE_BYTES, ServiceLog, TRUNCATED};
use super::{LastExit, ServicePaths, ServiceSource, ServiceSpec, ServiceState, ServiceStatus};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{self, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Names one service run in its processes' environment, so a later daemon
/// stops only processes a daemon started.
pub(super) const RUN_VARIABLE: &str = "DX_SERVICE_RUN";
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PACKAGE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const GRACE: Duration = Duration::from_secs(2);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const LAST_BACKOFF: Duration = Duration::from_secs(60);
/// A run up this long starts the next backoff from one second again.
const STABLE: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(100);
const MAX_QUEUED_LINES: usize = 1000;
const EVENT_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_TAIL_LINES: usize = 20;
const COPY_COMPLETE: &str = ".dx-service-complete";
const SETUP_COMPLETE: &str = ".setup-complete";

pub(super) struct Launch {
    pub spec: ServiceSpec,
    pub folder: Option<PathBuf>,
    pub api: String,
    pub paths: ServicePaths,
    pub log: Arc<ServiceLog>,
    pub groups: Arc<Groups>,
}

/// What the supervisor and its listeners share with the registry.
struct Shared {
    status: Mutex<ServiceStatus>,
    changed: Condvar,
    stop: AtomicBool,
    queues: Vec<Arc<LineQueue>>,
}

impl Shared {
    fn stopping(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    fn update(&self, change: impl FnOnce(&mut ServiceStatus)) {
        change(&mut lock(&self.status));
        self.changed.notify_all();
    }

    fn enter(&self, state: ServiceState) {
        self.update(|status| {
            if status.state != state {
                status.state = state;
                status.since = now_ms();
            }
        });
    }

    /// Waits up to `duration`; true when the service is stopping.
    fn pause(&self, duration: Duration) -> bool {
        let status = lock(&self.status);
        let _ = self
            .changed
            .wait_timeout_while(status, duration, |_| !self.stopping());
        self.stopping()
    }

    /// The service's port once it accepts connections; `None` when it stops.
    fn running_port(&self) -> Option<u16> {
        let mut status = lock(&self.status);
        loop {
            if self.stopping() {
                return None;
            }
            if status.state == ServiceState::Running
                && let Some(port) = status.port
            {
                return Some(port);
            }
            status = match self
                .changed
                .wait_timeout(status, Duration::from_millis(500))
            {
                Ok((status, _)) => status,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

pub(super) struct Instance {
    pub install_id: String,
    pub key: String,
    pub name: String,
    pub token: String,
    shared: Arc<Shared>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

/// Everything the supervisor's threads read.
struct Context {
    spec: ServiceSpec,
    folder: Option<PathBuf>,
    paths: ServicePaths,
    log: Arc<ServiceLog>,
    groups: Arc<Groups>,
    shared: Arc<Shared>,
    run_id: String,
    /// The environment without `PORT`; holds the spec's secrets.
    environment: BTreeMap<String, String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Instance {
    pub(super) fn start(launch: Launch) -> Arc<Self> {
        let token = hex(&rand::random::<[u8; 32]>());
        let run_id = hex(&rand::random::<[u8; 16]>());
        let spec = launch.spec;
        let mut environment = crate::environment::base_environment_for(
            &BTreeMap::new(),
            &launch.paths.home,
            &launch.paths.user,
        );
        environment.extend(spec.env.clone());
        for (name, value) in [
            ("DX_API", launch.api),
            ("DX_TOKEN", token.clone()),
            ("DX_PLUGIN_NAME", spec.name.clone()),
            ("DX_INSTALL_ID", spec.install_id.clone()),
            (RUN_VARIABLE, run_id.clone()),
        ] {
            environment.insert(name.into(), value);
        }
        let shared = Arc::new(Shared {
            status: Mutex::new(ServiceStatus {
                state: ServiceState::Setup,
                port: None,
                since: now_ms(),
                restarts: 0,
                last_exit: None,
                message: None,
            }),
            changed: Condvar::new(),
            stop: AtomicBool::new(false),
            queues: spec
                .listeners
                .iter()
                .map(|listener| Arc::new(LineQueue::new(listener.name.clone())))
                .collect(),
        });
        let instance = Arc::new(Self {
            install_id: spec.install_id.clone(),
            key: spec.key.clone(),
            name: spec.name.clone(),
            token,
            shared: Arc::clone(&shared),
            supervisor: Mutex::new(None),
        });
        let context = Arc::new(Context {
            spec,
            folder: launch.folder,
            paths: launch.paths,
            log: launch.log,
            groups: launch.groups,
            shared,
            run_id,
            environment,
        });
        let handle = std::thread::Builder::new()
            .name("dxd-service".into())
            .spawn(move || supervise(context));
        match handle {
            Ok(handle) => *lock(&instance.supervisor) = Some(handle),
            Err(error) => instance.shared.update(|status| {
                status.state = ServiceState::Failed;
                status.since = now_ms();
                status.message = Some(format!("dx could not start a supervisor: {error}"));
            }),
        }
        instance
    }

    pub(super) fn status(&self) -> ServiceStatus {
        lock(&self.shared.status).clone()
    }

    /// Stops every process of the service (SIGTERM to each group, SIGKILL
    /// after two seconds) and waits for its threads.
    pub(super) fn stop(&self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.update(|_| {});
        for queue in &self.shared.queues {
            queue.close();
        }
        if let Some(handle) = lock(&self.supervisor).take() {
            let _ = handle.join();
        }
        self.shared.enter(ServiceState::Stopped);
    }
}

fn supervise(context: Arc<Context>) {
    let folder = match prepare(&context) {
        Ok(folder) => folder,
        Err(message) => return fail(&context, message),
    };
    // The port is picked before listeners start: they get it as `PORT`.
    let port = match choose_port(None) {
        Ok(port) => port,
        Err(error) => return fail(&context, format!("dx found no free port: {error}")),
    };
    context.shared.update(|status| status.port = Some(port));
    if let Some(setup) = &context.spec.setup {
        let marker = context
            .paths
            .share(&context.spec.install_id)
            .join(format!("{}{SETUP_COMPLETE}", context.spec.key));
        if !marker.is_file() {
            match run_setup(&context, &folder, setup, port) {
                Ok(()) => {
                    let _ = fs::write(&marker, b"");
                }
                Err(None) => return,
                Err(Some(message)) => return fail(&context, message),
            }
        }
    }
    let mut threads = Vec::new();
    for (index, listener) in context.spec.listeners.iter().enumerate() {
        let queue = Arc::clone(&context.shared.queues[index]);
        let keeper = {
            let context = Arc::clone(&context);
            let folder = folder.clone();
            std::thread::Builder::new()
                .name("dxd-service-listener".into())
                .spawn(move || keep(&context, Role::Listener(index), &folder))
        };
        let sender = {
            let context = Arc::clone(&context);
            let name = listener.name.clone();
            std::thread::Builder::new()
                .name("dxd-service-events".into())
                .spawn(move || deliver(&context, &name, &queue))
        };
        threads.extend([keeper, sender].into_iter().filter_map(Result::ok));
    }
    keep(&context, Role::Run, &folder);
    for thread in threads {
        let _ = thread.join();
    }
}

fn fail(context: &Context, message: String) {
    context.log.line("[dxd]", message.as_bytes());
    context.shared.update(|status| {
        status.state = ServiceState::Failed;
        status.since = now_ms();
        status.message = Some(truncate(&message, 2048));
    });
}

/// The folder the service runs in: a draft's own, or the package copied
/// to `~/.local/share/dx/services/<installId>/<key>/` once per key.
fn prepare(context: &Context) -> Result<PathBuf, String> {
    let share = context.paths.share(&context.spec.install_id);
    fs::create_dir_all(&share)
        .map_err(|error| format!("dx could not create {share:?}: {error}"))?;
    // Earlier versions' copies and setup markers go.
    let key = &context.spec.key;
    let setup_marker = format!("{key}{SETUP_COMPLETE}");
    if let Ok(entries) = fs::read_dir(&share) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name != key.as_str() && name != setup_marker.as_str() {
                let path = entry.path();
                let _ = fs::remove_dir_all(&path).or_else(|_| fs::remove_file(&path));
            }
        }
    }
    let package = match (&context.folder, &context.spec.source) {
        (Some(folder), _) => return Ok(folder.clone()),
        (None, ServiceSource::Package(package)) => package,
        (None, ServiceSource::Folder(_)) => return Err("The folder was not resolved.".into()),
    };
    let target = share.join(key);
    if target.join(COPY_COMPLETE).is_file() {
        return Ok(target);
    }
    let mcp = crate::mcp::McpPaths {
        home: context.paths.home.clone(),
        user: context.paths.user.clone(),
        log_directory: context.paths.log_directory.clone(),
    };
    let root = crate::mcp::prepare_package(package, &mcp, Instant::now() + PACKAGE_TIMEOUT)
        .map_err(|result| match result {
            crate::mcp::McpResult::Unavailable { message, .. } => message,
            _ => "dx could not lay out the service's files.".into(),
        })?;
    let _ = fs::remove_dir_all(&target);
    let temporary = share.join(format!(".{key}.{}", rand::random::<u64>()));
    let copied = copy_tree(&root, &temporary)
        .and_then(|()| fs::File::create(temporary.join(COPY_COMPLETE)).map(drop))
        .and_then(|()| fs::rename(&temporary, &target));
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!("dx could not copy the service's files: {error}"));
    }
    Ok(target)
}

/// Copies files and folders (never symbolic links) with their modes.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name.as_encoded_bytes().starts_with(b".dx-package") {
            continue;
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// The previous port while it is free, else a new free one.
fn choose_port(previous: Option<u16>) -> io::Result<u16> {
    if let Some(port) = previous
        && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
    {
        return Ok(port);
    }
    for _ in 0..16 {
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))?
            .local_addr()?
            .port();
        if !crate::proxy::INTERNAL_PORTS.contains(&port) {
            return Ok(port);
        }
    }
    Err(io::ErrorKind::AddrInUse.into())
}

fn accepts(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), POLL)
        .is_ok()
}

fn command(context: &Context, folder: &Path, script: &str, port: u16) -> Command {
    let mut command = Command::new("/bin/bash");
    command
        .arg("-lc")
        .arg(script)
        .current_dir(folder)
        .env_clear()
        .envs(&context.environment)
        .env("PORT", port.to_string())
        .stdin(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no parent state; the
    // process leads its own session and group, which `stop` signals whole.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
}

/// Starts `script` with stdout and stderr into the log under `prefix`.
/// `tail` keeps its last lines when given.
fn spawn_logged(
    context: &Context,
    folder: &Path,
    script: &str,
    port: u16,
    prefix: String,
    tail: Option<Arc<Mutex<VecDeque<String>>>>,
) -> io::Result<(Child, JoinHandle<()>)> {
    let (reader, writer) = io::pipe()?;
    let mut command = command(context, folder, script, port);
    command.stdout(writer.try_clone()?).stderr(writer);
    let child = command.spawn()?;
    // The parent's write ends close here, so the pump ends with the group.
    drop(command);
    let log = Arc::clone(&context.log);
    let pump = std::thread::Builder::new()
        .name("dxd-service-log".into())
        .spawn(move || pump_log(reader, &log, &prefix, tail.as_deref()))?;
    Ok((child, pump))
}

fn pump_log(
    reader: io::PipeReader,
    log: &ServiceLog,
    prefix: &str,
    tail: Option<&Mutex<VecDeque<String>>>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while let Ok(Some(truncated)) = log::read_line(&mut reader, MAX_LINE_BYTES, &mut line) {
        if truncated {
            line.extend_from_slice(TRUNCATED.as_bytes());
        }
        log.line(prefix, &line);
        if let Some(tail) = tail {
            let mut tail = lock(tail);
            if tail.len() == SETUP_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(truncate(&String::from_utf8_lossy(&line), 512));
        }
    }
}

enum Ended {
    Exited(ExitStatus),
    Stopped,
    TimedOut,
}

/// Waits for the process, polling; stops its group when the service
/// stops or the deadline passes. `tick` runs every poll while it lives.
fn wait(
    context: &Context,
    child: &mut Child,
    deadline: Option<Instant>,
    mut tick: impl FnMut(),
) -> Ended {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                kill_group(child.id(), libc::SIGKILL);
                return Ended::Exited(status);
            }
            Ok(None) => {}
            Err(_) => {
                terminate(child);
                return Ended::Stopped;
            }
        }
        if context.shared.stopping() {
            terminate(child);
            return Ended::Stopped;
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            terminate(child);
            return Ended::TimedOut;
        }
        tick();
        context.shared.pause(POLL);
    }
}

fn kill_group(pid: u32, signal: libc::c_int) {
    // SAFETY: the process leads its own group (setsid); a negative pid
    // signals that group only.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

/// SIGTERM to the group, SIGKILL after the grace period; reaps the leader.
fn terminate(child: &mut Child) {
    kill_group(child.id(), libc::SIGTERM);
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
        std::thread::sleep(Duration::from_millis(20));
    }
    kill_group(child.id(), libc::SIGKILL);
    let _ = child.wait();
}

fn describe(status: &ExitStatus) -> String {
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exited with code {code}"),
        (_, Some(signal)) => format!("was killed by signal {signal}"),
        _ => "exited".into(),
    }
}

/// Runs `setup`; `Err(None)` when the service stopped meanwhile.
fn run_setup(
    context: &Context,
    folder: &Path,
    setup: &str,
    port: u16,
) -> Result<(), Option<String>> {
    context.shared.enter(ServiceState::Setup);
    context.log.line("[dxd]", b"running setup");
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let (mut child, pump) = spawn_logged(
        context,
        folder,
        setup,
        port,
        "[setup]".into(),
        Some(Arc::clone(&tail)),
    )
    .map_err(|error| Some(format!("dx could not start setup: {error}")))?;
    context.groups.register(child.id(), &context.run_id);
    let ended = wait(
        context,
        &mut child,
        Some(Instant::now() + SETUP_TIMEOUT),
        || {},
    );
    context.groups.unregister(child.id());
    // Its output is complete once every process of the group is gone.
    let pumped = Instant::now() + Duration::from_secs(1);
    while !pump.is_finished() && Instant::now() < pumped {
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = lock(&tail).iter().cloned().collect::<Vec<_>>().join("\n");
    let failed = |what: String| {
        Some(if output.is_empty() {
            format!("setup {what}.")
        } else {
            format!("setup {what}:\n{output}")
        })
    };
    match ended {
        Ended::Exited(status) if status.success() => Ok(()),
        Ended::Exited(status) => Err(failed(describe(&status))),
        Ended::TimedOut => Err(failed(format!(
            "did not finish within {} minutes",
            SETUP_TIMEOUT.as_secs() / 60
        ))),
        Ended::Stopped => Err(None),
    }
}

#[derive(Clone, Copy)]
enum Role {
    Run,
    Listener(usize),
}

/// Keeps `run` or one listener up until the service stops.
fn keep(context: &Context, role: Role, folder: &Path) {
    let (script, label) = match role {
        Role::Run => (context.spec.run.as_str(), "[run]".to_owned()),
        Role::Listener(index) => {
            let listener = &context.spec.listeners[index];
            (
                listener.run.as_str(),
                format!("[listener {}]", listener.name),
            )
        }
    };
    let mut backoff = FIRST_BACKOFF;
    loop {
        if context.shared.stopping() {
            return;
        }
        let current = lock(&context.shared.status).port;
        let port = match role {
            Role::Run => match choose_port(current) {
                Ok(port) => {
                    context.shared.update(|status| {
                        status.port = Some(port);
                        status.state = ServiceState::Starting;
                        status.since = now_ms();
                    });
                    port
                }
                Err(_) => current.unwrap_or_default(),
            },
            Role::Listener(_) => current.unwrap_or_default(),
        };
        let started = Instant::now();
        let ended = match spawn(context, role, folder, script, port, &label) {
            Ok(mut child) => {
                context.groups.register(child.id(), &context.run_id);
                let ended = wait(context, &mut child, None, || {
                    if matches!(role, Role::Run)
                        && lock(&context.shared.status).state == ServiceState::Starting
                        && accepts(port)
                    {
                        context.shared.enter(ServiceState::Running);
                    }
                });
                context.groups.unregister(child.id());
                ended
            }
            Err(error) => {
                context.log.line(
                    "[dxd]",
                    format!("{label} could not start: {error}").as_bytes(),
                );
                Ended::TimedOut
            }
        };
        let (code, signal, what) = match &ended {
            Ended::Stopped => return,
            Ended::Exited(status) => (status.code(), status.signal(), describe(status)),
            Ended::TimedOut => (None, None, "did not start".to_owned()),
        };
        if started.elapsed() >= STABLE {
            backoff = FIRST_BACKOFF;
        }
        context.log.line(
            "[dxd]",
            format!("{label} {what}; restarting in {} s", backoff.as_secs()).as_bytes(),
        );
        if matches!(role, Role::Run) {
            context.shared.update(|status| {
                status.state = ServiceState::Backoff;
                status.since = now_ms();
                status.restarts = status.restarts.saturating_add(1);
                status.last_exit = Some(LastExit {
                    code,
                    signal,
                    at: now_ms(),
                });
            });
        }
        if context.shared.pause(backoff) {
            return;
        }
        backoff = (backoff * 2).min(LAST_BACKOFF);
    }
}

fn spawn(
    context: &Context,
    role: Role,
    folder: &Path,
    script: &str,
    port: u16,
    label: &str,
) -> io::Result<Child> {
    let Role::Listener(index) = role else {
        return spawn_logged(context, folder, script, port, label.to_owned(), None)
            .map(|(child, _)| child);
    };
    // A listener's stdout is its events; its stderr goes to the log.
    let (events, events_writer) = io::pipe()?;
    let (errors, errors_writer) = io::pipe()?;
    let mut command = command(context, folder, script, port);
    command.stdout(events_writer).stderr(errors_writer);
    let child = command.spawn()?;
    drop(command);
    let log = Arc::clone(&context.log);
    let prefix = label.to_owned();
    std::thread::Builder::new()
        .name("dxd-service-log".into())
        .spawn(move || pump_log(errors, &log, &prefix, None))?;
    let queue = Arc::clone(&context.shared.queues[index]);
    std::thread::Builder::new()
        .name("dxd-service-lines".into())
        .spawn(move || {
            let mut reader = BufReader::new(events);
            let mut line = Vec::new();
            while let Ok(Some(truncated)) = log::read_line(&mut reader, MAX_LINE_BYTES, &mut line) {
                let mut text = String::from_utf8_lossy(&line).into_owned();
                if truncated {
                    text.push_str(TRUNCATED);
                }
                queue.push(text, now_ms());
            }
        })?;
    Ok(child)
}

/// A listener's lines on their way to the service: at most 1,000, the
/// oldest dropped first.
pub(super) struct LineQueue {
    name: String,
    state: Mutex<QueueState>,
    ready: Condvar,
}

#[derive(Default)]
struct QueueState {
    lines: VecDeque<(String, u64)>,
    dropped: u64,
    closed: bool,
}

impl LineQueue {
    fn new(name: String) -> Self {
        Self {
            name,
            state: Mutex::default(),
            ready: Condvar::new(),
        }
    }

    fn push(&self, line: String, at: u64) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        if state.lines.len() >= MAX_QUEUED_LINES {
            state.lines.pop_front();
            state.dropped += 1;
        }
        state.lines.push_back((line, at));
        drop(state);
        self.ready.notify_one();
    }

    fn close(&self) {
        lock(&self.state).closed = true;
        self.ready.notify_all();
    }

    /// The next line and how many were dropped before it; `None` once closed.
    fn next(&self) -> Option<(String, u64, u64)> {
        let mut state = lock(&self.state);
        loop {
            if state.closed {
                return None;
            }
            if let Some((line, at)) = state.lines.pop_front() {
                let dropped = std::mem::take(&mut state.dropped);
                return Some((line, at, dropped));
            }
            state = match self.ready.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }
}

/// Sends a listener's lines to the service in order, each once it runs.
fn deliver(context: &Context, name: &str, queue: &LineQueue) {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(EVENT_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent();
    while let Some((line, at, dropped)) = queue.next() {
        if dropped > 0 {
            context.log.line(
                "[dxd]",
                format!(
                    "listener {} dropped {dropped} line(s): the service did not keep up",
                    queue.name
                )
                .as_bytes(),
            );
        }
        let body = serde_json::json!({"line": line, "at": log::rfc3339(at)});
        loop {
            let Some(port) = context.shared.running_port() else {
                return;
            };
            match agent
                .post(format!("http://127.0.0.1:{port}/events/{name}"))
                .send_json(&body)
            {
                Ok(mut response) => {
                    let _ = response
                        .body_mut()
                        .with_config()
                        .limit(64 * 1024)
                        .read_to_vec();
                    break;
                }
                Err(ureq::Error::Timeout(_)) => {
                    context.log.line(
                        "[dxd]",
                        format!("listener {name}: the service did not take a line within 30 s")
                            .as_bytes(),
                    );
                    break;
                }
                // Restarting: the line waits for the next run.
                Err(_) => {
                    if context.shared.pause(Duration::from_millis(250)) {
                        return;
                    }
                }
            }
        }
    }
}

/// The process groups services run in, written to a file so the next
/// daemon can stop them when this one dies without stopping them.
pub(super) struct Groups {
    path: PathBuf,
    live: Mutex<HashMap<u32, String>>,
}

impl Groups {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            live: Mutex::default(),
        }
    }

    fn register(&self, pid: u32, run_id: &str) {
        let mut live = lock(&self.live);
        live.insert(pid, run_id.to_owned());
        self.write(&live);
    }

    fn unregister(&self, pid: u32) {
        let mut live = lock(&self.live);
        live.remove(&pid);
        self.write(&live);
    }

    fn write(&self, live: &HashMap<u32, String>) {
        let text: String = live
            .iter()
            .map(|(pid, run)| format!("{pid} {run}\n"))
            .collect();
        let Some(parent) = self.path.parent() else {
            return;
        };
        let _ = fs::create_dir_all(parent);
        let temporary = self.path.with_extension("tmp");
        let written = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)
            .and_then(|mut file| file.write_all(text.as_bytes()));
        if written.is_ok() {
            let _ = fs::rename(&temporary, &self.path);
        }
    }

    /// Stops the groups an earlier daemon recorded whose leader still
    /// carries that daemon's run id. Only Linux can tell (`/proc`).
    pub(super) fn sweep(&self) {
        #[cfg(target_os = "linux")]
        if let Ok(text) = fs::read_to_string(&self.path) {
            for line in text.lines() {
                let Some((pid, run)) = line.split_once(' ') else {
                    continue;
                };
                let Ok(pid) = pid.parse::<u32>() else {
                    continue;
                };
                let marker = format!("{RUN_VARIABLE}={run}");
                let ours = fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| {
                    environ
                        .split(|byte| *byte == 0)
                        .any(|entry| entry == marker.as_bytes())
                });
                if ours {
                    kill_group(pid, libc::SIGKILL);
                }
            }
        }
        let _ = fs::remove_file(&self.path);
    }
}
