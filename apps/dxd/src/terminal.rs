//! Resident terminal: one login shell on a daemon-owned PTY, a bounded replay
//! ring, up to eight browser attachments, and FIFO input.
//!
//! dxd owns the PTY directly (`openpty`, a session-leading login shell).
//! Output volume never ends the session: when the outbound path is slow the
//! bounded channel blocks the reader thread and the kernel PTY buffer blocks
//! the shell, which is ordinary terminal back-pressure.

use crate::environment::base_environment_for;
use crate::protocol::{
    Dimensions, TERMINAL_HEADER_BYTES, TERMINAL_MAX_PAYLOAD_BYTES, TERMINAL_VERSION,
    TerminalClientMessage, TerminalFrame, TerminalGeneration, TerminalHeartbeat, U64String,
    decode_terminal_frame, encode_terminal_frame,
};
use bytes::Bytes;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{Receiver, Sender, channel, error::TryRecvError};

const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1_024;
const REPLAY_BYTE_LIMIT: usize = 65_536;
const REPLAY_LINE_LIMIT: usize = 10_000;
const ATTACHMENT_LIMIT: usize = 8;
const INPUT_ATTACHMENT_BYTE_LIMIT: usize = 256 * 1_024;
const INPUT_TOTAL_BYTE_LIMIT: usize = 2 * 1_024 * 1_024;
const INPUT_FRAME_LIMIT: usize = 32;
const FIRST_OUTPUT_TIMEOUT: Duration = Duration::from_secs(10);
const SHELL_HANGUP_GRACE: Duration = Duration::from_millis(250);
/// State-directory file naming the current resident. It outlives the daemon
/// process, the shell does not.
const RESIDENT_RECORD: &str = "terminal-resident";

#[derive(Debug)]
pub enum ReaderEvent {
    Output(Bytes, usize),
    Closed,
}

#[derive(Clone, Debug)]
struct OutputChunk {
    sequence: u64,
    payload: Bytes,
    lines: usize,
}

pub struct ResidentProcess {
    /// The PTY master; absent only in tests without a terminal.
    master: Option<OwnedFd>,
    /// The login shell: spawned here, or inherited across a self-update exec.
    shell: Option<Shell>,
    writer: Box<dyn Write + Send>,
    output: Receiver<ReaderEvent>,
}

impl ResidentProcess {
    fn master_fd(&self) -> Option<RawFd> {
        self.master.as_ref().map(AsRawFd::as_raw_fd)
    }

