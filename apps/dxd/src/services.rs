//! Declared services: long-running guest processes (dev servers) that a
//! Portal can start on demand. Core reads and validates the Thread's
//! `.dx/services.yaml` and sends `services.ensure`; this module only starts
//! what is not already serving. A service runs in its own session through a
//! login shell, so it outlives this daemon, and a provider that restores only
//! files (Cloudflare Containers) gets it back on the first request after a
//! wake.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};

// Core's `thread-services/manifest.ts` checks the same bounds, in bytes,
// before it sends `services.ensure`.
pub const MAX_SERVICES: usize = 16;
pub const MAX_SERVICE_NAME_BYTES: usize = 32;
pub const MAX_COMMAND_BYTES: usize = 4096;
pub const MAX_CWD_BYTES: usize = 256;
pub const MAX_CHECKOUT_BYTES: usize = 255;
/// A `.dx/services.yaml` larger than this is not read.
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
pub const MAX_ENV: usize = 64;
pub const MAX_ENV_NAME_BYTES: usize = 128;
pub const MAX_ENV_VALUE_BYTES: usize = 4096;
/// Names the services this daemon started, for the image it re-executes
/// after an update: `name=pid` pairs separated by commas.
pub const HANDOFF_VARIABLE: &str = "DXD_SERVICES_HANDOFF";
const MAX_LOG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceSpec {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub port: u16,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The checkout under `~/workspace/repos` whose `.dx/services.yaml`
    /// declares it; `cwd` is relative to that checkout. None: the primary.
    #[serde(default)]
    pub checkout: Option<String>,
}

impl ServiceSpec {
    /// Names a service across checkouts: `name`, or `checkout:name`. The
    /// handoff's `name=pid` pairs carry it, and neither part holds `=` or `,`
    /// (a checkout name could; such a service is not handed over).
    fn key(&self) -> String {
        match &self.checkout {
            Some(checkout) => format!("{checkout}:{}", self.name),
            None => self.name.clone(),
        }
    }

