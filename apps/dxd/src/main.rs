mod changes;
mod environment;
mod files;
mod observer;
mod protocol;
mod terminal;
mod workload_identity;
mod worktrees;

use changes::{CandidateOutcome, ChangesScheduler, RefreshRequest};
use environment::EnvironmentRuntime;
use files::FilesOperation;
use protocol::{
    Capabilities, ClientMessage, EnvironmentOperation, OperationResult, RequestOperation,
    ServerMessage, WorkloadIdentityResult,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use terminal::{TerminalOutbound, TerminalRuntime};
use tungstenite::client::{IntoClientRequest, connect_with_config};
use tungstenite::http::header::AUTHORIZATION;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};
use url::Url;

const RELEASE: &str = "0.7.5";
const PROTOCOL_MAJOR: u8 = 1;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_LEASE: Duration = Duration::from_secs(15);
const STATE_DIR: &str = "/home/user/.local/state/dxd";
const CONFIG_PATH: &str = "/home/user/.local/state/dxd/config.json";
const HEALTH_PATH: &str = "/home/user/.local/state/dxd/health.sock";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_CHANGES_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES: usize = 4 * 1024;
const MAX_REQUEST_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENVIRONMENT_REQUEST_FRAME_BYTES: usize = 14 * 1024 * 1024;
const MAX_CLIENT_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKLOAD_IDENTITY_FRAME_BYTES: usize = 80 * 1024;
const MAX_CONCURRENT_WORKLOAD_IDENTITY_REQUESTS: usize = 32;
const WORKLOAD_IDENTITY_REQUEST_LEASE: Duration = Duration::from_secs(10);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    version: u8,
    endpoint: String,
    thread_id: String,
    generation: String,
    api_key: String,
    release: String,
    protocol_major: u8,
    workspace_root: String,
    local_runtime: Option<LocalRuntime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalRuntime {
    home_directory: String,
    state_directory: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health<'a> {
    release: &'static str,
    protocol_major: u8,
    generation: &'a str,
    connected: bool,
}

#[derive(Debug)]
enum SessionExit {
    Usage,
    Command,
    Config(io::Error),
    Workspace(io::Error),
    StateDirectory(io::Error),
    Health(io::Error),
    WorkloadIdentitySocket,
    WorkloadIdentity(io::Error),
    Endpoint(&'static str),
    Connect(tungstenite::Error),
    SocketTimeout(io::Error),
    Socket(tungstenite::Error),
    Encode(serde_json::Error),
    Protocol(&'static str),
    HeartbeatLease,
    Terminal(io::Error),
    Files(&'static str),
    Closed,
}

impl std::fmt::Display for SessionExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage => write!(f, "usage: dxd [--config <absolute path>]"),
            Self::Command => write!(f, "command failed"),
            Self::Config(e) => write!(f, "config: {e}"),
            Self::Workspace(e) => write!(f, "workspace root: {e}"),
            Self::StateDirectory(e) => write!(f, "state directory: {e}"),
            Self::Health(e) => write!(f, "health socket: {e}"),
            Self::WorkloadIdentitySocket => {
                write!(f, "DX_WORKLOAD_IDENTITY_SOCKET must be an absolute path")
            }
            Self::WorkloadIdentity(e) => write!(f, "workload identity socket: {e}"),
            Self::Endpoint(reason) => write!(f, "endpoint: {reason}"),
            Self::Connect(e) => write!(f, "connect: {e}"),
            Self::SocketTimeout(e) => write!(f, "socket timeout: {e}"),
            Self::Socket(e) => write!(f, "socket: {e}"),
            Self::Encode(e) => write!(f, "encode: {e}"),
            Self::Protocol(reason) => write!(f, "protocol: {reason}"),
            Self::HeartbeatLease => write!(f, "heartbeat lease expired"),
            Self::Terminal(e) => write!(f, "terminal: {e}"),
            Self::Files(reason) => write!(f, "files: {reason}"),
            Self::Closed => write!(f, "connection closed"),
        }
    }
}