    fn resize(&self, dimensions: Dimensions) -> io::Result<()> {
        let Some(fd) = self.master_fd() else {
            return Ok(());
        };
        // SAFETY: fd is the live PTY master and the winsize is valid.
        if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &window_size(dimensions)) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// A shell that is a child of this process and not yet reaped.
#[derive(Debug)]
struct Shell {
    pid: i32,
}

impl Shell {
    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        let mut status = 0;
        // SAFETY: waitpid on an owned child with WNOHANG.
        match unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) } {
            0 => Ok(None),
            pid if pid == self.pid => Ok(Some(status)),
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// Hang up as a closed terminal window does: SIGHUP (the shell saves
    /// history and hangs up its jobs), SIGKILL after a grace, then reap.
    fn hang_up(mut self) {
        if !matches!(self.try_wait(), Ok(None)) {
            // Already reaped: the pid may belong to someone else by now.
            return;
        }
        // SAFETY: signalling a child this process has not reaped.
        unsafe { libc::kill(self.pid, libc::SIGHUP) };
        let deadline = Instant::now() + SHELL_HANGUP_GRACE;
        while Instant::now() < deadline {
            if !matches!(self.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: as above; the child is still running.
        unsafe { libc::kill(self.pid, libc::SIGKILL) };
        let mut status = 0;
        // SAFETY: blocking waitpid on an owned child.
        unsafe { libc::waitpid(self.pid, &mut status, 0) };
    }
}

struct QueuedInput {
    attachment_generation: TerminalGeneration,
    payload: Vec<u8>,
    frame_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResidentState {
    Absent,
    Starting,
    Ready,
    Exited,
    Failed,
}

pub enum TerminalOutbound {
    Control(TerminalClientMessage),
    Binary(Vec<u8>),
}

/// Which shell the resident runs and how it is configured.
#[derive(Clone)]
pub struct ShellProfile {
    pub home: PathBuf,
    pub user: String,
    /// Local development sources this rc file instead of the login profile.
    pub rcfile: Option<PathBuf>,
}

pub struct TerminalRuntime {
    pub(crate) root: PathBuf,
    state: ResidentState,
    generation: Option<TerminalGeneration>,
    process: Option<ResidentProcess>,
    first_output_deadline: Option<Instant>,
    dimensions: Dimensions,
    dimensions_revision: u64,
    next_output_sequence: u64,
    next_input_sequence: u64,
    next_resize_ordinal: u64,
    attachments: HashSet<TerminalGeneration>,
    input_queue: VecDeque<QueuedInput>,
    input_bytes: usize,
    attachment_input_bytes: HashMap<TerminalGeneration, usize>,
    replay: VecDeque<OutputChunk>,
    replay_bytes: usize,
    replay_lines: usize,
    replay_truncated: bool,
    applied_environment_generation: u64,
    shell_environment_generation: Option<u64>,
    restart_required: bool,
    environment_values: BTreeMap<String, String>,
    profile: ShellProfile,
    record: Option<PathBuf>,
    #[cfg(test)]
    resize_observer: Option<std::sync::mpsc::SyncSender<Dimensions>>,
    #[cfg(test)]
    foreground_observer: Option<bool>,
}

impl TerminalRuntime {
    pub fn new(root: PathBuf, profile: ShellProfile) -> Self {
        Self {
            root,
            state: ResidentState::Absent,
            generation: None,
            process: None,
            first_output_deadline: None,
            dimensions: Dimensions::INITIAL,
            dimensions_revision: 0,
            next_output_sequence: 1,
            next_input_sequence: 1,
            next_resize_ordinal: 1,
            attachments: HashSet::new(),
            input_queue: VecDeque::new(),
            input_bytes: 0,
            attachment_input_bytes: HashMap::new(),
            replay: VecDeque::new(),
            replay_bytes: 0,
            replay_lines: 0,
            replay_truncated: false,
            applied_environment_generation: 0,
            shell_environment_generation: None,
            restart_required: false,
            environment_values: BTreeMap::new(),
            profile,
            record: None,
            #[cfg(test)]
            resize_observer: None,
            #[cfg(test)]
            foreground_observer: None,
        }
    }

    pub fn guest(root: PathBuf, state_root: &Path) -> Self {
        Self::new(
            root,
            ShellProfile {
                home: PathBuf::from("/home/user"),
                user: "user".into(),
                rcfile: None,
            },
        )
        .recorded_in(state_root)
    }

    pub fn local(root: PathBuf, home: PathBuf, state_root: PathBuf) -> Self {
        Self::new(
            root,
            ShellProfile {
                home,
                user: std::env::var("USER")
                    .or_else(|_| std::env::var("USERNAME"))
                    .unwrap_or_else(|_| "user".into()),
                rcfile: Some(state_root.join("dx-terminal/profile")),
            },
        )
        .recorded_in(&state_root)
    }

    /// Recover the resident a previous daemon process recorded. The shell
    /// died with that process (crash, `kill -9`, panic abort, or a restart),
    /// so it is reported as exited: the browser offers Restart instead of
    /// Core silently opening a new shell that looks like the old one. A
    /// successful self-update handoff replaces this with the live shell.
    fn recorded_in(mut self, state_root: &Path) -> Self {
        let path = state_root.join(RESIDENT_RECORD);
        if let Some(generation) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<TerminalGeneration>(&bytes).ok())
        {
            self.generation = Some(generation);
            self.state = ResidentState::Exited;
        }
        self.record = Some(path);
        self
    }

    /// Write the current resident generation before its shell starts.
    fn record_resident(&self) {
        let (Some(path), Some(generation)) = (self.record.as_ref(), self.generation) else {
            return;
        };
        let temporary = path.with_extension("tmp");
        let written = serde_json::to_vec(&generation)
            .map_err(io::Error::from)
            .and_then(|bytes| std::fs::write(&temporary, bytes))
            .and_then(|()| std::fs::rename(&temporary, path));
        if let Err(error) = written {
            eprintln!("dxd could not record the terminal resident: {error}");
        }
    }

    pub fn heartbeat(&self) -> TerminalHeartbeat {
        let Some(generation) = self.generation else {
            return TerminalHeartbeat::Absent {
                terminal_version: TERMINAL_VERSION,
                terminal: "default",
            };
        };
        let foreground_command = self.foreground_command();
        let common = (
            TERMINAL_VERSION,
            "default",
            generation,
            foreground_command,
            self.restart_required,
        );
        match self.state {
            ResidentState::Absent => TerminalHeartbeat::Absent {
                terminal_version: TERMINAL_VERSION,
                terminal: "default",
            },
            ResidentState::Starting => TerminalHeartbeat::Starting {
                terminal_version: common.0,
                terminal: common.1,
                resident_generation: common.2,
                foreground_command: common.3,
                restart_required: common.4,
            },
            ResidentState::Ready => TerminalHeartbeat::Ready {
                terminal_version: common.0,
                terminal: common.1,
                resident_generation: common.2,
                foreground_command: common.3,
                restart_required: common.4,
            },
            ResidentState::Exited => TerminalHeartbeat::Exited {
                terminal_version: common.0,
                terminal: common.1,
                resident_generation: common.2,
                foreground_command: common.3,
                restart_required: common.4,
            },
            ResidentState::Failed => TerminalHeartbeat::Failed {
                terminal_version: common.0,
                terminal: common.1,
                resident_generation: common.2,
                foreground_command: common.3,
                restart_required: common.4,
            },
        }
    }

    pub fn resident_state(&self) -> Option<TerminalClientMessage> {
        let generation = self.generation?;
        let state = match self.state {
            ResidentState::Absent => return None,
            ResidentState::Starting => "starting",
            ResidentState::Ready => "ready",
            ResidentState::Exited => "exited",
            ResidentState::Failed => "failed",
        };
        Some(TerminalClientMessage::ResidentState {
            terminal_version: TERMINAL_VERSION,
            terminal: "default",
            resident_generation: generation,
            state,
            dimensions: self.dimensions,
            next_output_sequence: U64String(self.next_output_sequence),
            foreground_command: self.foreground_command(),
            restart_required: self.restart_required,
        })
    }

    pub fn open(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        mode: &str,
        expected_resident_generation: Option<TerminalGeneration>,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        self.validate_common(terminal_version, terminal, dimensions)?;
        match mode {
            "open-if-absent" if expected_resident_generation.is_none() => {
                if self.state != ResidentState::Absent {
                    return Ok(self
                        .resident_state()
                        .into_iter()
                        .map(TerminalOutbound::Control)
                        .collect());
                }
            }
            "restart-exited" => {
                let Some(expected) = expected_resident_generation else {
                    return Err(invalid_control());
                };
                if self.generation != Some(expected)
                    || !matches!(self.state, ResidentState::Exited | ResidentState::Failed)
                {
                    return Ok(self
                        .resident_state()
                        .into_iter()
                        .map(TerminalOutbound::Control)
                        .collect());
                }
                self.stop_process();
                self.reset_resident_state();
            }
            _ => return Err(invalid_control()),
        }

        let generation = TerminalGeneration::random();
        self.generation = Some(generation);
        self.state = ResidentState::Starting;
        self.record_resident();
        self.dimensions = dimensions;
        if self.applied_environment_generation == 0 {
            self.state = ResidentState::Failed;
            return Ok(vec![TerminalOutbound::Control(
                self.resident_state().expect("failed resident has state"),
            )]);
        }
        self.process = match spawn_shell(
            &self.root,
            dimensions,
            &self.environment_values,
            &self.profile,
        ) {
            Ok(process) => Some(process),
            Err(_) => {
                self.state = ResidentState::Failed;
                return Ok(vec![TerminalOutbound::Control(
                    self.resident_state().expect("failed resident has state"),
                )]);
            }
        };
        self.first_output_deadline = Some(Instant::now() + FIRST_OUTPUT_TIMEOUT);
        Ok(vec![TerminalOutbound::Control(
            self.resident_state().expect("starting resident has state"),
        )])
    }

    pub fn restart(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        expected_resident_generation: TerminalGeneration,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        self.validate_common(terminal_version, terminal, dimensions)?;
        if self.generation != Some(expected_resident_generation)
            || self.state != ResidentState::Ready
            || !self.restart_required
        {
            return Ok(self
                .resident_state()
                .into_iter()
                .map(TerminalOutbound::Control)
                .collect());
        }
        self.stop_process();
        self.reset_resident_state();
        self.shell_environment_generation = Some(self.applied_environment_generation);
        self.restart_required = false;
        self.open(
            terminal_version,
            terminal,
            "open-if-absent",
            None,
            dimensions,
        )
    }

    pub fn environment_shell(&self) -> crate::environment::EnvironmentShell {
        use crate::environment::EnvironmentShell;
        if self.shell_environment_generation.is_none() {
            EnvironmentShell::NoShell
        } else if self.restart_required {
            EnvironmentShell::RestartRequired
        } else {
            EnvironmentShell::Current
        }
    }

    /// Record a newly applied environment. Future shells receive it directly;
    /// a running shell keeps its values until the owner confirms a restart.
    pub fn refresh_environment(
        &mut self,
        values: &BTreeMap<String, String>,
        generation: u64,
        changed: bool,
    ) {
        self.environment_values = values.clone();
        let shell_running = self.process.is_some()
            && matches!(self.state, ResidentState::Starting | ResidentState::Ready);
        if !shell_running {
            self.applied_environment_generation = generation;
            self.shell_environment_generation = None;
            self.restart_required = false;
            return;
        }
        let shell_was_current =
            self.shell_environment_generation == Some(self.applied_environment_generation);
        self.applied_environment_generation = generation;
        if self.state == ResidentState::Starting {
            // Ready promotion records the generation the shell started with.
            return;
        }
        if !changed && shell_was_current {
            self.shell_environment_generation = Some(generation);
            self.restart_required = false;
        } else {
            self.restart_required = self.shell_environment_generation.is_some();
        }
    }

    pub fn attach(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
        attachment_generation: TerminalGeneration,
        resize_ordinal: u64,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        self.validate_common(terminal_version, terminal, dimensions)?;
        if self.generation != Some(resident_generation) {
            return Ok(vec![TerminalOutbound::Control(
                TerminalClientMessage::Error {
                    terminal_version: TERMINAL_VERSION,
                    resident_generation,
                    attachment_generation: Some(attachment_generation),
                    code: "invalid-attachment",
                },
            )]);
        }
        if self.state != ResidentState::Ready {
            return Ok(vec![
                self.error(Some(attachment_generation), "terminal-unavailable"),
            ]);
        }
        if self.attachments.len() >= ATTACHMENT_LIMIT {
            return Ok(vec![
                self.error(Some(attachment_generation), "attachment-limit"),
            ]);
        }
        if self.attachments.contains(&attachment_generation) {
            return Ok(vec![
                self.error(Some(attachment_generation), "invalid-attachment"),
            ]);
        }
        if resize_ordinal != self.next_resize_ordinal {
            return Ok(vec![
                self.error(Some(attachment_generation), "invalid-attachment"),
            ]);
        }
        if self.advance_resize_ordinal().is_err() {
            return self.fail_resident("terminal-unavailable");
        }
        self.attachments.insert(attachment_generation);
        if self.apply_dimensions(dimensions).is_err() {
            return self.fail_resident("terminal-unavailable");
        }

        let first = self
            .replay
            .front()
            .map_or(self.next_output_sequence, |chunk| chunk.sequence);
        let through = self.next_output_sequence - 1;
        let mut outbound = Vec::with_capacity(self.replay.len() + 3);
        outbound.push(TerminalOutbound::Control(
            TerminalClientMessage::Dimensions {
                terminal_version: TERMINAL_VERSION,
                resident_generation,
                resize_ordinal: U64String(resize_ordinal),
                dimensions_revision: U64String(self.dimensions_revision),
                dimensions: self.dimensions,
            },
        ));
        outbound.push(TerminalOutbound::Control(
            TerminalClientMessage::ReplayStart {
                terminal_version: TERMINAL_VERSION,
                resident_generation,
                attachment_generation,
                first_output_sequence: U64String(first),
                through_output_sequence: U64String(through),
                replay_bytes: self.replay_bytes,
                truncated: self.replay_truncated,
            },
        ));
        for chunk in &self.replay {
            outbound.push(TerminalOutbound::Binary(
                encode_terminal_frame(&TerminalFrame {
                    kind: 2,
                    resident_generation,
                    attachment_generation: Some(attachment_generation),
                    sequence: chunk.sequence,
                    payload: chunk.payload.to_vec(),
                })
                .map_err(|_| io::Error::other("invalid replay frame"))?,
            ));
        }
        outbound.push(TerminalOutbound::Control(
            TerminalClientMessage::AttachmentReady {
                terminal_version: TERMINAL_VERSION,
                resident_generation,
                attachment_generation,
                through_output_sequence: U64String(through),
                dimensions_revision: U64String(self.dimensions_revision),
                dimensions: self.dimensions,
            },
        ));
        Ok(outbound)
    }

    pub fn resize(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
        attachment_generation: TerminalGeneration,
        resize_ordinal: u64,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        self.validate_common(terminal_version, terminal, dimensions)?;
        if self.generation != Some(resident_generation)
            || !self.attachments.contains(&attachment_generation)
        {
            return Ok(Vec::new());
        }
        if resize_ordinal != self.next_resize_ordinal {
            self.attachments.remove(&attachment_generation);
            self.remove_queued_input(attachment_generation);
            return Ok(vec![
                self.error(Some(attachment_generation), "invalid-attachment"),
            ]);
        }
        if self.advance_resize_ordinal().is_err() {
            return self.fail_resident("terminal-unavailable");
        }
        if self.apply_dimensions(dimensions).is_err() {
            return self.fail_resident("terminal-unavailable");
        }
        Ok(vec![TerminalOutbound::Control(
            TerminalClientMessage::Dimensions {
                terminal_version: TERMINAL_VERSION,
                resident_generation,
                resize_ordinal: U64String(resize_ordinal),
                dimensions_revision: U64String(self.dimensions_revision),
                dimensions: self.dimensions,
            },
        )])
    }

    pub fn detach(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
        attachment_generation: TerminalGeneration,
        reason: &str,
    ) -> io::Result<Vec<TerminalOutbound>> {
        if terminal_version != TERMINAL_VERSION
            || terminal != "default"
            || !matches!(
                reason,
                "browser-detached" | "slow-consumer" | "rebind" | "lifecycle"
            )
        {
            return Err(invalid_control());
        }
        if self.generation != Some(resident_generation)
            || !self.attachments.remove(&attachment_generation)
        {
            return Ok(Vec::new());
        }
        self.remove_queued_input(attachment_generation);
        Ok(vec![TerminalOutbound::Control(
            TerminalClientMessage::Detached {
                terminal_version: TERMINAL_VERSION,
                resident_generation,
                attachment_generation,
            },
        )])
    }

    pub fn reset_attachments(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
    ) -> io::Result<Vec<TerminalOutbound>> {
        if terminal_version != TERMINAL_VERSION || terminal != "default" {
            return Err(invalid_control());
        }
        if self.generation == Some(resident_generation) {
            self.attachments.clear();
            self.clear_input_queue();
            self.next_input_sequence = 1;
            self.next_resize_ordinal = 1;
        }
        Ok(Vec::new())
    }

    pub fn input(&mut self, encoded: &[u8]) -> io::Result<Vec<TerminalOutbound>> {
        let frame = decode_terminal_frame(encoded)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid terminal frame"))?;
        let (1, Some(attachment_generation)) = (frame.kind, frame.attachment_generation) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid input frame",
            ));
        };
        if self.generation != Some(frame.resident_generation)
            || !self.attachments.contains(&attachment_generation)
        {
            return Ok(Vec::new());
        }
        if frame.sequence != self.next_input_sequence {
            self.attachments.remove(&attachment_generation);
            self.remove_queued_input(attachment_generation);
            return Ok(vec![
                self.error(Some(attachment_generation), "invalid-attachment"),
            ]);
        }
        let Some(next_input_sequence) = self.next_input_sequence.checked_add(1) else {
            return self.fail_resident("terminal-unavailable");
        };
        self.next_input_sequence = next_input_sequence;
        let attachment_bytes = self
            .attachment_input_bytes
            .get(&attachment_generation)
            .copied()
            .unwrap_or(0);
        let frame_bytes = TERMINAL_HEADER_BYTES + frame.payload.len();
        if self.input_queue.len() >= INPUT_FRAME_LIMIT
            || self.input_bytes + frame_bytes > INPUT_TOTAL_BYTE_LIMIT
            || attachment_bytes + frame_bytes > INPUT_ATTACHMENT_BYTE_LIMIT
        {
            self.attachments.remove(&attachment_generation);
            self.remove_queued_input(attachment_generation);
            return Ok(vec![
                self.error(Some(attachment_generation), "input-overflow"),
            ]);
        }
        self.input_bytes += frame_bytes;
        self.attachment_input_bytes
            .insert(attachment_generation, attachment_bytes + frame_bytes);
        self.input_queue.push_back(QueuedInput {
            attachment_generation,
            payload: frame.payload,
            frame_bytes,
        });
        Ok(Vec::new())
    }

    /// Write every queued input frame to the PTY in acceptance order.
    pub fn drain_input(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        while let Some(input) = self.input_queue.pop_front() {
            self.release_input_usage(input.attachment_generation, input.frame_bytes);
            let Some(process) = self.process.as_mut() else {
                return self.fail_resident("terminal-unavailable");
            };
            if process.writer.write_all(&input.payload).is_err() {
                return self.fail_resident("terminal-unavailable");
            }
        }
        if let Some(process) = self.process.as_mut() {
            let _ = process.writer.flush();
        }
        Ok(Vec::new())
    }

    #[cfg(test)]
    pub fn has_queued_input(&self) -> bool {
        !self.input_queue.is_empty()
    }

    /// Resolve when the PTY reader produced an event. Pending forever without
    /// a process so it can sit in a `select!`.
    pub async fn wait_output(&mut self) -> Option<ReaderEvent> {
        match self.process.as_mut() {
            Some(process) => process.output.recv().await.or(Some(ReaderEvent::Closed)),
            None => std::future::pending().await,
        }
    }

    /// Wake when the first-output deadline of a starting shell passes.
    pub fn first_output_deadline(&self) -> Option<Instant> {
        if self.state == ResidentState::Starting {
            self.first_output_deadline
        } else {
            None
        }
    }

    /// Apply one reader event plus everything else already queued.
    pub fn drain_output(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        self.drain_output_with(None)
    }

    pub fn drain_output_with(
        &mut self,
        first: Option<ReaderEvent>,
    ) -> io::Result<Vec<TerminalOutbound>> {
        let mut received: Vec<(Bytes, usize)> = Vec::new();
        let Some(process) = self.process.as_mut() else {
            return Ok(Vec::new());
        };
        if self.state == ResidentState::Starting
            && self
                .first_output_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return self.fail_resident("terminal-unavailable");
        }
        let mut closed = false;
        let mut pending = first;
        loop {
            let event = match pending.take() {
                Some(event) => event,
                None => match process.output.try_recv() {
                    Ok(event) => event,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        closed = true;
                        break;
                    }
                },
            };
            match event {
                ReaderEvent::Output(payload, lines) => received.push((payload, lines)),
                ReaderEvent::Closed => {
                    closed = true;
                    break;
                }
            }
        }
        if closed {
            // Output that arrived with the close never promotes a starting
            // shell to ready; it only enters replay for the exited resident.
            self.state = ResidentState::Exited;
        }
        let mut outbound = Vec::new();
        for (payload, lines) in received {
            let sequence = self.next_output_sequence;
            if self.accept_output(payload.clone(), lines).is_err() {
                return self.fail_resident("terminal-unavailable");
            }
            if self.state == ResidentState::Starting {
                self.state = ResidentState::Ready;
                self.first_output_deadline = None;
                if self.shell_environment_generation.is_none() {
                    self.shell_environment_generation = Some(self.applied_environment_generation);
                    self.restart_required = false;
                }
                outbound.push(TerminalOutbound::Control(
                    self.resident_state().expect("ready resident has state"),
                ));
            }
            if let Some(resident_generation) = self.generation
                && !self.attachments.is_empty()
            {
                outbound.push(TerminalOutbound::Binary(
                    encode_terminal_frame(&TerminalFrame {
                        kind: 3,
                        resident_generation,
                        attachment_generation: None,
                        sequence,
                        payload: payload.to_vec(),
                    })
                    .map_err(|_| io::Error::other("invalid live frame"))?,
                ));
            }
        }
        if closed {
            outbound.extend(self.fail_resident("terminal-exited")?);
        }
        Ok(outbound)
    }

    /// End a resident whose shell exited while a job it left behind (`sleep
    /// 600 & exit`) still holds the PTY open, so no end-of-file arrives. The
    /// connection loop calls this on its heartbeat tick.
    pub fn reap_exited(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let exited = matches!(self.state, ResidentState::Starting | ResidentState::Ready)
            && self
                .process
                .as_mut()
                .and_then(|process| process.shell.as_mut())
                .is_some_and(|shell| matches!(shell.try_wait(), Ok(Some(_))));
        if !exited {
            return Ok(Vec::new());
        }
        let mut outbound = self.drain_output()?;
        if self.process.is_some() {
            outbound.extend(self.fail_resident("terminal-exited")?);
        }
        Ok(outbound)
    }

    fn fail_resident(&mut self, code: &'static str) -> io::Result<Vec<TerminalOutbound>> {
        self.state = if code == "terminal-exited" {
            ResidentState::Exited
        } else {
            ResidentState::Failed
        };
        let mut outbound = self
            .attachments
            .iter()
            .copied()
            .map(|attachment| self.error(Some(attachment), code))
            .collect::<Vec<_>>();
        self.stop_process();
        self.attachments.clear();
        self.clear_input_queue();
        if let Some(state) = self.resident_state() {
            outbound.push(TerminalOutbound::Control(state));
        }
        Ok(outbound)
    }

    fn release_input_usage(&mut self, attachment: TerminalGeneration, bytes: usize) {
        self.input_bytes = self.input_bytes.saturating_sub(bytes);
        if let Some(usage) = self.attachment_input_bytes.get_mut(&attachment) {
            *usage = usage.saturating_sub(bytes);
            if *usage == 0 {
                self.attachment_input_bytes.remove(&attachment);
            }
        }
    }

    fn remove_queued_input(&mut self, attachment: TerminalGeneration) {
        let mut retained = VecDeque::with_capacity(self.input_queue.len());
        for input in self.input_queue.drain(..) {
            if input.attachment_generation == attachment {
                self.input_bytes = self.input_bytes.saturating_sub(input.frame_bytes);
            } else {
                retained.push_back(input);
            }
        }
        self.input_queue = retained;
        self.attachment_input_bytes.remove(&attachment);
    }

    fn clear_input_queue(&mut self) {
        self.input_queue.clear();
        self.input_bytes = 0;
        self.attachment_input_bytes.clear();
    }

    fn stop_process(&mut self) {
        let Some(mut process) = self.process.take() else {
            return;
        };
        let Some(shell) = process.shell.take() else {
            return;
        };
        // The PTY closes only after the hangup, so the shell sees SIGHUP
        // rather than a closed terminal. The wait runs on its own thread: the
        // connection loop never waits for a shell, even one stuck in the
        // kernel.
        run_detached("dxd-hangup", move || {
            shell.hang_up();
            drop(process);
        });
    }

    fn reset_resident_state(&mut self) {
        self.state = ResidentState::Absent;
        self.generation = None;
        self.first_output_deadline = None;
        self.dimensions = Dimensions::INITIAL;
        self.dimensions_revision = 0;
        self.next_output_sequence = 1;
        self.next_input_sequence = 1;
        self.next_resize_ordinal = 1;
        self.attachments.clear();
        self.clear_input_queue();
        self.replay.clear();
        self.replay_bytes = 0;
        self.replay_lines = 0;
        self.replay_truncated = false;
    }

    fn foreground_command(&self) -> bool {
        if self.state != ResidentState::Ready {
            return false;
        }
        #[cfg(test)]
        if let Some(foreground) = self.foreground_observer {
            return foreground;
        }
        let Some(process) = self.process.as_ref() else {
            return false;
        };
        foreground_differs_from_shell(process)
    }

    fn validate_common(
        &self,
        terminal_version: u8,
        terminal: &str,
        dimensions: Dimensions,
    ) -> io::Result<()> {
        if terminal_version != TERMINAL_VERSION || terminal != "default" || !dimensions.valid() {
            return Err(invalid_control());
        }
        Ok(())
    }

    fn advance_resize_ordinal(&mut self) -> io::Result<()> {
        self.next_resize_ordinal = self
            .next_resize_ordinal
            .checked_add(1)
            .ok_or_else(|| io::Error::other("resize ordinal overflow"))?;
        Ok(())
    }

    fn apply_dimensions(&mut self, dimensions: Dimensions) -> io::Result<()> {
        if dimensions == self.dimensions {
            return Ok(());
        }
        let Some(process) = self.process.as_ref() else {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "resident terminal unavailable",
            ));
        };
        #[cfg(test)]
        if let Some(observer) = &self.resize_observer {
            observer
                .send(dimensions)
                .map_err(|_| io::Error::other("resize observer closed"))?;
            self.dimensions = dimensions;
            self.dimensions_revision = self
                .dimensions_revision
                .checked_add(1)
                .ok_or_else(|| io::Error::other("dimensions revision overflow"))?;
            return Ok(());
        }
        process.resize(dimensions)?;
        self.dimensions = dimensions;
        self.dimensions_revision = self
            .dimensions_revision
            .checked_add(1)
            .ok_or_else(|| io::Error::other("dimensions revision overflow"))?;
        Ok(())
    }

    fn accept_output(&mut self, payload: Bytes, lines: usize) -> io::Result<()> {
        if payload.is_empty() || payload.len() > TERMINAL_MAX_PAYLOAD_BYTES {
            return Err(io::Error::other("invalid terminal output"));
        }
        let sequence = self.next_output_sequence;
        self.next_output_sequence = self
            .next_output_sequence
            .checked_add(1)
            .ok_or_else(|| io::Error::other("output sequence overflow"))?;
        self.replay_bytes += payload.len();
        self.replay_lines += lines;
        self.replay.push_back(OutputChunk {
            sequence,
            payload,
            lines,
        });
        while self.replay_bytes > REPLAY_BYTE_LIMIT || self.replay_lines > REPLAY_LINE_LIMIT {
            let removed = self
                .replay
                .pop_front()
                .expect("replay exceeds a positive bound");
            self.replay_bytes -= removed.payload.len();
            self.replay_lines -= removed.lines;
            self.replay_truncated = true;
        }
        Ok(())
    }

    fn error(
        &self,
        attachment_generation: Option<TerminalGeneration>,
        code: &'static str,
    ) -> TerminalOutbound {
        TerminalOutbound::Control(TerminalClientMessage::Error {
            terminal_version: TERMINAL_VERSION,
            resident_generation: self
                .generation
                .expect("errors are reported for an existing resident"),
            attachment_generation,
            code,
        })
    }
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        self.stop_process();
    }
}

