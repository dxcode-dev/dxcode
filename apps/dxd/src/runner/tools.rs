//! dx-managed tools: what a runner Thread needs and a bare Mac or a minimal
//! Linux lacks (node, gh, git-lfs, Claude Code), kept once per machine in
//! `~/.dx/runner/tools`, never per Thread.
//!
//! - Pins come from the deployment's `/runner/manifest.json` (`tools`, from
//!   `deploy/runner/tools.json`): per platform an upstream URL, its SHA-256,
//!   and the paths of the tool's commands inside the archive. The last
//!   manifest read is kept in `tools/manifest.json` for an offline start.
//! - A tool is fetched only when one of its commands is missing from the
//!   person's own PATH, on the first activation that needs it or when the
//!   pin changes: downloaded from its own upstream URL, checked against the
//!   SHA-256 (a mismatch is refused), unpacked into a staging folder,
//!   renamed to `tools/<name>/<version>-<sha>`, and `tools/<name>/current`
//!   switched to it with one rename; only then is the previous version
//!   deleted. `tools/bin/<command>` links through `current`.
//! - Commands see `tools/bin` last on PATH, after the person's own PATH, so
//!   their tools always win and dx's fill the gaps.
//! - Claude Code (no pinned archive: Anthropic's installer fetches the
//!   build) installs once per machine with HOME at `tools/claude`, when a
//!   Claude Code launch needs it (`# dx-runner-needs: claude>=<version>` in
//!   the command) and the person has no `claude` of their own.
//! - Git and python3 come only with Apple's Command Line Tools on a Mac (or
//!   the distribution's packages on Linux): never downloaded, reported as
//!   missing prerequisites instead (`missing_prerequisites`).

