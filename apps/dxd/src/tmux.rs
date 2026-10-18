//! The shared tmux session behind the Terminal, on images that bundle tmux
//! (`/opt/dx/bin/tmux`, the standard Orb image).
//!
//! dxd only runs tmux clients. The client on the resident PTY starts the
//! server when none is running; tmux daemonizes it, so the server and the
//! shells in its panes are not dxd's children and survive dxd restarts,
//! crashes, and self-updates. The agent reaches the same session with its own
//! short tmux commands (`-L dx ... -t main`). Every other tmux command dxd
//! runs is short and bounded, and runs on a worker thread or at startup,
//! never on the connection loop.

use crate::protocol::{Dimensions, TerminalGeneration};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const SOCKET: &str = "dx";
pub const SESSION: &str = "main";
/// `=` asks for exactly `main`, never a prefix match such as `main2`.
const TARGET: &str = "=main";
/// The same session for commands that take a pane target (`set-option`,
/// `display-message`): without the colon tmux looks for a window `main`.
const PANE_TARGET: &str = "=main:";
/// Session user option naming the resident whose client created or joined
/// the session. Only that resident may rejoin it after a daemon dies.
const RESIDENT_OPTION: &str = "@dx_resident";
const DEFAULT_BINARY: &str = "/opt/dx/bin/tmux";
const DEFAULT_CONFIG: &str = "/opt/dx/share/tmux.conf";
/// Overrides for tests and diagnostics, read once at startup. An empty
/// `DXD_TMUX` turns the multiplexer off.
const BINARY_VARIABLE: &str = "DXD_TMUX";
const CONFIG_VARIABLE: &str = "DXD_TMUX_CONF";
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);
/// A new client usually attaches within milliseconds; look for it every
/// 100 ms for five seconds, then every second for about a minute.
const SERVER_LEARN_FAST_ATTEMPTS: u32 = 50;
const SERVER_LEARN_SLOW_ATTEMPTS: u32 = 55;
const SERVER_LEARN_INTERVAL: Duration = Duration::from_millis(100);
const SERVER_LEARN_SLOW_INTERVAL: Duration = Duration::from_secs(1);

/// How the resident PTY's client joins the session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Join {
    /// Only the existing session: a client that finds none exits, so dxd never
    /// passes a new session off as the one it lost.
    Existing,
    /// Attach to the session, or create it in the workspace root.
    AttachOrCreate,
    /// End the session (its shells get SIGHUP) and create a new one.
    Fresh,
}

#[derive(Clone)]
pub struct Tmux {
    binary: PathBuf,
    config: PathBuf,
    /// `TMUX_TMPDIR` as dxd received it; tests give each daemon its own.
    socket_directory: Option<OsString>,
    /// The PID of the server the current client is attached to, for
    /// foreground detection.
    server: Arc<Mutex<Server>>,
    /// Variables last pushed into the server's global environment.
    pushed: Arc<Mutex<Pushed>>,
}

#[derive(Default)]
struct Server {
    /// Counts clients started; a learner for an older client stores nothing.
    client: u64,
    /// 0 until first learned; the previous client's server until the
    /// current client's is.
    pid: i32,
}

#[derive(Default)]
struct Pushed {
    generation: u64,
    names: BTreeSet<String>,
}