/// Run `work` on its own thread, or inline when no thread can be spawned (see
/// `spawn_reader`): late is better than never for a hangup.
fn run_detached(name: &str, work: impl FnOnce() + Send + 'static) {
    let slot = std::sync::Arc::new(std::sync::Mutex::new(Some(work)));
    let take =
        |slot: &std::sync::Mutex<Option<_>>| slot.lock().ok().and_then(|mut work| work.take());
    let remote = std::sync::Arc::clone(&slot);
    let spawned = thread::Builder::new().name(name.into()).spawn(move || {
        if let Some(work) = take(&remote) {
            work();
        }
    });
    if spawned.is_err()
        && let Some(work) = take(&slot)
    {
        work();
    }
}

fn invalid_control() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid terminal control")
}

fn window_size(dimensions: Dimensions) -> libc::winsize {
    libc::winsize {
        ws_row: dimensions.rows,
        ws_col: dimensions.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn foreground_differs_from_shell(process: &ResidentProcess) -> bool {
    let (Some(fd), Some(shell)) = (process.master_fd(), process.shell.as_ref()) else {
        return false;
    };
    // SAFETY: fd is the live PTY master owned by this process.
    let foreground = unsafe { libc::tcgetpgrp(fd) };
    foreground > 0 && foreground != shell.pid
}

fn shell_command(
    root: &Path,
    values: &BTreeMap<String, String>,
    profile: &ShellProfile,
) -> Command {
    let mut command = Command::new("/bin/bash");
    match &profile.rcfile {
        Some(rcfile) => command.arg("--rcfile").arg(rcfile).arg("-i"),
        None => command.args(["--login", "-i"]),
    };
    command
        .current_dir(root)
        .env_clear()
        .envs(base_environment_for(values, &profile.home, &profile.user))
        .env("TERM", "xterm-256color");
    command
}

/// A new PTY pair, both ends close-on-exec.
fn open_pty(dimensions: Dimensions) -> io::Result<(OwnedFd, OwnedFd)> {
    let (mut master, mut slave) = (-1, -1);
    // SAFETY: out-pointers to locals and a valid winsize; no name buffer.
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            &window_size(dimensions),
        )
    };
    if opened != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were just opened and nothing else owns them.
    let pair = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    for fd in [&pair.0, &pair.1] {
        // SAFETY: valid descriptor.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(pair)
}

fn spawn_shell(
    root: &Path,
    dimensions: Dimensions,
    values: &BTreeMap<String, String>,
    profile: &ShellProfile,
) -> io::Result<ResidentProcess> {
    let (master, slave) = open_pty(dimensions)?;
    // Everything that can fail happens before the shell exists, so a failure
    // never leaves an unowned shell behind.
    let reader = std::fs::File::from(master.try_clone()?);
    let writer = std::fs::File::from(master.try_clone()?);
    let (sender, output) = channel(OUTPUT_CHANNEL_CAPACITY);
    spawn_reader(Box::new(reader), sender)?;
    let mut command = shell_command(root, values, profile);
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // Default dispositions and an empty mask, whatever this process
            // installed; then lead a new session with the PTY as its
            // controlling terminal, so job control and SIGWINCH work.
            for signal in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            let empty: libc::sigset_t = std::mem::zeroed();
            libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
            if libc::setsid() == -1 || libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    Ok(ResidentProcess {
        master: Some(master),
        shell: Some(Shell {
            pid: child.id() as i32,
        }),
        writer: Box::new(writer),
        output,
    })
}

/// State that survives a self-update re-exec: the PTY master (kept
/// open across `exec`) and the identity the browser already knows.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Handoff {
    fd: i32,
    shell_pid: u32,
    generation: TerminalGeneration,
    next_output_sequence: u64,
    dimensions: Dimensions,
    applied_environment_generation: u64,
    shell_environment_generation: Option<u64>,
    restart_required: bool,
    /// The replay ring's bytes (base64), so a browser that reattaches after
    /// the swap redraws the same screen. Absent from older images.
    #[serde(default)]
    replay: String,
}

