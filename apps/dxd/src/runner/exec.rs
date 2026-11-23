//! Runs one process for a Thread: sandboxed, clean environment, its own
//! process group, a timeout, and capped output. Every running group is
//! recorded so stopping the runner stops them too.

use crate::runner::{Paths, sandbox};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const OUTPUT_CAP: usize = 4 * 1024 * 1024;
const DEFAULT_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

static BASE_PATH: OnceLock<String> = OnceLock::new();
static OWN_PATH: OnceLock<String> = OnceLock::new();
static GROUPS: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

/// The PATH commands see: the runner's `bin` first (dxd for git helpers),
/// then the PATH captured when the machine was paired (the person's own).
/// dx's own tools (`tools/bin`) come after all of it (`with_tools_last`).
pub fn set_base_path(paths: &Paths, captured: Option<&str>) {
    let inherited = captured
        .map(str::to_string)
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_else(|| DEFAULT_PATH.into());
    let _ = BASE_PATH.set(format!("{}:{inherited}", paths.bin.display()));
    let _ = OWN_PATH.set(inherited);
}

pub fn base_path() -> String {
    BASE_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| DEFAULT_PATH.into())
}

/// The person's own PATH, without the runner's folders: where their own
/// tools are looked up before dx fetches one.
pub fn own_path() -> String {
    OWN_PATH
        .get()
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_else(|| DEFAULT_PATH.into())
}

/// The folder of dx's own tools, as a PATH entry.
pub fn tools_path(paths: &Paths) -> String {
    crate::runner::tools::bin_dir(paths).display().to_string()
}

/// `path` with dx's tools folder moved to its end: the person's tools, and
/// any a request's PATH names, always win over dx's.
pub fn with_tools_last(paths: &Paths, path: &str) -> String {
    let tools = tools_path(paths);
    let mut seen = HashSet::new();
    path.split(':')
        .filter(|d| !d.is_empty() && *d != tools && seen.insert(*d))
        .chain(std::iter::once(tools.as_str()))
        .collect::<Vec<_>>()
        .join(":")
}

/// The host PATH, after the runner's shims for whichever tools the host
/// lacks (`setsid`, `flock`, `timeout`; on macOS also `nohup`; and a clear
/// message for a missing git or python3).
pub fn command_path(paths: &Paths) -> String {
    static SHIMS: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    let base = base_path();
    match SHIMS.get_or_init(|| {
        let dir = super::shims::install(&paths.bin, &base);
        crate::runner::log(&match &dir {
            Some(d) => format!("shims: {} first on command PATH", d.display()),
            None => "shims: none needed".to_string(),
        });
        dir
    }) {
        Some(dir) => format!("{}:{base}", dir.display()),
        None => base,
    }
}

/// `request` with the runner's shims folder before it and the rest of
/// `runner` (shims, then the host PATH) after it, each folder once.
fn merge_path(runner: &str, request: &str) -> String {
    let mut runner_dirs = runner.split(':').filter(|d| !d.is_empty());
    let shims = runner_dirs.next().filter(|d| d.ends_with("/shims"));
    let mut seen = std::collections::HashSet::new();
    shims
        .into_iter()
        .chain(request.split(':'))
        .chain(runner.split(':'))
        .filter(|d| !d.is_empty() && seen.insert(*d))
        .collect::<Vec<_>>()
        .join(":")
}

/// Full access: the runner's PATH (shims, then the host's) before a
/// request's, each folder once.
fn host_path_first(runner: &str, request: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    runner
        .split(':')
        .chain(request.split(':'))
        .filter(|d| !d.is_empty() && seen.insert(*d))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn lang() -> &'static str {
    if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    }
}

pub fn track(pgid: i32) {
    GROUPS
        .lock()
        .unwrap()
        .get_or_insert_with(HashSet::new)
        .insert(pgid);
}

pub fn untrack(pgid: i32) {
    if let Some(set) = GROUPS.lock().unwrap().as_mut() {
        set.remove(&pgid);
    }
}

pub fn running_jobs() -> usize {
    GROUPS.lock().unwrap().as_ref().map_or(0, HashSet::len)
}

/// Stops every job the runner started (used on Ctrl-C, SIGTERM, update).
pub fn kill_all_jobs() {
    if let Some(set) = GROUPS.lock().unwrap().as_ref() {
        for &pgid in set {
            kill_group(pgid, libc::SIGKILL);
        }
    }
}

pub fn kill_group(pgid: i32, signal: i32) {
    if pgid > 1 {
        unsafe {
            libc::kill(-pgid, signal);
        }
    }
}

