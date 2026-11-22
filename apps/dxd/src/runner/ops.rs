//! The operations Core sends for a Thread. Shapes and semantics mirror
//! `scripts/local-runtime.mjs`: guest paths under `/home/user` map to the
//! Thread's `home`, symlinks are never traversed. Commands run in `bash -c`
//! with the runner's environment (not a login shell).

use crate::runner::daemon::Daemons;
use crate::runner::exec::run_in_thread;
use crate::runner::{Config, Paths, archive, daemon, set_mode};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const GUEST_HOME: &str = "/home/user";
pub const GUEST_WORKSPACE: &str = "/home/user/workspace/repo";
const MAX_READ_BYTES: u64 = 6 * 1024 * 1024;

/// An operation failure with a code Core can act on.
#[derive(Debug)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        OpError {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("failed", message)
    }
}

impl From<std::io::Error> for OpError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => OpError::new("not-found", e.to_string()),
            std::io::ErrorKind::AlreadyExists => OpError::new("exists", e.to_string()),
            _ => OpError::failed(e.to_string()),
        }
    }
}

impl From<String> for OpError {
    fn from(e: String) -> Self {
        OpError::failed(e)
    }
}

pub type OpResult = Result<Value, OpError>;

/// Everything an operation needs.
pub struct Ctx {
    pub paths: Paths,
    pub config: Config,
    pub daemons: Arc<Daemons>,
    pub desktop: Arc<crate::runner::desktop::Desktop>,
}

/// One Thread's folders on this machine.
#[derive(Clone, Debug)]
pub struct ThreadPaths {
    pub id: String,
    pub root: PathBuf,
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub daemon: PathBuf,
    pub state: PathBuf,
}

/// Core's Thread ids: `thr_` and a UUID.
pub fn valid_thread(id: &str) -> bool {
    let Some(uuid) = id.strip_prefix("thr_") else {
        return false;
    };
    let parts: Vec<&str> = uuid.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(lens)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        && matches!(parts[2].as_bytes()[0], b'1'..=b'5')
        && matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
}

pub fn thread_paths(paths: &Paths, id: &str) -> Result<ThreadPaths, OpError> {
    if !valid_thread(id) {
        return Err(OpError::invalid("invalid Thread id"));
    }
    let root = paths.threads.join(id);
    Ok(ThreadPaths {
        id: id.to_string(),
        home: root.join("home"),
        workspace: root.join("home/workspace/repo"),
        daemon: root.join("daemon"),
        state: root.join("state"),
        root,
    })
}

fn mkdir_private(path: &Path) -> Result<(), OpError> {
    fs::create_dir_all(path)?;
    set_mode(path, 0o700);
    Ok(())
}

/// The Thread folders exist (or `not-found` when `existingOnly`).
fn ensure_folders(
    t: &ThreadPaths,
    existing_only: bool,
    prepare_source: bool,
) -> Result<(), OpError> {
    if existing_only && !t.workspace.exists() {
        return Err(OpError::new(
            "not-found",
            "the Thread has no folder on this machine",
        ));
    }
    mkdir_private(&t.root)?;
    mkdir_private(&t.home)?;
    mkdir_private(&t.root.join("tmp"))?;
    if !prepare_source {
        mkdir_private(&t.workspace)?;
    }
    Ok(())
}

/// A guest path (`/home/user/...`) in the Thread's home. Refuses paths
/// outside `/home/user`, `..` escapes, and any symlink on the way.
pub fn guest_path(t: &ThreadPaths, value: Option<&str>) -> Result<PathBuf, OpError> {
    let source = value.unwrap_or(GUEST_WORKSPACE);
    if source != GUEST_HOME && !source.starts_with(&format!("{GUEST_HOME}/")) {
        return Err(OpError::invalid("paths must be rooted at /home/user"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in source[GUEST_HOME.len()..].split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(OpError::invalid("path escapes the Thread home"));
                }
            }
            p => parts.push(p),
        }
    }
    let mut current = t.home.clone();
    for part in parts {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(OpError::invalid("paths cannot traverse symbolic links"));
            }
            Ok(_) => {}
            Err(_) => {
                // The rest does not exist yet; no symlink can be on it.
            }
        }
    }
    Ok(current)
}