pub const HANDOFF_VARIABLE: &str = "DXD_TERMINAL_HANDOFF";

impl TerminalRuntime {
    /// Duplicate the PTY master without `CLOEXEC` and describe the resident so
    /// the next image can adopt it. Returns `None` when no shell is running.
    pub fn prepare_handoff(&self) -> Option<String> {
        if !matches!(self.state, ResidentState::Ready | ResidentState::Starting) {
            return None;
        }
        let process = self.process.as_ref()?;
        let fd = process.master_fd()?;
        let shell_pid = process.shell.as_ref()?.pid as u32;
        // SAFETY: dup of a live descriptor; the copy has no CLOEXEC flag.
        let duplicated = unsafe { libc::dup(fd) };
        if duplicated < 0 {
            return None;
        }
        let handoff = Handoff {
            fd: duplicated,
            shell_pid,
            generation: self.generation?,
            next_output_sequence: self.next_output_sequence,
            dimensions: self.dimensions,
            applied_environment_generation: self.applied_environment_generation,
            shell_environment_generation: self.shell_environment_generation,
            restart_required: self.restart_required,
            replay: {
                use base64::Engine as _;
                let bytes = self
                    .replay
                    .iter()
                    .flat_map(|chunk| chunk.payload.iter().copied())
                    .collect::<Vec<_>>();
                base64::engine::general_purpose::STANDARD.encode(bytes)
            },
        };
        serde_json::to_string(&handoff).ok()
    }

