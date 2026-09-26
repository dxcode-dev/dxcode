use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

pub const QUIET_PERIOD: Duration = Duration::from_millis(250);
pub const MAX_WAIT: Duration = Duration::from_secs(1);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
const CAPTURE_SOURCE: &str = include_str!("changes_capture.py");

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRequest {
    pub token: String,
    pub source: SourceContext,
    pub expected_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContext {
    pub baseline: String,
    pub default_branch: String,
}

#[derive(Clone, Debug)]
struct ScheduledRefresh {
    sequence: u64,
    request: RefreshRequest,
    ready_at: Instant,
    deadline: Instant,
}

#[derive(Debug)]
pub struct CompletedRefresh {
    sequence: u64,
    pub request: RefreshRequest,
    pub outcome: CandidateOutcome,
}

pub struct ChangesScheduler {
    next_sequence: u64,
    newest_sequence: u64,
    pending: Option<ScheduledRefresh>,
    in_flight: Option<u64>,
}

impl ChangesScheduler {
    pub fn new() -> Self {
        Self {
            next_sequence: 1,
            newest_sequence: 0,
            pending: None,
            in_flight: None,
        }
    }

    pub fn enqueue(&mut self, request: RefreshRequest, now: Instant) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.newest_sequence = sequence;
        let deadline = self
            .pending
            .as_ref()
            .map_or(now + MAX_WAIT, |pending| pending.deadline);
        self.pending = Some(ScheduledRefresh {
            sequence,
            request,
            ready_at: (now + QUIET_PERIOD).min(deadline),
            deadline,
        });
    }

    pub fn start_ready(&mut self, now: Instant, worker: &Sender<WorkerRequest>) {
        if self.in_flight.is_some()
            || self
                .pending
                .as_ref()
                .is_none_or(|pending| pending.ready_at > now)
        {
            return;
        }
        let pending = self.pending.take().expect("pending refresh disappeared");
        if worker
            .send(WorkerRequest {
                sequence: pending.sequence,
                request: pending.request,
            })
            .is_ok()
        {
            self.in_flight = Some(pending.sequence);
        }
    }

    pub fn complete(&mut self, completed: &CompletedRefresh) -> bool {
        if self.in_flight != Some(completed.sequence) {
            return false;
        }
        self.in_flight = None;
        completed.sequence == self.newest_sequence
    }
}

pub struct WorkerRequest {
    sequence: u64,
    request: RefreshRequest,
}

pub fn start_worker(workspace_root: &Path) -> (Sender<WorkerRequest>, Receiver<CompletedRefresh>) {
    let root = workspace_root.to_owned();
    let (requests_tx, requests_rx) = mpsc::channel::<WorkerRequest>();
    let (results_tx, results_rx) = mpsc::channel();
    thread::spawn(move || {
        while let Ok(request) = requests_rx.recv() {
            let outcome = capture(&root, &request.request);
            if results_tx
                .send(CompletedRefresh {
                    sequence: request.sequence,
                    request: request.request,
                    outcome,
                })
                .is_err()
            {
                return;
            }
        }
    });
    (requests_tx, results_rx)
}