impl Tmux {
    /// The bundled tmux, when this image has one.
    pub fn detect() -> Option<Self> {
        let binary = match std::env::var_os(BINARY_VARIABLE) {
            Some(value) if value.is_empty() => return None,
            Some(value) => PathBuf::from(value),
            None => PathBuf::from(DEFAULT_BINARY),
        };
        if !is_executable(&binary) {
            return None;
        }
        let config = std::env::var_os(CONFIG_VARIABLE)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG));
        Some(Self {
            binary,
            // Without dx's configuration tmux would read ~/.tmux.conf.
            config: if config.is_file() {
                config
            } else {
                PathBuf::from("/dev/null")
            },
            socket_directory: std::env::var_os("TMUX_TMPDIR"),
            server: Arc::new(Mutex::new(Server::default())),
            pushed: Arc::new(Mutex::new(Pushed::default())),
        })
    }

    /// The client the resident PTY runs. `environment` becomes the server's
    /// global environment when this client starts the server.
    /// `default_command` replaces the login shell in new panes (local
    /// development's rc file). A client that creates or joins the session
    /// marks it as `resident`'s.
    pub fn client(
        &self,
        join: Join,
        resident: TerminalGeneration,
        root: &Path,
        environment: &BTreeMap<String, String>,
        default_command: Option<String>,
    ) -> Command {
        let mut arguments: Vec<OsString> = vec![
            "-L".into(),
            SOCKET.into(),
            "-f".into(),
            self.config.clone().into(),
        ];
        match join {
            Join::Existing => {
                arguments.extend(["attach-session", "-t", TARGET].map(OsString::from));
            }
            Join::AttachOrCreate | Join::Fresh => {
                if join == Join::Fresh {
                    // The old session ends in the server that creates the new
                    // one, before `new-session -A` looks for it. This client
                    // keeps that server running even when `main` was its
                    // only session; a separate `kill-session` could leave
                    // the client connecting to a server that is exiting.
                    // `if-shell -F` because a failed `kill-session` (no
                    // session) would skip the rest of the list.
                    arguments.extend(
                        [
                            "if-shell",
                            "-F",
                            "#{S:#{?#{==:#{session_name},main},1,}}",
                            "kill-session -t =main",
                            ";",
                        ]
                        .map(OsString::from),
                    );
                }
                if let Some(command) = default_command {
                    arguments.extend(["set-option", "-g", "default-command"].map(OsString::from));
                    arguments.push(escape_argument(&command).into());
                    arguments.push(";".into());
                }
                arguments.extend(["new-session", "-A", "-s", SESSION, "-c"].map(OsString::from));
                arguments.push(root.into());
                // Runs once this client is attached, so the mark never names
                // a resident whose client did not reach the session.
                arguments.extend(
                    [";", "set-option", "-t", PANE_TARGET, RESIDENT_OPTION].map(OsString::from),
                );
                arguments.push(resident_mark(resident).into());
            }
        }
        let mut command = Command::new(&self.binary);
        command
            .args(arguments)
            .current_dir(root)
            .env_clear()
            .envs(environment)
            .env("TERM", "xterm-256color");
        if let Some(directory) = &self.socket_directory {
            command.env("TMUX_TMPDIR", directory);
        }
        command
    }

    /// A short tmux command on the dx socket.
    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .args(["-L", SOCKET])
            .env_clear()
            .env("LANG", "C.UTF-8");
        if let Some(directory) = &self.socket_directory {
            command.env("TMUX_TMPDIR", directory);
        }
        command
    }

    /// The window size of `resident`'s session when a previous dxd process
    /// left it running, or `None` when there is none. A session `main` that
    /// some other resident's client (or the agent) opened is not `resident`'s:
    /// rejoining it would pass a new session off as the lost one. Blocks for
    /// at most two seconds; called once at startup.
    pub fn surviving_session(&self, resident: TerminalGeneration) -> Option<Dimensions> {
        let mut command = self.command();
        command.args([
            "display-message",
            "-p",
            "-t",
            PANE_TARGET,
            &format!("#{{window_width}} #{{window_height}} #{{{RESIDENT_OPTION}}}"),
        ]);
        let output = run_bounded(command, QUERY_TIMEOUT)?;
        let mut fields = output.split_whitespace();
        let columns = fields.next()?.parse::<u16>().ok()?;
        let rows = fields.next()?.parse::<u16>().ok()?;
        if fields.next() != Some(resident_mark(resident).as_str()) || fields.next().is_some() {
            return None;
        }
        let dimensions = Dimensions { columns, rows };
        Some(if dimensions.valid() {
            dimensions
        } else {
            Dimensions::INITIAL
        })
    }

    /// Learn, on a worker thread, the PID of the server that `client` (the
    /// resident PTY's new tmux client) is attached to. Until it attaches,
    /// the socket may have no server or one that is exiting (the agent may
    /// have ended it), and the client may start another. So the learner
    /// waits for the server that lists `client` among its clients: the one
    /// it stays attached to for its whole life. It stops once learned, when
    /// the client has exited, when a newer client starts, or after a minute;
    /// foreground detection reads `/proc` after that.
    pub fn learn_server(&self, client: i32) {
        let started = {
            let Ok(mut server) = self.server.lock() else {
                return;
            };
            server.client += 1;
            server.client
        };
        let tmux = self.clone();
        let _ = thread::Builder::new()
            .name("dxd-tmux".into())
            .spawn(move || {
                let current = || {
                    tmux.server
                        .lock()
                        .is_ok_and(|server| server.client == started)
                };
                for attempt in 0..SERVER_LEARN_FAST_ATTEMPTS + SERVER_LEARN_SLOW_ATTEMPTS {
                    if !current() || !process_running(client) {
                        return;
                    }
                    let mut command = tmux.command();
                    command.args(["list-clients", "-F", "#{client_pid} #{pid}"]);
                    let found = run_bounded(command, QUERY_TIMEOUT).and_then(|output| {
                        output.lines().find_map(|line| {
                            let (listed, server) = line.split_once(' ')?;
                            (listed.parse::<i32>().ok()? == client)
                                .then(|| server.trim().parse::<i32>().ok())
                                .flatten()
                                .filter(|server| *server > 1)
                        })
                    });
                    if let Some(pid) = found {
                        if let Ok(mut server) = tmux.server.lock()
                            && server.client == started
                        {
                            server.pid = pid;
                        }
                        return;
                    }
                    thread::sleep(if attempt < SERVER_LEARN_FAST_ATTEMPTS {
                        SERVER_LEARN_INTERVAL
                    } else {
                        SERVER_LEARN_SLOW_INTERVAL
                    });
                }
            });
    }

    /// Whether a command runs in the foreground of any pane's shell: a pane
    /// process (a child of the server with a terminal) whose terminal's
    /// foreground process group is not its own. Reads `/proc` only.
    pub fn foreground_command(&self) -> bool {
        let server = self.server.lock().map_or(0, |server| server.pid);
        if server <= 1 {
            return false;
        }
        server_children(server)
            .into_iter()
            .any(|pid| process_stat(pid).is_some_and(|stat| stat.runs_foreground_command(pid)))
    }

    /// Make future panes start with `environment`: set every variable in the
    /// server's global environment and unset the ones a previous push set
    /// that are gone. Runs on a worker thread; an older generation that
    /// arrives late is dropped. Panes already running keep their values.
    pub fn push_environment(&self, environment: BTreeMap<String, String>, generation: u64) {
        let tmux = self.clone();
        let _ = thread::Builder::new()
            .name("dxd-tmux".into())
            .spawn(move || {
                let Ok(mut pushed) = tmux.pushed.lock() else {
                    return;
                };
                if generation <= pushed.generation {
                    return;
                }
                let mut command = tmux.command();
                let mut first = true;
                let mut separate = |command: &mut Command| {
                    if !std::mem::take(&mut first) {
                        command.arg(";");
                    }
                };
                for name in pushed
                    .names
                    .iter()
                    .filter(|name| !environment.contains_key(*name))
                {
                    separate(&mut command);
                    command
                        .args(["set-environment", "-g", "-u"])
                        .arg(escape_argument(name));
                }
                for (name, value) in &environment {
                    separate(&mut command);
                    command
                        .args(["set-environment", "-g"])
                        .arg(escape_argument(name))
                        .arg(escape_argument(value));
                }
                // No server is not a failure: the next one starts from the
                // client's environment, which already holds these values.
                let _ = run_bounded(command, QUERY_TIMEOUT);
                pushed.generation = generation;
                pushed.names = environment.into_keys().collect();
            });
    }
}