    /// Adopt a shell from the previous image. The carried replay bytes become
    /// the newest output sequences, marked truncated; the browser
    /// resynchronizes from `resident-state`.
    pub fn adopt(&mut self, encoded: &str) -> io::Result<()> {
        use std::io::IsTerminal;
        use std::os::fd::BorrowedFd;
        let handoff: Handoff =
            serde_json::from_str(encoded).map_err(|_| io::Error::other("invalid handoff"))?;
        if handoff.fd < 3 {
            return Err(io::Error::other("invalid handoff descriptor"));
        }
        // SAFETY: borrowed only to duplicate it; a descriptor that is not open
        // fails the duplication with EBADF.
        let master = unsafe { BorrowedFd::borrow_raw(handoff.fd) }
            .try_clone_to_owned()
            .map_err(|_| io::Error::other("handoff descriptor is not open"))?;
        // The copy is close-on-exec; release the inherited original. SAFETY:
        // it is open (the duplication succeeded) and nothing else owns it.
        drop(unsafe { OwnedFd::from_raw_fd(handoff.fd) });
        if !master.is_terminal() {
            return Err(io::Error::other("handoff descriptor is not a terminal"));
        }
        // Zero, one, or a negative pid would address a process group or init.
        let pid = i32::try_from(handoff.shell_pid)
            .ok()
            .filter(|pid| *pid > 1)
            .ok_or_else(|| io::Error::other("invalid handoff shell"))?;
        let mut shell = Shell { pid };
        if !matches!(shell.try_wait(), Ok(None)) {
            return Err(io::Error::other("handed-off shell is gone"));
        }
        let reader: std::fs::File = master.try_clone()?.into();
        let writer: std::fs::File = master.try_clone()?.into();
        let (sender, output) = channel(OUTPUT_CHANNEL_CAPACITY);
        spawn_reader(Box::new(reader), sender)?;
        self.reset_resident_state();
        self.process = Some(ResidentProcess {
            master: Some(master),
            shell: Some(shell),
            writer: Box::new(writer),
            output,
        });
        self.state = ResidentState::Ready;
        self.generation = Some(handoff.generation);
        self.next_output_sequence = handoff.next_output_sequence.max(1);
        self.dimensions = handoff.dimensions;
        self.replay_truncated = self.next_output_sequence > 1;
        self.restore_replay(&handoff.replay);
        self.applied_environment_generation = handoff.applied_environment_generation;
        self.shell_environment_generation = handoff.shell_environment_generation;
        self.restart_required = handoff.restart_required;
        Ok(())
    }
}

