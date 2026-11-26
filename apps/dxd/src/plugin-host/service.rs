//! Plugin services: an install's long-running process (decision: milestone
//! M3, `tasks/plugins-next.md` "Service"), supervised here.
//!
//! Core sends `service.ensure` with one install's reviewed spec. dxd lays
//! out its files (the `DXPK1` package, copied to
//! `~/.local/share/dx/services/<installId>/<key>/` because `setup` writes
//! there, or a draft's folder used in place), runs `setup` once per key,
//! then keeps `run` and each listener up in its own session, restarting
//! one that exits (1 s doubling to 60 s, reset after a minute up).
//!
//! dx reaches the service over HTTP on `127.0.0.1:$PORT` (`service.call`);
//! the service reaches dx through one relay per daemon on `$DX_API`, which
//! names the install by the run's `$DX_TOKEN` and forwards each request to
//! Core as `service.request` ([`relay`]). Each line a listener prints
//! becomes `POST /events/<listener>` to the service, sent here.
//!
//! A service does not survive a dxd self-update: its output pipes, tokens,
//! and relay live in this process, so it is stopped before the re-exec and
//! Core ensures it again. After a crash the next daemon stops what the last
//! one left (Linux; see [`supervise::Groups`]).

mod log;
mod relay;
mod supervise;

use super::{allowed_url, hex64, lock, token, truncate};
use crate::proxy::Outbound;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

pub use relay::MAX_SERVICE_FRAME_BYTES;

