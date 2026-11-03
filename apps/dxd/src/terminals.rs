//! Every Terminal of the Thread: `default` (tmux session `main`, which the
//! agent shares) and up to seven more, each its own resident with its own
//! PTY, replay ring, attachments, and tmux session `main-<n>`. Core names a
//! Terminal on every control; input frames find theirs by resident
//! generation, which is unique to one resident.

use crate::environment::EnvironmentShell;
use crate::protocol::{
    Dimensions, TERMINAL_VERSION, TerminalClientMessage, TerminalGeneration, TerminalHeartbeat,
    decode_terminal_frame,
};
use crate::terminal::{ReaderEvent, TerminalOutbound, TerminalRuntime};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::task::Poll;
use std::time::Instant;

/// Terminals, `default` included, that may hold a resident at once.
pub const SESSION_LIMIT: usize = 8;
/// The highest number a Terminal besides `default` may have.
const NUMBER_LIMIT: u16 = 1_000;
/// Carries every other Terminal's handoff across a self-update, by number.
pub const SESSIONS_HANDOFF_VARIABLE: &str = "DXD_TERMINAL_SESSIONS_HANDOFF";

/// Which Terminal a control names: `default` or `1`..=`1000` (no leading
/// zero). Anything else is not a Terminal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Name {
    Default,
    Number(u16),
}

fn parse(name: &str) -> Option<Name> {
    if name == "default" {
        return Some(Name::Default);
    }
    let number = name.parse::<u16>().ok()?;
    (number >= 1 && number <= NUMBER_LIMIT && number.to_string() == name)
        .then_some(Name::Number(number))
}

pub struct Terminals {
    default: TerminalRuntime,
    others: BTreeMap<u16, TerminalRuntime>,
    /// Where residents are recorded; `None` in tests without a state root.
    state_root: Option<PathBuf>,
    /// The first Terminal polled for output next, so a busy one never
    /// starves the others.
    next_poll: usize,
}

fn invalid_control() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid terminal control")
}

