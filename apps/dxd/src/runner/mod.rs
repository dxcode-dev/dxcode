//! `dxd runner`: runs dx Threads on a person's own Mac or Linux machine.
//! The same binary is the supervisor (one per machine) and each Thread's
//! dxd (one per active Thread, `dxd --config <thread>/daemon/config.json`).
//!
//! - Dials out to Core over one WebSocket (`/v1/runner/connect`); opens no port.
//! - Keeps each Thread in `~/.dx/threads/<thread>/` (guest `/home/user` is
//!   `<thread>/home`) and touches nothing else but `~/.dx/runner` and, when
//!   asked to, its LaunchAgent or systemd user unit.
//! - Runs every command and every per-Thread dxd inside the sandbox
//!   (Seatbelt on macOS, Landlock on Linux), with a clean environment.
//! - Never runs `.agents/setup` or installs tools: it uses what the machine has.
//! - On a Mac, runs one voxl for the owner's Desktop outside every sandbox,
//!   reached only through the supervisor (`desktop.rs`).

mod archive;
mod daemon;
pub mod desktop;
mod exec;
mod ops;
pub mod sandbox;
mod service;
mod session;
pub mod shims;
mod update;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const VERSION: &str = crate::RELEASE;
pub const MARKER: &str = ".dx-runner-owned";
const MARKER_TEXT: &str = "created by the dx runner; `dxd runner uninstall` deletes this folder\n";

/// Where the runner keeps its own files and the Threads.
#[derive(Clone, Debug)]
pub struct Paths {
    pub home: PathBuf,
    pub root: PathBuf,
    pub runner: PathBuf,
    pub threads: PathBuf,
    pub bin: PathBuf,
}

impl Paths {
    pub fn new(root: Option<String>) -> Result<Self, String> {
        let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME is not set")?);
        let root = match root.or_else(|| std::env::var("DX_RUNNER_ROOT").ok()) {
            Some(r) => PathBuf::from(r),
            None => home.join(".dx"),
        };
        if !root.is_absolute() {
            return Err("--root must be an absolute path".into());
        }
        let runner = root.join("runner");
        Ok(Paths {
            bin: runner.join("bin"),
            threads: root.join("threads"),
            runner,
            home,
            root,
        })
    }

    pub fn config(&self) -> PathBuf {
        self.runner.join("config.json")
    }

    pub fn log(&self) -> PathBuf {
        self.runner.join("runner.log")
    }
}

/// `~/.dx/runner/config.json`, mode 0600.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server: String,
    pub machine_id: String,
    pub token: String,
    #[serde(default)]
    pub name: String,
    /// Full access: Thread commands run as the person, like an agent in
    /// their own terminal (the default since pairing takes `--sandbox` to
    /// confine them; configs written before that default stay confined).
    #[serde(default)]
    pub unsandboxed: bool,
    /// The PATH commands see (captured from the shell that paired).
    #[serde(default)]
    pub path: Option<String>,
}

impl Config {
    pub fn load(paths: &Paths) -> Result<Self, String> {
        let text = fs::read_to_string(paths.config())
            .map_err(|_| "not paired; run `dx-runner pair` first")?;
        serde_json::from_str(&text).map_err(|e| format!("config: {e}"))
    }

    pub fn save(&self, paths: &Paths) -> Result<(), String> {
        write_private(
            &paths.config(),
            &serde_json::to_string_pretty(self).unwrap(),
        )
    }

    /// The WebSocket URL for this server.
    pub fn connect_url(&self) -> String {
        let ws = if let Some(rest) = self.server.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.server.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.server.clone()
        };
        format!("{ws}/v1/runner/connect")
    }

    /// Resolves a Core URL (absolute or `/path`) and refuses any other origin,
    /// so the runner token is never sent elsewhere.
    pub fn same_origin(&self, url: &str) -> Result<String, String> {
        let absolute = if url.starts_with('/') && !url.starts_with("//") {
            format!("{}{url}", self.server)
        } else {
            url.to_string()
        };
        let prefix = format!("{}/", self.server);
        if absolute.starts_with(&prefix) && !absolute[prefix.len()..].contains("..") {
            Ok(absolute)
        } else {
            Err(format!("refusing a URL outside {}", self.server))
        }
    }
}