/// `/home/user` in a command or value means the Thread's home.
pub fn translate(t: &ThreadPaths, text: &str) -> String {
    text.replace(GUEST_HOME, &t.home.display().to_string())
}

fn uses_workspace(value: Option<&str>) -> bool {
    value.is_some_and(|v| v == GUEST_WORKSPACE || v.starts_with(&format!("{GUEST_WORKSPACE}/")))
}

pub fn handle(ctx: &Ctx, op: &str, thread: &str, body: &Value) -> OpResult {
    match op {
        "threads" => return Ok(json!({ "threads": list_threads(&ctx.paths) })),
        "ping" => return Ok(json!({ "version": crate::runner::VERSION })),
        // The machine's Desktop: not a Thread's, so no Thread folder.
        "desktop.ensure" => return Ok(ctx.desktop.ensure(&ctx.paths, &ctx.config)),
        "desktop.health" => return Ok(ctx.desktop.health()),
        "desktop.windows" => return Ok(ctx.desktop.windows()),
        "desktop.settings" => return crate::runner::desktop::open_settings(body),
        _ => {}
    }
    let t = thread_paths(&ctx.paths, thread)?;
    let existing_only = body["existingOnly"].as_bool() == Some(true);
    match op {
        "pause" => {
            ctx.daemons.stop(&t);
            daemon::remove_config(&t);
            return Ok(json!({}));
        }
        "destroy" => {
            ctx.daemons.stop(&t);
            if t.root.exists() {
                fs::remove_dir_all(&t.root)?;
            }
            return Ok(json!({}));
        }
        "archive" => return archive::archive(ctx, &t, body),
        "ensure" => return ensure(ctx, &t, body, existing_only),
        _ => {}
    }
    let path = body["path"].as_str();
    let cwd = body["cwd"].as_str();
    let prepare_source = (op == "exec" && cwd.is_some() && !uses_workspace(cwd))
        || (path.is_some() && !uses_workspace(path));
    ensure_folders(&t, existing_only, prepare_source)?;
    match op {
        "exec" => exec(ctx, &t, body),
        "read" => {
            let p = guest_path(&t, path)?;
            let meta = fs::symlink_metadata(&p)?;
            if meta.len() > MAX_READ_BYTES {
                return Err(OpError::invalid("file is larger than 6 MiB"));
            }
            Ok(json!({ "contents": B64.encode(read_nofollow(&p)?) }))
        }
        "write" => {
            let p = guest_path(&t, path)?;
            let mut bytes = B64
                .decode(body["contents"].as_str().unwrap_or_default())
                .map_err(|_| OpError::invalid("contents must be base64"))?;
            // Core's own programs and helpers (`~/.local/libexec`, state)
            // name guest paths inside them; they run here, so their
            // `/home/user` becomes this Thread's home. Files anywhere else,
            // the repository's included, are written byte for byte.
            if path.is_some_and(|p| p.starts_with(&format!("{GUEST_HOME}/.local/")))
                && let Ok(text) = std::str::from_utf8(&bytes)
                && text.contains(GUEST_HOME)
            {
                bytes = translate(&t, text).into_bytes();
            }
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            write_nofollow(&p, &bytes)?;
            Ok(json!({}))
        }
        "stat" => {
            let m = fs::symlink_metadata(guest_path(&t, path)?)?;
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Ok(json!({
                "file": m.is_file(), "directory": m.is_dir(), "symlink": m.file_type().is_symlink(),
                "size": m.len(), "mtimeMs": mtime,
            }))
        }
        "readdir" => {
            let mut names: Vec<String> = fs::read_dir(guest_path(&t, path)?)?
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            Ok(json!({ "entries": names }))
        }
        "mkdir" => {
            let p = guest_path(&t, path)?;
            if body["recursive"].as_bool() == Some(true) {
                fs::create_dir_all(&p)?;
            } else {
                fs::create_dir(&p)?;
            }
            Ok(json!({}))
        }
        "rm" => {
            let p = guest_path(&t, path)?;
            let force = body["force"].as_bool() == Some(true);
            let recursive = body["recursive"].as_bool() == Some(true);
            match fs::symlink_metadata(&p) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && force => {}
                Err(e) => return Err(e.into()),
                Ok(m) if m.is_dir() => {
                    if !recursive {
                        return Err(OpError::invalid("is a directory; pass recursive"));
                    }
                    fs::remove_dir_all(&p)?;
                }
                Ok(_) => fs::remove_file(&p)?,
            }
            Ok(json!({}))
        }
        "snapshot" => Ok(snapshot(&t)),
        "daemon" => ctx.daemons.ensure(ctx, &t, body),
        other => Err(OpError::invalid(format!("unknown operation {other:?}"))),
    }
}

