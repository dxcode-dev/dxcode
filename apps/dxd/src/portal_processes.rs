//! Portal processes: servers someone opened through a Portal without
//! declaring them in `.dx/services.yaml`. When a Portal serves such a port,
//! Core sends `services.remember` and this module records the listening
//! process (its argv, working directory, and environment) in the Orb, mode
//! 0600. If nothing listens there later (after a restart, or on a provider
//! that restores only files), `services.recover` runs it again the way it
//! ran before. Declared services always win: Core tries the manifest first.

use crate::services::{ServicePaths, ServiceState, ServiceStatus};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// At most this many ports are remembered; the oldest is dropped first.
const MAX_REMEMBERED: usize = 16;
const MAX_ARGV_BYTES: usize = 16 * 1024;
const MAX_ENV_BYTES: usize = 256 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const STORE_FILE: &str = "portal-processes.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Remembered {
    argv: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    /// The process this was read from; a new listener is read again.
    pid: u32,
    remembered_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct Store {
    ports: BTreeMap<u16, Remembered>,
}

/// Processes started by `recover`, by port, so a second request while one
/// comes up answers `starting` instead of starting another.
#[derive(Default)]
pub struct PortalProcesses {
    children: HashMap<u16, Child>,
}

impl PortalProcesses {
    /// Record the process listening on `port`; false when none is found.
    pub fn remember(&mut self, port: u16, paths: &ServicePaths) -> bool {
        let Some(pid) = listener_pid(port) else {
            return false;
        };
        let mut store = load(paths);
        if store.ports.get(&port).is_some_and(|entry| entry.pid == pid) {
            return true;
        }
        let Some(snapshot) = snapshot(pid) else {
            return false;
        };
        store.ports.insert(port, snapshot);
        while store.ports.len() > MAX_REMEMBERED {
            let Some(oldest) = store
                .ports
                .iter()
                .min_by_key(|(_, entry)| entry.remembered_at)
                .map(|(port, _)| *port)
            else {
                break;
            };
            store.ports.remove(&oldest);
        }
        save(paths, &store).is_ok()
    }

    /// Run the remembered process for `port` again unless something
    /// listens there. `None` when nothing was remembered for it.
    pub fn recover(
        &mut self,
        port: u16,
        paths: &ServicePaths,
        listening: impl Fn(u16) -> bool,
    ) -> Option<ServiceStatus> {
        self.children
            .retain(|_, child| matches!(child.try_wait(), Ok(None)));
        let entry = load(paths).ports.remove(&port)?;
        let state = if listening(port) {
            ServiceState::Running
        } else if self.children.contains_key(&port) {
            ServiceState::Starting
        } else {
            match start(port, &entry, paths) {
                Ok(child) => {
                    self.children.insert(port, child);
                    ServiceState::Started
                }
                Err(_) => ServiceState::Failed,
            }
        };
        Some(ServiceStatus {
            name: format!("port-{port}"),
            state,
        })
    }
}

fn store_path(paths: &ServicePaths) -> PathBuf {
    paths.log_directory.join(STORE_FILE)
}

fn load(paths: &ServicePaths) -> Store {
    fs::read(store_path(paths))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(paths: &ServicePaths, store: &Store) -> std::io::Result<()> {
    fs::create_dir_all(&paths.log_directory)?;
    let path = store_path(paths);
    let temporary = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(store).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    fs::rename(temporary, path)
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn nul_separated(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

#[cfg(target_os = "linux")]
fn snapshot(pid: u32) -> Option<Remembered> {
    let proc = PathBuf::from(format!("/proc/{pid}"));
    let argv = nul_separated(&fs::read(proc.join("cmdline")).ok()?);
    if argv.is_empty() || argv.iter().map(String::len).sum::<usize>() > MAX_ARGV_BYTES {
        return None;
    }
    let cwd = fs::read_link(proc.join("cwd")).ok()?;
    let mut size = 0;
    let env = nul_separated(&fs::read(proc.join("environ")).unwrap_or_default())
        .into_iter()
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            size += pair.len();
            (size <= MAX_ENV_BYTES && !name.is_empty()).then(|| (name.to_owned(), value.to_owned()))
        })
        .collect();
    Some(Remembered {
        argv,
        cwd: cwd.to_string_lossy().into_owned(),
        env,
        pid,
        remembered_at: now_seconds(),
    })
}

#[cfg(not(target_os = "linux"))]
fn snapshot(_pid: u32) -> Option<Remembered> {
    None
}

/// The process of this daemon's user that listens on `port`.
#[cfg(target_os = "linux")]
fn listener_pid(port: u16) -> Option<u32> {
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let mut inodes = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(table) = fs::read_to_string(path) else {
            continue;
        };
        for line in table.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // sl local rem st queues timer retransmit uid timeout inode
            if fields.len() < 10 || fields[3] != "0A" || fields[7].parse::<u32>().ok() != Some(uid)
            {
                continue;
            }
            let listens = fields[1]
                .rsplit_once(':')
                .and_then(|(_, hex)| u16::from_str_radix(hex, 16).ok())
                == Some(port);
            if listens && fields[9] != "0" {
                inodes.push(format!("socket:[{}]", fields[9]));
            }
        }
    }
    if inodes.is_empty() {
        return None;
    }
    let own = std::process::id();
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own {
            continue;
        }
        let Ok(descriptors) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            if fs::read_link(descriptor.path()).is_ok_and(|target| {
                inodes
                    .iter()
                    .any(|inode| target.as_os_str() == inode.as_str())
            }) {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn listener_pid(_port: u16) -> Option<u32> {
    None
}

fn start(port: u16, entry: &Remembered, paths: &ServicePaths) -> std::io::Result<Child> {
    let cwd = Path::new(&entry.cwd);
    let (program, arguments) = entry
        .argv
        .split_first()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if !cwd.is_dir() {
        return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
    }
    // A relative program path ran from the process's own directory.
    let program = if program.contains('/') && !program.starts_with('/') {
        cwd.join(program)
    } else {
        PathBuf::from(program)
    };
    fs::create_dir_all(&paths.log_directory)?;
    let log_path = paths.log_directory.join(format!("port-{port}.log"));
    if fs::metadata(&log_path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(
            &log_path,
            paths.log_directory.join(format!("port-{port}.log.1")),
        );
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .current_dir(cwd)
        .env_clear()
        .envs(entry.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe and touches no parent state; the
    // process leads its own session so it outlives this daemon.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}