fn main() {
    if let Err(exit) = run() {
        eprintln!("dxd stopped: {exit}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), SessionExit> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "id-token")
    {
        return workload_identity::print_token(&arguments).map_err(|()| SessionExit::Command);
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "gcp-credential")
    {
        return workload_identity::print_gcp_credential(&arguments)
            .map_err(|()| SessionExit::Command);
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "git-sign")
    {
        return workload_identity::git_sign(&arguments).map_err(|()| SessionExit::Command);
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "git-credential")
    {
        return workload_identity::git_credential(&arguments).map_err(|()| SessionExit::Command);
    }
    let config_path = match arguments.as_slice() {
        [] => CONFIG_PATH,
        [flag, path] if flag == "--config" && Path::new(path).is_absolute() => path,
        _ => return Err(SessionExit::Usage),
    };
    unsafe { libc::umask(0o077) };
    let config = load_config(Path::new(&config_path)).map_err(SessionExit::Config)?;
    let workspace = open_workspace(&config).map_err(SessionExit::Workspace)?;
    let connected = Arc::new(AtomicBool::new(false));
    let (state_directory, mut terminal, mut environment) = match &config.local_runtime {
        Some(local) => {
            let state = PathBuf::from(&local.state_directory);
            fs::create_dir_all(&state).map_err(SessionExit::StateDirectory)?;
            fs::set_permissions(&state, fs::Permissions::from_mode(0o700))
                .map_err(SessionExit::StateDirectory)?;
            (
                state.clone(),
                TerminalRuntime::local(
                    PathBuf::from(&config.workspace_root),
                    config.thread_id.as_str(),
                    PathBuf::from(&local.home_directory),
                    state.clone(),
                ),
                EnvironmentRuntime::local(PathBuf::from(&local.home_directory), state),
            )
        }
        None => (
            PathBuf::from(STATE_DIR),
            TerminalRuntime::new(
                PathBuf::from(&config.workspace_root),
                config.thread_id.as_str(),
            ),
            EnvironmentRuntime::new(),
        ),
    };
    start_health(&config, &state_directory, Arc::clone(&connected)).map_err(SessionExit::Health)?;
    let workload_identity_epoch = Arc::new(AtomicU64::new(0));
    let workload_identity_socket = match &config.local_runtime {
        Some(_) => std::env::var("DX_WORKLOAD_IDENTITY_SOCKET")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or(SessionExit::WorkloadIdentitySocket)?,
        None => state_directory.join(workload_identity::SOCKET_NAME),
    };
    let workload_identity = workload_identity::start(
        &workload_identity_socket,
        Arc::clone(&connected),
        Arc::clone(&workload_identity_epoch),
    )
    .map_err(SessionExit::WorkloadIdentity)?;
    let observer = observer::Observer::start(Path::new(&config.workspace_root));
    eprintln!("dxd started");

    let mut delay = INITIAL_RECONNECT_DELAY;
    loop {
        let mut healthy_since = None;
        match session(
            &config,
            &connected,
            &workspace,
            &mut terminal,
            &mut environment,
            &mut healthy_since,
            &workload_identity,
            &workload_identity_epoch,
            &observer,
        ) {
            Ok(()) => eprintln!("dxd reconnecting"),
            Err(exit) => eprintln!("dxd reconnecting: {exit}"),
        }
        connected.store(false, Ordering::Release);
        delay = reconnect_delay(delay, healthy_since.map(|since| since.elapsed()));
        let jitter = rand::rng().random_range(0..=delay.as_millis() as u64 / 2);
        thread::sleep(delay + Duration::from_millis(jitter));
        delay = (delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

fn reconnect_delay(current: Duration, healthy_for: Option<Duration>) -> Duration {
    if healthy_for.is_some_and(|duration| duration >= HEARTBEAT_LEASE) {
        INITIAL_RECONNECT_DELAY
    } else {
        current
    }
}

fn load_config(path: &Path) -> io::Result<Config> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData)?;
    validate(&config)?;
    Ok(config)
}

fn validate(c: &Config) -> io::Result<()> {
    let token = |s: &str, min, max| {
        s.len() >= min
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let endpoint = Url::parse(&c.endpoint).map_err(|_| io::ErrorKind::InvalidData)?;
    let root = Path::new(&c.workspace_root);
    let api_key_valid = c.api_key.starts_with("dxd_")
        && c.api_key.len() <= 1024
        && c.api_key.len() >= 20
        && c.api_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'));
    let valid = c.version == 1
        && c.release == RELEASE
        && c.protocol_major == PROTOCOL_MAJOR
        && token(&c.generation, 1, 64)
        && api_key_valid
        && token(&c.thread_id, 1, 128)
        && c.endpoint.len() <= 4096
        && matches!(endpoint.scheme(), "ws" | "wss")
        && endpoint.host().is_some()
        && root.is_absolute()
        && c.workspace_root.len() <= 4096
        && c.local_runtime.as_ref().is_none_or(|local| {
            let home = Path::new(&local.home_directory);
            let state = Path::new(&local.state_directory);
            home.is_absolute()
                && state.is_absolute()
                && local.home_directory.len() <= 4096
                && local.state_directory.len() <= 4096
                && root.starts_with(home)
                && state.starts_with(home.parent().unwrap_or(home))
        });
    if valid {
        Ok(())
    } else {
        Err(io::ErrorKind::InvalidData.into())
    }
}

fn open_workspace(c: &Config) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&c.workspace_root)
}

fn start_health(
    config: &Config,
    state_directory: &Path,
    connected: Arc<AtomicBool>,
) -> io::Result<()> {
    if config.local_runtime.is_some() {
        return Ok(());
    }
    fs::create_dir_all(state_directory)?;
    fs::set_permissions(state_directory, fs::Permissions::from_mode(0o700))?;
    let health_path = PathBuf::from(HEALTH_PATH);
    match fs::symlink_metadata(&health_path) {
        Ok(m) if m.file_type().is_socket() => fs::remove_file(&health_path)?,
        Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(&health_path)?;
    fs::set_permissions(&health_path, fs::Permissions::from_mode(0o600))?;
    let release = RELEASE;
    let protocol_major = PROTOCOL_MAJOR;
    let generation = config.generation.clone();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let is_connected = connected.load(Ordering::Acquire);
            let body = match health_json(release, protocol_major, &generation, is_connected) {
                Ok(body) => body,
                Err(_) => continue,
            };
            let status = if is_connected {
                "200 OK"
            } else {
                "503 Service Unavailable"
            };
            let mut response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
            )
            .into_bytes();
            response.extend_from_slice(&body);
            let _ = stream.write_all(&response);
        }
    });
    Ok(())
}

