//! One authenticated outbound WebSocket session to Core's Thread execution
//! Durable Object, multiplexing every resident feature.
//!
//! The loop is readiness-driven: the socket, PTY reader, feature workers,
//! observer, helper relay, and timers all wake the same `select!`. Nothing
//! polls. Feature work that can block (files, git, environment
//! materialization, release download) runs on blocking tasks the daemon, not
//! the session, owns, so a reconnect never loses work already in flight.

use crate::changes::{
    CandidateOutcome, CaptureCache, ChangesScheduler, CompletedRefresh, RefreshRequest,
    UnavailableReason,
};
use crate::environment::{EnvironmentOutcome, EnvironmentResult, EnvironmentRuntime, Materialized};
use crate::files::{FilesContext, FilesDone, FilesOperation, FilesResult, FilesWorkers};
use crate::files_sandbox::{self, SandboxReadResult};
use crate::observer::Observer;
use crate::protocol::{
    Capabilities, ClientMessage, EnvironmentOperation, OperationResult, RequestOperation,
    ServerMessage, UpdateStatus, WorkloadIdentityResult,
};
use crate::terminal::{TerminalOutbound, TerminalRuntime};
use crate::update::{self, UpdateRequest, Updater};
use crate::workload_identity::{LocalRequest, Relay};
use crate::{Config, PROTOCOL_MAJOR, RELEASE};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::mpsc::{Receiver, Sender, UnboundedReceiver, UnboundedSender, channel};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
pub const HEARTBEAT_LEASE: Duration = Duration::from_secs(15);
pub const MAX_CHANGES_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CONTROL_FRAME_BYTES: usize = 4 * 1024;
pub const MAX_REQUEST_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ENVIRONMENT_REQUEST_FRAME_BYTES: usize = 14 * 1024 * 1024;
pub const MAX_CLIENT_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WORKLOAD_IDENTITY_FRAME_BYTES: usize = 80 * 1024;
pub const MAX_CONCURRENT_WORKLOAD_IDENTITY_REQUESTS: usize = 32;
pub const WORKLOAD_IDENTITY_REQUEST_LEASE: Duration = Duration::from_secs(10);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
/// Kept short: Core waits a few seconds for a resumed daemon to register on
/// its own before it falls back to guest commands.
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// Wall-clock progress beyond monotonic progress that means the VM was
/// suspended (E2B pause freezes `CLOCK_MONOTONIC`; the wall clock is corrected
/// on resume). A focused Terminal wakes the workspace within seconds of the
/// pause, so a frozen interval of one or two seconds must count too: missing
/// it leaves the daemon on its stale socket until the socket fails.
const SUSPENSION_GAP: Duration = Duration::from_secs(1);
const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(15);
/// After a resume, retry at this fixed cadence instead of backing off: the
/// guest network returns within moments and Core is waiting.
const RESUME_RETRY_DELAY: Duration = Duration::from_millis(100);
const RESUME_RETRY_WINDOW: Duration = Duration::from_secs(10);
const CACHED_ADDRESS_TIMEOUT: Duration = Duration::from_millis(1000);
/// Right after a resume the first SYN is often lost, and the kernel would
/// only resend it after a second: give up sooner and dial again.
const RESUME_TCP_TIMEOUT: Duration = Duration::from_millis(300);
/// TLS and upgrade inside the resume window. They legitimately take about a
/// second (a cold Worker at the guest's edge), so only a stall is abandoned;
/// the TCP connect before them has its own sub-second bound.
const RESUME_UPGRADE_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_QUEUE: usize = 1024;
/// `DXF1` frames sent but not yet acknowledged by Core. Every later control or
/// Terminal frame can queue behind these anywhere on the path (kernel, edge,
/// Durable Object), so the window caps that wait at about 1 MiB of transfer.
const SANDBOX_CHUNK_WINDOW: usize = 4;

#[derive(Debug)]
pub enum SessionExit {
    Endpoint(&'static str),
    Connect(String),
    Socket,
    Encode(serde_json::Error),
    Protocol(&'static str),
    HeartbeatLease,
    /// The VM was suspended; the socket is presumed stale.
    Suspended,
    /// `SIGHUP`: reload the configuration and reconnect now.
    Reload,
    Terminal(std::io::Error),
    Closed,
}

impl std::fmt::Display for SessionExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Endpoint(reason) => write!(f, "endpoint: {reason}"),
            Self::Connect(e) => write!(f, "connect: {e}"),
            Self::Socket => write!(f, "socket closed"),
            Self::Encode(e) => write!(f, "encode: {e}"),
            Self::Protocol(reason) => write!(f, "protocol: {reason}"),
            Self::HeartbeatLease => write!(f, "heartbeat lease expired"),
            Self::Suspended => write!(f, "resumed after suspension"),
            Self::Reload => write!(f, "reload requested"),
            Self::Terminal(e) => write!(f, "terminal: {e}"),
            Self::Closed => write!(f, "connection closed"),
        }
    }
}

/// A bulk frame. Its admission permit, when present, is released only once
/// the frame is written, so queued bulk bytes stay bounded by the Files lanes.
/// Sandbox chunk frames also wait for room in the acknowledged window.
struct BulkFrame {
    message: Message,
    windowed: bool,
    _admission: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}