/// tmux splits its argument list at an argument ending in `;`; `\;` keeps
/// the semicolon literal.
fn escape_argument(value: &str) -> String {
    match value.strip_suffix(';') {
        Some(rest) => format!("{rest}\\;"),
        None => value.to_owned(),
    }
}

/// The session's mark for `resident`: hex, so tmux never reads it as a flag.
fn resident_mark(resident: TerminalGeneration) -> String {
    resident
        .bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Single-quote `value` for the `sh -c` tmux runs a default command with.
pub fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', r"'\''"))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// Run `command` to completion within `timeout` and return its standard
/// output when it succeeded. A command still running at the deadline is
/// killed.
fn run_bounded(mut command: Command, timeout: Duration) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                child.stdout.take()?.read_to_string(&mut output).ok()?;
                return status.success().then_some(output);
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The server's children: its panes, plus any job processes it runs.
fn server_children(server: i32) -> Vec<i32> {
    let parse = |text: String| {
        text.split_whitespace()
            .filter_map(|pid| pid.parse::<i32>().ok())
            .collect::<Vec<_>>()
    };
    if let Ok(text) = std::fs::read_to_string(format!("/proc/{server}/task/{server}/children")) {
        return parse(text);
    }
    if !Path::new(&format!("/proc/{server}")).exists() {
        return Vec::new();
    }
    // A kernel without CONFIG_PROC_CHILDREN: find them by parent.
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|pid| process_stat(*pid).is_some_and(|stat| stat.parent == server))
        .collect()
}

struct ProcessStat {
    parent: i32,
    terminal: i32,
    foreground_group: i32,
}

impl ProcessStat {
    fn runs_foreground_command(&self, pid: i32) -> bool {
        self.terminal != 0 && self.foreground_group > 0 && self.foreground_group != pid
    }
}

/// Whether `pid` exists and has not exited (a zombie waits to be reaped).
fn process_running(pid: i32) -> bool {
    read_stat(pid, |fields| {
        Some(!matches!(fields.first(), Some(&("Z" | "X"))))
    })
    .unwrap_or(false)
}

fn process_stat(pid: i32) -> Option<ProcessStat> {
    read_stat(pid, |fields| {
        Some(ProcessStat {
            parent: fields.get(1)?.parse().ok()?,
            terminal: fields.get(4)?.parse().ok()?,
            foreground_group: fields.get(5)?.parse().ok()?,
        })
    })
}

/// Read `/proc/<pid>/stat` from the state on. The command name may contain
/// spaces and parentheses; fields resume after its last `)`: state, ppid,
/// pgrp, session, tty_nr, tpgid.
fn read_stat<T>(pid: i32, read: impl FnOnce(&[&str]) -> Option<T>) -> Option<T> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = text
        .get(text.rfind(')')? + 1..)?
        .split_whitespace()
        .collect::<Vec<_>>();
    read(&fields)
}
