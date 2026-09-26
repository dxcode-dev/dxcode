use crate::environment::{
    EnvironmentShell, MAX_ENVIRONMENT_ENTRIES, MAX_VALUE_BYTES, base_environment_for,
    runtime_environment_at, valid_name,
};
use crate::protocol::{
    Dimensions, TERMINAL_HEADER_BYTES, TERMINAL_MAX_PAYLOAD_BYTES, TERMINAL_VERSION,
    TerminalClientMessage, TerminalFrame, TerminalGeneration, TerminalHeartbeat, U64String,
    decode_terminal_frame, encode_terminal_frame,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1_024;
const OUTPUT_QUEUE_BYTE_LIMIT: usize = 1_024 * 1_024;
const OUTPUT_QUEUE_LINE_LIMIT: usize = 10_000;
const REPLAY_BYTE_LIMIT: usize = 65_536;
const REPLAY_LINE_LIMIT: usize = 10_000;
const ATTACHMENT_LIMIT: usize = 8;
const INPUT_ATTACHMENT_BYTE_LIMIT: usize = 256 * 1_024;
const INPUT_TOTAL_BYTE_LIMIT: usize = 2 * 1_024 * 1_024;
const INPUT_FRAME_LIMIT: usize = 32;
const FIRST_OUTPUT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
enum ReaderEvent {
    Output(Vec<u8>, usize),
    Closed,
}

#[derive(Default)]
struct OutputQueueUsage {
    bytes: usize,
    lines: usize,
}

#[derive(Clone, Debug)]
struct OutputChunk {
    sequence: u64,
    payload: Vec<u8>,
    lines: usize,
}

struct ResidentProcess {
    child: Option<Child>,
    writer: File,
    output: Receiver<ReaderEvent>,
    overflowed: Arc<AtomicBool>,
    output_usage: Arc<Mutex<OutputQueueUsage>>,
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

pub struct TerminalRuntime {
    pub(crate) root: PathBuf,
    session_name: String,
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
    pub(crate) environment_home: PathBuf,
    home: PathBuf,
    user: String,
    profile: Option<PathBuf>,
    #[cfg(test)]
    resize_observer: Option<SyncSender<Dimensions>>,
    #[cfg(test)]
    foreground_observer: Option<bool>,
}

impl TerminalRuntime {
    pub fn new(root: PathBuf, thread_id: &str) -> Self {
        Self {
            root,
            session_name: format!("dx-{thread_id}"),
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
            environment_home: PathBuf::from("/home/user"),
            home: PathBuf::from("/home/user"),
            user: "user".into(),
            profile: None,
            #[cfg(test)]
            resize_observer: None,
            #[cfg(test)]
            foreground_observer: None,
        }
    }

    pub fn local(root: PathBuf, thread_id: &str, home: PathBuf, state_root: PathBuf) -> Self {
        let mut runtime = Self::new(root, thread_id);
        runtime.environment_home = home.clone();
        runtime.profile = Some(state_root.join("dx-terminal/profile"));
        runtime.user = std::env::var("USER").unwrap_or_else(|_| "user".into());
        runtime.home = home;
        runtime
    }

    fn base_environment(&self, values: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        base_environment_for(values, &self.home, &self.user)
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
        self.dimensions = dimensions;
        if self.applied_environment_generation == 0 {
            self.state = ResidentState::Failed;
            return Ok(vec![TerminalOutbound::Control(
                self.resident_state().expect("failed resident has state"),
            )]);
        }
        self.process = match spawn_tmux_process(
            &self.root,
            &self.session_name,
            dimensions,
            self.applied_environment_generation,
            &self.environment_home,
            &self.home,
            &self.user,
            self.profile.as_deref(),
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
        flush_history_best_effort(&self.root, &self.session_name);
        let root = self
            .root
            .to_str()
            .ok_or_else(|| io::Error::other("invalid root"))?;
        let target = format!("{}:0.0", self.session_name);
        let mut arguments = vec!["respawn-pane", "-k", "-c", root, "-t", &target];
        let profile;
        if let Some(path) = &self.profile {
            profile = path
                .to_str()
                .ok_or_else(|| io::Error::other("invalid profile"))?;
            arguments.extend(["/bin/bash", "--rcfile", profile, "-i"]);
        } else {
            arguments.extend(["/bin/bash", "--login", "-i"]);
        }
        if !run_tmux(&self.root, &self.session_name, &arguments)? {
            self.state = ResidentState::Failed;
            return Ok(vec![TerminalOutbound::Control(
                self.resident_state().expect("failed resident has state"),
            )]);
        }
        set_tmux_option(
            &self.root,
            &self.session_name,
            "@dx-environment-shell-generation",
            &self.applied_environment_generation.to_string(),
        )?;
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

    pub fn environment_shell(&self) -> EnvironmentShell {
        if self.shell_environment_generation.is_none() {
            EnvironmentShell::NoShell
        } else if self.restart_required {
            EnvironmentShell::RestartRequired
        } else {
            EnvironmentShell::Current
        }
    }

    pub fn previous_managed_names(
        &self,
        fallback: &BTreeSet<String>,
    ) -> io::Result<BTreeSet<String>> {
        if !run_tmux(
            &self.root,
            &self.session_name,
            &["has-session", "-t", &self.session_name],
        )? {
            return Ok(fallback.clone());
        }
        let encoded = tmux_option(
            &self.root,
            &self.session_name,
            "@dx-environment-managed-names",
        )?
        .ok_or_else(|| io::Error::other("terminal environment state unavailable"))?;
        let names: BTreeSet<String> = if encoded.is_empty() {
            BTreeSet::new()
        } else {
            encoded.split(' ').map(str::to_owned).collect()
        };
        if names.len() > MAX_ENVIRONMENT_ENTRIES
            || names.iter().any(|name| !valid_name(name))
            || names.iter().cloned().collect::<Vec<_>>().join(" ") != encoded
        {
            return Err(io::Error::other("terminal environment state unavailable"));
        }
        let candidates = names
            .into_iter()
            .chain(fallback.iter().cloned())
            .collect::<BTreeSet<_>>();
        if candidates.len() > MAX_ENVIRONMENT_ENTRIES * 2 {
            return Err(io::Error::other("terminal environment state unavailable"));
        }
        tmux_present_names(&self.root, &self.session_name, &candidates)
    }

    pub fn refresh_environment(
        &mut self,
        values: &BTreeMap<String, String>,
        previous_names: &BTreeSet<String>,
        generation: u64,
        changed: bool,
    ) -> io::Result<()> {
        let exists = run_tmux(
            &self.root,
            &self.session_name,
            &["has-session", "-t", &self.session_name],
        )?;
        if !exists {
            self.stop_process();
            self.reset_resident_state();
            self.applied_environment_generation = generation;
            self.shell_environment_generation = None;
            self.restart_required = false;
            return Ok(());
        }
        let environment_changed = changed;
        let prior_applied = tmux_option(
            &self.root,
            &self.session_name,
            "@dx-environment-applied-generation",
        )?
        .and_then(|value| value.parse::<u64>().ok());
        let prior_shell = tmux_option(
            &self.root,
            &self.session_name,
            "@dx-environment-shell-generation",
        )?
        .and_then(|value| value.parse::<u64>().ok());
        let prior_managed = tmux_option(
            &self.root,
            &self.session_name,
            "@dx-environment-managed-names",
        )?;
        if self.applied_environment_generation == 0
            && (prior_applied.is_none() || prior_shell.is_none() || prior_managed.is_none())
        {
            return Err(io::Error::other("terminal environment state unavailable"));
        }
        let update_names = previous_names
            .iter()
            .chain(values.keys())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(" ");
        let managed_value = values.keys().cloned().collect::<Vec<_>>().join(" ");
        let update_succeeded = if update_names.is_empty() {
            run_tmux(
                &self.root,
                &self.session_name,
                &[
                    "set-option",
                    "-g",
                    "@dx-environment-applied-generation",
                    &generation.to_string(),
                ],
            )?
        } else {
            run_tmux(
                &self.root,
                &self.session_name,
                &[
                    "set-option",
                    "-t",
                    &self.session_name,
                    "update-environment",
                    &update_names,
                    ";",
                    "set-option",
                    "-g",
                    "@dx-environment-applied-generation",
                    &generation.to_string(),
                ],
            )?
        };
        if !update_succeeded {
            return Err(io::Error::other("terminal environment refresh failed"));
        }
        let refresh_succeeded = if update_names.is_empty() {
            true
        } else {
            let mut refresh = Command::new("tmux");
            refresh
                .args([
                    "-L",
                    &self.session_name,
                    "-C",
                    "attach-session",
                    "-t",
                    &self.session_name,
                ])
                .current_dir(&self.root)
                .env_clear()
                .envs(self.base_environment(values))
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut client = refresh.spawn()?;
            let mut refreshed = false;
            for _ in 0..100 {
                if matches!(
                    tmux_environment_matches(
                        &self.root,
                        &self.session_name,
                        values,
                        previous_names,
                    ),
                    Ok(true)
                ) {
                    refreshed = true;
                    break;
                }
                if !matches!(client.try_wait(), Ok(None)) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            if !refreshed {
                refreshed = matches!(
                    tmux_environment_matches(
                        &self.root,
                        &self.session_name,
                        values,
                        previous_names,
                    ),
                    Ok(true)
                );
            }
            let _ = client.kill();
            let _ = client.wait();
            refreshed
        };
        if !refresh_succeeded
            || !run_tmux(
                &self.root,
                &self.session_name,
                &[
                    "set-option",
                    "-g",
                    "@dx-environment-managed-names",
                    &managed_value,
                ],
            )?
        {
            return Err(io::Error::other("terminal environment refresh failed"));
        }
        let shell_was_current = prior_applied.is_some() && prior_applied == prior_shell;
        self.applied_environment_generation = generation;
        if !environment_changed && shell_was_current {
            self.shell_environment_generation = Some(generation);
            self.restart_required = false;
            set_tmux_option(
                &self.root,
                &self.session_name,
                "@dx-environment-shell-generation",
                &generation.to_string(),
            )?;
        } else {
            self.shell_environment_generation = prior_shell;
            self.restart_required = self.shell_environment_generation.is_some();
        }
        Ok(())
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
                    payload: chunk.payload.clone(),
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
        if frame.kind != 1 || frame.attachment_generation.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid input frame",
            ));
        }
        if self.generation != Some(frame.resident_generation)
            || !frame
                .attachment_generation
                .is_some_and(|attachment| self.attachments.contains(&attachment))
        {
            return Ok(Vec::new());
        }
        if frame.sequence != self.next_input_sequence {
            let attachment_generation = frame
                .attachment_generation
                .expect("input frames require an attachment");
            self.attachments.remove(&attachment_generation);
            self.remove_queued_input(attachment_generation);
            return Ok(vec![
                self.error(frame.attachment_generation, "invalid-attachment"),
            ]);
        }
        let Some(next_input_sequence) = self.next_input_sequence.checked_add(1) else {
            return self.fail_resident("terminal-unavailable");
        };
        self.next_input_sequence = next_input_sequence;
        let attachment_generation = frame
            .attachment_generation
            .expect("input frames require an attachment");
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

    pub fn drain_input(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let Some(input) = self.input_queue.pop_front() else {
            return Ok(Vec::new());
        };
        self.release_input_usage(input.attachment_generation, input.frame_bytes);
        let Some(process) = self.process.as_mut() else {
            return self.fail_resident("terminal-unavailable");
        };
        if process.writer.write_all(&input.payload).is_err() {
            return self.fail_resident("terminal-unavailable");
        }
        Ok(Vec::new())
    }

    pub fn drain_output(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let mut received: Vec<(Vec<u8>, usize)> = Vec::new();
        let Some(process) = self.process.as_ref() else {
            return Ok(Vec::new());
        };
        if self.state == ResidentState::Starting
            && self
                .first_output_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return self.fail_resident("terminal-unavailable");
        }
        if process.overflowed.load(Ordering::Acquire) {
            return self.fail_resident("terminal-overflow");
        }
        loop {
            match process.output.try_recv() {
                Ok(ReaderEvent::Output(payload, lines)) => received.push((payload, lines)),
                Ok(ReaderEvent::Closed) => {
                    self.state = ResidentState::Exited;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.state = ResidentState::Exited;
                    break;
                }
            }
        }
        let mut outbound = Vec::new();
        for (payload, lines) in received {
            if self.release_output_usage(payload.len(), lines).is_err() {
                return self.fail_resident("terminal-unavailable");
            }
            let sequence = self.next_output_sequence;
            if self.accept_output(payload.clone()).is_err() {
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
                        payload,
                    })
                    .map_err(|_| io::Error::other("invalid live frame"))?,
                ));
            }
        }
        if self.state == ResidentState::Exited {
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

    fn release_output_usage(&self, bytes: usize, lines: usize) -> io::Result<()> {
        let process = self
            .process
            .as_ref()
            .ok_or_else(|| io::Error::other("resident process unavailable"))?;
        let mut usage = process
            .output_usage
            .lock()
            .map_err(|_| io::Error::other("terminal output accounting failed"))?;
        usage.bytes = usage
            .bytes
            .checked_sub(bytes)
            .ok_or_else(|| io::Error::other("terminal output accounting failed"))?;
        usage.lines = usage
            .lines
            .checked_sub(lines)
            .ok_or_else(|| io::Error::other("terminal output accounting failed"))?;
        Ok(())
    }

    fn release_input_usage(&mut self, attachment: TerminalGeneration, bytes: usize) {
        self.input_bytes -= bytes;
        let remaining = self
            .attachment_input_bytes
            .get(&attachment)
            .copied()
            .expect("queued input has attachment accounting")
            - bytes;
        if remaining == 0 {
            self.attachment_input_bytes.remove(&attachment);
        } else {
            self.attachment_input_bytes.insert(attachment, remaining);
        }
    }

    fn remove_queued_input(&mut self, attachment: TerminalGeneration) {
        let removed = self
            .input_queue
            .iter()
            .filter(|input| input.attachment_generation == attachment)
            .map(|input| input.frame_bytes)
            .sum::<usize>();
        self.input_queue
            .retain(|input| input.attachment_generation != attachment);
        self.input_bytes -= removed;
        self.attachment_input_bytes.remove(&attachment);
    }

    fn clear_input_queue(&mut self) {
        self.input_queue.clear();
        self.input_bytes = 0;
        self.attachment_input_bytes.clear();
    }

    fn stop_process(&mut self) {
        self.first_output_deadline = None;
        if let Some(mut process) = self.process.take()
            && let Some(mut child) = process.child.take()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn reset_resident_state(&mut self) {
        self.generation = None;
        self.state = ResidentState::Absent;
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
        self.restart_required = self
            .shell_environment_generation
            .is_some_and(|shell| shell != self.applied_environment_generation);
    }

    fn foreground_command(&self) -> bool {
        if self.state != ResidentState::Ready {
            return false;
        }
        #[cfg(test)]
        if let Some(foreground) = self.foreground_observer {
            return foreground;
        }
        let output = match Command::new("tmux")
            .args([
                "-L",
                &self.session_name,
                "display-message",
                "-p",
                "-t",
                &format!("{}:0.0", self.session_name),
                "#{pane_current_command}",
            ])
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            Ok(output) if output.status.success() && output.stdout.len() <= 64 => output.stdout,
            _ => return false,
        };
        let Ok(command) = std::str::from_utf8(&output) else {
            return false;
        };
        let command = command.trim();
        !command.is_empty() && !matches!(command, "bash" | "-bash")
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
        let window = libc::winsize {
            ws_row: dimensions.rows,
            ws_col: dimensions.columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: writer owns the live PTY master and window points to a valid winsize.
        if unsafe { libc::ioctl(process.writer.as_raw_fd(), libc::TIOCSWINSZ, &window) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let status = Command::new("tmux")
            .args([
                "-L",
                &self.session_name,
                "resize-window",
                "-x",
                &dimensions.columns.to_string(),
                "-y",
                &dimensions.rows.to_string(),
                "-t",
                &format!("{}:0", self.session_name),
            ])
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(io::Error::other("terminal resize failed"));
        }
        self.dimensions = dimensions;
        self.dimensions_revision = self
            .dimensions_revision
            .checked_add(1)
            .ok_or_else(|| io::Error::other("dimensions revision overflow"))?;
        Ok(())
    }

    fn accept_output(&mut self, payload: Vec<u8>) -> io::Result<()> {
        if payload.is_empty() || payload.len() > TERMINAL_MAX_PAYLOAD_BYTES {
            return Err(io::Error::other("invalid terminal output"));
        }
        let lines = payload.iter().filter(|byte| **byte == b'\n').count();
        if lines > OUTPUT_QUEUE_LINE_LIMIT {
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
                .expect("terminal errors require a resident generation"),
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

fn invalid_control() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid terminal control")
}

fn run_tmux(root: &Path, session_name: &str, arguments: &[&str]) -> io::Result<bool> {
    Ok(Command::new("tmux")
        .args(["-L", session_name])
        .args(arguments)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success())
}

fn flush_history_best_effort(root: &Path, session_name: &str) {
    let target = format!("{session_name}:0.0");
    let current = Command::new("tmux")
        .args([
            "-L",
            session_name,
            "display-message",
            "-p",
            "-t",
            &target,
            "#{pane_current_command}",
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    if !matches!(
        current,
        Ok(output)
            if output.status.success()
                && matches!(String::from_utf8_lossy(&output.stdout).trim(), "bash" | "-bash")
    ) {
        return;
    }
    if matches!(
        run_tmux(
            root,
            session_name,
            &[
                "send-keys",
                "-t",
                &target,
                "builtin history -d -1; builtin history -w",
                "Enter",
            ],
        ),
        Ok(true)
    ) {
        thread::sleep(Duration::from_millis(25));
    }
}

fn tmux_option(root: &Path, session_name: &str, name: &str) -> io::Result<Option<String>> {
    let output = Command::new("tmux")
        .args(["-L", session_name, "show-options", "-gv", name])
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| io::Error::other("invalid terminal option"))?;
    Ok(Some(value.trim_end_matches(['\r', '\n']).to_owned()))
}

fn tmux_environment_matches(
    root: &Path,
    session_name: &str,
    values: &BTreeMap<String, String>,
    previous_names: &BTreeSet<String>,
) -> io::Result<bool> {
    for name in previous_names.iter().chain(values.keys()) {
        let output = Command::new("tmux")
            .args([
                "-L",
                session_name,
                "show-environment",
                "-t",
                session_name,
                name,
            ])
            .current_dir(root)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        let Some(value) = values.get(name) else {
            if output.status.success() && output.stdout != format!("-{name}\n").as_bytes() {
                return Ok(false);
            }
            continue;
        };
        if !output.status.success() || output.stdout.len() > name.len() + MAX_VALUE_BYTES + 2 {
            return Ok(false);
        }
        let mut expected = Vec::with_capacity(name.len() + value.len() + 2);
        expected.extend_from_slice(name.as_bytes());
        expected.push(b'=');
        expected.extend_from_slice(value.as_bytes());
        expected.push(b'\n');
        if output.stdout != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

fn tmux_present_names(
    root: &Path,
    session_name: &str,
    candidates: &BTreeSet<String>,
) -> io::Result<BTreeSet<String>> {
    let mut present = BTreeSet::new();
    for name in candidates {
        let output = Command::new("tmux")
            .args([
                "-L",
                session_name,
                "show-environment",
                "-t",
                session_name,
                name,
            ])
            .current_dir(root)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        if !output.status.success() || output.stdout == format!("-{name}\n").as_bytes() {
            continue;
        }
        let prefix = format!("{name}=");
        if output.stdout.len() > name.len() + MAX_VALUE_BYTES + 2
            || !output.stdout.starts_with(prefix.as_bytes())
            || !output.stdout.ends_with(b"\n")
        {
            return Err(io::Error::other("terminal environment state unavailable"));
        }
        present.insert(name.clone());
    }
    if present.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(io::Error::other("terminal environment state unavailable"));
    }
    Ok(present)
}

fn set_tmux_option(root: &Path, session_name: &str, name: &str, value: &str) -> io::Result<()> {
    if run_tmux(root, session_name, &["set-option", "-g", name, value])? {
        Ok(())
    } else {
        Err(io::Error::other("terminal option unavailable"))
    }
}

fn ensure_tmux(
    root: &Path,
    session_name: &str,
    environment_generation: u64,
    environment_home: &Path,
    home: &Path,
    user: &str,
    profile: Option<&Path>,
) -> io::Result<()> {
    if !run_tmux(root, session_name, &["has-session", "-t", session_name])? {
        let values = runtime_environment_at(environment_home)?;
        let managed = values.keys().cloned().collect::<Vec<_>>().join(" ");
        let mut command = Command::new("tmux");
        command.args([
            "-L",
            session_name,
            "start-server",
            ";",
            "set-option",
            "-g",
            "history-limit",
            "10000",
            ";",
            "set-option",
            "-g",
            "exit-unattached",
            "off",
            ";",
            "set-option",
            "-g",
            "exit-empty",
            "on",
            ";",
            "set-option",
            "-g",
            "remain-on-exit",
            "off",
            ";",
            "set-option",
            "-g",
            "@dx-environment-managed-names",
            &managed,
            ";",
            "set-option",
            "-g",
            "@dx-environment-applied-generation",
            &environment_generation.to_string(),
            ";",
            "set-option",
            "-g",
            "@dx-environment-shell-generation",
            &environment_generation.to_string(),
            ";",
            "new-session",
            "-d",
            "-s",
            session_name,
            "-c",
            root.to_str()
                .ok_or_else(|| io::Error::other("invalid root"))?,
        ]);
        if let Some(profile) = profile {
            command.args(["/bin/bash", "--rcfile"]);
            command.arg(profile);
            command.arg("-i");
        } else {
            command.args(["/bin/bash", "--login", "-i"]);
        }
        command
            .current_dir(root)
            .env_clear()
            .envs(base_environment_for(&values, home, user))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if !command.status()?.success() {
            return Err(io::Error::other("terminal session unavailable"));
        }
    } else if !run_tmux(
        root,
        session_name,
        &["set-option", "-g", "history-limit", "10000"],
    )? {
        return Err(io::Error::other("terminal history unavailable"));
    }
    if !run_tmux(
        root,
        session_name,
        &[
            "set-option",
            "-g",
            "status",
            "off",
            ";",
            "set-option",
            "-g",
            "terminal-overrides[99]",
            "*:smcup@:rmcup@",
        ],
    )? {
        return Err(io::Error::other("terminal display unavailable"));
    }
    Ok(())
}

fn spawn_tmux_process(
    root: &Path,
    session_name: &str,
    dimensions: Dimensions,
    environment_generation: u64,
    environment_home: &Path,
    home: &Path,
    user: &str,
    profile: Option<&Path>,
) -> io::Result<ResidentProcess> {
    ensure_tmux(
        root,
        session_name,
        environment_generation,
        environment_home,
        home,
        user,
        profile,
    )?;
    let window = libc::winsize {
        ws_row: dimensions.rows,
        ws_col: dimensions.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let mut master_fd = -1;
    let mut slave_fd = -1;
    // SAFETY: openpty initializes both file descriptors and reads a valid winsize.
    if unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            &window,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned newly owned descriptors.
    let master = unsafe { File::from_raw_fd(master_fd) };
    // SAFETY: openpty returned newly owned descriptors.
    let slave = unsafe { File::from_raw_fd(slave_fd) };
    let mut command = Command::new("tmux");
    command
        .args([
            "-L",
            session_name,
            "attach-session",
            "-E",
            "-t",
            session_name,
        ])
        .current_dir(root)
        .env_clear()
        .envs(base_environment_for(&BTreeMap::new(), home, user))
        .env("TERM", "xterm-256color")
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    // SAFETY: the callback executes after fork, calls only async-signal-safe libc functions,
    // and uses the still-open PTY slave descriptor.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 || libc::ioctl(slave_fd, libc::TIOCSCTTY, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    drop(slave);
    let reader = master.try_clone()?;
    let (sender, output) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let overflowed = Arc::new(AtomicBool::new(false));
    let output_usage = Arc::new(Mutex::new(OutputQueueUsage::default()));
    spawn_reader(
        reader,
        sender,
        Arc::clone(&overflowed),
        Arc::clone(&output_usage),
    );
    Ok(ResidentProcess {
        child: Some(child),
        writer: master,
        output,
        overflowed,
        output_usage,
    })
}

fn spawn_reader(
    mut reader: File,
    sender: SyncSender<ReaderEvent>,
    overflowed: Arc<AtomicBool>,
    output_usage: Arc<Mutex<OutputQueueUsage>>,
) {
    thread::spawn(move || {
        loop {
            let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.try_send(ReaderEvent::Closed);
                    break;
                }
                Ok(length) => {
                    buffer.truncate(length);
                    let mut start = 0;
                    let mut lines = 0;
                    for index in 0..buffer.len() {
                        if buffer[index] == b'\n' {
                            lines += 1;
                        }
                        if lines == OUTPUT_QUEUE_LINE_LIMIT {
                            if !queue_output(
                                &sender,
                                &overflowed,
                                &output_usage,
                                buffer[start..=index].to_vec(),
                                lines,
                            ) {
                                return;
                            }
                            start = index + 1;
                            lines = 0;
                        }
                    }
                    if start < buffer.len()
                        && !queue_output(
                            &sender,
                            &overflowed,
                            &output_usage,
                            buffer[start..].to_vec(),
                            lines,
                        )
                    {
                        return;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    let _ = sender.try_send(ReaderEvent::Closed);
                    break;
                }
            }
        }
    });
}

fn queue_output(
    sender: &SyncSender<ReaderEvent>,
    overflowed: &AtomicBool,
    output_usage: &Mutex<OutputQueueUsage>,
    payload: Vec<u8>,
    lines: usize,
) -> bool {
    let mut usage = match output_usage.lock() {
        Ok(usage) => usage,
        Err(_) => {
            overflowed.store(true, Ordering::Release);
            return false;
        }
    };
    if usage.bytes + payload.len() > OUTPUT_QUEUE_BYTE_LIMIT
        || usage.lines + lines > OUTPUT_QUEUE_LINE_LIMIT
    {
        overflowed.store(true, Ordering::Release);
        return false;
    }
    usage.bytes += payload.len();
    usage.lines += lines;
    drop(usage);
    if let Err(error) = sender.try_send(ReaderEvent::Output(payload, lines)) {
        if let Ok(mut usage) = output_usage.lock() {
            match error {
                TrySendError::Full(ReaderEvent::Output(payload, lines))
                | TrySendError::Disconnected(ReaderEvent::Output(payload, lines)) => {
                    usage.bytes -= payload.len();
                    usage.lines -= lines;
                }
                TrySendError::Full(ReaderEvent::Closed)
                | TrySendError::Disconnected(ReaderEvent::Closed) => {}
            }
        }
        overflowed.store(true, Ordering::Release);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::{
        EnvironmentActivate, EnvironmentEntry, EnvironmentOutcome, EnvironmentRuntime,
    };
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::fs;
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::time::Instant;
    use tempfile::tempdir;

    struct TmuxCleanup {
        root: PathBuf,
        session_name: String,
    }

    impl Drop for TmuxCleanup {
        fn drop(&mut self) {
            let _ = run_tmux(&self.root, &self.session_name, &["kill-server"]);
        }
    }

    fn tmux_text(root: &Path, session_name: &str, arguments: &[&str]) -> String {
        let output = Command::new("tmux")
            .args(["-L", session_name])
            .args(arguments)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "tmux {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end_matches(['\r', '\n'])
            .to_owned()
    }

    fn shell_probe(root: &Path, session_name: &str, target: &str, destination: &Path) -> String {
        let quoted_destination =
            format!("'{}'", destination.to_string_lossy().replace('\'', "'\\''"));
        let command = format!(
            "printf '%s\\n' \"${{OLD_VALUE-unset}}\" \"${{NEW_VALUE-unset}}\" \"$PWD\" \"$PATH\" \"$HOME\" \"$USER\" \"$LOGNAME\" \"$SHELL\" > {quoted_destination}"
        );
        assert!(
            run_tmux(
                root,
                session_name,
                &["send-keys", "-t", target, &command, "Enter"]
            )
            .unwrap()
        );
        wait_for_file_lines(destination, 8)
    }

    fn wait_for_file_lines(destination: &Path, expected_lines: usize) -> String {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(contents) = fs::read_to_string(destination) {
                if contents.lines().count() == expected_lines {
                    return contents;
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("shell probe did not complete")
    }

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

    fn fake_ready() -> (
        TerminalRuntime,
        UnixStream,
        SyncSender<ReaderEvent>,
        Receiver<Dimensions>,
        TerminalGeneration,
    ) {
        let (writer, peer) = UnixStream::pair().unwrap();
        let writer = File::from(OwnedFd::from(writer));
        let (output_sender, output) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_sender, resize_receiver) = sync_channel(4);
        let generation = TerminalGeneration::random();
        let mut runtime = TerminalRuntime::new(PathBuf::from("/workspace/repo"), "thread-id");
        runtime.state = ResidentState::Ready;
        runtime.generation = Some(generation);
        runtime.process = Some(ResidentProcess {
            child: None,
            writer,
            output,
            overflowed: Arc::new(AtomicBool::new(false)),
            output_usage: Arc::new(Mutex::new(OutputQueueUsage::default())),
        });
        runtime.resize_observer = Some(resize_sender);
        runtime.accept_output(b"first\n".to_vec()).unwrap();
        (runtime, peer, output_sender, resize_receiver, generation)
    }

    fn fake_starting() -> (
        TerminalRuntime,
        UnixStream,
        SyncSender<ReaderEvent>,
        Receiver<Dimensions>,
        TerminalGeneration,
    ) {
        let (mut runtime, peer, output, resize, generation) = fake_ready();
        runtime.state = ResidentState::Starting;
        runtime.applied_environment_generation = 1;
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

    fn wait_for_ready(runtime: &mut TerminalRuntime) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !matches!(runtime.heartbeat(), TerminalHeartbeat::Ready { .. }) {
            runtime.drain_output().unwrap();
            assert!(Instant::now() < deadline, "resident did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn first_drained_output_promotes_starting_and_replays_identical_bytes() {
        let (mut runtime, _, output, _, generation) = fake_starting();
        let first = b"first output\n".to_vec();
        {
            let process = runtime.process.as_ref().unwrap();
            let mut usage = process.output_usage.lock().unwrap();
            usage.bytes = first.len();
            usage.lines = 1;
        }
        output.send(ReaderEvent::Output(first.clone(), 1)).unwrap();

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
        assert_eq!(frame.payload, first);
    }

    #[test]
    fn first_output_cannot_revive_an_already_closed_terminal() {
        let (mut runtime, _, output, _, _) = fake_starting();
        let first = b"final output\n".to_vec();
        {
            let process = runtime.process.as_ref().unwrap();
            let mut usage = process.output_usage.lock().unwrap();
            usage.bytes = first.len();
            usage.lines = 1;
        }
        output.send(ReaderEvent::Output(first, 1)).unwrap();
        output.send(ReaderEvent::Closed).unwrap();

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
        let (mut runtime, _peer, output, _resize, _) = fake_starting();
        output
            .send(ReaderEvent::Output(b"late output\n".to_vec(), 1))
            .unwrap();
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
        assert!(matches!(
            runtime.resident_state(),
            Some(TerminalClientMessage::ResidentState {
                foreground_command: true,
                ..
            })
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
    fn vertical_attach_input_resize_detach_and_warm_reattach_are_ordered() {
        let (mut runtime, mut input_peer, output_sender, resize_receiver, resident) = fake_ready();
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

        let input = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(first_attachment),
            sequence: 1,
            payload: b"input\n".to_vec(),
        })
        .unwrap();
        runtime.input(&input).unwrap();
        runtime.drain_input().unwrap();
        let mut observed = [0_u8; 6];
        input_peer.read_exact(&mut observed).unwrap();
        assert_eq!(&observed, b"input\n");

        let dimensions = Dimensions {
            columns: 100,
            rows: 30,
        };
        let resized = runtime
            .resize(1, "default", resident, first_attachment, 2, dimensions)
            .unwrap();
        assert_eq!(control_types(&resized), ["dimensions"]);
        assert_eq!(resize_receiver.recv().unwrap(), dimensions);

        let detached = runtime
            .detach(1, "default", resident, first_attachment, "browser-detached")
            .unwrap();
        assert_eq!(control_types(&detached), ["detached"]);
        {
            let mut usage = runtime
                .process
                .as_ref()
                .unwrap()
                .output_usage
                .lock()
                .unwrap();
            usage.bytes = 5;
            usage.lines = 1;
        }
        output_sender
            .send(ReaderEvent::Output(b"warm\n".to_vec(), 1))
            .unwrap();
        assert!(runtime.drain_output().unwrap().is_empty());

        let second_attachment = TerminalGeneration::random();
        let second = runtime
            .attach(1, "default", resident, second_attachment, 3, dimensions)
            .unwrap();
        assert_eq!(
            control_types(&second),
            ["dimensions", "replay-start", "ready"]
        );
        let replay_sequences = second
            .iter()
            .filter_map(|message| match message {
                TerminalOutbound::Binary(encoded) => {
                    Some(decode_terminal_frame(encoded).unwrap().sequence)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(replay_sequences, [1, 2]);
        assert_eq!(runtime.generation, Some(resident));
        assert_eq!(runtime.root, PathBuf::from("/workspace/repo"));
    }

    #[test]
    fn replay_high_water_hands_off_to_the_next_live_sequence_without_a_gap() {
        let (mut runtime, _, output_sender, _, resident) = fake_ready();
        runtime.accept_output(b"before-gate".to_vec()).unwrap();
        let attachment = TerminalGeneration::random();
        let replay = runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let replay_sequences = replay
            .iter()
            .filter_map(|message| match message {
                TerminalOutbound::Binary(encoded) => {
                    let frame = decode_terminal_frame(encoded).unwrap();
                    (frame.kind == 2).then_some(frame.sequence)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(replay_sequences, [1, 2]);
        assert!(replay.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::AttachmentReady {
                through_output_sequence: U64String(2),
                ..
            })
        )));

        {
            let process = runtime.process.as_ref().unwrap();
            let mut usage = process.output_usage.lock().unwrap();
            usage.bytes = 10;
        }
        output_sender
            .send(ReaderEvent::Output(b"after-gate".to_vec(), 0))
            .unwrap();
        let live = runtime.drain_output().unwrap();
        let live_sequences = live
            .iter()
            .filter_map(|message| match message {
                TerminalOutbound::Binary(encoded) => {
                    let frame = decode_terminal_frame(encoded).unwrap();
                    (frame.kind == 3).then_some(frame.sequence)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(live_sequences, [3]);
    }

    #[test]
    fn stale_identity_is_ignored_and_input_is_never_replayed() {
        let (mut runtime, mut input_peer, _, _, resident) = fake_ready();
        input_peer.set_nonblocking(true).unwrap();
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        let stale = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: TerminalGeneration::random(),
            attachment_generation: Some(attachment),
            sequence: 1,
            payload: b"secret".to_vec(),
        })
        .unwrap();
        assert!(runtime.input(&stale).unwrap().is_empty());
        let mut observed = [0_u8; 6];
        assert_eq!(
            input_peer.read(&mut observed).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn admits_eight_attachments_and_serializes_complete_input_frames() {
        let (mut runtime, mut input_peer, _, _, resident) = fake_ready();
        let attachments = (1..=ATTACHMENT_LIMIT)
            .map(|ordinal| {
                let attachment = TerminalGeneration::random();
                let output = runtime
                    .attach(
                        1,
                        "default",
                        resident,
                        attachment,
                        ordinal as u64,
                        Dimensions::INITIAL,
                    )
                    .unwrap();
                assert!(output.iter().any(|message| matches!(
                    message,
                    TerminalOutbound::Control(TerminalClientMessage::AttachmentReady { .. })
                )));
                attachment
            })
            .collect::<Vec<_>>();
        let rejected = TerminalGeneration::random();
        let output = runtime
            .attach(1, "default", resident, rejected, 9, Dimensions::INITIAL)
            .unwrap();
        assert!(output.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::Error {
                code: "attachment-limit",
                ..
            })
        )));

        for (sequence, attachment, payload) in [
            (1, attachments[0], b"first".as_slice()),
            (2, attachments[1], b"second".as_slice()),
        ] {
            let frame = encode_terminal_frame(&TerminalFrame {
                kind: 1,
                resident_generation: resident,
                attachment_generation: Some(attachment),
                sequence,
                payload: payload.to_vec(),
            })
            .unwrap();
            assert!(runtime.input(&frame).unwrap().is_empty());
        }
        runtime.drain_input().unwrap();
        runtime.drain_input().unwrap();
        let mut observed = [0_u8; 11];
        input_peer.read_exact(&mut observed).unwrap();
        assert_eq!(&observed, b"firstsecond");
    }

    #[test]
    fn input_overflow_detaches_only_its_source_and_preserves_prior_fifo_frames() {
        let (mut runtime, mut input_peer, _, _, resident) = fake_ready();
        let first = TerminalGeneration::random();
        let overflow = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, first, 1, Dimensions::INITIAL)
            .unwrap();
        runtime
            .attach(1, "default", resident, overflow, 2, Dimensions::INITIAL)
            .unwrap();
        for sequence in 1..=INPUT_FRAME_LIMIT as u64 {
            let frame = encode_terminal_frame(&TerminalFrame {
                kind: 1,
                resident_generation: resident,
                attachment_generation: Some(first),
                sequence,
                payload: vec![sequence as u8],
            })
            .unwrap();
            runtime.input(&frame).unwrap();
        }
        let rejected = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(overflow),
            sequence: 33,
            payload: vec![99],
        })
        .unwrap();
        let output = runtime.input(&rejected).unwrap();
        assert!(output.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::Error {
                attachment_generation: Some(value),
                code: "input-overflow",
                ..
            }) if *value == overflow
        )));
        assert!(!runtime.attachments.contains(&overflow));
        assert_eq!(runtime.input_queue.len(), INPUT_FRAME_LIMIT);

        for _ in 0..INPUT_FRAME_LIMIT {
            runtime.drain_input().unwrap();
        }
        let mut observed = [0_u8; INPUT_FRAME_LIMIT];
        input_peer.read_exact(&mut observed).unwrap();
        assert_eq!(observed, std::array::from_fn(|index| (index + 1) as u8));
    }

    #[test]
    fn input_accounting_uses_complete_frames_at_attachment_and_total_bounds() {
        let (mut runtime, _, _, _, resident) = fake_ready();
        let attachments = (1..=ATTACHMENT_LIMIT)
            .map(|ordinal| {
                let attachment = TerminalGeneration::random();
                runtime
                    .attach(
                        1,
                        "default",
                        resident,
                        attachment,
                        ordinal as u64,
                        Dimensions::INITIAL,
                    )
                    .unwrap();
                attachment
            })
            .collect::<Vec<_>>();
        for sequence in 1..=4 {
            let frame = encode_terminal_frame(&TerminalFrame {
                kind: 1,
                resident_generation: resident,
                attachment_generation: Some(attachments[0]),
                sequence,
                payload: vec![1; TERMINAL_MAX_PAYLOAD_BYTES],
            })
            .unwrap();
            runtime.input(&frame).unwrap();
        }
        assert_eq!(
            runtime.attachment_input_bytes[&attachments[0]],
            INPUT_ATTACHMENT_BYTE_LIMIT
        );
        assert_eq!(runtime.input_bytes, INPUT_ATTACHMENT_BYTE_LIMIT);
        let overflow = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(attachments[0]),
            sequence: 5,
            payload: vec![1],
        })
        .unwrap();
        assert!(
            runtime
                .input(&overflow)
                .unwrap()
                .iter()
                .any(|message| matches!(
                    message,
                    TerminalOutbound::Control(TerminalClientMessage::Error {
                        code: "input-overflow",
                        ..
                    })
                ))
        );
        assert_eq!(runtime.input_bytes, 0);
        assert_eq!(runtime.input_queue.len(), 0);

        let (mut runtime, _, _, _, resident) = fake_ready();
        let attachments = (1..=ATTACHMENT_LIMIT)
            .map(|ordinal| {
                let attachment = TerminalGeneration::random();
                runtime
                    .attach(
                        1,
                        "default",
                        resident,
                        attachment,
                        ordinal as u64,
                        Dimensions::INITIAL,
                    )
                    .unwrap();
                attachment
            })
            .collect::<Vec<_>>();
        for (attachment_index, attachment) in attachments.iter().enumerate() {
            for frame_index in 0..4 {
                let sequence = (attachment_index * 4 + frame_index + 1) as u64;
                let frame = encode_terminal_frame(&TerminalFrame {
                    kind: 1,
                    resident_generation: resident,
                    attachment_generation: Some(*attachment),
                    sequence,
                    payload: vec![1; TERMINAL_MAX_PAYLOAD_BYTES],
                })
                .unwrap();
                runtime.input(&frame).unwrap();
            }
        }
        assert_eq!(runtime.input_queue.len(), INPUT_FRAME_LIMIT);
        assert_eq!(runtime.input_bytes, INPUT_TOTAL_BYTE_LIMIT);
        let rejected_source = attachments[7];
        let rejected = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(rejected_source),
            sequence: 33,
            payload: vec![1],
        })
        .unwrap();
        runtime.input(&rejected).unwrap();
        assert_eq!(runtime.input_queue.len(), INPUT_FRAME_LIMIT - 4);
        assert_eq!(
            runtime.input_bytes,
            INPUT_TOTAL_BYTE_LIMIT - 4 * (TERMINAL_HEADER_BYTES + TERMINAL_MAX_PAYLOAD_BYTES)
        );
        assert!(!runtime.attachments.contains(&rejected_source));
    }

    #[test]
    fn resize_bounds_and_revision_follow_acceptance_order() {
        let (mut runtime, _, _, resize_receiver, resident) = fake_ready();
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        assert_eq!(runtime.dimensions_revision, 0);
        let minimum = Dimensions {
            columns: 1,
            rows: 1,
        };
        runtime
            .resize(1, "default", resident, attachment, 2, minimum)
            .unwrap();
        assert_eq!(resize_receiver.recv().unwrap(), minimum);
        assert_eq!(runtime.dimensions_revision, 1);
        runtime
            .resize(1, "default", resident, attachment, 3, minimum)
            .unwrap();
        assert!(resize_receiver.try_recv().is_err());
        assert_eq!(runtime.dimensions_revision, 1);
        let maximum = Dimensions {
            columns: 1_000,
            rows: 1_000,
        };
        runtime
            .resize(1, "default", resident, attachment, 4, maximum)
            .unwrap();
        assert_eq!(resize_receiver.recv().unwrap(), maximum);
        assert_eq!(runtime.dimensions, maximum);
        assert_eq!(runtime.dimensions_revision, 2);
        for invalid in [
            Dimensions {
                columns: 0,
                rows: 1,
            },
            Dimensions {
                columns: 1_001,
                rows: 1,
            },
        ] {
            assert!(
                runtime
                    .resize(1, "default", resident, attachment, 5, invalid)
                    .is_err()
            );
            assert_eq!(runtime.dimensions, maximum);
            assert_eq!(runtime.next_resize_ordinal, 5);
        }
    }

    #[test]
    fn invalid_open_shapes_do_not_create_or_replace_a_resident() {
        let mut runtime = TerminalRuntime::new(PathBuf::from("/workspace/repo"), "thread-id");
        let expected = TerminalGeneration::random();
        assert!(
            runtime
                .open(
                    1,
                    "default",
                    "open-if-absent",
                    Some(expected),
                    Dimensions::INITIAL,
                )
                .is_err()
        );
        assert!(
            runtime
                .open(1, "default", "restart-exited", None, Dimensions::INITIAL,)
                .is_err()
        );
        assert_eq!(runtime.state, ResidentState::Absent);
        assert_eq!(runtime.generation, None);
        assert!(runtime.process.is_none());
    }

    #[test]
    fn replay_eviction_is_complete_and_truncation_stays_set() {
        let (mut runtime, _, _, _, _) = fake_ready();
        runtime.replay.clear();
        runtime.replay_bytes = 0;
        runtime.replay_lines = 0;
        runtime.next_output_sequence = 1;
        runtime.accept_output(vec![b'a'; 40_000]).unwrap();
        runtime.accept_output(vec![b'b'; 40_000]).unwrap();
        assert_eq!(runtime.replay.len(), 1);
        assert_eq!(runtime.replay.front().unwrap().sequence, 2);
        assert_eq!(runtime.replay_bytes, 40_000);
        assert!(runtime.replay_truncated);
        runtime.accept_output(b"tail".to_vec()).unwrap();
        assert!(runtime.replay_truncated);

        runtime.replay.clear();
        runtime.replay_bytes = 0;
        runtime.replay_lines = 0;
        runtime.replay_truncated = false;
        runtime.accept_output(vec![b'\n'; 6_000]).unwrap();
        runtime.accept_output(vec![b'\n'; 6_000]).unwrap();
        assert_eq!(runtime.replay.len(), 1);
        assert_eq!(runtime.replay_lines, 6_000);
        assert!(runtime.replay_truncated);
    }

    #[test]
    fn output_queue_fails_instead_of_dropping_at_each_bound() {
        let (sender, _receiver) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let overflowed = AtomicBool::new(false);
        let usage = Mutex::new(OutputQueueUsage::default());
        for _ in 0..OUTPUT_CHANNEL_CAPACITY {
            assert!(queue_output(
                &sender,
                &overflowed,
                &usage,
                vec![1; OUTPUT_CHUNK_BYTES],
                0,
            ));
        }
        assert_eq!(usage.lock().unwrap().bytes, OUTPUT_QUEUE_BYTE_LIMIT);
        assert!(!queue_output(&sender, &overflowed, &usage, vec![1], 0,));
        assert!(overflowed.load(Ordering::Acquire));

        let (line_sender, _receiver) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let line_overflowed = AtomicBool::new(false);
        let line_usage = Mutex::new(OutputQueueUsage::default());
        assert!(queue_output(
            &line_sender,
            &line_overflowed,
            &line_usage,
            vec![b'\n'; OUTPUT_QUEUE_LINE_LIMIT],
            OUTPUT_QUEUE_LINE_LIMIT,
        ));
        assert!(!queue_output(
            &line_sender,
            &line_overflowed,
            &line_usage,
            vec![b'\n'],
            1,
        ));
        assert!(line_overflowed.load(Ordering::Acquire));
    }

    #[test]
    fn output_overflow_stops_and_fails_the_resident() {
        let (mut runtime, _, _, _, resident) = fake_ready();
        let attachment = TerminalGeneration::random();
        runtime
            .attach(1, "default", resident, attachment, 1, Dimensions::INITIAL)
            .unwrap();
        runtime
            .process
            .as_ref()
            .unwrap()
            .overflowed
            .store(true, Ordering::Release);

        let outbound = runtime.drain_output().unwrap();

        assert_eq!(runtime.state, ResidentState::Failed);
        assert!(runtime.process.is_none());
        assert!(runtime.attachments.is_empty());
        assert!(outbound.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::Error {
                code: "terminal-overflow",
                ..
            })
        )));
        assert!(outbound.iter().any(|message| matches!(
            message,
            TerminalOutbound::Control(TerminalClientMessage::ResidentState {
                state: "failed",
                ..
            })
        )));
    }

    #[test]
    fn local_pty_uses_the_existing_logical_tmux_session_across_warm_detach() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("dxd is nested under the repository")
            .to_path_buf();
        let thread_id = format!("resident-local-{}", std::process::id());
        let session_name = format!("dx-{thread_id}");
        let _cleanup = TmuxCleanup {
            root: root.clone(),
            session_name,
        };
        let environment = tempdir().unwrap();
        fs::set_permissions(environment.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let fragment = environment.path().join(".env");
        fs::write(&fragment, super::super::environment::ENVIRONMENT_HEADER).unwrap();
        fs::set_permissions(&fragment, fs::Permissions::from_mode(0o600)).unwrap();
        let mut runtime = TerminalRuntime::new(root.clone(), &thread_id);
        runtime.applied_environment_generation = 1;
        runtime.environment_home = environment.path().to_path_buf();
        runtime
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut runtime);
        let resident = match runtime.heartbeat() {
            TerminalHeartbeat::Ready {
                resident_generation,
                ..
            } => resident_generation,
            _ => panic!("resident did not become ready"),
        };
        let first_attachment = TerminalGeneration::random();
        let attached = runtime
            .attach(
                1,
                "default",
                resident,
                first_attachment,
                1,
                Dimensions::INITIAL,
            )
            .unwrap();
        let through = attached
            .iter()
            .find_map(|message| match message {
                TerminalOutbound::Control(TerminalClientMessage::AttachmentReady {
                    through_output_sequence,
                    ..
                }) => Some(through_output_sequence.0),
                _ => None,
            })
            .expect("attach completed");
        let input = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(first_attachment),
            sequence: 1,
            payload: b"printf x\n".to_vec(),
        })
        .unwrap();
        runtime.input(&input).unwrap();
        runtime.drain_input().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut newest = through;
        while newest == through && Instant::now() < deadline {
            for message in runtime.drain_output().unwrap() {
                if let TerminalOutbound::Binary(encoded) = message {
                    newest = newest.max(decode_terminal_frame(&encoded).unwrap().sequence);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            newest > through,
            "accepted input produced no ordered PTY output"
        );
        let sleep = encode_terminal_frame(&TerminalFrame {
            kind: 1,
            resident_generation: resident,
            attachment_generation: Some(first_attachment),
            sequence: 2,
            payload: b"sleep 2\n".to_vec(),
        })
        .unwrap();
        runtime.input(&sleep).unwrap();
        runtime.drain_input().unwrap();
        let foreground_deadline = Instant::now() + Duration::from_secs(1);
        let mut observed_foreground = false;
        while !observed_foreground && Instant::now() < foreground_deadline {
            observed_foreground = matches!(
                runtime.heartbeat(),
                TerminalHeartbeat::Ready {
                    foreground_command: true,
                    ..
                }
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            observed_foreground,
            "tmux foreground command was not reflected in health"
        );

        let dimensions = Dimensions {
            columns: 100,
            rows: 30,
        };
        runtime
            .resize(1, "default", resident, first_attachment, 2, dimensions)
            .unwrap();
        runtime
            .detach(1, "default", resident, first_attachment, "browser-detached")
            .unwrap();
        let second_attachment = TerminalGeneration::random();
        let warm = runtime
            .attach(1, "default", resident, second_attachment, 3, dimensions)
            .unwrap();
        assert!(warm.iter().any(|message| {
            matches!(
                message,
                TerminalOutbound::Binary(encoded)
                    if decode_terminal_frame(encoded).is_ok_and(|frame| frame.sequence == newest)
            )
        }));
        assert_eq!(runtime.root, root);
        assert_eq!(runtime.generation, Some(resident));

        runtime.state = ResidentState::Exited;
        runtime
            .open(
                1,
                "default",
                "restart-exited",
                Some(resident),
                Dimensions::INITIAL,
            )
            .unwrap();
        wait_for_ready(&mut runtime);
        assert_ne!(runtime.generation, Some(resident));
        assert_eq!(runtime.state, ResidentState::Ready);
    }

    #[test]
    fn refresh_resets_a_resident_whose_tmux_session_disappeared() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("dxd is nested under the repository")
            .to_path_buf();
        let thread_id = format!("resident-missing-tmux-{}", std::process::id());
        let session_name = format!("dx-{thread_id}");
        let _cleanup = TmuxCleanup {
            root: root.clone(),
            session_name: session_name.clone(),
        };
        let environment = tempdir().unwrap();
        fs::set_permissions(environment.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let fragment = environment.path().join(".env");
        fs::write(&fragment, super::super::environment::ENVIRONMENT_HEADER).unwrap();
        fs::set_permissions(&fragment, fs::Permissions::from_mode(0o600)).unwrap();
        let mut runtime = TerminalRuntime::new(root.clone(), &thread_id);
        runtime.applied_environment_generation = 1;
        runtime.environment_home = environment.path().to_path_buf();
        runtime
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut runtime);
        assert!(matches!(
            runtime.heartbeat(),
            TerminalHeartbeat::Ready { .. }
        ));
        assert!(
            run_tmux(&root, &session_name, &["kill-server"]).unwrap(),
            "tmux server was not running"
        );

        runtime
            .refresh_environment(&BTreeMap::new(), &BTreeSet::new(), 2, false)
            .unwrap();

        assert!(matches!(
            runtime.heartbeat(),
            TerminalHeartbeat::Absent {
                terminal_version: TERMINAL_VERSION,
                terminal: "default",
            }
        ));
    }

    #[test]
    fn local_tmux_refreshes_only_future_login_shells_and_confirmed_restart() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("dxd is nested under the repository")
            .to_path_buf();
        let thread_id = format!("resident-environment-local-{}", std::process::id());
        let session_name = format!("dx-{thread_id}");
        let _cleanup = TmuxCleanup {
            root: root.clone(),
            session_name: session_name.clone(),
        };
        let environment = tempdir().unwrap();
        fs::set_permissions(environment.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let fragment = environment.path().join(".env");
        fs::write(
            &fragment,
            [
                super::super::environment::ENVIRONMENT_HEADER,
                b"OLD_VALUE='before'\n",
            ]
            .concat(),
        )
        .unwrap();
        fs::set_permissions(&fragment, fs::Permissions::from_mode(0o600)).unwrap();
        let history = environment.path().join("history");
        fs::write(&history, []).unwrap();
        fs::set_permissions(&history, fs::Permissions::from_mode(0o600)).unwrap();

        let mut runtime = TerminalRuntime::new(root.clone(), &thread_id);
        runtime.applied_environment_generation = 1;
        runtime.environment_home = environment.path().to_path_buf();
        runtime
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut runtime);
        let first_resident = runtime.generation.unwrap();
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    &format!("{session_name}:0.0"),
                    "#{pane_start_command}",
                ],
            ),
            "/bin/bash --login -i"
        );
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &["show-options", "-gv", "history-limit"],
            ),
            "10000"
        );
        for expected in [
            "PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME=/home/user",
            "USER=user",
            "LOGNAME=user",
            "SHELL=/bin/bash",
            "LANG=C.UTF-8",
        ] {
            assert_eq!(
                tmux_text(
                    &root,
                    &session_name,
                    &[
                        "show-environment",
                        "-g",
                        expected.split('=').next().unwrap()
                    ],
                ),
                expected
            );
        }
        let current = shell_probe(
            &root,
            &session_name,
            &format!("{session_name}:0.0"),
            &environment.path().join("current-before"),
        );
        let current = current.lines().collect::<Vec<_>>();
        assert_eq!(&current[..3], ["before", "unset", root.to_str().unwrap()]);
        // A host login profile may refine PATH and HOME after the canonical tmux
        // base asserted above; identity and shell fields remain runtime-owned.
        assert_eq!(&current[5..], ["user", "user", "/bin/bash"]);
        let first_pane_pid = tmux_text(
            &root,
            &session_name,
            &[
                "display-message",
                "-p",
                "-t",
                &format!("{session_name}:0.0"),
                "#{pane_pid}",
            ],
        );

        fs::write(
            &fragment,
            [
                super::super::environment::ENVIRONMENT_HEADER,
                b"NEW_VALUE='after'\n",
            ]
            .concat(),
        )
        .unwrap();
        fs::set_permissions(&fragment, fs::Permissions::from_mode(0o600)).unwrap();
        runtime
            .refresh_environment(
                &BTreeMap::from([("NEW_VALUE".to_owned(), "after".to_owned())]),
                &BTreeSet::from(["OLD_VALUE".to_owned()]),
                2,
                true,
            )
            .unwrap();
        assert!(matches!(
            runtime.environment_shell(),
            EnvironmentShell::RestartRequired
        ));
        assert_eq!(
            shell_probe(
                &root,
                &session_name,
                &format!("{session_name}:0.0"),
                &environment.path().join("current-after"),
            )
            .lines()
            .take(2)
            .collect::<Vec<_>>(),
            ["before", "unset"]
        );

        assert!(
            run_tmux(
                &root,
                &session_name,
                &[
                    "new-window",
                    "-d",
                    "-t",
                    &session_name,
                    "-c",
                    root.to_str().unwrap(),
                    "/bin/bash",
                    "--login",
                    "-i",
                ],
            )
            .unwrap()
        );
        assert_eq!(
            shell_probe(
                &root,
                &session_name,
                &format!("{session_name}:1.0"),
                &environment.path().join("future"),
            )
            .lines()
            .take(2)
            .collect::<Vec<_>>(),
            ["unset", "after"]
        );
        assert!(
            run_tmux(
                &root,
                &session_name,
                &["kill-window", "-t", &format!("{session_name}:1")],
            )
            .unwrap()
        );

        runtime
            .restart(1, "default", first_resident, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut runtime);
        assert_ne!(runtime.generation, Some(first_resident));
        assert!(matches!(
            runtime.environment_shell(),
            EnvironmentShell::Current
        ));
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &["show-environment", "-t", &session_name, "OLD_VALUE"],
            ),
            "-OLD_VALUE"
        );
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &["show-environment", "-t", &session_name, "NEW_VALUE"],
            ),
            "NEW_VALUE=after"
        );
        assert_ne!(
            tmux_text(
                &root,
                &session_name,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    &format!("{session_name}:0.0"),
                    "#{pane_pid}",
                ],
            ),
            first_pane_pid
        );
        assert_eq!(
            shell_probe(
                &root,
                &session_name,
                &format!("{session_name}:0.0"),
                &environment.path().join("restarted"),
            )
            .lines()
            .take(2)
            .collect::<Vec<_>>(),
            ["unset", "after"]
        );
        assert_eq!(
            fs::metadata(history).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn local_restart_reuses_profile_and_persistent_history() {
        let local = tempdir().unwrap();
        let root = local.path().join("workspace");
        let home = local.path().join("home");
        let state = local.path().join("state");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let thread_id = format!("resident-local-profile-{}", std::process::id());
        let session_name = format!("dx-{thread_id}");
        let _cleanup = TmuxCleanup {
            root: root.clone(),
            session_name: session_name.clone(),
        };
        let mut terminal =
            TerminalRuntime::local(root.clone(), &thread_id, home.clone(), state.clone());
        let mut environment = EnvironmentRuntime::local(home, state.clone());
        let activation = |generation, value: &str| EnvironmentActivate {
            generation,
            entries: vec![EnvironmentEntry {
                name: "LOCAL_PROFILE_PROOF".into(),
                value_base64_url: URL_SAFE_NO_PAD.encode(value),
            }],
            git: crate::environment::GitConfiguration {
                author_name: "dx".into(),
                author_email: "dx@example.invalid".into(),
                thread_url:
                    "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000"
                        .into(),
                signing_enabled: true,
                bitbucket_gateway: None,
            },
        };

        assert!(matches!(
            environment
                .activate(activation(1, "before"), &mut terminal)
                .kind,
            EnvironmentOutcome::Applied
        ));
        terminal
            .open(1, "default", "open-if-absent", None, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut terminal);
        let first_resident = terminal.generation.unwrap();
        let profile = state.join("dx-terminal/profile");
        let expected_command = format!("/bin/bash --rcfile {} -i", profile.display());
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    &format!("{session_name}:0.0"),
                    "#{pane_start_command}",
                ],
            ),
            expected_command
        );
        assert!(
            run_tmux(
                &root,
                &session_name,
                &[
                    "send-keys",
                    "-t",
                    &format!("{session_name}:0.0"),
                    "echo local-history-proof >/dev/null",
                    "Enter",
                ],
            )
            .unwrap()
        );

        assert!(matches!(
            environment
                .activate(activation(2, "after"), &mut terminal)
                .kind,
            EnvironmentOutcome::Applied
        ));
        terminal
            .restart(1, "default", first_resident, Dimensions::INITIAL)
            .unwrap();
        wait_for_ready(&mut terminal);
        assert_eq!(
            tmux_text(
                &root,
                &session_name,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    &format!("{session_name}:0.0"),
                    "#{pane_start_command}",
                ],
            ),
            expected_command
        );
        let probe = state.join("restart-profile-proof");
        let quoted_probe = format!("'{}'", probe.to_string_lossy().replace('\'', "'\\''"));
        let command =
            format!("printf '%s\\n' \"$LOCAL_PROFILE_PROOF\" \"$HISTFILE\" > {quoted_probe}");
        assert!(
            run_tmux(
                &root,
                &session_name,
                &[
                    "send-keys",
                    "-t",
                    &format!("{session_name}:0.0"),
                    &command,
                    "Enter",
                ],
            )
            .unwrap()
        );
        assert_eq!(
            wait_for_file_lines(&probe, 2).lines().collect::<Vec<_>>(),
            ["after", state.join("dx-terminal/history").to_str().unwrap(),]
        );
        let history = fs::read_to_string(state.join("dx-terminal/history")).unwrap();
        assert!(history.contains("local-history-proof"));
    }
}