impl Terminals {
    /// `default` plus every other Terminal a previous daemon recorded in
    /// `state_root`; each starts as its recorded resident, exited until
    /// `reattach_sessions` finds its tmux session.
    pub fn recorded(default: TerminalRuntime, state_root: &Path) -> Self {
        let mut others = BTreeMap::new();
        let prefix = default
            .record_path()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .map(|name| format!("{name}-"));
        if let (Some(prefix), Ok(entries)) = (prefix, std::fs::read_dir(state_root)) {
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                let Some(Name::Number(number)) = file_name
                    .to_str()
                    .and_then(|name| name.strip_prefix(&prefix))
                    .and_then(parse)
                else {
                    continue;
                };
                if others.len() + 1 >= SESSION_LIMIT {
                    break;
                }
                others.insert(
                    number,
                    default.sibling(&number.to_string(), Some(state_root)),
                );
            }
        }
        Self {
            default,
            others,
            state_root: Some(state_root.to_owned()),
            next_poll: 0,
        }
    }

    fn named(&mut self, terminal: &str) -> io::Result<Option<&mut TerminalRuntime>> {
        match parse(terminal).ok_or_else(invalid_control)? {
            Name::Default => Ok(Some(&mut self.default)),
            Name::Number(number) => Ok(self.others.get_mut(&number)),
        }
    }

    fn all_mut(&mut self) -> impl Iterator<Item = &mut TerminalRuntime> {
        std::iter::once(&mut self.default).chain(self.others.values_mut())
    }

    fn all(&self) -> impl Iterator<Item = &TerminalRuntime> {
        std::iter::once(&self.default).chain(self.others.values())
    }

    /// Adopt the shells a previous image handed off, then rejoin every
    /// recorded tmux session that outlived the previous process.
    pub fn adopt_and_reattach(&mut self, default: Option<String>, others: Option<String>) {
        if let Some(encoded) = default {
            match self.default.adopt(&encoded) {
                Ok(()) => eprintln!("dxd adopted the running shell after update"),
                Err(error) => eprintln!("dxd could not adopt the shell after update: {error}"),
            }
        }
        let handed = others
            .and_then(|encoded| serde_json::from_str::<BTreeMap<u16, String>>(&encoded).ok())
            .unwrap_or_default();
        for (number, encoded) in handed {
            let Some(terminal) = self.others.get_mut(&number) else {
                continue;
            };
            if let Err(error) = terminal.adopt(&encoded) {
                eprintln!("dxd could not adopt Terminal {number} after update: {error}");
            }
        }
        for terminal in self.all_mut() {
            terminal.reattach_session();
        }
    }

    pub fn heartbeat(&self) -> TerminalHeartbeat {
        self.default.heartbeat()
    }

    /// Every Terminal besides `default`, by number.
    pub fn other_heartbeats(&self) -> Vec<TerminalHeartbeat> {
        self.others
            .values()
            .map(TerminalRuntime::heartbeat)
            .collect()
    }

    pub fn open(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        mode: &str,
        expected_resident_generation: Option<TerminalGeneration>,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        if let Name::Number(number) = parse(terminal).ok_or_else(invalid_control)?
            && !self.others.contains_key(&number)
        {
            let present = usize::from(self.default.present()) + self.others.len();
            if present >= SESSION_LIMIT {
                return Ok(vec![TerminalOutbound::Control(
                    TerminalClientMessage::Refused {
                        terminal_version: TERMINAL_VERSION,
                        terminal: terminal.to_owned(),
                        code: "session-limit",
                    },
                )]);
            }
            let sibling = self.default.sibling(terminal, self.state_root.as_deref());
            self.others.insert(number, sibling);
        }
        self.named(terminal)?.expect("the Terminal exists").open(
            terminal_version,
            terminal,
            mode,
            expected_resident_generation,
            dimensions,
        )
    }

    /// End Terminal `terminal` (never `default`) and its session.
    pub fn close(
        &mut self,
        terminal_version: u8,
        terminal: &str,
    ) -> io::Result<Vec<TerminalOutbound>> {
        let Name::Number(number) = parse(terminal).ok_or_else(invalid_control)? else {
            return Err(invalid_control());
        };
        if terminal_version != TERMINAL_VERSION {
            return Err(invalid_control());
        }
        Ok(match self.others.remove(&number) {
            Some(runtime) => runtime.close(),
            // A session a lost record left behind still ends.
            None => {
                self.default
                    .sibling(terminal, self.state_root.as_deref())
                    .close();
                Vec::new()
            }
        })
    }

    pub fn restart(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        expected_resident_generation: TerminalGeneration,
        dimensions: Dimensions,
    ) -> io::Result<Vec<TerminalOutbound>> {
        match self.named(terminal)? {
            Some(runtime) => runtime.restart(
                terminal_version,
                terminal,
                expected_resident_generation,
                dimensions,
            ),
            None => Ok(Vec::new()),
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
        match self.named(terminal)? {
            Some(runtime) => runtime.attach(
                terminal_version,
                terminal,
                resident_generation,
                attachment_generation,
                resize_ordinal,
                dimensions,
            ),
            // A closed Terminal: the attachment is stale.
            None => Ok(vec![TerminalOutbound::Control(
                TerminalClientMessage::Error {
                    terminal_version: TERMINAL_VERSION,
                    resident_generation,
                    attachment_generation: Some(attachment_generation),
                    code: "invalid-attachment",
                },
            )]),
        }
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
        match self.named(terminal)? {
            Some(runtime) => runtime.resize(
                terminal_version,
                terminal,
                resident_generation,
                attachment_generation,
                resize_ordinal,
                dimensions,
            ),
            None => Ok(Vec::new()),
        }
    }

    pub fn detach(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
        attachment_generation: TerminalGeneration,
        reason: &str,
    ) -> io::Result<Vec<TerminalOutbound>> {
        match self.named(terminal)? {
            Some(runtime) => runtime.detach(
                terminal_version,
                terminal,
                resident_generation,
                attachment_generation,
                reason,
            ),
            None => Ok(Vec::new()),
        }
    }

    pub fn reset_attachments(
        &mut self,
        terminal_version: u8,
        terminal: &str,
        resident_generation: TerminalGeneration,
    ) -> io::Result<Vec<TerminalOutbound>> {
        match self.named(terminal)? {
            Some(runtime) => {
                runtime.reset_attachments(terminal_version, terminal, resident_generation)
            }
            None => Ok(Vec::new()),
        }
    }

    /// Queue an input frame on the Terminal whose resident it names; a frame
    /// for no current resident is stale and dropped, as one Terminal does.
    pub fn input(&mut self, encoded: &[u8]) -> io::Result<Vec<TerminalOutbound>> {
        let frame = decode_terminal_frame(encoded)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid terminal frame"))?;
        let runtime = self
            .all_mut()
            .find(|terminal| terminal.generation() == Some(frame.resident_generation));
        match runtime {
            Some(runtime) => runtime.input(encoded),
            None => self.default.input(encoded),
        }
    }

    pub fn drain_input(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let mut outbound = Vec::new();
        for terminal in self.all_mut() {
            outbound.extend(terminal.drain_input()?);
        }
        Ok(outbound)
    }

    /// Resolve with the next reader event of any Terminal and which one it
    /// came from. Pending forever while none runs, so it can sit in a
    /// `select!`.
    pub async fn wait_output(&mut self) -> (Option<u16>, Option<ReaderEvent>) {
        std::future::poll_fn(|context| {
            let count = 1 + self.others.len();
            let start = self.next_poll % count;
            let keys = std::iter::once(None)
                .chain(self.others.keys().copied().map(Some))
                .collect::<Vec<_>>();
            for offset in 0..count {
                let key = keys[(start + offset) % count];
                let terminal = match key {
                    None => &mut self.default,
                    Some(number) => self.others.get_mut(&number).expect("listed Terminal"),
                };
                if let Poll::Ready(event) = terminal.poll_output(context) {
                    self.next_poll = start + offset + 1;
                    return Poll::Ready((key, event));
                }
            }
            Poll::Pending
        })
        .await
    }

    pub fn drain_output_with(
        &mut self,
        (key, event): (Option<u16>, Option<ReaderEvent>),
    ) -> io::Result<Vec<TerminalOutbound>> {
        match key {
            None => self.default.drain_output_with(event),
            Some(number) => match self.others.get_mut(&number) {
                Some(terminal) => terminal.drain_output_with(event),
                None => Ok(Vec::new()),
            },
        }
    }

    pub fn drain_output(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let mut outbound = Vec::new();
        for terminal in self.all_mut() {
            outbound.extend(terminal.drain_output()?);
        }
        Ok(outbound)
    }

    pub fn first_output_deadline(&self) -> Option<Instant> {
        self.all()
            .filter_map(TerminalRuntime::first_output_deadline)
            .min()
    }

    pub fn reap_exited(&mut self) -> io::Result<Vec<TerminalOutbound>> {
        let mut outbound = Vec::new();
        for terminal in self.all_mut() {
            outbound.extend(terminal.reap_exited()?);
        }
        Ok(outbound)
    }

    pub fn refresh_environment(
        &mut self,
        values: &BTreeMap<String, String>,
        generation: u64,
        changed: bool,
    ) {
        for terminal in self.all_mut() {
            terminal.refresh_environment(values, generation, changed);
        }
    }

    /// A restart is required when any Terminal's shell has older values.
    pub fn environment_shell(&self) -> EnvironmentShell {
        let shells = self
            .all()
            .map(TerminalRuntime::environment_shell)
            .collect::<Vec<_>>();
        if shells.contains(&EnvironmentShell::RestartRequired) {
            EnvironmentShell::RestartRequired
        } else if shells.contains(&EnvironmentShell::Current) {
            EnvironmentShell::Current
        } else {
            EnvironmentShell::NoShell
        }
    }

    /// The environment variables that carry every running Terminal into the
    /// next image.
    pub fn prepare_handoff(&self) -> Vec<(&'static str, String)> {
        let mut handoff = Vec::new();
        if let Some(encoded) = self.default.prepare_handoff() {
            handoff.push((crate::terminal::HANDOFF_VARIABLE, encoded));
        }
        let others = self
            .others
            .iter()
            .filter_map(|(number, terminal)| Some((*number, terminal.prepare_handoff()?)))
            .collect::<BTreeMap<_, _>>();
        if !others.is_empty()
            && let Ok(encoded) = serde_json::to_string(&others)
        {
            handoff.push((SESSIONS_HANDOFF_VARIABLE, encoded));
        }
        handoff
    }
}