    pub fn valid(&self) -> bool {
        (1..=MAX_SERVICE_NAME_BYTES).contains(&self.name.len())
            && self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && self.name.as_bytes()[0].is_ascii_alphanumeric()
            && !self.command.trim().is_empty()
            && self.command.len() <= MAX_COMMAND_BYTES
            && !self.command.contains('\0')
            && self.port != 0
            && !crate::proxy::INTERNAL_PORTS.contains(&self.port)
            && self.checkout.as_ref().is_none_or(|checkout| {
                (1..=MAX_CHECKOUT_BYTES).contains(&checkout.len())
                    && !checkout.starts_with('.')
                    && matches!(
                        Path::new(checkout)
                            .components()
                            .collect::<Vec<_>>()
                            .as_slice(),
                        [Component::Normal(_)]
                    )
            })
            && self.cwd.as_ref().is_none_or(|cwd| {
                cwd.len() <= MAX_CWD_BYTES
                    && !cwd.contains('\0')
                    && Path::new(cwd).components().all(|component| {
                        matches!(component, Component::Normal(_) | Component::CurDir)
                    })
            })
            && self.env.len() <= MAX_ENV
            && self.env.iter().all(|(name, value)| {
                (1..=MAX_ENV_NAME_BYTES).contains(&name.len())
                    && !name.as_bytes()[0].is_ascii_digit()
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    && name != "PORT"
                    && value.len() <= MAX_ENV_VALUE_BYTES
                    && !value.contains('\0')
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceState {
    /// Something already listens on the service's port.
    Running,
    /// A process this daemon started is still coming up.
    Starting,
    /// This request started it.
    Started,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ServiceStatus {
    pub name: String,
    pub state: ServiceState,
}

pub struct ServicePaths {
    pub workspace_root: PathBuf,
    pub home: PathBuf,
    pub user: String,
    pub log_directory: PathBuf,
}

/// A process this daemon's image started: its own child, or one an earlier
/// image of this process started and handed over across an update.
enum Tracked {
    Child(Child),
    Adopted(libc::pid_t),
}

impl Tracked {
    fn pid(&self) -> u32 {
        match self {
            Self::Child(child) => child.id(),
            Self::Adopted(pid) => *pid as u32,
        }
    }

    /// Reap the process if it exited; true while it runs.
    fn running(&mut self) -> bool {
        match self {
            Self::Child(child) => matches!(child.try_wait(), Ok(None)),
            Self::Adopted(pid) => {
                let mut status = 0;
                // SAFETY: waitpid on one pid with WNOHANG. exec keeps this
                // process's children, so the pid still names the service
                // until it is reaped here.
                unsafe { libc::waitpid(*pid, &mut status, libc::WNOHANG) == 0 }
            }
        }
    }
}

/// Processes this daemon started, by service name. A process started by an
/// earlier daemon is recognised by its listening port.
#[derive(Default)]
pub struct Services {
    children: HashMap<String, Tracked>,
}

impl Services {
    /// Take back the services an earlier image of this process started.
    pub fn adopt(encoded: &str) -> Self {
        let children = encoded
            .split(',')
            .filter_map(|entry| {
                let (name, pid) = entry.split_once('=')?;
                let pid = pid.parse::<libc::pid_t>().ok().filter(|pid| *pid > 0)?;
                Some((name.to_owned(), Tracked::Adopted(pid)))
            })
            .collect();
        Self { children }
    }

    /// The running services, for the image this process re-executes.
    pub fn handoff(&mut self) -> String {
        self.reap();
        self.children
            .iter()
            .filter(|(name, _)| !name.contains(['=', ',']))
            .map(|(name, tracked)| format!("{name}={}", tracked.pid()))
            .collect::<Vec<_>>()
            .join(",")
    }

    /// Start every valid spec that is not serving. An invalid spec is
    /// `failed`; it never ends the session.
    pub fn ensure(
        &mut self,
        specs: &[ServiceSpec],
        paths: &ServicePaths,
        listening: impl Fn(u16) -> bool,
    ) -> Vec<ServiceStatus> {
        self.reap();
        specs
            .iter()
            .map(|spec| {
                let state = if !spec.valid() {
                    ServiceState::Failed
                } else if listening(spec.port) {
                    ServiceState::Running
                } else if self.children.contains_key(&spec.key()) {
                    ServiceState::Starting
                } else {
                    match start(spec, paths) {
                        Ok(child) => {
                            self.children.insert(spec.key(), Tracked::Child(child));
                            ServiceState::Started
                        }
                        Err(_) => ServiceState::Failed,
                    }
                };
                ServiceStatus {
                    name: spec.name.clone(),
                    state,
                }
            })
            .collect()
    }

    /// Reap services whose process exited, so none stays a zombie and the
    /// next request starts them again.
    pub fn reap(&mut self) {
        self.children.retain(|_, tracked| tracked.running());
    }
}

/// One checkout's `.dx/services.yaml`: the primary's (`checkout` None) or
/// one under `~/workspace/repos`.
#[derive(Debug, Serialize)]
pub struct Manifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
    pub content: String,
}

/// The primary checkout's manifest, then each repository checkout's, for
/// those that have one; Core validates them.
pub fn manifests(workspace_root: &Path) -> Vec<Manifest> {
    let read = |root: &Path| {
        let path = root.join(".dx/services.yaml");
        let metadata = fs::metadata(&path).ok()?;
        (metadata.is_file() && metadata.len() <= MAX_MANIFEST_BYTES)
            .then(|| fs::read_to_string(&path).ok())
            .flatten()
    };
    let mut found = Vec::new();
    if let Some(content) = read(workspace_root) {
        found.push(Manifest {
            checkout: None,
            content,
        });
    }
    let primary = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_owned());
    for checkout in crate::worktrees::repository_checkouts(&primary)
        .into_iter()
        .take(crate::worktrees::MAX_WORKTREES)
    {
        let Some(name) = checkout.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Some(content) = read(&checkout) {
            found.push(Manifest {
                checkout: Some(name.to_owned()),
                content,
            });
        }
    }
    found
}

fn checkout_root(spec: &ServiceSpec, paths: &ServicePaths) -> PathBuf {
    match &spec.checkout {
        Some(checkout) => crate::worktrees::repositories_root(&paths.workspace_root)
            .unwrap_or_else(|| paths.workspace_root.clone())
            .join(checkout),
        None => paths.workspace_root.clone(),
    }
}

fn start(spec: &ServiceSpec, paths: &ServicePaths) -> std::io::Result<Child> {
    let root = checkout_root(spec, paths);
    let cwd = match &spec.cwd {
        Some(cwd) => root.join(cwd),
        None => root,
    };
    if !cwd.is_dir() {
        return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
    }
    fs::create_dir_all(&paths.log_directory)?;
    let log_name = spec.key().replace(':', "--");
    let log_path = paths.log_directory.join(format!("{log_name}.log"));
    if fs::metadata(&log_path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(
            &log_path,
            paths.log_directory.join(format!("{log_name}.log.1")),
        );
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)?;
    let mut environment =
        crate::environment::base_environment_for(&BTreeMap::new(), &paths.home, &paths.user);
    environment.extend(spec.env.clone());
    environment.insert("PORT".into(), spec.port.to_string());
    environment.insert("DX_SERVICE".into(), spec.name.clone());
    let mut command = Command::new("/bin/bash");
    command
        .arg("-lc")
        .arg(&spec.command)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe and touches no parent state; the
    // service leads its own session so it outlives this daemon and never
    // shares a controlling terminal with it.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, cwd: Option<&str>) -> ServiceSpec {
        ServiceSpec {
            name: name.into(),
            command: "true".into(),
            cwd: cwd.map(Into::into),
            port: 3000,
            env: BTreeMap::new(),
            checkout: None,
        }
    }

    #[test]
    fn specs_reject_escapes_reserved_names_and_internal_ports() {
        assert!(spec("web", None).valid());
        assert!(spec("web-2", Some("apps/web")).valid());
        assert!(!spec("Web", None).valid());
        assert!(!spec("-web", None).valid());
        assert!(!spec("web", Some("../outside")).valid());
        assert!(!spec("web", Some("/etc")).valid());
        let mut desktop = spec("web", None);
        desktop.port = crate::proxy::DESKTOP_GATEWAY_PORT;
        assert!(!desktop.valid());
        let mut port = spec("web", None);
        port.env.insert("PORT".into(), "1".into());
        assert!(!port.valid());
    }
}