fn health_json(
    release: &'static str,
    protocol_major: u8,
    generation: &str,
    connected: bool,
) -> io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(&Health {
        release,
        protocol_major,
        generation,
        connected,
    })
    .map_err(|_| io::ErrorKind::InvalidData)?;
    if bytes.len() > 8192 {
        Err(io::ErrorKind::InvalidData.into())
    } else {
        Ok(bytes)
    }
}

fn session(
    config: &Config,
    connected: &AtomicBool,
    workspace: &File,
    terminal: &mut TerminalRuntime,
    environment: &mut EnvironmentRuntime,
    healthy_since: &mut Option<Instant>,
    workload_identity: &workload_identity::Relay,
    workload_identity_epoch: &AtomicU64,
    observer: &observer::Observer,
) -> Result<(), SessionExit> {
    connected.store(false, Ordering::Release);
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| SessionExit::Endpoint("invalid websocket request"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|_| SessionExit::Endpoint("invalid authorization header"))?,
    );
    let websocket_config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_ENVIRONMENT_REQUEST_FRAME_BYTES));
    let (mut socket, _) =
        connect_with_config(request, Some(websocket_config), 3).map_err(SessionExit::Connect)?;
    set_timeout(&mut socket, Some(Duration::from_millis(100)))
        .map_err(SessionExit::SocketTimeout)?;
    send_json(
        &mut socket,
        &ClientMessage::Register {
            generation: &config.generation,
            protocol_major: PROTOCOL_MAJOR,
            release: RELEASE,
            capabilities: Capabilities::current(),
        },
    )?;
    let registered = read_server(&mut socket)?;
    match registered {
        ServerMessage::Registered {
            generation,
            heartbeat_interval_ms: 2000,
            heartbeat_lease_ms: 15000,
        } if generation == config.generation => {}
        _ => return Err(SessionExit::Protocol("unexpected registration response")),
    }
    let session_epoch = workload_identity_epoch.fetch_add(1, Ordering::AcqRel) + 1;
    connected.store(true, Ordering::Release);
    *healthy_since = Some(Instant::now());
    send_json(
        &mut socket,
        &ClientMessage::Heartbeat {
            generation: &config.generation,
            terminal: terminal.heartbeat(),
        },
    )?;
    send_json(&mut socket, &ClientMessage::ChangesDirty)?;
    let (changes_worker, changes_results) =
        changes::start_worker(Path::new(&config.workspace_root));
    let (files_worker, files_results) =
        files::start_worker(workspace, Path::new(&config.workspace_root))
            .map_err(|_| SessionExit::Files("worker failed to start"))?;
    let mut changes_scheduler = ChangesScheduler::new();
    let mut pending_file_refreshes = HashMap::new();
    let mut pending_workload_identity = PendingWorkloadIdentity::default();
    let mut last_activity = Instant::now();
    let mut next_heartbeat = Instant::now() + HEARTBEAT_INTERVAL;
    loop {
        if last_activity.elapsed() >= HEARTBEAT_LEASE {
            return Err(SessionExit::HeartbeatLease);
        }
        while let Some(completed) = files::next_completed(&files_results) {
            let refresh = pending_file_refreshes
                .remove(&completed.request_id)
                .flatten();
            let saved = matches!(&completed.result, files::FilesResult::Saved { .. });
            send_json(
                &mut socket,
                &ClientMessage::Response {
                    generation: &config.generation,
                    request_id: &completed.request_id,
                    result: OperationResult::Files(completed.result),
                },
            )?;
            if saved {
                if let Some(refresh) = refresh {
                    changes_scheduler.enqueue(refresh, Instant::now());
                }
            }
            last_activity = Instant::now();
        }
        if Instant::now() >= next_heartbeat {
            send_json(
                &mut socket,
                &ClientMessage::Heartbeat {
                    generation: &config.generation,
                    terminal: terminal.heartbeat(),
                },
            )?;
            next_heartbeat = Instant::now() + HEARTBEAT_INTERVAL;
        }
        while let Some(completed) = changes::next_completed(&changes_results) {
            let retry = completed.request.clone();
            if changes_scheduler.complete(&completed) {
                send_changes_candidate(&mut socket, &completed.request.token, &completed.outcome)?;
                if matches!(completed.outcome, CandidateOutcome::Raced) {
                    changes_scheduler.enqueue(retry, Instant::now());
                }
            }
        }
        changes_scheduler.start_ready(Instant::now(), &changes_worker);
        if observer.take_dirty() {
            send_json(&mut socket, &ClientMessage::ChangesDirty)?;
        }
        dispatch_workload_identity_requests(
            &mut socket,
            &config.generation,
            workload_identity,
            session_epoch,
            &mut pending_workload_identity,
        )?;
        let terminal_input = terminal.drain_input().map_err(SessionExit::Terminal)?;
        send_terminal_output(&mut socket, terminal_input)?;
        let terminal_output = terminal.drain_output().map_err(SessionExit::Terminal)?;
        send_terminal_output(&mut socket, terminal_output)?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                let message = decode_server(&text)?;
                match message {
                    ServerMessage::HeartbeatAck { generation }
                        if generation == config.generation =>
                    {
                        last_activity = Instant::now()
                    }
                    ServerMessage::ReadinessPing {
                        generation,
                        request_id,
                    } if generation == config.generation
                        && !request_id.is_empty()
                        && request_id.len() <= 64 =>
                    {
                        last_activity = Instant::now();
                        send_json(
                            &mut socket,
                            &ClientMessage::ReadinessPong {
                                generation: &config.generation,
                                request_id: &request_id,
                            },
                        )?;
                    }
                    ServerMessage::ChangesRefresh {
                        token,
                        source,
                        expected_fingerprint,
                    } => {
                        let refresh = RefreshRequest {
                            token,
                            source,
                            expected_fingerprint,
                        };
                        if !valid_refresh(&refresh) {
                            return Err(SessionExit::Protocol("invalid changes refresh"));
                        }
                        changes_scheduler.enqueue(refresh, Instant::now());
                    }
                    ServerMessage::Request {
                        generation,
                        request_id,
                        operation,
                    } if generation == config.generation => {
                        let refresh = operation.refresh();
                        if matches!(
                            &operation,
                            RequestOperation::Files(FilesOperation::Save { refresh: None, .. })
                        ) && config.local_runtime.is_none()
                        {
                            return Err(SessionExit::Protocol("files save without refresh"));
                        }
                        if refresh.as_ref().is_some_and(|value| !valid_refresh(value)) {
                            return Err(SessionExit::Protocol("invalid request refresh"));
                        }
                        match operation {
                            RequestOperation::Files(operation) => {
                                let request = files::WorkerRequest {
                                    request_id: request_id.clone(),
                                    operation,
                                };
                                match files::try_submit(&files_worker, request) {
                                    Ok(()) => {
                                        if pending_file_refreshes
                                            .insert(request_id.clone(), refresh)
                                            .is_some()
                                        {
                                            return Err(SessionExit::Protocol(
                                                "duplicate files request id",
                                            ));
                                        }
                                    }
                                    Err(std::sync::mpsc::TrySendError::Full(_)) => {
                                        send_json(
                                            &mut socket,
                                            &ClientMessage::Response {
                                                generation: &config.generation,
                                                request_id: &request_id,
                                                result: OperationResult::Files(
                                                    files::FilesResult::Unavailable,
                                                ),
                                            },
                                        )?;
                                    }
                                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                                        return Err(SessionExit::Files("worker disconnected"));
                                    }
                                }
                            }
                            RequestOperation::Environment(EnvironmentOperation::Activate(
                                operation,
                            )) => {
                                send_json(
                                    &mut socket,
                                    &ClientMessage::Response {
                                        generation: &config.generation,
                                        request_id: &request_id,
                                        result: OperationResult::Environment(
                                            environment.activate(operation, terminal),
                                        ),
                                    },
                                )?;
                            }
                        }
                        last_activity = Instant::now();
                    }
                    ServerMessage::WorkloadIdentityResponse {
                        generation,
                        request_id,
                        result,
                    } if generation == config.generation && result.valid() => {
                        pending_workload_identity.respond(&request_id, result)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalOpen {
                        terminal_version,
                        terminal: terminal_name,
                        mode,
                        expected_resident_generation,
                        dimensions,
                    } => {
                        let output = terminal
                            .open(
                                terminal_version,
                                &terminal_name,
                                &mode,
                                expected_resident_generation,
                                dimensions,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalResetAttachments {
                        terminal_version,
                        terminal: terminal_name,
                        resident_generation,
                    } => {
                        let output = terminal
                            .reset_attachments(
                                terminal_version,
                                &terminal_name,
                                resident_generation,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalAttach {
                        terminal_version,
                        terminal: terminal_name,
                        resident_generation,
                        attachment_generation,
                        resize_ordinal,
                        dimensions,
                    } => {
                        let output = terminal
                            .attach(
                                terminal_version,
                                &terminal_name,
                                resident_generation,
                                attachment_generation,
                                resize_ordinal.0,
                                dimensions,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalResize {
                        terminal_version,
                        terminal: terminal_name,
                        resident_generation,
                        attachment_generation,
                        resize_ordinal,
                        dimensions,
                    } => {
                        let output = terminal
                            .resize(
                                terminal_version,
                                &terminal_name,
                                resident_generation,
                                attachment_generation,
                                resize_ordinal.0,
                                dimensions,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalDetach {
                        terminal_version,
                        terminal: terminal_name,
                        resident_generation,
                        attachment_generation,
                        reason,
                    } => {
                        let output = terminal
                            .detach(
                                terminal_version,
                                &terminal_name,
                                resident_generation,
                                attachment_generation,
                                &reason,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    ServerMessage::TerminalRestart {
                        terminal_version,
                        terminal: terminal_name,
                        expected_resident_generation,
                        dimensions,
                    } => {
                        let output = terminal
                            .restart(
                                terminal_version,
                                &terminal_name,
                                expected_resident_generation,
                                dimensions,
                            )
                            .map_err(SessionExit::Terminal)?;
                        send_terminal_output(&mut socket, output)?;
                        last_activity = Instant::now();
                    }
                    _ => return Err(SessionExit::Protocol("unexpected server message")),
                }
            }
            Ok(Message::Binary(bytes)) => {
                let output = terminal.input(&bytes).map_err(SessionExit::Terminal)?;
                send_terminal_output(&mut socket, output)?;
                last_activity = Instant::now();
            }
            Ok(Message::Ping(data)) => {
                socket
                    .send(Message::Pong(data))
                    .map_err(SessionExit::Socket)?;
                last_activity = Instant::now();
            }
            Ok(Message::Pong(_)) => last_activity = Instant::now(),
            Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => {
                return Err(SessionExit::Closed);
            }
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(SessionExit::Socket(e)),
            _ => {}
        }
    }
}

fn valid_refresh(refresh: &RefreshRequest) -> bool {
    let hash = |value: &str, length| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    refresh.token.len() >= 16
        && refresh.token.len() <= 64
        && refresh
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && hash(&refresh.source.baseline, 40)
        && !refresh.source.default_branch.is_empty()
        && refresh.source.default_branch.len() <= 256
        && refresh
            .expected_fingerprint
            .as_deref()
            .is_none_or(|fingerprint| hash(fingerprint, 64))
}

#[derive(Default)]
struct PendingWorkloadIdentity {
    requests: HashMap<String, (Instant, workload_identity::LocalRequest)>,
    expired: VecDeque<String>,
}

impl PendingWorkloadIdentity {
    fn expire(&mut self, now: Instant) {
        let expired = self
            .requests
            .iter()
            .filter(|(_, (queued_at, _))| {
                now.duration_since(*queued_at) >= WORKLOAD_IDENTITY_REQUEST_LEASE
            })
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in expired {
            if let Some((_, request)) = self.requests.remove(&request_id) {
                request.respond(WorkloadIdentityResult::Unavailable);
                // Bound session memory. Responses older than this window still fail closed.
                if self.expired.len() == 256 {
                    self.expired.pop_front();
                }
                self.expired.push_back(request_id);
            }
        }
    }

    fn respond(
        &mut self,
        request_id: &str,
        result: WorkloadIdentityResult,
    ) -> Result<(), SessionExit> {
        if let Some((_, request)) = self.requests.remove(request_id) {
            request.respond(result);
        }
        // A helper can time out locally while Core is finishing its bounded
        // request. Late or duplicate replies are not daemon protocol faults:
        // discarding them preserves the resident terminal session.
        Ok(())
    }
}

impl Drop for PendingWorkloadIdentity {
    fn drop(&mut self) {
        for (_, (_, request)) in self.requests.drain() {
            request.respond(WorkloadIdentityResult::Unavailable);
        }
    }
}

fn dispatch_workload_identity_requests(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    generation: &str,
    relay: &workload_identity::Relay,
    session_epoch: u64,
    pending: &mut PendingWorkloadIdentity,
) -> Result<(), SessionExit> {
    pending.expire(Instant::now());
    loop {
        let request = match relay.try_request() {
            Ok(request) => request,
            Err(std::sync::mpsc::TryRecvError::Empty) => return Ok(()),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err(SessionExit::Protocol(
                    "workload identity relay disconnected",
                ));
            }
        };
        if request.epoch != session_epoch
            || pending.requests.len() >= MAX_CONCURRENT_WORKLOAD_IDENTITY_REQUESTS
            || pending.requests.contains_key(&request.request_id)
            || pending.expired.contains(&request.request_id)
        {
            request.respond(WorkloadIdentityResult::Unavailable);
            continue;
        }
        if let Err(exit) = send_json(
            socket,
            &ClientMessage::WorkloadIdentityRequest {
                generation,
                request_id: &request.request_id,
                request: &request.request,
            },
        ) {
            request.respond(WorkloadIdentityResult::Unavailable);
            return Err(exit);
        }
        pending
            .requests
            .insert(request.request_id.clone(), (Instant::now(), request));
    }
}

fn send_json<S: Serialize>(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    value: &S,
) -> Result<(), SessionExit> {
    let text = serde_json::to_string(value).map_err(SessionExit::Encode)?;
    if text.len() > MAX_CLIENT_FRAME_BYTES {
        return Err(SessionExit::Protocol("client frame too large"));
    }
    socket
        .send(Message::Text(text.into()))
        .map_err(SessionExit::Socket)
}

fn send_terminal_output(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    output: Vec<TerminalOutbound>,
) -> Result<(), SessionExit> {
    for message in output {
        match message {
            TerminalOutbound::Control(control) => {
                let text = serde_json::to_string(&control).map_err(SessionExit::Encode)?;
                if text.len() > MAX_CONTROL_FRAME_BYTES {
                    return Err(SessionExit::Protocol("terminal control frame too large"));
                }
                socket
                    .send(Message::Text(text.into()))
                    .map_err(SessionExit::Socket)?;
            }
            TerminalOutbound::Binary(bytes) => {
                socket
                    .send(Message::Binary(bytes.into()))
                    .map_err(SessionExit::Socket)?;
            }
        }
    }
    Ok(())
}

fn changes_candidate_json(token: &str, outcome: &CandidateOutcome) -> Result<String, SessionExit> {
    let text = serde_json::to_string(&ClientMessage::ChangesCandidate { token, outcome })
        .map_err(SessionExit::Encode)?;
    if text.len() <= MAX_CHANGES_CANDIDATE_BYTES {
        return Ok(text);
    }
    let unavailable = CandidateOutcome::Unavailable {
        reason: changes::UnavailableReason::CandidateTooLarge,
    };
    serde_json::to_string(&ClientMessage::ChangesCandidate {
        token,
        outcome: &unavailable,
    })
    .map_err(SessionExit::Encode)
}

fn send_changes_candidate(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    token: &str,
    outcome: &CandidateOutcome,
) -> Result<(), SessionExit> {
    let text = changes_candidate_json(token, outcome)?;
    socket
        .send(Message::Text(text.into()))
        .map_err(SessionExit::Socket)
}

fn decode_server(text: &str) -> Result<ServerMessage, SessionExit> {
    if text.len() > MAX_ENVIRONMENT_REQUEST_FRAME_BYTES {
        return Err(SessionExit::Protocol("server frame too large"));
    }
    if text.len() > MAX_CONTROL_FRAME_BYTES {
        #[derive(Deserialize)]
        struct MessageDiscriminator {
            #[serde(rename = "type")]
            message_type: String,
        }
        let discriminator: MessageDiscriminator = serde_json::from_str(text)
            .map_err(|_| SessionExit::Protocol("malformed server message"))?;
        if discriminator.message_type == "workload-identity.response" {
            if text.len() > MAX_WORKLOAD_IDENTITY_FRAME_BYTES {
                return Err(SessionExit::Protocol("workload identity frame too large"));
            }
        } else if discriminator.message_type == "request" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct RequestEnvelope {
                #[serde(rename = "type")]
                message_type: String,
                generation: String,
                #[serde(rename = "requestId")]
                request_id: String,
                operation: Box<serde_json::value::RawValue>,
            }
            #[derive(Deserialize)]
            struct OperationDiscriminator {
                operation: String,
            }
            let envelope: RequestEnvelope = serde_json::from_str(text)
                .map_err(|_| SessionExit::Protocol("malformed request envelope"))?;
            if envelope.message_type != "request"
                || envelope.generation.is_empty()
                || envelope.request_id.is_empty()
            {
                return Err(SessionExit::Protocol("invalid request envelope"));
            }
            let discriminator: OperationDiscriminator =
                serde_json::from_str(envelope.operation.get())
                    .map_err(|_| SessionExit::Protocol("malformed request operation"))?;
            let bound = if discriminator.operation == "environment.activate" {
                MAX_ENVIRONMENT_REQUEST_FRAME_BYTES
            } else {
                MAX_REQUEST_FRAME_BYTES
            };
            if text.len() > bound {
                return Err(SessionExit::Protocol("request frame too large"));
            }
        } else {
            return Err(SessionExit::Protocol("control frame too large"));
        }
    }
    let message: ServerMessage = serde_json::from_str(text)
        .map_err(|_| SessionExit::Protocol("malformed server message"))?;
    if !message.has_valid_conditional_fields() {
        return Err(SessionExit::Protocol("invalid server message fields"));
    }
    let bound = match &message {
        message
            if matches!(
                message.request_operation(),
                Some(RequestOperation::Environment(_))
            ) =>
        {
            MAX_ENVIRONMENT_REQUEST_FRAME_BYTES
        }
        message if message.request_operation().is_some() => MAX_REQUEST_FRAME_BYTES,
        ServerMessage::WorkloadIdentityResponse { .. } => MAX_WORKLOAD_IDENTITY_FRAME_BYTES,
        _ => MAX_CONTROL_FRAME_BYTES,
    };
    if text.len() > bound {
        Err(SessionExit::Protocol("server frame exceeds bound"))
    } else {
        Ok(message)
    }
}

fn read_server(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
) -> Result<ServerMessage, SessionExit> {
    let deadline = Instant::now() + HEARTBEAT_LEASE;
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => return decode_server(&text),
            Ok(Message::Ping(data)) => socket
                .send(Message::Pong(data))
                .map_err(SessionExit::Socket)?,
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(SessionExit::Socket(e)),
            _ => {}
        }
    }
    Err(SessionExit::Protocol("registration timed out"))
}

fn set_timeout(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    timeout: Option<Duration>,
) -> io::Result<()> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(timeout),
        MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(timeout),
        _ => Err(io::ErrorKind::Unsupported.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FilesResult;
    use base64::Engine;
    fn config() -> Config {
        Config {
            version: 1,
            endpoint: "wss://example.invalid/dxd".into(),
            thread_id: "thread".into(),
            generation: "gen_1".into(),
            api_key: "dxd_test-api-key-value".into(),
            release: RELEASE.into(),
            protocol_major: 1,
            workspace_root: "/tmp/work".into(),
            local_runtime: None,
        }
    }

    #[test]
    fn validates_config_bounds_and_constants() {
        assert!(validate(&config()).is_ok());
        let mut bad = config();
        bad.api_key = "dxu_wrong-key-kind".into();
        assert!(validate(&bad).is_err());
        let mut bad = config();
        bad.generation = "bad!".into();
        assert!(validate(&bad).is_err());
        let mut bad = config();
        bad.release = "0.1.0".into();
        assert!(validate(&bad).is_err());
        let mut bad = config();
        bad.protocol_major = 2;
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn resets_reconnect_delay_only_after_a_heartbeat_lease_of_health() {
        let backed_off = Duration::from_secs(30);
        assert_eq!(reconnect_delay(backed_off, None), backed_off);
        assert_eq!(
            reconnect_delay(backed_off, Some(HEARTBEAT_LEASE - Duration::from_millis(1))),
            backed_off
        );
        assert_eq!(
            reconnect_delay(backed_off, Some(HEARTBEAT_LEASE)),
            INITIAL_RECONNECT_DELAY
        );
    }

    #[test]
    fn health_is_api_key_and_endpoint_free() {
        let c = config();
        let text =
            String::from_utf8(health_json(RELEASE, PROTOCOL_MAJOR, &c.generation, true).unwrap())
                .unwrap();
        assert_eq!(
            text,
            r#"{"release":"0.7.5","protocolMajor":1,"generation":"gen_1","connected":true}"#
        );
        assert!(!text.contains(&c.api_key));
        assert!(!text.contains(&c.endpoint));
    }

    #[test]
    fn local_supervision_does_not_bind_a_checkout_health_socket() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("x".repeat(128));
        let mut c = config();
        c.local_runtime = Some(LocalRuntime {
            home_directory: root.path().join("home").to_string_lossy().into_owned(),
            state_directory: state.to_string_lossy().into_owned(),
        });

        assert!(start_health(&c, &state, Arc::new(AtomicBool::new(false))).is_ok());
        assert!(!state.join("health.sock").exists());
    }

    #[test]
    fn readiness_probe_is_correlated_and_control_bounded() {
        let ping = r#"{"type":"readiness-ping","generation":"gen_1","requestId":"probe_12345678"}"#;
        let ServerMessage::ReadinessPing {
            generation,
            request_id,
        } = decode_server(ping).unwrap()
        else {
            panic!("expected readiness ping")
        };
        assert_eq!(
            serde_json::to_string(&ClientMessage::ReadinessPong {
                generation: &generation,
                request_id: &request_id,
            })
            .unwrap(),
            r#"{"type":"readiness-pong","generation":"gen_1","requestId":"probe_12345678"}"#
        );
        assert!(
            decode_server(&ping.replace("probe_12345678", &"x".repeat(MAX_CONTROL_FRAME_BYTES)))
                .is_err()
        );
    }

    #[test]
    fn encodes_protocol_messages_exactly() {
        let c = config();
        assert_eq!(
            serde_json::to_string(&ClientMessage::Register {
                generation: &c.generation,
                protocol_major: 1,
                release: RELEASE,
                capabilities: Capabilities::current(),
            })
            .unwrap(),
            r#"{"type":"register","generation":"gen_1","protocolMajor":1,"release":"0.7.5","capabilities":{"terminal":{"version":1},"workloadIdentity":{"version":1}}}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientMessage::Heartbeat {
                generation: &c.generation,
                terminal: TerminalRuntime::new(PathBuf::from("/tmp/work"), "thread").heartbeat(),
            })
            .unwrap(),
            r#"{"type":"heartbeat","generation":"gen_1","terminal":{"state":"absent","terminalVersion":1,"terminal":"default"}}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientMessage::ChangesDirty).unwrap(),
            r#"{"type":"changes-dirty"}"#
        );
        let refresh: ServerMessage = serde_json::from_str(
            r#"{"type":"changes-refresh","token":"opaque-refresh-token","source":{"baseline":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","defaultBranch":"main"},"expectedFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#,
        )
        .unwrap();
        let ServerMessage::ChangesRefresh {
            token,
            source,
            expected_fingerprint,
        } = refresh
        else {
            panic!("refresh did not decode")
        };
        assert_eq!(token, "opaque-refresh-token");
        assert_eq!(source.default_branch, "main");
        assert_eq!(expected_fingerprint, Some("b".repeat(64)));
        let outcome = CandidateOutcome::Unchanged {
            fingerprint: "b".repeat(64),
        };
        assert_eq!(
            serde_json::to_string(&ClientMessage::ChangesCandidate {
                token: &token,
                outcome: &outcome,
            })
            .unwrap(),
            r#"{"type":"changes-candidate","token":"opaque-refresh-token","outcome":{"kind":"unchanged","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#
        );
        let request = decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{"operation":"files.read","path":"src/main.rs"}}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            ServerMessage::Request {
                generation,
                request_id,
                operation: RequestOperation::Files(FilesOperation::Read { path, .. }),
            } if generation == "gen_1" && request_id == "request_12345678" && path == "src/main.rs"
        ));
        let save = decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{"operation":"files.save","path":"src/main.rs","expectedVersion":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content":"newest\n","refresh":{"type":"changes-refresh","token":"opaque-refresh-token","source":{"baseline":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","defaultBranch":"main"},"expectedFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}"#,
        )
        .unwrap();
        assert!(matches!(
            save,
            ServerMessage::Request {
                generation,
                request_id,
                operation: RequestOperation::Files(FilesOperation::Save { path, content, .. }),
            } if generation == "gen_1"
                && request_id == "request_12345678"
                && path == "src/main.rs"
                && content == "newest\n"
        ));
        let local_scratch_save = decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{"operation":"files.save","path":"README.md","expectedVersion":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content":"local\n"}}"#,
        )
        .unwrap();
        assert!(matches!(
            local_scratch_save,
            ServerMessage::Request {
                operation: RequestOperation::Files(FilesOperation::Save { refresh: None, .. }),
                ..
            }
        ));
        assert_eq!(
            serde_json::to_string(&ClientMessage::Response {
                generation: &c.generation,
                request_id: "request_12345678",
                result: OperationResult::Files(FilesResult::Missing),
            })
            .unwrap(),
            r#"{"type":"response","generation":"gen_1","requestId":"request_12345678","result":{"kind":"missing"}}"#
        );
    }

    #[test]
    fn replaces_an_oversized_candidate_with_a_typed_unavailable_outcome() {
        let patch = "x".repeat(256 * 1024);
        let files = (0..33)
            .map(|index| changes::CapturedFile {
                worktree: None,
                path: format!("file-{index}.txt"),
                status: changes::FileStatus::Modified,
                additions: 1,
                deletions: 1,
                binary: false,
                truncated: true,
                patch: patch.clone(),
            })
            .collect();
        let outcome = CandidateOutcome::Complete {
            capture: changes::CompleteCapture {
                fingerprint: "b".repeat(64),
                baseline: "a".repeat(40),
                head: "a".repeat(40),
                branch: Some("main".into()),
                upstream_label: None,
                ahead: 0,
                commits: vec![],
                worktrees: None,
                ranges: vec![changes::CapturedRange {
                    range: changes::Range::All,
                    truncated: false,
                    summary: changes::Summary {
                        additions: 33,
                        deletions: 33,
                        files: 33,
                    },
                    files,
                }],
            },
        };

        let encoded = changes_candidate_json("opaque-refresh-token", &outcome).unwrap();

        assert!(encoded.len() <= MAX_CHANGES_CANDIDATE_BYTES);
        assert_eq!(
            encoded,
            r#"{"type":"changes-candidate","token":"opaque-refresh-token","outcome":{"kind":"unavailable","reason":"candidate-too-large"}}"#
        );
    }

    #[test]
    fn rejects_oversized_or_unknown_server_frames() {
        assert!(decode_server(&"x".repeat(MAX_REQUEST_FRAME_BYTES + 1)).is_err());
        let oversized_control = format!(
            r#"{{"type":"heartbeat-ack","generation":"{}"}}"#,
            "x".repeat(MAX_CONTROL_FRAME_BYTES)
        );
        assert!(oversized_control.len() > MAX_CONTROL_FRAME_BYTES);
        assert!(decode_server(&oversized_control).is_err());
        assert!(decode_server(r#"{"type":"shell","command":"id"}"#).is_err());
        assert!(
            decode_server(
                r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"open-if-absent","expectedResidentGeneration":"AQAAAAAAAAAAAAAAAAAAAA","dimensions":{"columns":80,"rows":20}}"#
            )
            .is_err()
        );
        assert!(
            decode_server(
                r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"restart-exited","dimensions":{"columns":80,"rows":20}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn stages_the_environment_request_bound_without_widening_other_operations() {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(vec![b'x'; environment::MAX_VALUE_BYTES]);
        let entries = (0..environment::MAX_ENVIRONMENT_ENTRIES)
            .map(|index| {
                serde_json::json!({
                    "name": format!("VALUE_{index:03}"),
                    "valueBase64Url": encoded,
                })
            })
            .collect::<Vec<_>>();
        let environment = serde_json::json!({
            "type": "request",
            "generation": "gen_1",
            "requestId": "request_12345678",
            "operation": {
                "operation": "environment.activate",
                "generation": 1,
                "entries": entries,
                "git": {
                    "authorName": "dxcodeagent",
                    "authorEmail": "agent@dxcode.dev",
                    "threadUrl": "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000",
                    "signingEnabled": false,
                },
            },
        })
        .to_string();
        assert!(environment.len() > 12 * 1_024 * 1_024);
        assert!(environment.len() <= MAX_ENVIRONMENT_REQUEST_FRAME_BYTES);
        assert!(matches!(
            decode_server(&environment),
            Ok(ServerMessage::Request {
                operation: RequestOperation::Environment(_),
                ..
            })
        ));

        let ordinary = format!(
            r#"{{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{{"operation":"files.save","path":"file","expectedVersion":null,"content":"{}"}}}}"#,
            "x".repeat(MAX_REQUEST_FRAME_BYTES)
        );
        assert!(ordinary.len() > MAX_REQUEST_FRAME_BYTES);
        assert!(decode_server(&ordinary).is_err());
        let unknown = format!(
            r#"{{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{{"operation":"unknown","padding":"{}"}}}}"#,
            "x".repeat(MAX_REQUEST_FRAME_BYTES)
        );
        assert!(decode_server(&unknown).is_err());
        assert!(decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{"operation":"environment.activate","operation":"files.read","generation":1,"entries":[]}}"#
        )
        .is_err());
        let over_environment = format!(
            r#"{{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{{"operation":"environment.activate","generation":1,"entries":[],"padding":"{}"}}}}"#,
            "x".repeat(MAX_ENVIRONMENT_REQUEST_FRAME_BYTES)
        );
        assert!(decode_server(&over_environment).is_err());
    }

    #[test]
    fn session_exits_name_their_reason() {
        let oversized = format!(
            r#"{{"type":"heartbeat.ack","generation":"gen_1","padding":"{}"}}"#,
            "x".repeat(MAX_CONTROL_FRAME_BYTES)
        );
        let Err(exit) = decode_server(&oversized) else {
            panic!("oversized frame must be rejected");
        };
        assert_eq!(exit.to_string(), "protocol: control frame too large");
        let Err(exit) = decode_server("not json") else {
            panic!("malformed frame must be rejected");
        };
        assert_eq!(exit.to_string(), "protocol: malformed server message");
        assert_eq!(
            SessionExit::HeartbeatLease.to_string(),
            "heartbeat lease expired"
        );
        assert_eq!(
            SessionExit::Terminal(io::ErrorKind::BrokenPipe.into()).to_string(),
            "terminal: broken pipe"
        );
    }

    #[test]
    fn late_workload_identity_reply_does_not_exit_the_daemon() {
        let mut pending = PendingWorkloadIdentity::default();
        assert!(
            pending
                .respond("timed-out-helper", WorkloadIdentityResult::Unavailable)
                .is_ok()
        );
    }
}
