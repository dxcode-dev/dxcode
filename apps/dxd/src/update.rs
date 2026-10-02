//! Self-update. After every registration Core names the release it pins (URL
//! and SHA-256). The daemon compares that digest with the image it is
//! running; when they differ it downloads, verifies, and smoke-tests the
//! release on a background worker that outlives connections, so no feature
//! waits and a dropped connection loses nothing. A failure leaves the running
//! daemon untouched; Core names the release again on the next registration.
//!
//! The session swaps images only at a safe moment (see `session.rs`):
//! nothing in flight and no feature traffic for `QUIET`. The running shell
//! survives because its PTY is handed to the new image (`terminal::Handoff`).

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{Receiver, Sender, channel};

const MAX_RELEASE_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const SMOKE_TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long every feature must have been quiet before the swap.
pub const QUIET: Duration = Duration::from_secs(5);
/// A failed attempt (for example the guest resolver still waking up after a
/// resume) is retried in-process after 15, 30, 60, 120, and 240 seconds;
/// the next registration starts a fresh series.
const RETRY_BASE: Duration = Duration::from_secs(15);
const RETRY_ATTEMPTS: u32 = 5;

#[derive(Clone, Debug)]
pub struct UpdateRequest {
    pub url: String,
    pub sha256: String,
    pub release: String,
}

/// A verified release waiting for its swap.
#[derive(Debug)]
pub struct Ready {
    release: String,
    sha256: String,
    /// `None` when the file at the binary path already is this release (a
    /// bootstrap replaced it on disk); only the re-exec is left.
    verified: Option<PathBuf>,
}

#[derive(Debug)]
enum State {
    Idle,
    Downloading(UpdateRequest, u32),
    /// The last attempt failed; try again at the instant.
    Retrying(UpdateRequest, u32, Instant),
    Ready(Ready),
}

#[derive(Debug)]
pub enum Outcome {
    /// The running image already is the named release.
    Current {
        sha256: String,
    },
    Verified(Ready),
    Failed {
        sha256: String,
        release: String,
    },
}

/// Process-lifetime update state, owned by the daemon rather than a session.
pub struct Updater {
    current_exe: PathBuf,
    running: Arc<OnceLock<Option<String>>>,
    state: State,
    sender: Sender<Outcome>,
    outcomes: Receiver<Outcome>,
}

impl Updater {
    pub fn new(current_exe: PathBuf) -> Self {
        // Digest the running image before anything can replace the file.
        let running = Arc::new(OnceLock::new());
        let slot = Arc::clone(&running);
        let path = current_exe.clone();
        std::thread::spawn(move || {
            let _ = slot.set(sha256_file(&path).ok());
        });
        let (sender, outcomes) = channel(4);
        Self {
            current_exe,
            running,
            state: State::Idle,
            sender,
            outcomes,
        }
    }

    pub fn current_exe(&self) -> &Path {
        &self.current_exe
    }

    /// Core named its release. Starts a background download unless this
    /// release is already running, downloading, or verified.
    pub fn request(&mut self, request: UpdateRequest) {
        match &self.state {
            State::Downloading(pending, _) if pending.sha256 == request.sha256 => return,
            State::Ready(ready) if ready.sha256 == request.sha256 => return,
            State::Ready(_) => self.discard(),
            _ => {}
        }
        if self
            .running
            .get()
            .is_some_and(|running| running.as_deref() == Some(request.sha256.as_str()))
        {
            return;
        }
        self.start(request, 0);
    }

    /// Start a due retry. Called on the heartbeat tick.
    pub fn retry_due(&mut self, now: Instant) {
        if let State::Retrying(_, _, at) = &self.state
            && now >= *at
            && let State::Retrying(request, attempt, _) =
                std::mem::replace(&mut self.state, State::Idle)
        {
            self.start(request, attempt);
        }
    }