/// Process-lifetime state shared by every session.
pub struct Daemon {
    config: Config,
    config_path: PathBuf,
    reconnect: ReconnectSignal,
    clock_step: ClockStepSignal,
    last_address: Option<std::net::SocketAddr>,
    resumed_at: Option<Instant>,
    updater: Updater,
    terminal: TerminalRuntime,
    environment: EnvironmentRuntime,
    files: FilesWorkers,
    files_results: Receiver<FilesDone>,
    changes_workspace: PathBuf,
    changes_cache: CaptureCache,
    changes_results_tx: Sender<CompletedRefresh>,
    changes_results: Receiver<CompletedRefresh>,
    changes_scheduler: ChangesScheduler,
    pending_file_refreshes: HashMap<String, Option<RefreshRequest>>,
    observer: Observer,
    workload_identity: Relay,
    workload_identity_epoch: Arc<AtomicU64>,
    connected: Arc<AtomicBool>,
}

impl Daemon {
    pub fn new(
        config: Config,
        config_path: PathBuf,
        current_exe: PathBuf,
        terminal: TerminalRuntime,
        environment: EnvironmentRuntime,
        files: FilesContext,
        observer: Observer,
        workload_identity: Relay,
        workload_identity_epoch: Arc<AtomicU64>,
        connected: Arc<AtomicBool>,
    ) -> std::io::Result<Self> {
        let (files, files_results) = FilesWorkers::new(files);
        let (changes_results_tx, changes_results) = channel(4);
        Ok(Self {
            changes_workspace: PathBuf::from(&config.workspace_root),
            changes_cache: CaptureCache::default(),
            changes_results_tx,
            config,
            config_path,
            reconnect: ReconnectSignal::install(),
            clock_step: ClockStepSignal::install(),
            last_address: None,
            resumed_at: None,
            updater: Updater::new(current_exe),
            terminal,
            environment,
            files,
            files_results,
            changes_results,
            changes_scheduler: ChangesScheduler::new(),
            pending_file_refreshes: HashMap::new(),
            observer,
            workload_identity,
            workload_identity_epoch,
            connected,
        })
    }

    /// Connect, serve, and reconnect forever.
    pub async fn run(mut self) {
        let mut delay = INITIAL_RECONNECT_DELAY;
        loop {
            let mut healthy_since = None;
            let exit = self.session(&mut healthy_since).await;
            match &exit {
                Ok(()) => eprintln!("dxd reconnecting"),
                Err(exit) => eprintln!("dxd reconnecting: {exit}"),
            }
            self.connected.store(false, Ordering::Release);
            if healthy_since.is_some() {
                self.resumed_at = None;
            }
            if matches!(exit, Err(SessionExit::Suspended | SessionExit::Reload)) {
                // Nothing is wrong with Core: reconnect at once so a resumed
                // or reconfigured guest is usable within one round trip.
                if matches!(exit, Err(SessionExit::Suspended)) {
                    self.resumed_at = Some(Instant::now());
                }
                delay = INITIAL_RECONNECT_DELAY;
                continue;
            }
            if self
                .resumed_at
                .is_some_and(|at| at.elapsed() < RESUME_RETRY_WINDOW)
            {
                tokio::select! {
                    () = tokio::time::sleep(RESUME_RETRY_DELAY) => {}
                    () = self.reconnect.requested() => {
                        self.reload_config();
                    }
                }
                continue;
            }
            delay =
                if healthy_since.is_some_and(|since: Instant| since.elapsed() >= HEARTBEAT_LEASE) {
                    INITIAL_RECONNECT_DELAY
                } else {
                    delay
                };
            let jitter = rand::rng().random_range(0..=delay.as_millis() as u64 / 2);
            tokio::select! {
                () = tokio::time::sleep(delay + Duration::from_millis(jitter)) => {}
                () = self.reconnect.requested() => {
                    self.reload_config();
                    delay = INITIAL_RECONNECT_DELAY;
                    continue;
                }
                // A resume makes the backoff moot: reconnect now.
                () = self.clock_step.stepped() => {
                    delay = INITIAL_RECONNECT_DELAY;
                    continue;
                }
            }
            delay = (delay * 2).min(MAX_RECONNECT_DELAY);
        }
    }