pub struct Run {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

impl Run {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    /// Exit code as a shell reports it (128 + signal for a killed process).
    pub fn exit_code(&self) -> i32 {
        self.code.unwrap_or_else(|| 128 + self.signal.unwrap_or(9))
    }
}

/// With full access, where the person's own tools keep their state: HOME is
/// the Thread's folder (dx's files for the Thread live there), so rustup,
/// cargo, and gh are pointed back at the person's real ones. SSH finds the
/// real `~/.ssh` by itself (it reads the account's home, not HOME).
pub fn full_access_env(paths: &Paths) -> Vec<(&'static str, PathBuf)> {
    [
        ("RUSTUP_HOME", paths.home.join(".rustup")),
        ("CARGO_HOME", paths.home.join(".cargo")),
        ("GH_CONFIG_DIR", paths.home.join(".config/gh")),
    ]
    .into_iter()
    .filter(|(_, dir)| dir.is_dir())
    .collect()
}

/// Runs `argv` for the Thread at `thread_dir`, in `cwd`, with HOME at
/// `<thread>/home`. `env` adds to or replaces the base environment.
pub fn run_in_thread(
    paths: &Paths,
    thread_dir: &Path,
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    env: &[(String, String)],
    unsandboxed: bool,
) -> Result<Run, String> {
    let home = thread_dir.join("home");
    let tmp = thread_dir.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut cmd = sandbox::command(paths, thread_dir, argv, unsandboxed)?;
    cmd.env_clear()
        .env("PATH", with_tools_last(paths, &command_path(paths)))
        .env("HOME", &home)
        .env("TMPDIR", &tmp)
        .env("LANG", lang())
        .env("TERM", "xterm-256color")
        .env("SHELL", "/bin/bash")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("DX_RUNNER", "1")
        // The runner installs Claude Code once per machine (tools.rs); Core's
        // launch must not install a copy into the Thread's folder.
        .env("DX_RUNNER_TOOLS", "1");
    // Sandboxed, Git reads no system config; with full access it does, as in
    // the person's terminal (Homebrew's Git sets the Keychain helper there).
    if !unsandboxed {
        cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    }
    for key in ["USER", "LOGNAME"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    if unsandboxed {
        cmd.envs(full_access_env(paths));
    }
    for (k, v) in env {
        // Full access: a Git config file the request names but this machine
        // lacks (an Orb's dx-terminal config) would hide the person's own
        // ~/.gitconfig, so Git falls back to it instead.
        if k == "GIT_CONFIG_GLOBAL" && unsandboxed && !Path::new(v).exists() {
            continue;
        }
        if k == "PATH" && unsandboxed {
            // Full access: the person's own tools (gh, Homebrew) win over the
            // ones a request's PATH (an Orb's) names.
            cmd.env(
                k,
                with_tools_last(paths, &host_path_first(&command_path(paths), v)),
            );
        } else if k == "PATH" {
            // A request's own PATH (an Orb's) keeps the runner's shims first
            // and the host's PATH (Homebrew, toolchains) after it.
            cmd.env(
                k,
                with_tools_last(paths, &merge_path(&command_path(paths), v)),
            );
        } else {
            cmd.env(k, v);
        }
    }
    use std::os::unix::process::CommandExt;
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", argv[0]))?;
    let pgid = child.id() as i32;
    track(pgid);
    let (tx, rx) = mpsc::channel();
    for (which, stream) in [
        (
            0u8,
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (1u8, Box::new(child.stderr.take().unwrap())),
    ] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let (bytes, cut) = read_capped(stream);
            let _ = tx.send((which, bytes, cut));
        });
    }
    drop(tx);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if started.elapsed() > timeout {
            timed_out = true;
            kill_group(pgid, libc::SIGTERM);
            std::thread::sleep(Duration::from_millis(250));
            kill_group(pgid, libc::SIGKILL);
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Leave nothing behind: end background processes the command started.
    kill_group(pgid, libc::SIGKILL);
    untrack(pgid);
    let (mut stdout, mut stderr, mut truncated) = (Vec::new(), Vec::new(), false);
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok((0, b, cut)) => {
                stdout = b;
                truncated |= cut;
            }
            Ok((_, b, cut)) => {
                stderr = b;
                truncated |= cut;
            }
            Err(_) => break,
        }
    }
    use std::os::unix::process::ExitStatusExt;
    Ok(Run {
        code: status.and_then(|s| s.code()),
        signal: status.and_then(|s| s.signal()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
        truncated,
    })
}

fn read_capped(mut stream: Box<dyn Read + Send>) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 16384];
    let mut cut = false;
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return (out, cut),
            Ok(n) => {
                let room = OUTPUT_CAP.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
                cut |= n > room;
            }
        }
    }
}