    fn start(&mut self, request: UpdateRequest, attempt: u32) {
        self.state = State::Downloading(request.clone(), attempt);
        let running = Arc::clone(&self.running);
        let current = self.current_exe.clone();
        let sender = self.sender.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = prepare(&request, &current, &running);
            let _ = sender.blocking_send(outcome);
        });
    }

    pub async fn next(&mut self) -> Outcome {
        self.outcomes
            .recv()
            .await
            .expect("the updater holds its own sender")
    }

    /// Record a worker outcome. Returns the release to report as failed.
    pub fn complete(&mut self, outcome: Outcome) -> Option<String> {
        let expected = match &self.state {
            State::Downloading(request, _) => request.sha256.clone(),
            _ => String::new(),
        };
        match outcome {
            Outcome::Current { sha256 } if sha256 == expected => {
                self.state = State::Idle;
                None
            }
            Outcome::Verified(ready) if ready.sha256 == expected => {
                eprintln!("dxd verified release {}; swapping when idle", ready.release);
                self.state = State::Ready(ready);
                None
            }
            Outcome::Failed { sha256, release } if sha256 == expected => {
                let State::Downloading(request, attempt) =
                    std::mem::replace(&mut self.state, State::Idle)
                else {
                    unreachable!("a matching outcome belongs to a download");
                };
                if attempt < RETRY_ATTEMPTS {
                    let at = Instant::now() + RETRY_BASE * 2_u32.pow(attempt);
                    self.state = State::Retrying(request, attempt + 1, at);
                }
                Some(release)
            }
            // Superseded by a newer request: drop its file, keep the state.
            Outcome::Verified(Ready {
                verified: Some(path),
                ..
            }) => {
                let _ = fs::remove_file(path);
                None
            }
            _ => None,
        }
    }

    /// The release waiting for a safe moment, if any.
    pub fn ready(&self) -> Option<&str> {
        match &self.state {
            State::Ready(ready) => Some(&ready.release),
            _ => None,
        }
    }

    /// Put the verified release at the binary path. Nothing running changes;
    /// the caller re-execs next. On failure the running daemon is untouched
    /// and the release is asked for again on the next registration.
    pub fn install(&mut self) -> io::Result<()> {
        let State::Ready(ready) = std::mem::replace(&mut self.state, State::Idle) else {
            return Err(io::Error::other("no verified release"));
        };
        match &ready.verified {
            None => Ok(()),
            Some(verified) => install(verified, &self.current_exe).inspect_err(|_| {
                let _ = fs::remove_file(verified);
            }),
        }
    }

    fn discard(&mut self) {
        if let State::Ready(Ready {
            verified: Some(path),
            ..
        }) = std::mem::replace(&mut self.state, State::Idle)
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn prepare(request: &UpdateRequest, current: &Path, running: &OnceLock<Option<String>>) -> Outcome {
    let failed = |error: io::Error| {
        eprintln!("dxd update to {} failed: {error}", request.release);
        Outcome::Failed {
            sha256: request.sha256.clone(),
            release: request.release.clone(),
        }
    };
    if running.wait().as_deref() == Some(request.sha256.as_str()) {
        return Outcome::Current {
            sha256: request.sha256.clone(),
        };
    }
    let ready = |verified| {
        Outcome::Verified(Ready {
            release: request.release.clone(),
            sha256: request.sha256.clone(),
            verified,
        })
    };
    if sha256_file(current).is_ok_and(|installed| installed == request.sha256) {
        return match smoke_test(current, &request.release) {
            Ok(()) => ready(None),
            Err(error) => failed(error),
        };
    }
    let verified = match download(request, current) {
        Ok(path) => path,
        Err(error) => return failed(error),
    };
    match smoke_test(&verified, &request.release) {
        Ok(()) => ready(Some(verified)),
        Err(error) => {
            let _ = fs::remove_file(&verified);
            failed(error)
        }
    }
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// Run the candidate once before trusting it with the running shell: it must
/// execute on this platform and report the release and protocol Core named.
fn smoke_test(binary: &Path, release: &str) -> io::Result<()> {
    let mut child = retry_text_busy(|| {
        std::process::Command::new(binary)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    })?;
    let deadline = Instant::now() + SMOKE_TEST_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("release did not answer --version"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut output = String::new();
    if let Some(stdout) = child.stdout.take() {
        stdout.take(256).read_to_string(&mut output)?;
    }
    let expected = format!("dxd {release} protocol {}", crate::PROTOCOL_MAJOR);
    if !status.success() || output.trim_end() != expected {
        return Err(io::Error::other(
            "release does not report the named version",
        ));
    }
    Ok(())
}

/// Download and verify the release next to the current binary. Returns the
/// verified temporary path; nothing running has changed yet.
pub fn download(request: &UpdateRequest, current: &Path) -> io::Result<PathBuf> {
    let directory = current
        .parent()
        .ok_or_else(|| io::Error::other("binary has no parent directory"))?;
    let temporary = directory.join(format!(
        ".dxd-update-{}{}",
        rand::random::<u64>(),
        std::env::consts::EXE_SUFFIX
    ));
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .http_status_as_error(true)
        .build()
        .new_agent();
    let response = agent
        .get(&request.url)
        .call()
        .map_err(|error| io::Error::other(error.to_string()))?;
    let mut body = response
        .into_body()
        .into_with_config()
        .limit(MAX_RELEASE_BYTES + 1)
        .reader();
    let mut file = fs::File::create(&temporary)?;
    let result = (|| {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut total = 0_u64;
        loop {
            let read = body.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > MAX_RELEASE_BYTES {
                return Err(io::Error::other("release exceeds its size limit"));
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read])?;
        }
        file.sync_all()?;
        let actual = format!("{:x}", hasher.finalize());
        if actual != request.sha256 {
            return Err(io::Error::other("release checksum mismatch"));
        }
        set_executable(&temporary)?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

/// Move the verified binary into place atomically.
pub fn install(verified: &Path, current: &Path) -> io::Result<()> {
    fs::rename(verified, current)?;
    if let Some(directory) = current.parent() {
        if let Ok(directory) = fs::File::open(directory) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn set_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// Replace this process with the freshly installed binary, passing the same
/// arguments plus any handoff state through the environment.
pub fn reexec(current: &Path, handoff: Option<(&str, String)>) -> io::Error {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let mut command = std::process::Command::new(current);
    command.args(&arguments);
    if let Some((name, value)) = handoff {
        command.env(name, value);
    }
    use std::os::unix::process::CommandExt;
    match retry_text_busy(|| Err::<(), _>(command.exec())) {
        Ok(()) => unreachable!("exec returns only on failure"),
        Err(error) => error,
    }
}

/// A file just written can be briefly "text busy" while another thread's
/// fork still holds its write descriptor; that clears within milliseconds.
fn retry_text_busy<T>(mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempts = 0;
    loop {
        match operation() {
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 20 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            result => return result,
        }
    }
}

/// Remove any download an interrupted update left beside the binary.
pub fn cleanup_previous(current: &Path) {
    if let Some(entries) = current
        .parent()
        .and_then(|parent| fs::read_dir(parent).ok())
    {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".dxd-update-")
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve_once(body: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 4096];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(body);
            }
        });
        format!("http://{address}/dxd")
    }

    #[test]
    fn install_replaces_the_binary_in_place() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        fs::write(&current, b"old").unwrap();
        let verified = directory.path().join(".dxd-update-1");
        fs::write(&verified, b"new").unwrap();
        install(&verified, &current).unwrap();
        assert_eq!(fs::read(&current).unwrap(), b"new");
        assert!(!verified.exists());
    }

    #[test]
    fn download_rejects_checksum_mismatch_without_touching_the_binary() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        fs::write(&current, b"old").unwrap();
        let request = UpdateRequest {
            url: serve_once(b"hello"),
            sha256: "0".repeat(64),
            release: "9.9.9".into(),
        };
        assert!(download(&request, &current).is_err());
        assert_eq!(fs::read(&current).unwrap(), b"old");
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dxd-update-")
        }));
        let good = UpdateRequest {
            url: serve_once(b"hello"),
            sha256: format!("{:x}", Sha256::digest(b"hello")),
            ..request
        };
        let verified = download(&good, &current).unwrap();
        assert_eq!(fs::read(&verified).unwrap(), b"hello");
    }

    #[test]
    fn a_download_that_is_not_a_runnable_dxd_fails_and_leaves_nothing_behind() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        fs::write(&current, b"old").unwrap();
        let running = OnceLock::new();
        running.set(Some("1".repeat(64))).unwrap();
        let body: &'static [u8] = b"#!/bin/sh\necho dxd 0.0.1 protocol 1\n";
        let request = UpdateRequest {
            url: serve_once(body),
            sha256: format!("{:x}", Sha256::digest(body)),
            release: "9.9.9".into(),
        };
        assert!(matches!(
            prepare(&request, &current, &running),
            Outcome::Failed { .. }
        ));
        assert_eq!(fs::read(&current).unwrap(), b"old");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_release_already_on_disk_is_swapped_without_a_download() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        let body = format!(
            "#!/bin/sh\necho dxd 9.9.9 protocol {}\n",
            crate::PROTOCOL_MAJOR
        );
        fs::write(&current, &body).unwrap();
        set_executable(&current).unwrap();
        let running = OnceLock::new();
        running.set(Some("1".repeat(64))).unwrap();
        let request = UpdateRequest {
            url: "http://127.0.0.1:9/unreachable".into(),
            sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
            release: "9.9.9".into(),
        };
        assert!(matches!(
            prepare(&request, &current, &running),
            Outcome::Verified(Ready { verified: None, .. })
        ));
        let current_request = UpdateRequest {
            sha256: "1".repeat(64),
            ..request
        };
        assert!(matches!(
            prepare(&current_request, &current, &running),
            Outcome::Current { .. }
        ));
    }

    #[tokio::test]
    async fn a_failed_attempt_is_retried_in_process_with_backoff() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        fs::write(&current, b"running").unwrap();
        let mut updater = Updater::new(current);
        let request = UpdateRequest {
            // Nothing listens: the attempt fails like a resolver gap would.
            url: "http://127.0.0.1:9/dxd".into(),
            sha256: "2".repeat(64),
            release: "9.9.9".into(),
        };
        updater.request(request.clone());
        let outcome = updater.next().await;
        assert_eq!(updater.complete(outcome).as_deref(), Some("9.9.9"));
        assert!(matches!(updater.state, State::Retrying(_, 1, _)));
        // Not yet due: nothing starts.
        updater.retry_due(Instant::now());
        assert!(matches!(updater.state, State::Retrying(_, 1, _)));
        updater.retry_due(Instant::now() + RETRY_BASE);
        assert!(matches!(updater.state, State::Downloading(_, 1)));
        let outcome = updater.next().await;
        updater.complete(outcome);
        let State::Retrying(_, 2, at) = updater.state else {
            panic!("expected a second retry");
        };
        assert!(at >= Instant::now() + RETRY_BASE);
        // A new registration names the release again and starts afresh.
        updater.request(request);
        assert!(matches!(updater.state, State::Downloading(_, 0)));
        let outcome = updater.next().await;
        updater.complete(outcome);
    }

    #[test]
    fn cleanup_removes_interrupted_downloads_only() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("dxd");
        fs::write(&current, b"binary").unwrap();
        fs::write(directory.path().join(".dxd-update-7"), b"partial").unwrap();
        cleanup_previous(&current);
        assert!(current.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