impl TerminalRuntime {
    /// Refill the replay ring from handed-off bytes. They end at the last
    /// sequence the previous image emitted, so chunk sequences count back
    /// from there; anything that does not fit the bounds is dropped.
    fn restore_replay(&mut self, encoded: &str) {
        use base64::Engine as _;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return;
        };
        let mut bytes = &bytes[bytes.len().saturating_sub(REPLAY_BYTE_LIMIT)..];
        let excess_lines = bytes
            .iter()
            .filter(|byte| **byte == b'\n')
            .count()
            .saturating_sub(REPLAY_LINE_LIMIT);
        if excess_lines > 0 {
            let cut = bytes
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b'\n')
                .nth(excess_lines - 1)
                .map_or(0, |(index, _)| index + 1);
            bytes = &bytes[cut..];
        }
        let chunks = bytes.chunks(TERMINAL_MAX_PAYLOAD_BYTES).collect::<Vec<_>>();
        let Some(first) = self.next_output_sequence.checked_sub(chunks.len() as u64) else {
            return;
        };
        if first < 1 {
            return;
        }
        for (index, payload) in chunks.into_iter().enumerate() {
            let lines = payload.iter().filter(|byte| **byte == b'\n').count();
            self.replay_bytes += payload.len();
            self.replay_lines += lines;
            self.replay.push_back(OutputChunk {
                sequence: first + index as u64,
                payload: Bytes::copy_from_slice(payload),
                lines,
            });
        }
    }
}