/// Services per daemon.
pub const MAX_SERVICES: usize = 16;
const MAX_LISTENERS: usize = 8;
const MAX_COMMAND_BYTES: usize = 4096;
const MAX_ENV: usize = 64;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
const MAX_ENV_BYTES: usize = 256 * 1024;
const MAX_CALL_TIMEOUT_MS: u64 = 300_000;
/// Calls into services in flight at once on one Orb; more wait for a turn.
/// Each holds a blocking thread while its service answers, so this keeps a
/// flood from exhausting them, while a workspace's people calling a plugin
/// (its tools, views, or its internet address) never queue behind each other.
const MAX_CONCURRENT_CALLS: usize = 64;
/// The largest reply body dxd reads from a service.
const MAX_CALL_REPLY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 2048;
/// Variables dxd sets itself; a spec may not set them.
const RESERVED_ENV: [&str; 6] = [
    "PORT",
    "DX_API",
    "DX_TOKEN",
    "DX_PLUGIN_NAME",
    "DX_INSTALL_ID",
    supervise::RUN_VARIABLE,
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceSource {
    Package(crate::mcp::PackageRef),
    /// A draft's folder (milestone M2), used in place.
    Folder(String),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListenerSpec {
    pub name: String,
    pub run: String,
}

/// One install's service as Core describes it; `key` digests the rest.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceSpec {
    pub install_id: String,
    pub key: String,
    pub name: String,
    pub source: ServiceSource,
    pub run: String,
    #[serde(default)]
    pub setup: Option<String>,
    /// May hold secrets: never logged.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub listeners: Vec<ListenerSpec>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceState {
    Setup,
    Starting,
    Running,
    Backoff,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastExit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub state: ServiceState,
    /// Absent until the first run picks one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Milliseconds since the epoch when `state` began.
    pub since: u64,
    pub restarts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<LastExit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEntry {
    pub install_id: String,
    pub key: String,
    pub name: String,
    #[serde(flatten)]
    pub status: ServiceStatus,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServiceResult {
    /// `service.ensure`: the install's service now.
    Status(ServiceEntry),
    /// `service.call`: the service's reply; `body` is its JSON, else text.
    Response {
        status: u16,
        body: Value,
    },
    Unavailable {
        reason: &'static str,
        message: String,
    },
    Stopped {
        count: usize,
    },
    Services {
        services: Vec<ServiceEntry>,
    },
    Logs {
        text: String,
    },
}

fn unavailable(reason: &'static str, message: impl Into<String>) -> ServiceResult {
    ServiceResult::Unavailable {
        reason,
        message: truncate(&message.into(), 2048),
    }
}

/// Where services keep their files.
#[derive(Clone)]
pub struct ServicePaths {
    pub home: PathBuf,
    pub user: String,
    /// The plugin host's log directory; logs go in `services/` under it.
    pub log_directory: PathBuf,
}

impl ServicePaths {
    fn share(&self, install_id: &str) -> PathBuf {
        self.home.join(".local/share/dx/services").join(install_id)
    }
    fn logs(&self) -> PathBuf {
        self.log_directory.join("services")
    }
}

fn valid_command(command: &str) -> bool {
    !command.trim().is_empty() && command.len() <= MAX_COMMAND_BYTES && !command.contains('\0')
}

/// Checks the spec and resolves a folder source; the folder must be a
/// directory under the daemon's home.
fn validate(spec: &ServiceSpec, home: &Path) -> Result<Option<PathBuf>, &'static str> {
    if !token(&spec.install_id, 1, 128, b"_-") {
        return Err("The install id is invalid.");
    }
    if !token(&spec.key, 8, 128, b"_-") {
        return Err("The service key is invalid.");
    }
    if !token(&spec.name, 1, 128, b"._-") {
        return Err("The plugin name is invalid.");
    }
    if !valid_command(&spec.run) || spec.setup.as_deref().is_some_and(|s| !valid_command(s)) {
        return Err("The service's commands are invalid.");
    }
    let env_bytes: usize = spec.env.iter().map(|(n, v)| n.len() + v.len()).sum();
    if spec.env.len() > MAX_ENV
        || env_bytes > MAX_ENV_BYTES
        || !spec.env.iter().all(|(name, value)| {
            token(name, 1, 128, b"_")
                && !name.as_bytes()[0].is_ascii_digit()
                && !RESERVED_ENV.contains(&name.as_str())
                && value.len() <= MAX_ENV_VALUE_BYTES
                && !value.contains('\0')
        })
    {
        return Err("The service's environment is invalid.");
    }
    if spec.listeners.len() > MAX_LISTENERS
        || !spec.listeners.iter().enumerate().all(|(index, listener)| {
            token(&listener.name, 1, 64, b"_-")
                && valid_command(&listener.run)
                && spec.listeners[..index]
                    .iter()
                    .all(|other| other.name != listener.name)
        })
    {
        return Err("The service's listeners are invalid.");
    }
    match &spec.source {
        ServiceSource::Package(package) => {
            if !hex64(&package.sha256)
                || !allowed_url(&package.url)
                || package.size > 32 * 1024 * 1024
            {
                return Err("The package is invalid.");
            }
            Ok(None)
        }
        ServiceSource::Folder(folder) => {
            let path = Path::new(folder);
            if folder.len() > 1024 || !path.is_absolute() || folder.contains('\0') {
                return Err("The folder must be an absolute path.");
            }
            let resolved = std::fs::canonicalize(path).map_err(|_| "The folder does not exist.")?;
            let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_owned());
            if !resolved.starts_with(&home) || resolved == home || !resolved.is_dir() {
                return Err("The folder must be a directory in the home folder.");
            }
            Ok(Some(resolved))
        }
    }
}

struct Inner {
    paths: ServicePaths,
    services: Mutex<HashMap<String, Arc<supervise::Instance>>>,
    /// One `service.ensure` or `service.stop` at a time.
    changes: Mutex<()>,
    logs: Mutex<HashMap<String, Arc<log::ServiceLog>>>,
    groups: Arc<supervise::Groups>,
    relay: Arc<relay::Relay>,
    calls: tokio::sync::Semaphore,
}

/// Every plugin service, shared by sessions: services outlive a reconnect.
#[derive(Clone)]
pub struct PluginServices {
    inner: Arc<Inner>,
}

impl PluginServices {
    pub fn new(paths: ServicePaths) -> Self {
        let groups = Arc::new(supervise::Groups::new(paths.logs().join("groups")));
        // What a daemon that crashed left running.
        groups.sweep();
        Self {
            inner: Arc::new(Inner {
                paths,
                services: Mutex::default(),
                changes: Mutex::default(),
                logs: Mutex::default(),
                groups,
                relay: Arc::new(relay::Relay::default()),
                calls: tokio::sync::Semaphore::new(MAX_CONCURRENT_CALLS),
            }),
        }
    }

    /// The session that now carries `service.request` frames to Core.
    pub fn connect(&self, sender: UnboundedSender<Outbound>, generation: &str) {
        self.inner.relay.connect(sender, generation);
    }

    /// The session ended: requests waiting on Core fail as disconnected.
    pub fn disconnect(&self) {
        self.inner.relay.disconnect();
    }

    /// Core's answer to one `service.request`.
    pub fn respond(&self, generation: &str, request_id: &str, status: u16, body: Value) {
        self.inner
            .relay
            .respond(generation, request_id, status, body);
    }

    /// Starts the service when its install runs none, or a different key.
    /// Async only to start the relay on the daemon's runtime; the rest
    /// runs on the blocking pool (stopping an old key waits seconds).
    pub async fn ensure(&self, spec: ServiceSpec) -> ServiceResult {
        let api = match self.inner.relay.start() {
            Ok(port) => format!("http://127.0.0.1:{port}"),
            Err(error) => {
                return unavailable("failed", format!("dx could not start DX_API: {error}"));
            }
        };
        let services = self.clone();
        tokio::task::spawn_blocking(move || services.ensure_blocking(spec, api))
            .await
            .unwrap_or_else(|_| unavailable("failed", "The service did not start."))
    }

    fn ensure_blocking(&self, spec: ServiceSpec, api: String) -> ServiceResult {
        let folder = match validate(&spec, &self.inner.paths.home) {
            Ok(folder) => folder,
            Err(message) => return unavailable("invalid", message),
        };
        let _changes = lock(&self.inner.changes);
        let existing = lock(&self.inner.services).get(&spec.install_id).cloned();
        if let Some(existing) = existing {
            if existing.key == spec.key && existing.status().state != ServiceState::Failed {
                return ServiceResult::Status(existing.entry());
            }
            // Another version, or a failed setup to retry: the old one stops
            // first, so they never share a folder or run side by side.
            lock(&self.inner.services).remove(&spec.install_id);
            self.retire(&existing);
        }
        if lock(&self.inner.services).len() >= MAX_SERVICES {
            return unavailable(
                "limit",
                format!("{MAX_SERVICES} services already run in this Orb."),
            );
        }
        let log = Arc::clone(
            lock(&self.inner.logs)
                .entry(spec.install_id.clone())
                .or_insert_with(|| {
                    Arc::new(log::ServiceLog::new(
                        self.inner
                            .paths
                            .logs()
                            .join(format!("{}.log", spec.install_id)),
                    ))
                }),
        );
        let instance = supervise::Instance::start(supervise::Launch {
            spec,
            folder,
            api,
            paths: self.inner.paths.clone(),
            log,
            groups: Arc::clone(&self.inner.groups),
        });
        self.inner
            .relay
            .allow(&instance.token, &instance.install_id);
        lock(&self.inner.services).insert(instance.install_id.clone(), Arc::clone(&instance));
        ServiceResult::Status(instance.entry())
    }

    fn retire(&self, instance: &supervise::Instance) {
        self.inner.relay.revoke(&instance.token);
        instance.stop();
    }

    /// Stops one install's service, or every one. Blocking: up to two
    /// seconds while their processes exit.
    pub fn stop(&self, install_id: Option<&str>, reason: &str) -> ServiceResult {
        let _changes = lock(&self.inner.changes);
        let stopping: Vec<Arc<supervise::Instance>> = {
            let mut services = lock(&self.inner.services);
            let ids: Vec<String> = services
                .keys()
                .filter(|id| install_id.is_none_or(|wanted| wanted == id.as_str()))
                .cloned()
                .collect();
            ids.iter().filter_map(|id| services.remove(id)).collect()
        };
        for instance in &stopping {
            self.inner.relay.revoke(&instance.token);
        }
        // In parallel: each waits its own grace period.
        std::thread::scope(|scope| {
            for instance in &stopping {
                scope.spawn(|| instance.stop());
            }
        });
        if reason == "uninstalled" {
            for instance in &stopping {
                let _ = std::fs::remove_dir_all(self.inner.paths.share(&instance.install_id));
            }
        }
        if !stopping.is_empty() {
            eprintln!(
                "dxd services: stopped {} ({})",
                stopping.len(),
                reason.chars().take(32).collect::<String>()
            );
        }
        ServiceResult::Stopped {
            count: stopping.len(),
        }
    }

    pub fn status(&self) -> ServiceResult {
        let services = lock(&self.inner.services);
        let mut services: Vec<ServiceEntry> =
            services.values().map(|instance| instance.entry()).collect();
        services.sort_by(|a, b| a.install_id.cmp(&b.install_id));
        ServiceResult::Services { services }
    }

    pub fn logs(&self, install_id: &str, tail: usize) -> ServiceResult {
        if !token(install_id, 1, 128, b"_-") {
            return unavailable("invalid", "The install id is invalid.");
        }
        let path = self.inner.paths.logs().join(format!("{install_id}.log"));
        ServiceResult::Logs {
            text: log::tail(&path, tail.clamp(1, 1000)),
        }
    }

    /// One request to the install's service, once it accepts connections.
    pub async fn call(
        &self,
        install_id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout_ms: u64,
    ) -> ServiceResult {
        let method = method.to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
            || !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > MAX_PATH_BYTES
            || !path
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b'\\')
        {
            return unavailable("invalid", "The call's method or path is invalid.");
        }
        let deadline =
            Instant::now() + Duration::from_millis(timeout_ms.clamp(1, MAX_CALL_TIMEOUT_MS));
        let Some(instance) = lock(&self.inner.services).get(install_id).cloned() else {
            return unavailable("not-running", "The install runs no service here.");
        };
        let port = loop {
            let status = instance.status();
            match status.state {
                ServiceState::Running => break status.port.unwrap_or_default(),
                ServiceState::Failed => {
                    return unavailable(
                        "failed",
                        status
                            .message
                            .unwrap_or_else(|| "The service failed.".into()),
                    );
                }
                ServiceState::Stopped => {
                    return unavailable("not-running", "The service stopped.");
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return unavailable(
                    "timeout",
                    format!("{} did not start in time.", instance.name),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let Ok(_permit) = self.inner.calls.acquire().await else {
            return unavailable("busy", "dx is shutting down.");
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return unavailable("timeout", "The call timed out.");
        }
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || send(port, &method, &path, body, remaining))
            .await
            .unwrap_or_else(|_| unavailable("unreachable", "The call failed."))
    }
}

/// One HTTP exchange with a service on loopback.
fn send(
    port: u16,
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout: Duration,
) -> ServiceResult {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent();
    let mut request = ureq::http::Request::builder()
        .method(method)
        .uri(format!("http://127.0.0.1:{port}{path}"));
    let bytes = match body.filter(|body| !body.is_null()) {
        Some(body) => {
            request = request.header("content-type", "application/json");
            serde_json::to_vec(&body).unwrap_or_default()
        }
        None => Vec::new(),
    };
    let Ok(request) = request.body(bytes) else {
        return unavailable("invalid", "The call's path is invalid.");
    };
    let mut response = match agent.run(request) {
        Ok(response) => response,
        Err(ureq::Error::Timeout(_)) => {
            return unavailable("timeout", "The service did not answer in time.");
        }
        Err(error) => {
            return unavailable(
                "unreachable",
                format!("dx could not reach the service: {error}"),
            );
        }
    };
    let status = response.status().as_u16();
    let bytes = match response
        .body_mut()
        .with_config()
        .limit(MAX_CALL_REPLY_BYTES)
        .read_to_vec()
    {
        Ok(bytes) => bytes,
        Err(ureq::Error::BodyExceedsLimit(_)) => {
            return unavailable("too-large", "The service's reply is larger than 8 MiB.");
        }
        Err(ureq::Error::Timeout(_)) => {
            return unavailable("timeout", "The service did not finish its reply in time.");
        }
        Err(error) => return unavailable("unreachable", format!("The reply broke off: {error}")),
    };
    let body = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    ServiceResult::Response { status, body }
}

impl supervise::Instance {
    fn entry(&self) -> ServiceEntry {
        ServiceEntry {
            install_id: self.install_id.clone(),
            key: self.key.clone(),
            name: self.name.clone(),
            status: self.status(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(source: Value) -> ServiceSpec {
        serde_json::from_value(serde_json::json!({
            "installId": "plg_one",
            "key": "key-00000001",
            "name": "pager",
            "source": source,
            "run": "node server.mjs",
            "env": {"API_KEY": "secret"},
            "listeners": [{"name": "tail", "run": "tail -F x"}],
        }))
        .unwrap()
    }

    // Ways it could fail: a folder outside home (or a symlink out of it),
    // a relative folder, dx's own variables overridden by the spec,
    // listeners sharing a name, or a package from a plain-http host.
    #[test]
    fn specs_stay_inside_home_and_keep_dx_variables() {
        let home = tempfile::tempdir().unwrap();
        let draft = home.path().join("drafts/pager");
        std::fs::create_dir_all(&draft).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("escape")).unwrap();
        let folder = |path: &Path| spec(serde_json::json!({"folder": path}));
        assert_eq!(
            validate(&folder(&draft), home.path()).unwrap(),
            Some(std::fs::canonicalize(&draft).unwrap())
        );
        for bad in [
            outside.path().to_owned(),
            home.path().join("escape"),
            home.path().to_owned(),
            PathBuf::from("drafts/pager"),
            home.path().join("missing"),
        ] {
            assert!(validate(&folder(&bad), home.path()).is_err(), "{bad:?}");
        }
        let package = |url: &str| {
            spec(serde_json::json!({"package": {"url": url, "sha256": "a".repeat(64), "size": 10}}))
        };
        assert!(validate(&package("https://r2.example/pkg"), home.path()).is_ok());
        assert!(validate(&package("http://example.com/pkg"), home.path()).is_err());
        let mut reserved = package("https://r2.example/pkg");
        reserved.env.insert("DX_TOKEN".into(), "forged".into());
        assert!(validate(&reserved, home.path()).is_err());
        let mut twice = package("https://r2.example/pkg");
        twice.listeners.push(twice.listeners[0].clone());
        assert!(validate(&twice, home.path()).is_err());
    }
}