fn ensure(ctx: &Ctx, t: &ThreadPaths, body: &Value, existing_only: bool) -> OpResult {
    let mut restored = false;
    if !t.root.exists()
        && let Some(url) = body["restore"]["url"].as_str()
    {
        archive::restore(ctx, t, url, &body["restore"]["env"])?;
        restored = true;
    }
    let prepare = body["prepareSourceWorkspace"].as_bool() == Some(true);
    ensure_folders(t, existing_only && !restored, prepare)?;
    if ctx.config.unsandboxed {
        link_own_home(&ctx.paths.home, &t.home);
    }
    Ok(json!({ "cwd": GUEST_WORKSPACE, "restored": restored }))
}

/// Names in the Thread's home that dx itself writes (the guest's
/// `/home/user/...`), which stay the Thread's own.
const DX_HOME_ENTRIES: &[&str] = &[
    "workspace",
    ".dx",
    ".local",
    ".agents",
    ".cache",
    ".npm",
    ".config",
    ".netrc",
    ".git-credentials",
    ".bashrc",
    ".bash_profile",
    // Project variables dx writes for the Thread.
    ".env",
    // Claude Code mode's own settings, never the person's.
    ".claude",
    ".claude.json",
];

/// Full access: the Thread's home (HOME for its commands) links to the
/// person's own home folder's entries, so their tools find what they would
/// in their own terminal: `Library` (the Keychain, which gh and git's
/// credential helper use), `~/.ssh`, `~/.gitconfig`, shell profiles, cloud
/// and registry logins. dx's own entries stay the Thread's, and `.config`
/// is the Thread's folder linking each of the person's (`dx` excepted).
/// Links are added, never replaced, so it is safe on every ensure; Files and
/// archives never follow them.
pub fn link_own_home(own: &Path, thread_home: &Path) {
    let link_children = |from: &Path, to: &Path, skip: &[&str]| {
        let Ok(entries) = fs::read_dir(from) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if skip.iter().any(|s| name == *s) {
                continue;
            }
            let target = to.join(&name);
            if fs::symlink_metadata(&target).is_ok() {
                continue;
            }
            let _ = std::os::unix::fs::symlink(entry.path(), &target);
        }
    };
    if own == thread_home || !own.is_dir() {
        return;
    }
    link_children(own, thread_home, DX_HOME_ENTRIES);
    let own_config = own.join(".config");
    if own_config.is_dir() {
        let config = thread_home.join(".config");
        if fs::create_dir_all(&config).is_ok() {
            link_children(&own_config, &config, &["dx"]);
        }
    }
    link_own_claude(own, thread_home, &crate::runner::exec::base_path());
}

/// Claude Code mode runs `$HOME/.local/bin/claude` (Core's
/// claude-code/workspace-run.ts) and installs it there when missing, which on
/// a runner would install a copy into every Thread's folder. With full access
/// the Thread uses the person's own: `~/.local/bin/claude` (where Anthropic's
/// installer puts it), else the first `claude` on the machine's PATH.
fn link_own_claude(own: &Path, thread_home: &Path, host_path: &str) {
    let target = thread_home.join(".local/bin/claude");
    if fs::symlink_metadata(&target).is_ok() {
        return;
    }
    let found = std::iter::once(own.join(".local/bin/claude"))
        .chain(
            host_path
                .split(':')
                .filter(|dir| !dir.is_empty() && !dir.starts_with(&*thread_home.to_string_lossy()))
                .map(|dir| Path::new(dir).join("claude")),
        )
        .find(|candidate| candidate.is_file());
    let Some(claude) = found else {
        return;
    };
    if let Some(bin) = target.parent()
        && fs::create_dir_all(bin).is_ok()
    {
        let _ = std::os::unix::fs::symlink(claude, &target);
    }
}