pub fn valid_server(server: &str) -> Result<String, String> {
    let server = server.trim_end_matches('/').to_string();
    let loopback = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| server == *p || server.starts_with(&format!("{p}:")));
    let rest = server.strip_prefix("https://").unwrap_or("");
    if loopback || (!rest.is_empty() && !rest.contains('/') && !rest.contains('@')) {
        Ok(server)
    } else {
        Err("--server must be an https:// origin (or http://127.0.0.1 for tests)".into())
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn log(line: &str) {
    let text = format!("{} {line}", now_ms());
    eprintln!("{text}");
    if let Some(path) = LOG.lock().unwrap().as_ref()
        && let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(f, "{text}");
    }
}

pub fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

pub fn write_private(path: &Path, text: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Creates `dir` with the ownership marker, or accepts it when it has one.
pub fn ensure_owned_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        if !dir.join(MARKER).exists() {
            return Err(format!(
                "{} exists and was not created by the dx runner; pick another --root",
                dir.display()
            ));
        }
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    set_mode(dir, 0o700);
    fs::write(dir.join(MARKER), MARKER_TEXT).map_err(|e| e.to_string())
}

pub fn start_logging(paths: &Paths) -> Result<(), String> {
    ensure_owned_dir(&paths.runner)?;
    *LOG.lock().unwrap() = Some(paths.log());
    Ok(())
}

pub fn http() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(600)))
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    let name = if ok {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };
    let name = name.trim_end_matches(".local").to_string();
    if name.is_empty() {
        "my-machine".into()
    } else {
        name
    }
}

fn usage() -> ! {
    eprintln!(
        "dxd runner {VERSION}: run dx Threads on this machine

  dxd runner pair --server URL --code CODE [--name NAME] [--sandbox]
                                 --sandbox confines Thread commands to their
                                 folder (for a shared machine); by default they
                                 run as you, with your tools and keys
  dxd runner run                 connect to dx and serve Threads (Ctrl-C stops)
  dxd runner install-service     start at login (macOS LaunchAgent, Linux systemd --user)
  dxd runner uninstall-service
  dxd runner doctor              self-test (and the sandbox's, with --sandbox)
  dxd runner status              pairing, Threads, disk use
  dxd runner uninstall           remove the service, ~/.dx/runner and ~/.dx/threads
  dxd runner version

  --root DIR   use DIR instead of ~/.dx (absolute path)"
    );
    std::process::exit(2)
}

/// `dxd runner <command> ...` (arguments after `runner`).
pub fn cli(arguments: &[String]) -> ! {
    let mut args: Vec<String> = arguments.to_vec();
    let mut root = None;
    if let Some(i) = args.iter().position(|a| a == "--root") {
        if i + 1 >= args.len() {
            usage();
        }
        root = Some(args.remove(i + 1));
        args.remove(i);
    }
    let paths = match Paths::new(root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1)
        }
    };
    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let has = |name: &str| args.iter().any(|a| a == name);
    let command = args.first().cloned().unwrap_or_default();
    if command != "version" && command != "uninstall" {
        update::handoff(&paths);
    }
    let result = match command.as_str() {
        "version" => {
            println!("{VERSION}");
            Ok(())
        }
        "pair" => match (flag("--server"), flag("--code")) {
            // Full access unless the person asks for the sandbox; `--unsandboxed`
            // (the earlier opt-out) still means full access.
            (Some(s), Some(c)) => pair(&paths, &s, &c, flag("--name"), !has("--sandbox")),
            _ => usage(),
        },
        "run" => session::run(paths.clone()),
        "doctor" => doctor(&paths),
        "status" => status(&paths),
        "install-service" => service::install(&paths),
        "uninstall-service" => service::uninstall(&paths),
        "uninstall" => uninstall(&paths),
        _ => usage(),
    };
    match result {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1)
        }
    }
}