    /// Dial Core, trying the address that last worked before DNS: a resumed
    /// guest's resolver fails for a few seconds while its network is already
    /// usable. TLS still verifies the endpoint's name, so the cached address
    /// is only a routing hint.
    async fn connect_tcp(
        &mut self,
        uri: &tokio_tungstenite::tungstenite::http::Uri,
    ) -> Result<tokio::net::TcpStream, SessionExit> {
        let resuming = self
            .resumed_at
            .is_some_and(|at| at.elapsed() < RESUME_RETRY_WINDOW);
        if let Some(address) = self.last_address {
            let timeout = if resuming {
                RESUME_TCP_TIMEOUT
            } else {
                CACHED_ADDRESS_TIMEOUT
            };
            if let Ok(Ok(stream)) =
                tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address)).await
            {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
        }
        let host = uri
            .host()
            .ok_or(SessionExit::Endpoint("endpoint has no host"))?;
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("wss") {
                443
            } else {
                80
            });
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let resolved = tokio::net::TcpStream::connect((host, port));
        let stream = if resuming {
            tokio::time::timeout(CACHED_ADDRESS_TIMEOUT, resolved)
                .await
                .map_err(|_| SessionExit::Connect("timed out".into()))?
        } else {
            resolved.await
        }
        .map_err(|error| SessionExit::Connect(error.to_string()))?;
        self.last_address = stream.peer_addr().ok();
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }

    /// Adopt a rewritten configuration. Only the endpoint and credential may
    /// change; a document for another Thread or workspace is ignored. Returns
    /// whether the connection must be remade.
    fn reload_config(&mut self) -> bool {
        match crate::load_config(&self.config_path) {
            Ok(next)
                if next.thread_id == self.config.thread_id
                    && next.workspace_root == self.config.workspace_root =>
            {
                let changed =
                    next.endpoint != self.config.endpoint || next.api_key != self.config.api_key;
                self.config = next;
                changed
            }
            Ok(_) => {
                eprintln!("dxd ignored a configuration for another Thread");
                false
            }
            Err(error) => {
                eprintln!("dxd kept its configuration: {error}");
                false
            }
        }
    }

    async fn session(&mut self, healthy_since: &mut Option<Instant>) -> Result<(), SessionExit> {
        self.connected.store(false, Ordering::Release);
        let mut request = self
            .config
            .endpoint
            .as_str()
            .into_client_request()
            .map_err(|_| SessionExit::Endpoint("invalid websocket request"))?;
        request.headers_mut().insert(
            AUTHORIZATION,
            format!("Bearer {}", self.config.api_key)
                .parse()
                .map_err(|_| SessionExit::Endpoint("invalid authorization header"))?,
        );
        let websocket_config =
            WebSocketConfig::default().max_message_size(Some(MAX_ENVIRONMENT_REQUEST_FRAME_BYTES));
        let mut tcp_at = None;
        let dial_timeout = if self
            .resumed_at
            .is_some_and(|at| at.elapsed() < RESUME_RETRY_WINDOW)
        {
            RESUME_UPGRADE_TIMEOUT
        } else {
            REGISTRATION_TIMEOUT
        };
        let (socket, _) = tokio::time::timeout(dial_timeout, async {
            let stream = self.connect_tcp(request.uri()).await?;
            tcp_at = Some(Instant::now());
            tokio_tungstenite::client_async_tls_with_config(
                request,
                stream,
                Some(websocket_config),
                None,
            )
            .await
            .map_err(|error| {
                // Never keep retrying an address that no longer serves Core.
                self.last_address = None;
                SessionExit::Connect(error.to_string())
            })
        })
        .await
        .map_err(|_| SessionExit::Connect("timed out".into()))??;
        let connected_at = Instant::now();
        let (sink, mut stream) = socket.split();

        // Two outbound lanes: controls and terminal bytes first, bulk after.
        // Bulk is unbounded so the loop never waits on it: sandbox chunks carry
        // their Files admission permit and Changes has one capture in flight.
        let (control, control_rx) = channel::<Message>(CONTROL_QUEUE);
        let (bulk, bulk_rx) = tokio::sync::mpsc::unbounded_channel::<BulkFrame>();
        let window = Arc::new(tokio::sync::Semaphore::new(SANDBOX_CHUNK_WINDOW));
        let mut writer = tokio::spawn(write_loop(sink, control_rx, bulk_rx, Arc::clone(&window)));
        // A stale socket (a resumed VM) can hold a write for its whole TCP
        // timeout; it must not outlive the session it served.
        let _writer_guard = AbortOnDrop(writer.abort_handle());

        send_json(
            &control,
            &ClientMessage::Register {
                protocol_major: PROTOCOL_MAJOR,
                release: RELEASE,
                capabilities: Capabilities::current(),
            },
        )
        .await?;
        let generation = {
            let registered = tokio::time::timeout(REGISTRATION_TIMEOUT, async {
                loop {
                    match stream.next().await {
                        Some(Ok(Message::Text(text))) => return decode_server(text.as_str()),
                        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                        Some(Ok(Message::Close(_))) | None => return Err(SessionExit::Closed),
                        Some(Ok(_)) => return Err(SessionExit::Protocol("unexpected frame")),
                        Some(Err(_)) => return Err(SessionExit::Socket),
                    }
                }
            })
            .await
            .map_err(|_| SessionExit::Protocol("registration timed out"))??;
            match registered {
                ServerMessage::Registered {
                    generation,
                    heartbeat_interval_ms: 2000,
                    heartbeat_lease_ms: 15000,
                } if valid_generation(&generation) => generation,
                _ => return Err(SessionExit::Protocol("unexpected registration response")),
            }
        };
        if let Some(resumed_at) = self.resumed_at {
            eprintln!(
                "dxd registered {} ms after resume (tcp at {} ms, upgraded at {} ms)",
                resumed_at.elapsed().as_millis(),
                tcp_at.map_or(0, |at: Instant| at.duration_since(resumed_at).as_millis()),
                connected_at.duration_since(resumed_at).as_millis()
            );
        }
        let session_epoch = self.workload_identity_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.connected.store(true, Ordering::Release);
        *healthy_since = Some(Instant::now());

        send_json(
            &control,
            &ClientMessage::Heartbeat {
                generation: &generation,
                terminal: self.terminal.heartbeat(),
            },
        )
        .await?;
        send_json(&control, &ClientMessage::ChangesDirty).await?;

        let mut pending_workload_identity = PendingWorkloadIdentity::default();
        let mut last_activity = Instant::now();
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
            HEARTBEAT_INTERVAL,
        );
        let mut environment_task: Option<(String, JoinHandle<Materialized>)> = None;
        // A fresh registration is itself activity: Core repairs and attaches.
        let mut last_feature_activity = Instant::now();
        let workspace_root = PathBuf::from(&self.config.workspace_root);
        let mut clock = SuspensionClock::now();

        loop {
            let lease_deadline = tokio::time::Instant::from_std(last_activity + HEARTBEAT_LEASE);
            let first_output_deadline = self
                .terminal
                .first_output_deadline()
                .map(tokio::time::Instant::from_std);
            let changes_ready_at = self
                .changes_scheduler
                .next_ready_at()
                .map(tokio::time::Instant::from_std);
            tokio::select! {
                biased;

                result = &mut writer => {
                    let _ = result;
                    return Err(SessionExit::Socket);
                }

                inbound = stream.next() => {
                    match inbound {
                        Some(Ok(Message::Text(text))) => {
                            last_activity = Instant::now();
                            let message = decode_server(text.as_str())?;
                            if let ServerMessage::ChunkAck {} = message {
                                if window.available_permits() >= SANDBOX_CHUNK_WINDOW {
                                    return Err(SessionExit::Protocol("unexpected chunk ack"));
                                }
                                window.add_permits(1);
                                continue;
                            }
                            if !matches!(
                                message,
                                ServerMessage::HeartbeatAck { .. }
                                    | ServerMessage::ReadinessPing { .. }
                                    | ServerMessage::Update { .. }
                            ) {
                                last_feature_activity = last_activity;
                            }
                            self.handle_server_message(
                                message,
                                &generation,
                                &control,
                                &mut pending_workload_identity,
                                &mut environment_task,
                                &workspace_root,
                            )
                            .await?;
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            last_activity = Instant::now();
                            last_feature_activity = last_activity;
                            let output = self.terminal.input(&bytes).map_err(SessionExit::Terminal)?;
                            send_terminal_output(&control, output).await?;
                            let output = self.terminal.drain_input().map_err(SessionExit::Terminal)?;
                            send_terminal_output(&control, output).await?;
                        }
                        Some(Ok(Message::Ping(data))) => {
                            last_activity = Instant::now();
                            control.send(Message::Pong(data)).await.map_err(|_| SessionExit::Socket)?;
                        }
                        Some(Ok(Message::Pong(_))) => last_activity = Instant::now(),
                        Some(Ok(Message::Close(_))) | None => return Err(SessionExit::Closed),
                        Some(Ok(Message::Frame(_))) => {}
                        Some(Err(_)) => return Err(SessionExit::Socket),
                    }
                }

                event = self.terminal.wait_output() => {
                    last_feature_activity = Instant::now();
                    let output = self.terminal.drain_output_with(event).map_err(SessionExit::Terminal)?;
                    send_terminal_output(&control, output).await?;
                }

                _ = async { tokio::time::sleep_until(first_output_deadline.unwrap()).await }, if first_output_deadline.is_some() => {
                    let output = self.terminal.drain_output().map_err(SessionExit::Terminal)?;
                    send_terminal_output(&control, output).await?;
                }

                // A bootstrap nudge that raced this registration changes
                // nothing; only a rewritten endpoint or key needs a new socket.
                () = self.reconnect.requested() => {
                    if self.reload_config() {
                        return Err(SessionExit::Reload);
                    }
                }

                // A resumed VM re-registers at once: the socket is presumed
                // stale, and Core is waiting for this registration.
                () = self.clock_step.stepped() => {
                    if clock.suspended_since_last() {
                        return Err(SessionExit::Suspended);
                    }
                }

                _ = heartbeat.tick() => {
                    if clock.suspended_since_last() {
                        return Err(SessionExit::Suspended);
                    }
                    let output = self.terminal.reap_exited().map_err(SessionExit::Terminal)?;
                    send_terminal_output(&control, output).await?;
                    send_json(
                        &control,
                        &ClientMessage::Heartbeat {
                            generation: &generation,
                            terminal: self.terminal.heartbeat(),
                        },
                    )
                    .await?;
                    pending_workload_identity.expire(Instant::now());
                    self.updater.retry_due(Instant::now());
                    if self.update_due(
                        environment_task.is_some() || !pending_workload_identity.requests.is_empty(),
                        last_feature_activity,
                    ) && self.install_update(&control, &generation).await?
                    {
                        // Let the status and a clean close leave before the image changes.
                        let _ = control.send(Message::Close(None)).await;
                        drop(control);
                        drop(bulk);
                        let _ = tokio::time::timeout(Duration::from_secs(1), &mut writer).await;
                        self.reexec_after_update();
                    }
                }

                _ = tokio::time::sleep_until(lease_deadline) => {
                    return Err(SessionExit::HeartbeatLease);
                }

                Some(completed) = self.files_results.recv() => {
                    self.deliver_files_result(completed, &generation, &control, &bulk).await?;
                }

                Some(completed) = self.changes_results.recv() => {
                    let retry = completed.request.clone();
                    if self.changes_scheduler.complete(&completed) {
                        send_changes_candidate(&bulk, &completed.request.token, &completed.outcome).await?;
                        if matches!(completed.outcome, CandidateOutcome::Raced) {
                            self.changes_scheduler.retry(retry, Instant::now());
                        }
                    }
                }

                _ = async { tokio::time::sleep_until(changes_ready_at.unwrap()).await }, if changes_ready_at.is_some() => {
                    if let Some((sequence, request)) = self.changes_scheduler.take_ready(Instant::now()) {
                        // The scheduler keeps one capture in flight; it
                        // outlives this session and reports to the daemon.
                        let root = self.changes_workspace.clone();
                        let cache = self.changes_cache.clone();
                        let results = self.changes_results_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            let outcome = crate::changes::capture(&root, &request, &cache);
                            let _ = results.blocking_send(CompletedRefresh { sequence, request, outcome });
                        });
                    }
                }

                () = self.observer.dirty() => {
                    send_json(&control, &ClientMessage::ChangesDirty).await?;
                }

                request = self.workload_identity.next() => {
                    pending_workload_identity.expire(Instant::now());
                    dispatch_workload_identity_request(
                        &control,
                        &generation,
                        request,
                        session_epoch,
                        &mut pending_workload_identity,
                    )
                    .await?;
                }

                materialized = async { (&mut environment_task.as_mut().unwrap().1).await }, if environment_task.is_some() => {
                    let (request_id, _) = environment_task.take().expect("environment task present");
                    let materialized = materialized.map_err(|_| SessionExit::Protocol("environment worker failed"))?;
                    self.environment.complete(&materialized);
                    if matches!(materialized.outcome, EnvironmentOutcome::Applied | EnvironmentOutcome::Unchanged) {
                        self.terminal.refresh_environment(&materialized.values, materialized.generation, materialized.changed);
                    }
                    send_json(
                        &control,
                        &ClientMessage::Response {
                            generation: &generation,
                            request_id: &request_id,
                            result: OperationResult::Environment(EnvironmentResult {
                                kind: materialized.outcome,
                                generation: materialized.generation,
                                shell: self.terminal.environment_shell(),
                            }),
                        },
                    )
                    .await?;
                }

                outcome = self.updater.next() => {
                    if let Some(release) = self.updater.complete(outcome) {
                        send_json(
                            &control,
                            &ClientMessage::UpdateStatus {
                                generation: &generation,
                                release: &release,
                                status: UpdateStatus::Failed,
                            },
                        )
                        .await?;
                    }
                }
            }
        }
    }

    /// A verified release swaps only while nothing is in flight and every
    /// feature has been quiet for `update::QUIET`.
    fn update_due(&self, session_busy: bool, last_feature_activity: Instant) -> bool {
        self.updater.ready().is_some()
            && !session_busy
            && last_feature_activity.elapsed() >= update::QUIET
            && self.pending_file_refreshes.is_empty()
            && !self.changes_scheduler.busy()
    }

    /// Report the swap and put the verified binary in place. Returns false,
    /// after reporting the failure, when the running image must stay.
    async fn install_update(
        &mut self,
        control: &Sender<Message>,
        generation: &str,
    ) -> Result<bool, SessionExit> {
        let release = self.updater.ready().unwrap_or_default().to_owned();
        send_json(
            control,
            &ClientMessage::UpdateStatus {
                generation,
                release: &release,
                status: UpdateStatus::Applying,
            },
        )
        .await?;
        if let Err(error) = self.updater.install() {
            eprintln!("dxd update install failed: {error}");
            send_json(
                control,
                &ClientMessage::UpdateStatus {
                    generation,
                    release: &release,
                    status: UpdateStatus::Failed,
                },
            )
            .await?;
            return Ok(false);
        }
        let output = self
            .terminal
            .drain_output()
            .map_err(SessionExit::Terminal)?;
        send_terminal_output(control, output).await?;
        Ok(true)
    }

    fn reexec_after_update(&mut self) -> ! {
        let handoff = self
            .terminal
            .prepare_handoff()
            .map(|encoded| (crate::terminal::HANDOFF_VARIABLE, encoded));
        eprintln!("dxd restarting into the updated release");
        let error = update::reexec(self.updater.current_exe(), handoff);
        eprintln!("dxd re-exec failed: {error}");
        std::process::exit(1);
    }

    async fn handle_server_message(
        &mut self,
        message: ServerMessage,
        generation: &str,
        control: &Sender<Message>,
        pending_workload_identity: &mut PendingWorkloadIdentity,
        environment_task: &mut Option<(String, JoinHandle<Materialized>)>,
        workspace_root: &Path,
    ) -> Result<(), SessionExit> {
        match message {
            ServerMessage::HeartbeatAck { generation: seen } if seen == generation => {}
            ServerMessage::ReadinessPing {
                generation: seen,
                request_id,
            } if seen == generation && !request_id.is_empty() && request_id.len() <= 64 => {
                send_json(
                    control,
                    &ClientMessage::ReadinessPong {
                        generation,
                        request_id: &request_id,
                    },
                )
                .await?;
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
                self.changes_scheduler.enqueue(refresh, Instant::now());
            }
            ServerMessage::Request {
                generation: seen,
                request_id,
                operation,
            } if seen == generation => {
                if request_id.is_empty() || request_id.len() > 128 {
                    return Err(SessionExit::Protocol("invalid request id"));
                }
                let refresh = operation.refresh();
                if matches!(
                    &operation,
                    RequestOperation::Files(FilesOperation::Save { refresh: None, .. })
                ) && self.config.local_runtime.is_none()
                {
                    return Err(SessionExit::Protocol("files save without refresh"));
                }
                if refresh.as_ref().is_some_and(|value| !valid_refresh(value)) {
                    return Err(SessionExit::Protocol("invalid request refresh"));
                }
                match operation {
                    RequestOperation::Files(operation) => {
                        if self.pending_file_refreshes.contains_key(&request_id) {
                            return Err(SessionExit::Protocol("duplicate files request id"));
                        }
                        if self.files.submit(request_id.clone(), operation) {
                            self.pending_file_refreshes.insert(request_id, refresh);
                        } else {
                            send_json(
                                control,
                                &ClientMessage::Response {
                                    generation,
                                    request_id: &request_id,
                                    result: OperationResult::Files(FilesResult::Unavailable),
                                },
                            )
                            .await?;
                        }
                    }
                    RequestOperation::Environment(EnvironmentOperation::Check(check)) => {
                        let kind = self.environment.check(&check);
                        send_json(
                            control,
                            &ClientMessage::Response {
                                generation,
                                request_id: &request_id,
                                result: OperationResult::Environment(EnvironmentResult {
                                    kind,
                                    generation: check.generation,
                                    shell: self.terminal.environment_shell(),
                                }),
                            },
                        )
                        .await?;
                    }
                    RequestOperation::Environment(EnvironmentOperation::Activate(operation)) => {
                        let outcome = if environment_task.is_some() {
                            Err(EnvironmentOutcome::Unavailable)
                        } else {
                            self.environment.admit(&operation)
                        };
                        match outcome {
                            Ok(admitted) => {
                                let root = workspace_root.to_owned();
                                let task = tokio::task::spawn_blocking(move || {
                                    admitted.materialize(&root)
                                });
                                *environment_task = Some((request_id, task));
                            }
                            Err(kind) => {
                                send_json(
                                    control,
                                    &ClientMessage::Response {
                                        generation,
                                        request_id: &request_id,
                                        result: OperationResult::Environment(EnvironmentResult {
                                            kind,
                                            generation: operation.generation,
                                            shell: self.terminal.environment_shell(),
                                        }),
                                    },
                                )
                                .await?;
                            }
                        }
                    }
                }
            }
            ServerMessage::WorkloadIdentityResponse {
                generation: seen,
                request_id,
                result,
            } if seen == generation && result.valid() => {
                pending_workload_identity.respond(&request_id, result)?;
            }
            ServerMessage::Update {
                generation: seen,
                url,
                sha256,
                release,
            } if seen == generation => {
                self.updater.request(UpdateRequest {
                    url,
                    sha256,
                    release,
                });
            }
            ServerMessage::TerminalOpen {
                terminal_version,
                terminal: terminal_name,
                mode,
                expected_resident_generation,
                dimensions,
            } => {
                let output = self
                    .terminal
                    .open(
                        terminal_version,
                        &terminal_name,
                        &mode,
                        expected_resident_generation,
                        dimensions,
                    )
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            ServerMessage::TerminalResetAttachments {
                terminal_version,
                terminal: terminal_name,
                resident_generation,
            } => {
                let output = self
                    .terminal
                    .reset_attachments(terminal_version, &terminal_name, resident_generation)
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            ServerMessage::TerminalAttach {
                terminal_version,
                terminal: terminal_name,
                resident_generation,
                attachment_generation,
                resize_ordinal,
                dimensions,
            } => {
                let output = self
                    .terminal
                    .attach(
                        terminal_version,
                        &terminal_name,
                        resident_generation,
                        attachment_generation,
                        resize_ordinal.0,
                        dimensions,
                    )
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            ServerMessage::TerminalResize {
                terminal_version,
                terminal: terminal_name,
                resident_generation,
                attachment_generation,
                resize_ordinal,
                dimensions,
            } => {
                let output = self
                    .terminal
                    .resize(
                        terminal_version,
                        &terminal_name,
                        resident_generation,
                        attachment_generation,
                        resize_ordinal.0,
                        dimensions,
                    )
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            ServerMessage::TerminalDetach {
                terminal_version,
                terminal: terminal_name,
                resident_generation,
                attachment_generation,
                reason,
            } => {
                let output = self
                    .terminal
                    .detach(
                        terminal_version,
                        &terminal_name,
                        resident_generation,
                        attachment_generation,
                        &reason,
                    )
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            ServerMessage::TerminalRestart {
                terminal_version,
                terminal: terminal_name,
                expected_resident_generation,
                dimensions,
            } => {
                let output = self
                    .terminal
                    .restart(
                        terminal_version,
                        &terminal_name,
                        expected_resident_generation,
                        dimensions,
                    )
                    .map_err(SessionExit::Terminal)?;
                send_terminal_output(control, output).await?;
            }
            _ => return Err(SessionExit::Protocol("unexpected server message")),
        }
        Ok(())
    }

    async fn deliver_files_result(
        &mut self,
        completed: FilesDone,
        generation: &str,
        control: &Sender<Message>,
        bulk: &UnboundedSender<BulkFrame>,
    ) -> Result<(), SessionExit> {
        let refresh = self
            .pending_file_refreshes
            .remove(&completed.request_id)
            .flatten();
        let saved = matches!(&completed.result, FilesResult::Saved { .. });
        match completed.result {
            // File bytes travel as binary frames, not base64 inside JSON.
            FilesResult::Sandbox(SandboxReadResult::SandboxChunk {
                version,
                size_bytes,
                offset,
                bytes,
            }) => {
                let frames = files_sandbox::chunk_frames(
                    generation,
                    &completed.request_id,
                    &version,
                    size_bytes,
                    offset,
                    &bytes,
                )
                .map_err(SessionExit::Encode)?;
                drop(bytes);
                let admission = Arc::new(completed.admission);
                for frame in frames {
                    if frame.len() > MAX_CLIENT_FRAME_BYTES {
                        return Err(SessionExit::Protocol("file chunk frame too large"));
                    }
                    bulk.send(BulkFrame {
                        message: Message::Binary(Bytes::from(frame)),
                        windowed: true,
                        _admission: Some(Arc::clone(&admission)),
                    })
                    .map_err(|_| SessionExit::Socket)?;
                }
            }
            result => {
                send_json(
                    control,
                    &ClientMessage::Response {
                        generation,
                        request_id: &completed.request_id,
                        result: OperationResult::Files(result),
                    },
                )
                .await?
            }
        }
        if saved {
            if let Some(refresh) = refresh {
                self.changes_scheduler.enqueue(refresh, Instant::now());
            }
        }
        Ok(())
    }
}

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn write_loop(
    mut sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    mut control: Receiver<Message>,
    mut bulk: UnboundedReceiver<BulkFrame>,
    window: Arc<tokio::sync::Semaphore>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    // A windowed frame waits here for an acknowledgement while control and
    // Terminal frames keep flowing.
    let mut waiting: Option<BulkFrame> = None;
    loop {
        tokio::select! {
            biased;
            message = control.recv() => match message {
                Some(message) => sink.send(message).await?,
                None => return Ok(()),
            },
            permit = window.acquire(), if waiting.is_some() => {
                permit.expect("window semaphore is never closed").forget();
                let frame = waiting.take().expect("a frame is waiting");
                sink.send(frame.message).await?;
            }
            frame = bulk.recv(), if waiting.is_none() => match frame {
                Some(frame) if frame.windowed => waiting = Some(frame),
                Some(frame) => sink.send(frame.message).await?,
                None => return Ok(()),
            },
        }
    }
}

fn valid_generation(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn valid_refresh(refresh: &RefreshRequest) -> bool {
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
pub struct PendingWorkloadIdentity {
    pub(crate) requests: HashMap<String, (Instant, LocalRequest)>,
    pub(crate) expired: VecDeque<String>,
}

impl PendingWorkloadIdentity {
    pub(crate) fn expire(&mut self, now: Instant) {
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

    /// Late or duplicate replies are not daemon protocol faults: discarding
    /// them preserves the resident session.
    pub(crate) fn respond(
        &mut self,
        request_id: &str,
        result: WorkloadIdentityResult,
    ) -> Result<(), SessionExit> {
        if let Some((_, request)) = self.requests.remove(request_id) {
            request.respond(result);
        }
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

async fn dispatch_workload_identity_request(
    control: &Sender<Message>,
    generation: &str,
    request: LocalRequest,
    session_epoch: u64,
    pending: &mut PendingWorkloadIdentity,
) -> Result<(), SessionExit> {
    if request.epoch != session_epoch
        || pending.requests.len() >= MAX_CONCURRENT_WORKLOAD_IDENTITY_REQUESTS
        || pending.requests.contains_key(&request.request_id)
        || pending.expired.contains(&request.request_id)
    {
        request.respond(WorkloadIdentityResult::Unavailable);
        return Ok(());
    }
    if let Err(exit) = send_json(
        control,
        &ClientMessage::WorkloadIdentityRequest {
            generation,
            request_id: &request.request_id,
            request: &request.request,
        },
    )
    .await
    {
        request.respond(WorkloadIdentityResult::Unavailable);
        return Err(exit);
    }
    pending
        .requests
        .insert(request.request_id.clone(), (Instant::now(), request));
    Ok(())
}

async fn send_json<S: Serialize>(lane: &Sender<Message>, value: &S) -> Result<(), SessionExit> {
    let text = serde_json::to_string(value).map_err(SessionExit::Encode)?;
    if text.len() > MAX_CLIENT_FRAME_BYTES {
        return Err(SessionExit::Protocol("client frame too large"));
    }
    lane.send(Message::Text(text.into()))
        .await
        .map_err(|_| SessionExit::Socket)
}

async fn send_terminal_output(
    control: &Sender<Message>,
    output: Vec<TerminalOutbound>,
) -> Result<(), SessionExit> {
    for message in output {
        match message {
            TerminalOutbound::Control(control_message) => {
                let text = serde_json::to_string(&control_message).map_err(SessionExit::Encode)?;
                if text.len() > MAX_CONTROL_FRAME_BYTES {
                    return Err(SessionExit::Protocol("terminal control frame too large"));
                }
                control
                    .send(Message::Text(text.into()))
                    .await
                    .map_err(|_| SessionExit::Socket)?;
            }
            TerminalOutbound::Binary(bytes) => {
                control
                    .send(Message::Binary(Bytes::from(bytes)))
                    .await
                    .map_err(|_| SessionExit::Socket)?;
            }
        }
    }
    Ok(())
}

/// Detects a VM suspension between two observations: the wall clock moved
/// well past the monotonic clock, which does not advance while paused.
struct SuspensionClock {
    wall: SystemTime,
    monotonic: Instant,
}

impl SuspensionClock {
    fn now() -> Self {
        Self {
            wall: SystemTime::now(),
            monotonic: Instant::now(),
        }
    }

    fn suspended_since_last(&mut self) -> bool {
        let next = Self::now();
        let suspended = suspended_between(
            next.wall.duration_since(self.wall).unwrap_or_default(),
            next.monotonic.duration_since(self.monotonic),
        );
        *self = next;
        suspended
    }
}

fn suspended_between(wall_elapsed: Duration, monotonic_elapsed: Duration) -> bool {
    wall_elapsed > monotonic_elapsed + SUSPENSION_GAP
}

/// Wakes when the wall clock is stepped. E2B sets the guest clock the moment
/// it resumes a paused VM, so this reports a resume at once instead of on the
/// next heartbeat tick, whose monotonic timer froze with the VM. The kernel
/// reports clock steps through a `timerfd` with `TFD_TIMER_CANCEL_ON_SET`.
struct ClockStepSignal {
    timer: Option<tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>>,
}

impl ClockStepSignal {
    fn install() -> Self {
        let timer = clock_step::open()
            .and_then(tokio::io::unix::AsyncFd::new)
            .map_err(|error| eprintln!("dxd clock-step detection unavailable: {error}"))
            .ok();
        Self { timer }
    }

    async fn stepped(&mut self) {
        while let Some(timer) = self.timer.as_ref() {
            let Ok(mut ready) = timer.readable().await else {
                self.timer = None;
                break;
            };
            match clock_step::consume(timer.get_ref()) {
                Ok(true) => return,
                Ok(false) => ready.clear_ready(),
                Err(error) => {
                    eprintln!("dxd clock-step detection stopped: {error}");
                    self.timer = None;
                }
            }
        }
        std::future::pending::<()>().await;
    }
}

mod clock_step {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    pub fn open() -> std::io::Result<OwnedFd> {
        // SAFETY: plain syscall; the descriptor is owned below.
        let fd = unsafe {
            libc::timerfd_create(libc::CLOCK_REALTIME, libc::TFD_NONBLOCK | libc::TFD_CLOEXEC)
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: `fd` is a new descriptor nothing else owns.
        let timer = unsafe { OwnedFd::from_raw_fd(fd) };
        arm(&timer)?;
        Ok(timer)
    }

    /// An absolute expiry far in the future that is cancelled by any step.
    fn arm(timer: &OwnedFd) -> std::io::Result<()> {
        let spec = libc::itimerspec {
            it_interval: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
            it_value: libc::timespec {
                // Half the 64-bit range (both targets have a 64-bit time_t).
                tv_sec: (i64::MAX / 2) as _,
                tv_nsec: 0,
            },
        };
        // SAFETY: valid descriptor and a fully initialized `itimerspec`.
        let result = unsafe {
            libc::timerfd_settime(
                timer.as_raw_fd(),
                libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET,
                &spec,
                std::ptr::null_mut(),
            )
        };
        if result < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Returns true when the clock was stepped (and re-arms), false when the
    /// readiness was spurious.
    pub fn consume(timer: &OwnedFd) -> std::io::Result<bool> {
        let mut expirations = [0u8; 8];
        // SAFETY: reads at most eight bytes into a local buffer.
        let read = unsafe { libc::read(timer.as_raw_fd(), expirations.as_mut_ptr().cast(), 8) };
        if read >= 0 {
            arm(timer)?;
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ECANCELED) => {
                arm(timer)?;
                Ok(true)
            }
            Some(libc::EAGAIN) | Some(libc::EINTR) => Ok(false),
            _ => Err(error),
        }
    }
}

/// `SIGHUP` asks the daemon to re-read its configuration and reconnect without
/// restarting, so the shell it owns survives a bootstrap repair.
struct ReconnectSignal {
    hangup: Option<tokio::signal::unix::Signal>,
}

impl ReconnectSignal {
    fn install() -> Self {
        Self {
            hangup: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()).ok(),
        }
    }

    async fn requested(&mut self) {
        if let Some(hangup) = self.hangup.as_mut()
            && hangup.recv().await.is_some()
        {
            return;
        }
        std::future::pending::<()>().await;
    }
}

pub fn changes_candidate_json(
    token: &str,
    outcome: &CandidateOutcome,
) -> Result<String, SessionExit> {
    let text = serde_json::to_string(&ClientMessage::ChangesCandidate { token, outcome })
        .map_err(SessionExit::Encode)?;
    if text.len() <= MAX_CHANGES_CANDIDATE_BYTES {
        return Ok(text);
    }
    let unavailable = CandidateOutcome::Unavailable {
        reason: UnavailableReason::CandidateTooLarge,
    };
    serde_json::to_string(&ClientMessage::ChangesCandidate {
        token,
        outcome: &unavailable,
    })
    .map_err(SessionExit::Encode)
}

async fn send_changes_candidate(
    bulk: &UnboundedSender<BulkFrame>,
    token: &str,
    outcome: &CandidateOutcome,
) -> Result<(), SessionExit> {
    let text = changes_candidate_json(token, outcome)?;
    bulk.send(BulkFrame {
        message: Message::Text(text.into()),
        windowed: false,
        _admission: None,
    })
    .map_err(|_| SessionExit::Socket)
}

/// Parse one server frame and enforce the bound that applies to its kind.
pub fn decode_server(text: &str) -> Result<ServerMessage, SessionExit> {
    if text.len() > MAX_ENVIRONMENT_REQUEST_FRAME_BYTES {
        return Err(SessionExit::Protocol("server frame too large"));
    }
    let message: ServerMessage = serde_json::from_str(text)
        .map_err(|_| SessionExit::Protocol("malformed server message"))?;
    if !message.has_valid_conditional_fields() {
        return Err(SessionExit::Protocol("invalid server message fields"));
    }
    let bound = match &message {
        ServerMessage::Request {
            operation: RequestOperation::Environment(EnvironmentOperation::Activate(_)),
            ..
        } => MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
        ServerMessage::Request { .. } => MAX_REQUEST_FRAME_BYTES,
        ServerMessage::WorkloadIdentityResponse { .. } => MAX_WORKLOAD_IDENTITY_FRAME_BYTES,
        _ => MAX_CONTROL_FRAME_BYTES,
    };
    if text.len() > bound {
        Err(SessionExit::Protocol("server frame exceeds bound"))
    } else {
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suspension_is_a_wall_clock_jump_beyond_monotonic_progress() {
        let second = Duration::from_secs(1);
        assert!(!suspended_between(2 * second, 2 * second), "a normal tick");
        assert!(
            !suspended_between(2 * second + second / 10, 2 * second),
            "ordinary clock slew"
        );
        assert!(
            suspended_between(4 * second, 2 * second),
            "a pause the focused Terminal wakes at once"
        );
        assert!(
            suspended_between(30 * second, 2 * second),
            "an E2B memory pause"
        );
        assert!(
            !suspended_between(Duration::ZERO, 2 * second),
            "wall clock stepped back"
        );
    }

    #[tokio::test]
    async fn clock_step_signal_arms_and_stays_quiet_without_a_step() {
        let mut signal = ClockStepSignal::install();
        assert!(signal.timer.is_some(), "timerfd armed");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), signal.stepped())
                .await
                .is_err()
        );
    }
}