fn exec(ctx: &Ctx, t: &ThreadPaths, body: &Value) -> OpResult {
    let command = body["command"]
        .as_str()
        .ok_or_else(|| OpError::invalid("exec needs a command"))?;
    if command.is_empty() || command.len() > 2 * 1024 * 1024 {
        return Err(OpError::invalid("invalid command"));
    }
    let cwd = guest_path(t, body["cwd"].as_str())?;
    if !cwd.is_dir() {
        return Err(OpError::new("not-found", "cwd does not exist"));
    }
    let mut env = Vec::new();
    if let Some(map) = body["env"].as_object() {
        for (k, v) in map {
            let valid = !k.is_empty()
                && k.len() <= 64
                && k.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit())
                });
            let Some(v) = v.as_str().filter(|_| valid) else {
                return Err(OpError::invalid("invalid environment"));
            };
            env.push((k.clone(), translate(t, v)));
        }
    }
    let timeout = body["timeoutMs"]
        .as_u64()
        .unwrap_or(120_000)
        .clamp(1, 600_000);
    // Not a login shell: a host's /etc/profile (Debian resets PATH) or the
    // person's own profile would replace the environment the runner set.
    let argv = vec![
        "/bin/bash".to_string(),
        "-c".to_string(),
        translate(t, command),
    ];
    let run = run_in_thread(
        &ctx.paths,
        &t.root,
        &argv,
        &cwd,
        Duration::from_millis(timeout),
        &env,
        ctx.config.unsandboxed,
    )?;
    if run.timed_out {
        return Err(OpError::new("timeout", "command timed out"));
    }
    let mut stderr = run.stderr.clone();
    if run.truncated {
        stderr.push_str("\n[dx runner: output over 4 MiB was cut]\n");
    }
    Ok(json!({ "stdout": run.stdout, "stderr": stderr, "exitCode": run.exit_code() }))
}

fn read_nofollow(p: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(p)?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn write_nofollow(p: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW)
        .open(p)?;
    f.write_all(bytes)
}

/// The workspace context Core reads at activation: instruction files, skills,
/// and the top-level listing (as `local-runtime.mjs` returns).
fn snapshot(t: &ThreadPaths) -> Value {
    let read = |p: &Path| -> Option<String> {
        let m = fs::symlink_metadata(p).ok()?;
        if !m.is_file() || m.len() > 64 * 1024 {
            return None;
        }
        fs::read_to_string(p).ok()
    };
    let mut instructions = serde_json::Map::new();
    for name in ["AGENTS.md", "CLAUDE.md"] {
        if let Some(c) = read(&t.workspace.join(name)) {
            instructions.insert(name.into(), json!(c));
        }
    }
    let mut skills = Vec::new();
    let dir = t.workspace.join(".agents/skills");
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir())
        && let Ok(it) = fs::read_dir(&dir)
    {
        for e in it.flatten().take(256) {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(c) = read(&e.path().join("SKILL.md")) {
                skills.push(json!({ "kind": "file", "directoryName": name, "content": c }));
            }
        }
    }
    let listing: Vec<String> = fs::read_dir(&t.workspace)
        .map(|it| {
            it.flatten()
                .take(256)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    json!({ "instructionFiles": instructions, "skillFiles": skills, "directoryListing": listing })
}

pub fn dir_size(p: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(p) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(p)
        .map(|it| it.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

pub fn thread_ids(paths: &Paths) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(&paths.threads)
        .map(|it| {
            it.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| valid_thread(n))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

pub fn list_threads(paths: &Paths) -> Value {
    json!(
        thread_ids(paths)
            .into_iter()
            .map(|id| json!({ "id": id, "bytes": dir_size(&paths.threads.join(&id)) }))
            .collect::<Vec<_>>()
    )
}

/// Normal path components only (for archive entries).
pub fn plain_relative(p: &str) -> bool {
    !p.is_empty()
        && Path::new(p)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