fn pair(
    paths: &Paths,
    server: &str,
    code: &str,
    name: Option<String>,
    unsandboxed: bool,
) -> Result<(), String> {
    let server = valid_server(server)?;
    start_logging(paths)?;
    ensure_owned_dir(&paths.threads)?;
    let name = name.unwrap_or_else(hostname);
    let mut resp = http()
        .post(&format!("{server}/v1/runner/pair"))
        .send_json(serde_json::json!({
            "code": code.trim().to_uppercase(),
            "name": name,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        }))
        .map_err(|e| format!("pairing request failed: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.body_mut().read_json().unwrap_or_default();
    let (Some(machine_id), Some(token)) = (body["machineId"].as_str(), body["token"].as_str())
    else {
        return Err(format!("pairing refused ({status}): {body}"));
    };
    let config = Config {
        server,
        machine_id: machine_id.into(),
        token: token.into(),
        name: name.clone(),
        unsandboxed,
        path: std::env::var("PATH").ok(),
    };
    config.save(paths)?;
    log(&format!(
        "paired with {} as {name} ({machine_id})",
        config.server
    ));
    println!(
        "paired as {name}; config at {} (mode 0600)",
        paths.config().display()
    );
    Ok(())
}

fn doctor(paths: &Paths) -> Result<(), String> {
    start_logging(paths)?;
    ensure_owned_dir(&paths.threads)?;
    let unsandboxed = Config::load(paths).map(|c| c.unsandboxed).unwrap_or(false);
    let report = sandbox::self_test(paths, unsandboxed)?;
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if report["ok"] == serde_json::json!(true) {
        println!("\nOK: the dx runner can run Threads on this machine");
        Ok(())
    } else {
        Err("sandbox self-test failed; `run` will refuse to start".into())
    }
}

fn status(paths: &Paths) -> Result<(), String> {
    println!("version:  {VERSION}");
    println!("root:     {}", paths.root.display());
    match Config::load(paths) {
        Ok(c) => println!("paired:   {} as {} ({})", c.server, c.name, c.machine_id),
        Err(_) => println!("paired:   no"),
    }
    println!("service:  {}", service::describe(paths));
    println!(
        "threads:  {}",
        serde_json::to_string_pretty(&ops::list_threads(paths)).unwrap()
    );
    Ok(())
}

/// Stops a `dxd runner run` still going outside the login service (one
/// started with `--no-service`), from the pid it recorded: SIGTERM, then
/// SIGKILL after five seconds. Only a process whose command line is a
/// `dxd runner run` is signalled.
fn stop_foreground_runner(paths: &Paths) {
    let Ok(text) = fs::read_to_string(paths.runner.join("run.pid")) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<i32>() else {
        return;
    };
    if pid <= 1 || pid == std::process::id() as i32 {
        return;
    }
    let command = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if !command.contains("dxd") || !command.contains("runner") || !command.contains("run") {
        return;
    }
    let alive = || unsafe { libc::kill(pid, 0) } == 0;
    unsafe { libc::kill(pid, libc::SIGTERM) };
    for _ in 0..50 {
        if !alive() {
            println!("stopped the running dx runner (pid {pid})");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe { libc::kill(pid, libc::SIGKILL) };
    println!("killed the running dx runner (pid {pid})");
}

fn uninstall(paths: &Paths) -> Result<(), String> {
    let _ = service::uninstall(paths);
    stop_foreground_runner(paths);
    daemon::stop_all_recorded(paths);
    for dir in [&paths.threads, &paths.runner] {
        if !dir.exists() {
            continue;
        }
        if !dir.join(MARKER).exists() {
            return Err(format!(
                "{} has no {MARKER}; not deleting it",
                dir.display()
            ));
        }
        fs::remove_dir_all(dir).map_err(|e| format!("delete {}: {e}", dir.display()))?;
        println!("deleted {}", dir.display());
    }
    if fs::remove_dir(&paths.root).is_ok() {
        println!("deleted {}", paths.root.display());
    }
    println!("the dx runner is removed from this machine; remove it in dx Settings › Runners too");
    Ok(())
}