pub fn next_completed(receiver: &Receiver<CompletedRefresh>) -> Option<CompletedRefresh> {
    receiver.try_recv().ok()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum CaptureOutput {
    Unchanged { fingerprint: String },
    Complete(CompleteCapture),
    Changed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteCapture {
    pub fingerprint: String,
    pub baseline: String,
    pub head: String,
    pub branch: Option<String>,
    pub upstream_label: Option<String>,
    pub ahead: u64,
    pub commits: Vec<Commit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<Worktree>>,
    pub ranges: Vec<CapturedRange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Worktree {
    pub id: String,
    pub name: String,
    pub head: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedRange {
    pub range: Range,
    pub truncated: bool,
    pub summary: Summary,
    pub files: Vec<CapturedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Range {
    All,
    Uncommitted,
    Commit { sha: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub path: String,
    pub status: FileStatus,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub truncated: bool,
    pub patch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Untracked,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CandidateOutcome {
    Unchanged { fingerprint: String },
    Complete { capture: CompleteCapture },
    Raced,
    Unavailable { reason: UnavailableReason },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    SourceUnavailable,
    CaptureFailed,
    Timeout,
    CandidateTooLarge,
}

fn capture(root: &Path, request: &RefreshRequest) -> CandidateOutcome {
    if !root.is_absolute() || !root.is_dir() {
        return CandidateOutcome::Unavailable {
            reason: UnavailableReason::SourceUnavailable,
        };
    }
    let mut command = Command::new("python3");
    command
        .arg("-c")
        .arg(CAPTURE_SOURCE)
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LC_ALL", "C.UTF-8")
        .env("DX_CHANGES_ROOT", root)
        .env("DX_CHANGES_BASELINE", &request.source.baseline)
        .env("DX_CHANGES_DEFAULT_BRANCH", &request.source.default_branch)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(fingerprint) = &request.expected_fingerprint {
        command.env("DX_CHANGES_EXPECTED_FINGERPRINT", fingerprint);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return CandidateOutcome::Unavailable {
                reason: UnavailableReason::CaptureFailed,
            };
        }
    };
    let stdout = child.stdout.take().expect("capture stdout was not piped");
    let reader = thread::spawn(move || read_bounded(stdout));
    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = match reader.join() {
        Ok(Ok(bytes)) => bytes,
        _ => {
            return CandidateOutcome::Unavailable {
                reason: UnavailableReason::CandidateTooLarge,
            };
        }
    };
    let Some(status) = status else {
        return CandidateOutcome::Unavailable {
            reason: UnavailableReason::Timeout,
        };
    };
    if !status.success() {
        return CandidateOutcome::Unavailable {
            reason: UnavailableReason::CaptureFailed,
        };
    }
    match serde_json::from_slice::<CaptureOutput>(&bytes) {
        Ok(CaptureOutput::Unchanged { fingerprint }) => CandidateOutcome::Unchanged { fingerprint },
        Ok(CaptureOutput::Complete(capture)) => CandidateOutcome::Complete { capture },
        Ok(CaptureOutput::Changed) => CandidateOutcome::Raced,
        Err(_) => CandidateOutcome::Unavailable {
            reason: UnavailableReason::CaptureFailed,
        },
    }
}

fn read_bounded(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut oversized = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if bytes.len() + read <= MAX_CAPTURE_BYTES {
            bytes.extend_from_slice(&buffer[..read]);
        } else {
            oversized = true;
        }
    }
    if oversized {
        Err(io::ErrorKind::FileTooLarge.into())
    } else {
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(token: &str) -> RefreshRequest {
        RefreshRequest {
            token: token.into(),
            source: SourceContext {
                baseline: "a".repeat(40),
                default_branch: "main".into(),
            },
            expected_fingerprint: None,
        }
    }

    #[test]
    fn decodes_flat_capture_output_and_encodes_candidate_envelope() {
        let fingerprint = "b".repeat(64);
        let baseline = "a".repeat(40);
        let source = format!(
            r#"{{"kind":"complete","fingerprint":"{fingerprint}","baseline":"{baseline}","head":"{baseline}","branch":"main","upstreamLabel":null,"ahead":0,"commits":[],"ranges":[]}}"#
        );
        let decoded: CaptureOutput = serde_json::from_str(&source).unwrap();
        let CaptureOutput::Complete(capture) = decoded else {
            panic!("complete capture did not decode")
        };
        assert_eq!(capture.fingerprint, fingerprint);
        assert_eq!(
            serde_json::to_string(&CandidateOutcome::Complete { capture }).unwrap(),
            format!(
                r#"{{"kind":"complete","capture":{{"fingerprint":"{fingerprint}","baseline":"{baseline}","head":"{baseline}","branch":"main","upstreamLabel":null,"ahead":0,"commits":[],"ranges":[]}}}}"#
            )
        );
    }

    #[test]
    fn coalesces_a_burst_to_the_newest_refresh_after_quiet() {
        let now = Instant::now();
        let (tx, rx) = mpsc::channel();
        let mut scheduler = ChangesScheduler::new();
        for generation in 1..=30 {
            scheduler.enqueue(request(&format!("token-{generation}")), now);
        }
        scheduler.start_ready(now + QUIET_PERIOD - Duration::from_millis(1), &tx);
        assert!(rx.try_recv().is_err());
        scheduler.start_ready(now + QUIET_PERIOD, &tx);
        assert_eq!(rx.recv().unwrap().request.token, "token-30");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn ongoing_refreshes_cannot_starve_capture() {
        let now = Instant::now();
        let (tx, rx) = mpsc::channel();
        let mut scheduler = ChangesScheduler::new();
        for step in 0..=10 {
            scheduler.enqueue(
                request(&format!("token-{step}")),
                now + Duration::from_millis(step * 100),
            );
        }
        scheduler.start_ready(now + MAX_WAIT - Duration::from_millis(1), &tx);
        assert!(rx.try_recv().is_err());
        scheduler.start_ready(now + MAX_WAIT, &tx);
        assert_eq!(rx.recv().unwrap().request.token, "token-10");
    }

    #[test]
    fn suppresses_an_in_flight_candidate_when_a_newer_refresh_arrives() {
        let now = Instant::now();
        let (tx, rx) = mpsc::channel();
        let mut scheduler = ChangesScheduler::new();
        scheduler.enqueue(request("older-token"), now);
        scheduler.start_ready(now + QUIET_PERIOD, &tx);
        let older = rx.recv().unwrap();
        scheduler.enqueue(request("newer-token"), now + QUIET_PERIOD);
        assert!(!scheduler.complete(&CompletedRefresh {
            sequence: older.sequence,
            request: older.request,
            outcome: CandidateOutcome::Raced,
        }));
        scheduler.start_ready(now + QUIET_PERIOD * 2, &tx);
        assert_eq!(rx.recv().unwrap().request.token, "newer-token");
    }

    #[test]
    fn a_new_scheduler_has_no_refresh_to_replay_after_disconnect() {
        let now = Instant::now();
        let (tx, rx) = mpsc::channel();
        let mut disconnected = ChangesScheduler::new();
        disconnected.enqueue(request("lost-token"), now);
        drop(disconnected);

        let mut reconnected = ChangesScheduler::new();
        reconnected.start_ready(now + QUIET_PERIOD, &tx);
        assert!(rx.try_recv().is_err());
    }
}