use crate::runner::{Config, Paths, log, set_mode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
/// How long a fetched manifest is trusted before the next activation reads
/// it again.
const MANIFEST_FRESH: Duration = Duration::from_secs(10 * 60);
const CLAUDE_INSTALLER: &str = "https://claude.ai/install.sh";
const CLAUDE_INSTALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Serializes every install on this machine: two Threads activating at once
/// download a tool once, and the second finds it in place.
static INSTALLS: Mutex<Option<Instant>> = Mutex::new(None);
/// A pin whose download failed, and when: activations in the next ten
/// minutes report the failure without trying again under the lock.
static FAILED: Mutex<Vec<(String, Instant, String)>> = Mutex::new(Vec::new());
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

pub fn dir(paths: &Paths) -> PathBuf {
    paths.runner.join("tools")
}

pub fn bin_dir(paths: &Paths) -> PathBuf {
    dir(paths).join("bin")
}

/// The runner-owned Claude Code: `tools/claude` is its installer's HOME.
pub fn claude(paths: &Paths) -> PathBuf {
    dir(paths).join("claude/.local/bin/claude")
}

/// `macos-aarch64`, `linux-x86_64`, ... (the manifest's platform keys).
fn platform() -> String {
    crate::runner::update::platform()
}

fn sha256_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `command` is an executable file in one of `path`'s folders.
pub fn on_path(path: &str, command: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(command))
        .find(|p| executable(p))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A command and its path inside the archive: a plain relative path.
fn valid_bin(command: &str, path: &str) -> bool {
    !command.is_empty()
        && command.len() <= 32
        && command
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Upstream https (a loopback http server in tests).
fn valid_url(url: &str) -> bool {
    let loopback = ["http://127.0.0.1:", "http://localhost:"]
        .iter()
        .any(|p| url.starts_with(p));
    (url.starts_with("https://") || loopback) && !url.contains(char::is_whitespace)
}

/// One tool's asset for this machine.
#[derive(Debug, Clone)]
struct Asset {
    name: String,
    version: String,
    url: String,
    sha256: String,
    bin: Vec<(String, String)>,
    /// Every Thread needs it (node runs every source action): an activation
    /// without it fails, saying why, instead of later with an internal error.
    required: bool,
}

impl Asset {
    /// `<version>-<first 12 of the SHA-256>`: one folder per pinned build.
    fn folder(&self) -> String {
        format!("{}-{}", self.version, &self.sha256[..12])
    }
}

fn assets(tools: &Value) -> Vec<Asset> {
    let Some(map) = tools.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, tool) in map {
        let entry = &tool["assets"][platform()];
        let (Some(version), Some(url), Some(sha)) = (
            tool["version"].as_str(),
            entry["url"].as_str(),
            entry["sha256"].as_str(),
        ) else {
            continue;
        };
        let valid_name = valid_bin(name, "x");
        let valid_version = !version.is_empty()
            && version.len() <= 32
            && version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'));
        let sha = sha.to_ascii_lowercase();
        let valid_sha = sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit());
        let bin: Vec<(String, String)> = entry["bin"]
            .as_object()
            .map(|b| {
                b.iter()
                    .filter_map(|(c, p)| Some((c.clone(), p.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        if !valid_name
            || !valid_version
            || !valid_sha
            || !valid_url(url)
            || bin.is_empty()
            || !bin.iter().all(|(c, p)| valid_bin(c, p))
        {
            log(&format!("tools: ignoring an invalid {name} entry"));
            continue;
        }
        out.push(Asset {
            name: name.clone(),
            version: version.to_string(),
            url: url.to_string(),
            sha256: sha,
            bin,
            required: tool["required"] == json!(true),
        });
    }
    out
}

/// The manifest's `tools`, fetched at most every ten minutes, else the copy
/// kept from the last fetch.
fn manifest_tools(paths: &Paths, config: &Config, last: &mut Option<Instant>) -> Value {
    let saved = dir(paths).join("manifest.json");
    let fresh = last.is_some_and(|t| t.elapsed() < MANIFEST_FRESH);
    if !fresh {
        match crate::runner::desktop::manifest(config) {
            Ok(Some(manifest)) => {
                let tools = manifest["tools"].clone();
                if fs::create_dir_all(dir(paths)).is_ok() {
                    let _ = fs::write(&saved, tools.to_string());
                }
                *last = Some(Instant::now());
                return tools;
            }
            Ok(None) => *last = Some(Instant::now()),
            Err(e) => log(&format!("tools: {e}")),
        }
    }
    fs::read_to_string(&saved)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

fn current(paths: &Paths, name: &str) -> Option<String> {
    fs::read_link(dir(paths).join(name).join("current"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// What `ensure` did: the status per tool, and why each required tool the
/// machine still lacks could not be fetched.
pub struct Ensured {
    pub report: Value,
    pub required_missing: Vec<String>,
}

/// Every tool the person's own PATH lacks is installed and current. Returns
/// what was done, per tool; a failed optional tool is logged and reported
/// (the command that needs it says so), a failed required one too.
pub fn ensure(paths: &Paths, config: &Config, own_path: &str) -> Ensured {
    let mut last = INSTALLS.lock().unwrap_or_else(|e| e.into_inner());
    let tools = manifest_tools(paths, config, &mut last);
    let mut report = serde_json::Map::new();
    let mut required_missing = Vec::new();
    for asset in assets(&tools) {
        let own = asset
            .bin
            .iter()
            .all(|(command, _)| on_path(own_path, command).is_some());
        let status = if own {
            "own".to_string()
        } else if current(paths, &asset.name).as_deref() == Some(asset.folder().as_str())
            && asset.bin.iter().all(|(_, p)| {
                dir(paths)
                    .join(&asset.name)
                    .join("current")
                    .join(p)
                    .is_file()
            })
        {
            link(paths, &asset);
            "installed".to_string()
        } else {
            let pin = format!("{}@{}", asset.name, asset.sha256);
            let recent = {
                let mut failed = FAILED.lock().unwrap_or_else(|e| e.into_inner());
                failed.retain(|(_, at, _)| at.elapsed() < RETRY_AFTER);
                failed
                    .iter()
                    .find(|(p, _, _)| *p == pin)
                    .map(|(_, _, e)| e.clone())
            };
            let result = match recent {
                Some(e) => Err(format!("{e} (tried in the last ten minutes)")),
                None => install(paths, &asset).inspect_err(|e| {
                    FAILED.lock().unwrap_or_else(|p| p.into_inner()).push((
                        pin.clone(),
                        Instant::now(),
                        e.clone(),
                    ));
                }),
            };
            match result {
                Ok(()) => "downloaded".to_string(),
                Err(e) => {
                    log(&format!("tools: {} {}: {e}", asset.name, asset.version));
                    if asset.required {
                        required_missing.push(format!(
                            "dx could not fetch {} {} for this machine ({e}). Check the machine's network, or install {} yourself, then try again.",
                            asset.name, asset.version, asset.name
                        ));
                    }
                    format!("failed: {e}")
                }
            }
        };
        report.insert(asset.name.clone(), json!(status));
    }
    Ensured {
        report: Value::Object(report),
        required_missing,
    }
}

/// What `ensure` would find, without fetching or installing (`doctor`):
/// `own`, `installed <version>`, or `missing`, per tool the kept manifest
/// lists, and `claude`.
pub fn status(paths: &Paths, own_path: &str) -> Value {
    let tools = fs::read_to_string(dir(paths).join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let mut report = serde_json::Map::new();
    for asset in assets(&tools) {
        let status = if asset
            .bin
            .iter()
            .all(|(c, _)| on_path(own_path, c).is_some())
        {
            "own".to_string()
        } else if let Some(installed) = current(paths, &asset.name) {
            format!("installed {installed}")
        } else {
            "missing (fetched on the first Thread that needs it)".to_string()
        };
        report.insert(asset.name, json!(status));
    }
    let claude_status =
        if on_path(own_path, "claude").is_some() || paths.home.join(".local/bin/claude").exists() {
            "own".to_string()
        } else if claude(paths).exists() {
            "installed".to_string()
        } else {
            "missing (installed on the first Claude Code run)".to_string()
        };
    report.insert("claude".into(), json!(claude_status));
    Value::Object(report)
}

/// Downloads `url` into `to` while hashing it; refuses a SHA-256 mismatch.
fn download(url: &str, sha256: &str, to: &Path) -> Result<(), String> {
    let mut resp = crate::runner::http()
        .get(url)
        .call()
        .map_err(|e| format!("download {url}: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("download {url} answered {}", resp.status()));
    }
    let mut reader = resp
        .body_mut()
        .with_config()
        .limit(MAX_ARCHIVE)
        .reader()
        .take(MAX_ARCHIVE);
    let mut file = fs::File::create(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download {url}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    let got = sha256_hex(&hasher.finalize());
    if got != sha256 {
        let _ = fs::remove_file(to);
        return Err(format!(
            "SHA-256 {got} does not match the pinned {sha256}; refusing it"
        ));
    }
    Ok(())
}

/// Unpacks `archive` into `into` with the system's tar (macOS's bsdtar also
/// reads zip); Linux reads a zip with unzip when it has one.
fn unpack(archive: &Path, url: &str, into: &Path) -> Result<(), String> {
    let zip = url.ends_with(".zip");
    let mut cmd = if zip && !cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("unzip");
        c.arg("-q").arg(archive).arg("-d").arg(into);
        c
    } else {
        let mut c = std::process::Command::new("tar");
        // Files belong to whoever runs the runner: as root, GNU tar would
        // otherwise try to restore the archive's owners and fail.
        c.arg("--no-same-owner")
            .arg("-xf")
            .arg(archive)
            .arg("-C")
            .arg(into);
        c
    };
    let out = cmd
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("unpack: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "unpack: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn install(paths: &Paths, asset: &Asset) -> Result<(), String> {
    let root = dir(paths);
    let tool = root.join(&asset.name);
    fs::create_dir_all(&tool).map_err(|e| e.to_string())?;
    set_mode(&root, 0o755);
    // What an earlier install left when it was cut off (a crash, a reboot):
    // only installs make these, and they run one at a time.
    if let Ok(entries) = fs::read_dir(&tool) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".download-") || name == "current.new" {
                let _ = fs::remove_file(entry.path());
            } else if name.starts_with(".staging-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let tag = format!("{}-{}", std::process::id(), crate::runner::now_ms());
    let archive = tool.join(format!(".download-{tag}"));
    let staging = tool.join(format!(".staging-{tag}"));
    log(&format!(
        "tools: downloading {} {} from {}",
        asset.name, asset.version, asset.url
    ));
    let result = (|| {
        download(&asset.url, &asset.sha256, &archive)?;
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        unpack(&archive, &asset.url, &staging)?;
        for (command, path) in &asset.bin {
            let file = staging.join(path);
            if !file.is_file() {
                return Err(format!("the archive has no {path} for {command}"));
            }
        }
        let folder = tool.join(asset.folder());
        if folder.exists() {
            fs::remove_dir_all(&folder).map_err(|e| e.to_string())?;
        }
        fs::rename(&staging, &folder).map_err(|e| e.to_string())?;
        // One rename switches every command to the new build.
        let next = tool.join("current.new");
        let _ = fs::remove_file(&next);
        std::os::unix::fs::symlink(asset.folder(), &next).map_err(|e| e.to_string())?;
        fs::rename(&next, tool.join("current")).map_err(|e| e.to_string())?;
        link(paths, asset);
        // The new build is in place: earlier ones go.
        if let Ok(entries) = fs::read_dir(&tool) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name != asset.folder() && name != "current" && !name.starts_with('.') {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&staging);
    if result.is_ok() {
        log(&format!(
            "tools: installed {} {}",
            asset.name, asset.version
        ));
    }
    result
}

/// `tools/bin/<command>` links to `../<name>/current/<path>`.
fn link(paths: &Paths, asset: &Asset) {
    let bin = bin_dir(paths);
    if fs::create_dir_all(&bin).is_err() {
        return;
    }
    for (command, path) in &asset.bin {
        let target = PathBuf::from(format!("../{}/current/{path}", asset.name));
        let at = bin.join(command);
        if fs::read_link(&at).ok().as_deref() == Some(target.as_path()) {
            continue;
        }
        let next = bin.join(format!(".{command}.new"));
        let _ = fs::remove_file(&next);
        if std::os::unix::fs::symlink(&target, &next).is_ok() {
            let _ = fs::rename(&next, &at);
        }
    }
}

/// Dotted numeric versions, compared part by part.
fn version_at_least(version: &str, minimum: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (parse(version), parse(minimum));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    true
}

fn claude_version(claude: &Path) -> Option<String> {
    let out = std::process::Command::new(claude)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.split_whitespace().next()?;
    first
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit())
        .then(|| first.to_string())
}

/// The tools a command asks for on a `# dx-runner-needs: <tool>[>=<version>]`
/// line (Core's Claude Code launch names `claude`).
pub fn needs(command: &str) -> Vec<(String, Option<String>)> {
    command
        .lines()
        .filter_map(|line| line.trim().strip_prefix("# dx-runner-needs:"))
        .flat_map(|rest| rest.split_whitespace())
        .map(|need| match need.split_once(">=") {
            Some((name, min)) => (name.to_string(), Some(min.to_string())),
            None => (need.to_string(), None),
        })
        .collect()
}

/// One Claude Code install at a time per machine, in the background: a
/// launch waits for it only as long as Core waits for that launch, and the
/// next launch finds it done (or joins it).
struct ClaudeInstall {
    started: Instant,
    done: Mutex<Option<Result<(), String>>>,
    ready: std::sync::Condvar,
}

static CLAUDE: Mutex<Option<std::sync::Arc<ClaudeInstall>>> = Mutex::new(None);

/// The runner's Claude Code exists and is at least `minimum`, installed
/// with Anthropic's installer (HOME at `tools/claude`) when it is not. Waits
/// until `deadline` at most; the install keeps going after that, and a later
/// launch finds it.
pub fn ensure_claude(
    paths: &Paths,
    path: &str,
    minimum: Option<&str>,
    deadline: Instant,
) -> Result<PathBuf, String> {
    let claude = claude(paths);
    let usable = |c: &Path| {
        claude_version(c).is_some_and(|v| minimum.is_none_or(|m| version_at_least(&v, m)))
    };
    if usable(&claude) {
        return Ok(claude);
    }
    let install = {
        let mut slot = CLAUDE.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some(running) => running.clone(),
            None => {
                let install = std::sync::Arc::new(ClaudeInstall {
                    started: Instant::now(),
                    done: Mutex::new(None),
                    ready: std::sync::Condvar::new(),
                });
                *slot = Some(install.clone());
                let (paths, path, finished) = (paths.clone(), path.to_string(), install.clone());
                std::thread::spawn(move || {
                    let result = run_claude_installer(&paths, &path);
                    *finished.done.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
                    finished.ready.notify_all();
                    *CLAUDE.lock().unwrap_or_else(|e| e.into_inner()) = None;
                });
                install
            }
        }
    };
    let mut done = install.done.lock().unwrap_or_else(|e| e.into_inner());
    while done.is_none() {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "Claude Code is still installing on this machine (for {}s now); it keeps going, so try again in a minute.",
                install.started.elapsed().as_secs()
            ));
        }
        done = install
            .ready
            .wait_timeout(done, deadline - now)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    let result = done.clone().unwrap_or(Ok(()));
    drop(done);
    if usable(&claude) {
        return Ok(claude);
    }
    let log_file = dir(paths).join("claude/install.log");
    Err(match (result, claude.exists(), minimum) {
        (Err(e), _, _) => e,
        (Ok(()), true, Some(m)) => format!(
            "Claude Code on this machine is older than {m} and the update failed (log: {})",
            log_file.display()
        ),
        (Ok(()), _, _) => format!(
            "Claude Code could not be installed on this machine (log: {})",
            log_file.display()
        ),
    })
}

/// Runs Anthropic's installer with HOME, TMPDIR, and Claude Code's
/// credential store all in `tools/claude`, inside the runner's sandbox
/// (Seatbelt, Landlock) with writes limited to that folder, so it reads
/// neither the person's `~/.claude` nor their Keychain login, and writes
/// nothing outside `~/.dx/runner`. A machine whose kernel has no Landlock
/// runs it unconfined, still with that HOME.
fn run_claude_installer(paths: &Paths, path: &str) -> Result<(), String> {
    let home = dir(paths).join("claude");
    let tmp = home.join("tmp");
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let installer = std::env::var("DX_RUNNER_CLAUDE_INSTALLER")
        .ok()
        .filter(|u| valid_url(u))
        .unwrap_or_else(|| CLAUDE_INSTALLER.into());
    log(&format!("tools: installing Claude Code from {installer}"));
    let script = home.join("install.sh");
    let log_file = home.join("install.log");
    // https only, redirects included (a loopback test server is plain http).
    let proto = if installer.starts_with("https://") {
        "--proto '=https' --proto-redir '=https' "
    } else {
        ""
    };
    let (url, file) = (
        shell_quote(&installer),
        shell_quote(&script.to_string_lossy()),
    );
    // Where Anthropic does not serve the machine's network, claude.ai answers
    // with a web page instead of the installer; bash never runs that page.
    let run = format!(
        "curl {proto}-fsSL {url} > {file} || exit 3\n\
         case \"$(tr -d ' \\t\\r\\n' < {file} | head -c 1)\" in '<') echo 'claude.ai answered with a web page instead of the Claude Code installer, as it does where Anthropic does not serve Claude.'; exit 4 ;; esac\n\
         bash {file} latest"
    );
    let attempt = |confined: bool| -> Result<std::process::ExitStatus, String> {
        let argv = vec!["/bin/bash".to_string(), "-c".to_string(), run.clone()];
        let mut cmd = crate::runner::sandbox::command(paths, &home, &argv, !confined)?;
        let out = fs::File::create(&log_file).map_err(|e| e.to_string())?;
        let err = out.try_clone().map_err(|e| e.to_string())?;
        let mut child = cmd
            .env_clear()
            .env("HOME", &home)
            .env("PATH", path)
            .env("LANG", crate::runner::exec::lang())
            .env("TMPDIR", &tmp)
            .env(
                "CLAUDE_SECURESTORAGE_CONFIG_DIR",
                home.join(".claude/dx-plan-only"),
            )
            .current_dir(&home)
            .stdin(std::process::Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .map_err(|e| format!("start the Claude Code installer: {e}"))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) if started.elapsed() > CLAUDE_INSTALL_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "the Claude Code installer took over {}s",
                        CLAUDE_INSTALL_TIMEOUT.as_secs()
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(e) => return Err(e.to_string()),
            }
        }
    };
    let mut status = attempt(true);
    let unconfinable = |s: &Result<std::process::ExitStatus, String>| match s {
        Err(_) => true,
        Ok(st) => {
            st.code() == Some(126)
                && fs::read_to_string(&log_file).is_ok_and(|l| l.contains("dxd runner sandbox:"))
        }
    };
    if unconfinable(&status) && !status.as_ref().is_err_and(|e| e.contains("took over")) {
        log(
            "tools: the sandbox is unavailable here; installing Claude Code unconfined (HOME stays in tools/claude)",
        );
        status = attempt(false);
    }
    let _ = fs::remove_file(&script);
    let _ = fs::remove_dir_all(&tmp);
    let tail: String = fs::read_to_string(&log_file)
        .unwrap_or_default()
        .lines()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ");
    match status {
        Ok(s) if s.success() => {
            log("tools: Claude Code installer finished");
            Ok(())
        }
        Ok(_) => Err(format!(
            "Claude Code could not be installed on this machine (log: {}): {tail}",
            log_file.display()
        )),
        Err(e) => Err(format!(
            "Claude Code could not be installed on this machine: {e} (log: {}): {tail}",
            log_file.display()
        )),
    }
}

/// Apple's Command Line Tools (or Xcode) are installed: `/usr/bin/git` and
/// `/usr/bin/python3` are only stubs that open Apple's installer otherwise.
pub fn command_line_tools() -> bool {
    if !cfg!(target_os = "macos") {
        return true;
    }
    std::process::Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| {
            o.status.success() && Path::new(String::from_utf8_lossy(&o.stdout).trim()).is_dir()
        })
}

pub const PREREQUISITES: [&str; 2] = ["git", "python3"];

/// A usable `tool` on `path`, skipping macOS's `/usr/bin` stubs without
/// the Command Line Tools and any folder in `skip`.
pub fn find_prerequisite(
    path: &str,
    tool: &str,
    clt: bool,
    skip: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(tool))
        .filter(|p| !skip(p))
        .filter(|p| clt || !(cfg!(target_os = "macos") && p.starts_with("/usr/bin")))
        .find(|p| executable(p))
}

/// Git and python3, when this machine has no usable one.
pub fn missing_prerequisites(own_path: &str) -> Vec<&'static str> {
    let clt = command_line_tools();
    PREREQUISITES
        .into_iter()
        .filter(|tool| find_prerequisite(own_path, tool, clt, &|_| false).is_none())
        .collect()
}

/// What to do about a missing prerequisite, in the person's words.
pub fn prerequisite_advice(tool: &str) -> String {
    if cfg!(target_os = "macos") {
        format!(
            "{tool} comes with Apple's Command Line Tools, which this Mac does not have. Install them: run `xcode-select --install` on the Mac (or finish the dialog it opened), then try again."
        )
    } else {
        format!(
            "{tool} is not installed on this machine. Install it with the system's package manager (for example `sudo apt-get install {}`), then try again.",
            if tool == "python3" { "python3" } else { tool }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_needs_lines() {
        assert_eq!(
            needs("set -eu\n# dx-runner-needs: claude>=2.1.3\necho hi"),
            vec![("claude".to_string(), Some("2.1.3".to_string()))]
        );
        assert!(needs("echo '# not a need'").is_empty());
    }

    #[test]
    fn compares_versions() {
        assert!(version_at_least("2.1.10", "2.1.3"));
        assert!(version_at_least("2.1.3", "2.1.3"));
        assert!(!version_at_least("2.0.99", "2.1.0"));
    }

    #[test]
    fn refuses_escaping_paths_and_plain_http() {
        assert!(valid_bin("node", "node-v24/bin/node"));
        assert!(!valid_bin("node", "../node"));
        assert!(!valid_bin("node", "/usr/bin/node"));
        assert!(!valid_bin("Node", "bin/node"));
        assert!(valid_url("https://nodejs.org/dist/x.tar.gz"));
        assert!(valid_url("http://127.0.0.1:9/x.tar.gz"));
        assert!(!valid_url("http://example.com/x.tar.gz"));
    }
}