/// Read PTY output on a dedicated thread. `blocking_send` on the bounded
/// channel is the back-pressure point: a slow consumer stops this thread, the
/// kernel PTY buffer fills, and the shell blocks on write.
///
/// Threads are spawned fallibly: the shell runs as the same user as dxd, so a
/// runaway shell can exhaust the thread limit, and that must fail the
/// resident, not abort the daemon.
pub fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    sender: Sender<ReaderEvent>,
) -> io::Result<()> {
    thread::Builder::new()
        .name("dxd-pty".into())
        .spawn(move || {
            let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = sender.blocking_send(ReaderEvent::Closed);
                        break;
                    }
                    Ok(length) => {
                        let chunk = &buffer[..length];
                        let lines = chunk.iter().filter(|byte| **byte == b'\n').count();
                        if sender
                            .blocking_send(ReaderEvent::Output(
                                Bytes::copy_from_slice(chunk),
                                lines,
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        let _ = sender.blocking_send(ReaderEvent::Closed);
                        break;
                    }
                }
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{Receiver as StdReceiver, SyncSender, sync_channel};

    fn control_types(outbound: &[TerminalOutbound]) -> Vec<&'static str> {
        outbound
            .iter()
            .filter_map(|message| match message {
                TerminalOutbound::Control(TerminalClientMessage::ReplayStart { .. }) => {
                    Some("replay-start")
                }
                TerminalOutbound::Control(TerminalClientMessage::AttachmentReady { .. }) => {
                    Some("ready")
                }
                TerminalOutbound::Control(TerminalClientMessage::Dimensions { .. }) => {
                    Some("dimensions")
                }
                TerminalOutbound::Control(TerminalClientMessage::Detached { .. }) => {
                    Some("detached")
                }
                _ => None,
            })
            .collect()
    }

    struct PipeWriter(std::sync::mpsc::Sender<Vec<u8>>);

    impl Write for PipeWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .send(buf.to_vec())
                .map_err(|_| io::Error::other("closed"))?;
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn profile() -> ShellProfile {
        ShellProfile {
            home: PathBuf::from("/home/user"),
            user: "user".into(),
            rcfile: None,
        }
    }

    fn fake_ready() -> (
        TerminalRuntime,
        StdReceiver<Vec<u8>>,
        Sender<ReaderEvent>,
        StdReceiver<Dimensions>,
        TerminalGeneration,
    ) {
        let (writer, written) = std::sync::mpsc::channel();
        let (output_sender, output) = channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_sender, resize_receiver): (SyncSender<Dimensions>, _) = sync_channel(4);
        let generation = TerminalGeneration::random();
        let mut runtime = TerminalRuntime::new(PathBuf::from("/workspace/repo"), profile());
        runtime.state = ResidentState::Ready;
        runtime.generation = Some(generation);
        runtime.applied_environment_generation = 1;
        runtime.shell_environment_generation = Some(1);
        runtime.process = Some(ResidentProcess {
            master: None,
            shell: None,
            writer: Box::new(PipeWriter(writer)),
            output,
        });
        runtime.resize_observer = Some(resize_sender);
        runtime
            .accept_output(Bytes::from_static(b"first\n"), 1)
            .unwrap();
        (runtime, written, output_sender, resize_receiver, generation)
    }

    fn fake_starting() -> (
        TerminalRuntime,
        StdReceiver<Vec<u8>>,
        Sender<ReaderEvent>,
        StdReceiver<Dimensions>,
        TerminalGeneration,
    ) {
        let (mut runtime, peer, output, resize, generation) = fake_ready();
        runtime.state = ResidentState::Starting;
        runtime.shell_environment_generation = None;
        runtime.restart_required = false;
        runtime.next_output_sequence = 1;
        runtime.replay.clear();
        runtime.replay_bytes = 0;
        runtime.replay_lines = 0;
        runtime.replay_truncated = false;
        runtime.first_output_deadline = Some(Instant::now() + FIRST_OUTPUT_TIMEOUT);
        (runtime, peer, output, resize, generation)
    }

    fn output(sender: &Sender<ReaderEvent>, bytes: &[u8]) {
        let lines = bytes.iter().filter(|byte| **byte == b'\n').count();
        sender
            .try_send(ReaderEvent::Output(Bytes::copy_from_slice(bytes), lines))
            .unwrap();
    }

    fn input_frame(
        resident: TerminalGeneration,
        attachment: TerminalGeneration,
        sequence: u64,
        payload: &[u8],
    ) -> Vec<u8> {
        encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(attachment),
            sequence,
            payload: payload.to_vec(),
        })
        .unwrap()
    }

    #[test]
    fn first_drained_output_promotes_starting_and_replays_identical_bytes() {
        let (mut runtime, _, sender, _, generation) = fake_starting();
        output(&sender, b"first output\n");
        let promoted = runtime.drain_output().unwrap();
        assert!(matches!(
            promoted.as_slice(),
            [TerminalOutbound::Control(TerminalClientMessage::ResidentState {
                state: "ready",
                resident_generation,
                next_output_sequence: U64String(2),
                ..
            })] if *resident_generation == generation
        ));
        assert!(matches!(
            runtime.heartbeat(),
            TerminalHeartbeat::Ready { .. }
        ));
        assert_eq!(runtime.shell_environment_generation, Some(1));
        let attachment = TerminalGeneration::random();
        let replay = runtime
            .attach(1, "default", generation, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let frame = replay
            .iter()
            .find_map(|message| match message {
                TerminalOutbound::Binary(frame) => Some(decode_terminal_frame(frame).unwrap()),
                TerminalOutbound::Control(_) => None,
            })
            .expect("first output was replayed");
        assert_eq!(frame.kind, 2);
        assert_eq!(frame.sequence, 1);
        assert_eq!(frame.payload, b"first output\n");
    }

    #[test]
    fn first_output_cannot_revive_an_already_closed_terminal() {
        let (mut runtime, _, sender, _, _) = fake_starting();
        output(&sender, b"final output\n");
        sender.try_send(ReaderEvent::Closed).unwrap();
        let outbound = runtime.drain_output().unwrap();
        assert_eq!(runtime.state, ResidentState::Exited);
        assert!(runtime.process.is_none());
        assert!(!outbound.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::ResidentState { state: "ready", .. })
        )));
        assert!(outbound.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::ResidentState {
                state: "exited",
                ..
            })
        )));
    }

    #[test]
    fn first_output_deadline_rejects_a_queued_first_output() {
        let (mut runtime, _, sender, _, _) = fake_starting();
        output(&sender, b"late output\n");
        runtime.first_output_deadline = Some(Instant::now() - Duration::from_millis(1));
        let outbound = runtime.drain_output().unwrap();
        assert_eq!(runtime.state, ResidentState::Failed);
        assert!(runtime.process.is_none());
        assert!(matches!(
            outbound.as_slice(),
            [TerminalOutbound::Control(
                TerminalClientMessage::ResidentState {
                    state: "failed",
                    ..
                }
            )]
        ));
    }

    #[test]
    fn reports_only_a_ready_observed_foreground_command() {
        let (mut runtime, _, _, _, _) = fake_ready();
        runtime.foreground_observer = Some(true);
        assert!(matches!(
            runtime.heartbeat(),
            TerminalHeartbeat::Ready {
                foreground_command: true,
                ..
            }
        ));
        runtime.state = ResidentState::Exited;
        assert!(matches!(
            runtime.heartbeat(),
            TerminalHeartbeat::Exited {
                foreground_command: false,
                ..
            }
        ));
    }

    #[test]
    fn rejects_a_stale_resident_attach_instead_of_silently_hanging() {
        let (mut runtime, _, _, _, _) = fake_ready();
        let stale_resident = TerminalGeneration::random();
        let attachment = TerminalGeneration::random();
        let output = runtime
            .attach(
                1,
                "default",
                stale_resident,
                attachment,
                1,
                Dimensions::INITIAL,
            )
            .unwrap();
        assert!(matches!(
            output.as_slice(),
            [TerminalOutbound::Control(TerminalClientMessage::Error {
                resident_generation,
                attachment_generation: Some(attachment_generation),
                code: "invalid-attachment",
                ..
            })] if *resident_generation == stale_resident && *attachment_generation == attachment
        ));
    }

    #[test]
    fn attach_input_resize_detach_and_warm_reattach_are_ordered() {
        let (mut runtime, written, sender, resize_receiver, resident) = fake_ready();
        let first_attachment = TerminalGeneration::random();
        let first = runtime
            .attach(
                1,
                "default",
                resident,
                first_attachment,
                1,
                Dimensions::INITIAL,
            )
            .unwrap();
        assert_eq!(
            control_types(&first),
            ["dimensions", "replay-start", "ready"]
        );
        assert!(matches!(first[2], TerminalOutbound::Binary(_)));

        runtime
            .input(&input_frame(resident, first_attachment, 1, b"ls\n"))
            .unwrap();
        runtime
            .input(&input_frame(resident, first_attachment, 2, b"pwd\n"))
            .unwrap();
        runtime.drain_input().unwrap();
        assert_eq!(written.try_recv().unwrap(), b"ls\n");
        assert_eq!(written.try_recv().unwrap(), b"pwd\n");
        assert!(!runtime.has_queued_input());

        output(&sender, b"live\n");
        let live = runtime.drain_output().unwrap();
        let frame = match &live[0] {
            TerminalOutbound::Binary(frame) => decode_terminal_frame(frame).unwrap(),
            TerminalOutbound::Control(_) => panic!("expected live frame"),
        };
        assert_eq!(frame.kind, 3);
        assert_eq!(frame.sequence, 2);

        let resized = runtime
            .resize(
                1,
                "default",
                resident,
                first_attachment,
                2,
                Dimensions {
                    columns: 120,
                    rows: 40,
                },
            )
            .unwrap();
        assert_eq!(control_types(&resized), ["dimensions"]);
        assert_eq!(resize_receiver.try_recv().unwrap().columns, 120);

        let detached = runtime
            .detach(1, "default", resident, first_attachment, "browser-detached")
            .unwrap();
        assert_eq!(control_types(&detached), ["detached"]);
        assert!(runtime.attachments.is_empty());

        // Output while nobody is attached only enters replay.
        output(&sender, b"unattended\n");
        assert!(runtime.drain_output().unwrap().is_empty());
        let second_attachment = TerminalGeneration::random();
        let second = runtime
            .attach(
                1,
                "default",
                resident,
                second_attachment,
                3,
                Dimensions::INITIAL,
            )
            .unwrap();
        let replayed = second
            .iter()
            .filter(|message| matches!(message, TerminalOutbound::Binary(_)))
            .count();
        assert_eq!(replayed, 3);
    }

    #[test]
    fn stale_identity_is_ignored_and_input_is_never_replayed() {
        let (mut runtime, written, _, _, resident) = fake_ready();
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let stranger = TerminalGeneration::random();
        assert!(
            runtime
                .input(&input_frame(resident, stranger, 1, b"x"))
                .unwrap()
                .is_empty()
        );
        let wrong_sequence = runtime
            .input(&input_frame(resident, attachment, 5, b"x"))
            .unwrap();
        assert!(matches!(
            wrong_sequence.as_slice(),
            [TerminalOutbound::Control(TerminalClientMessage::Error {
                code: "invalid-attachment",
                ..
            })]
        ));
        runtime.drain_input().unwrap();
        assert!(written.try_recv().is_err());
    }

    #[test]
    fn admits_eight_attachments_and_bounds_input() {
        let (mut runtime, _, _, _, resident) = fake_ready();
        let mut attachments = Vec::new();
        for ordinal in 1..=8 {
            let attachment = TerminalGeneration::random();
            let outbound = runtime
                .attach(
                    1,
                    "default",
                    resident,
                    attachment,
                    ordinal,
                    Dimensions::INITIAL,
                )
                .unwrap();
            assert_eq!(
                control_types(&outbound),
                ["dimensions", "replay-start", "ready"]
            );
            attachments.push(attachment);
        }
        let ninth = runtime
            .attach(
                1,
                "default",
                resident,
                TerminalGeneration::random(),
                9,
                Dimensions::INITIAL,
            )
            .unwrap();
        assert!(matches!(
            ninth.as_slice(),
            [TerminalOutbound::Control(TerminalClientMessage::Error {
                code: "attachment-limit",
                ..
            })]
        ));
        let payload = vec![b'a'; INPUT_ATTACHMENT_BYTE_LIMIT];
        let overflow = runtime
            .input(&input_frame(
                resident,
                attachments[0],
                1,
                &payload[..TERMINAL_MAX_PAYLOAD_BYTES],
            ))
            .unwrap();
        assert!(overflow.is_empty());
        let mut sequence = 2;
        let mut last = Vec::new();
        for _ in 0..8 {
            last = runtime
                .input(&input_frame(
                    resident,
                    attachments[0],
                    sequence,
                    &payload[..TERMINAL_MAX_PAYLOAD_BYTES],
                ))
                .unwrap();
            sequence += 1;
            if !last.is_empty() {
                break;
            }
        }
        assert!(matches!(
            last.as_slice(),
            [TerminalOutbound::Control(TerminalClientMessage::Error {
                code: "input-overflow",
                ..
            })]
        ));
        assert!(!runtime.attachments.contains(&attachments[0]));
        assert_eq!(runtime.attachments.len(), 7);
    }

    #[test]
    fn replay_eviction_is_complete_and_truncation_stays_set() {
        let (mut runtime, _, sender, _, _) = fake_ready();
        for _ in 0..8 {
            output(&sender, &vec![b'x'; 16_000]);
        }
        runtime.drain_output().unwrap();
        assert!(runtime.replay_bytes <= REPLAY_BYTE_LIMIT);
        assert!(runtime.replay_truncated);
        assert_eq!(
            runtime.replay_bytes,
            runtime
                .replay
                .iter()
                .map(|chunk| chunk.payload.len())
                .sum::<usize>()
        );
    }

    #[test]
    fn environment_refresh_tracks_shell_currency_without_a_multiplexer() {
        let (mut runtime, _, _, _, _) = fake_ready();
        let values = BTreeMap::from([("A".to_owned(), "1".to_owned())]);
        runtime.refresh_environment(&values, 2, false);
        assert_eq!(runtime.applied_environment_generation, 2);
        assert_eq!(runtime.shell_environment_generation, Some(2));
        assert!(!runtime.restart_required);
        runtime.refresh_environment(&values, 3, true);
        assert_eq!(runtime.applied_environment_generation, 3);
        assert_eq!(runtime.shell_environment_generation, Some(2));
        assert!(runtime.restart_required);
        assert!(matches!(
            runtime.environment_shell(),
            crate::environment::EnvironmentShell::RestartRequired
        ));
        runtime.stop_process();
        runtime.state = ResidentState::Exited;
        runtime.refresh_environment(&values, 4, false);
        assert_eq!(runtime.shell_environment_generation, None);
        assert!(!runtime.restart_required);
    }

    fn real_ready_shell(home: &Path, root: &Path) -> (TerminalRuntime, TerminalGeneration) {
        let rcfile = home.join("rc");
        std::fs::write(&rcfile, "PS1='> '\n").unwrap();
        let mut runtime = TerminalRuntime::new(
            root.to_owned(),
            ShellProfile {
                home: home.to_owned(),
                user: "user".into(),
                rcfile: Some(rcfile),
            },
        )
        .recorded_in(home);
        runtime.refresh_environment(&BTreeMap::new(), 1, true);
        runtime
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while runtime.state == ResidentState::Starting {
            assert!(Instant::now() < deadline, "shell produced no output");
            runtime.drain_output().unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(runtime.state, ResidentState::Ready);
        let resident = runtime.generation.unwrap();
        (runtime, resident)
    }

    fn type_until(
        runtime: &mut TerminalRuntime,
        resident: TerminalGeneration,
        attachment: TerminalGeneration,
        sequence: u64,
        input: &str,
        expected: &str,
    ) -> String {
        runtime
            .input(&input_frame(
                resident,
                attachment,
                sequence,
                input.as_bytes(),
            ))
            .unwrap();
        runtime.drain_input().unwrap();
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8_lossy(&seen).into_owned();
            if let Some(line) = text.lines().find(|line| line.starts_with(expected)) {
                return line.to_owned();
            }
            assert!(Instant::now() < deadline, "no {expected:?} in {text:?}");
            for message in runtime.drain_output().unwrap() {
                if let TerminalOutbound::Binary(frame) = message {
                    seen.extend(decode_terminal_frame(&frame).unwrap().payload);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn process_alive(pid: &str) -> bool {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    /// Stopping the resident is a hangup, as when a terminal window closes:
    /// the shell's jobs end with it, and the connection loop is not held for
    /// the shell's exit.
    #[test]
    fn stopping_a_resident_hangs_up_its_jobs_without_blocking() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (mut runtime, resident) = real_ready_shell(home.path(), root.path());
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let line = type_until(
            &mut runtime,
            resident,
            attachment,
            1,
            "sleep 600 & echo job=$!\n",
            "job=",
        );
        let pid = line.trim_start_matches("job=").trim().to_owned();
        assert!(process_alive(&pid));
        // A foreground command that ignores EOF keeps the shell busy.
        runtime
            .input(&input_frame(resident, attachment, 2, b"sleep 600\n"))
            .unwrap();
        runtime.drain_input().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !runtime.foreground_command() {
            assert!(Instant::now() < deadline);
            runtime.drain_output().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        let started = Instant::now();
        runtime.stop_process();
        let stop = started.elapsed();
        assert!(stop < Duration::from_millis(20), "stop took {stop:?}");
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_alive(&pid) {
            assert!(Instant::now() < deadline, "background job {pid} survived");
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// The shell exiting ends the resident even while a background job it
    /// left behind still holds the PTY open, so the Terminal never stays
    /// ready on a dead shell.
    #[test]
    fn shell_exit_is_reported_while_an_orphaned_job_holds_the_pty() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (mut runtime, resident) = real_ready_shell(home.path(), root.path());
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let line = type_until(
            &mut runtime,
            resident,
            attachment,
            1,
            "sleep 600 & echo job=$!\n",
            "job=",
        );
        let pid = line.trim_start_matches("job=").trim().to_owned();
        runtime
            .input(&input_frame(resident, attachment, 2, b"exit\n"))
            .unwrap();
        runtime.drain_input().unwrap();
        let started = Instant::now();
        let mut outbound = Vec::new();
        while runtime.state == ResidentState::Ready {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the exited shell was still reported ready"
            );
            outbound.extend(runtime.drain_output().unwrap());
            outbound.extend(runtime.reap_exited().unwrap());
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(runtime.state, ResidentState::Exited);
        assert!(outbound.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::ResidentState {
                state: "exited",
                ..
            })
        )));
        let _ = std::process::Command::new("kill").arg(&pid).status();
    }

    /// The resident is recorded in the state directory before its shell
    /// starts; the next daemon process reports that shell as exited.
    #[test]
    fn a_new_daemon_reports_the_recorded_resident_as_exited() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (mut runtime, resident) = real_ready_shell(home.path(), root.path());
        runtime.stop_process();
        let next = TerminalRuntime::new(root.path().to_owned(), profile()).recorded_in(home.path());
        assert_eq!(next.state, ResidentState::Exited);
        assert_eq!(next.generation, Some(resident));
        assert!(next.process.is_none());
        assert!(matches!(next.heartbeat(), TerminalHeartbeat::Exited { .. }));
        let fresh =
            TerminalRuntime::new(root.path().to_owned(), profile()).recorded_in(root.path());
        assert!(matches!(
            fresh.heartbeat(),
            TerminalHeartbeat::Absent { .. }
        ));
    }

    #[test]
    fn real_shell_on_a_daemon_owned_pty_echoes_and_reports_foreground_commands() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let rcfile = home.path().join("rc");
        std::fs::write(&rcfile, "PS1='> '\n").unwrap();
        let mut runtime = TerminalRuntime::new(
            root.path().to_owned(),
            ShellProfile {
                home: home.path().to_owned(),
                user: "user".into(),
                rcfile: Some(rcfile),
            },
        );
        runtime.refresh_environment(&BTreeMap::new(), 1, true);
        let opened = runtime
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        assert!(matches!(
            opened.as_slice(),
            [TerminalOutbound::Control(
                TerminalClientMessage::ResidentState {
                    state: "starting",
                    ..
                }
            )]
        ));
        let deadline = Instant::now() + Duration::from_secs(5);
        while runtime.state == ResidentState::Starting {
            assert!(Instant::now() < deadline, "shell produced no output");
            runtime.drain_output().unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(runtime.state, ResidentState::Ready);
        let resident = runtime.generation.unwrap();
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        runtime
            .input(&input_frame(
                resident,
                attachment,
                1,
                b"echo dx-$((20+22))\n",
            ))
            .unwrap();
        runtime.drain_input().unwrap();
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&seen).contains("dx-42") {
            assert!(Instant::now() < deadline, "shell did not echo");
            for message in runtime.drain_output().unwrap() {
                if let TerminalOutbound::Binary(frame) = message {
                    seen.extend(decode_terminal_frame(&frame).unwrap().payload);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!runtime.foreground_command());
        runtime
            .input(&input_frame(resident, attachment, 2, b"sleep 5\n"))
            .unwrap();
        runtime.drain_input().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !runtime.foreground_command() {
            assert!(
                Instant::now() < deadline,
                "sleep was not observed in the foreground"
            );
            runtime.drain_output().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        let resized = runtime
            .resize(
                1,
                "default",
                resident,
                attachment,
                2,
                Dimensions {
                    columns: 100,
                    rows: 30,
                },
            )
            .unwrap();
        assert_eq!(control_types(&resized), ["dimensions"]);
        runtime.stop_process();
        assert!(runtime.process.is_none());
    }
}
