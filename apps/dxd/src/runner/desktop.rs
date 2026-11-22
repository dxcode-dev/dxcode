//! The Desktop of a Mac runner: one voxl per machine, started by the
//! supervisor outside every sandbox, showing and controlling the whole Mac
//! for the Threads' owner.
//!
//! - voxl listens on `127.0.0.1:VOXL_PORT` with a fresh random password per
//!   start, held only in this process's memory and voxl's environment: never
//!   written under `~/.dx`, never handed to a Thread's dxd.
//! - The Seatbelt profile (`sandbox.rs`) denies every Thread process a
//!   connection to that port and a listener on it.
//! - Core reaches voxl only through the supervisor's own connection:
//!   `desktop.ensure`, `desktop.health`, `desktop.windows`, and
//!   `desktop.settings` (opens System Settings at a privacy pane) requests, and
//!   streams (Core sends
//!   `{"type":"stream-open","stream":n,"path":"/ws"}`; data travels as binary
//!   messages, see [`encode`]).
//! - The deployment's voxl (its `/runner/manifest.json` asset
//!   `voxl-darwin-<arch>`, SHA-256-checked) is `~/.dx/runner/bin/voxl`. Its
//!   launcher (`dx-desktop-darwin-<arch>`, apps/desktop) becomes the app
//!   bundle `~/.dx/runner/dx.app` (`Contents/MacOS/dx`, bundle identifier
//!   [`BUNDLE_ID`], ad-hoc signed on macOS): the supervisor starts the
//!   launcher, which starts voxl as its child. macOS's privacy settings list
//!   "dx", and its grants survive voxl updates, since they belong to the
//!   launcher, which changes only when dx ships a new one. `dx.app.sha256`
//!   records the launcher download the bundle was made from (signing changes
//!   the file). Without a launcher it runs voxl itself; without the manifest's
//!   voxl, a local `cargo install voxl-server --root ~/.dx/runner/voxl`. All
//!   sit under `~/.dx/runner`, which no Thread can read or write.
//! - macOS asks for Screen Recording and Accessibility the first time voxl
//!   runs (an ad-hoc signature's code requirement is its hash, so a new
//!   launcher asks again; a new voxl does not). voxl keeps running without them; a denied Screen Recording is
//!   reported `failed` with voxl's log tail and voxl is stopped, so the next
//!   `desktop.ensure` starts it again once the person allowed it.
//! - The launcher (or voxl, without one) is spawned as its own responsible
//!   process (macOS), so the permissions belong to dx.app and never to the
//!   supervisor, whose sandboxed children would otherwise share them.
//! - Linux runners have no Desktop: Landlock cannot keep Thread commands off
//!   one port. `DX_RUNNER_DESKTOP_TEST=1` turns it on for the runner E2E only.

use crate::runner::{Config, Paths, log, set_mode};
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// voxl's port on loopback. The Seatbelt profile denies it to Threads.
pub const VOXL_PORT: u16 = 6911;
/// How long voxl has to answer `/healthz` after it starts.
const START_WAIT: Duration = Duration::from_secs(20);
/// voxl with no viewer stops after this long.
const IDLE_STOP: Duration = Duration::from_secs(10 * 60);
const LOG_TAIL_BYTES: u64 = 2048;
const MAX_VOXL_BINARY: u64 = 128 * 1024 * 1024;
/// What voxl logs when macOS has not allowed Screen Recording.
const CAPTURE_DENIED: &str = "Screen Recording permission is missing";
const INPUT_DENIED: &str = "Accessibility permission is missing";
/// The Desktop app bundle's identifier; `uninstall` resets its privacy grants.
/// Its own identifier, not the future dx Mac app's (`dev.dx.app`): macOS
/// keys each privacy grant to the identifier plus the signature, so sharing
/// one would leave stale ad-hoc entries once a Developer ID app ships.
pub const BUNDLE_ID: &str = "dev.dx.app.desktop";
const BUNDLE_NAME: &str = "dx";
pub const BUILD_COMMAND: &str = "cargo install voxl-server --root ~/.dx/runner/voxl";

// ---------- stream frames ----------

/// Data messages between Core and the supervisor:
/// `[u32 stream BE][u8 kind][payload]`. Kind 0 is a text WebSocket message
/// (UTF-8), 1 a binary one, 2 a close (`[u16 code BE][reason]`, or empty).
/// Kind | [`MORE`] marks a fragment: the payloads of fragments up to the next
/// message without it join into one WebSocket message. A Workers WebSocket
/// message is at most 1 MiB, and an H.264 keyframe of a large display can be
/// bigger, so both sides split at [`STREAM_CHUNK`] bytes and join.
pub const KIND_TEXT: u8 = 0;
pub const KIND_BINARY: u8 = 1;
pub const KIND_CLOSE: u8 = 2;
pub const MORE: u8 = 0x80;
pub const STREAM_CHUNK: usize = 512 * 1024;
/// A joined message larger than this ends the stream (voxl's own limit is 64 MiB
/// for what it receives; what it sends is one encoded frame).
pub const MAX_STREAM_MESSAGE: usize = 32 * 1024 * 1024;

pub fn encode(stream: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&stream.to_be_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

pub fn decode(frame: &[u8]) -> Option<(u32, u8, &[u8])> {
    if frame.len() < 5 {
        return None;
    }
    let stream = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    Some((stream, frame[4], &frame[5..]))
}

/// One WebSocket message as one or more data messages.
pub fn split(stream: u32, kind: u8, payload: &[u8]) -> Vec<Vec<u8>> {
    if payload.len() <= STREAM_CHUNK {
        return vec![encode(stream, kind, payload)];
    }
    let chunks: Vec<&[u8]> = payload.chunks(STREAM_CHUNK).collect();
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| encode(stream, if i == last { kind } else { kind | MORE }, c))
        .collect()
}

pub fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut out = code.to_be_bytes().to_vec();
    // A WebSocket close reason is at most 123 bytes.
    let mut end = reason.len().min(120);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    out.extend_from_slice(&reason.as_bytes()[..end]);
    out
}

/// Joins fragments into whole messages.
#[derive(Default)]
pub struct Joiner {
    kind: Option<u8>,
    data: Vec<u8>,
}

pub enum Joined {
    /// A whole message: its kind (no [`MORE`]) and payload.
    Message(u8, Vec<u8>),
    Partial,
    /// Fragments that do not fit together, or too large.
    Invalid,
}

impl Joiner {
    pub fn accept(&mut self, kind: u8, payload: &[u8]) -> Joined {
        let base = kind & !MORE;
        if base == KIND_CLOSE {
            self.kind = None;
            self.data.clear();
            return Joined::Message(KIND_CLOSE, payload.to_vec());
        }
        if base != KIND_TEXT && base != KIND_BINARY {
            return Joined::Invalid;
        }
        if self.kind.is_some_and(|k| k != base) {
            return Joined::Invalid;
        }
        if self.data.len() + payload.len() > MAX_STREAM_MESSAGE {
            return Joined::Invalid;
        }
        self.kind = Some(base);
        self.data.extend_from_slice(payload);
        if kind & MORE != 0 {
            return Joined::Partial;
        }
        self.kind = None;
        Joined::Message(base, std::mem::take(&mut self.data))
    }
}

// ---------- voxl ----------

/// Whether this runner can have a Desktop.
pub fn supported() -> bool {
    cfg!(target_os = "macos") || std::env::var_os("DX_RUNNER_DESKTOP_TEST").is_some()
}

struct Voxl {
    pid: i32,
    password: String,
    log: PathBuf,
}

impl Voxl {
    fn alive(&self) -> bool {
        let mut status = 0;
        let r = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        r == 0
    }

    /// Stops voxl's process group: the launcher and the voxl it started.
    fn stop(&self) {
        unsafe {
            libc::kill(-self.pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if !self.alive() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
            let mut status = 0;
            libc::waitpid(self.pid, &mut status, 0);
        }
    }
}

struct State {
    voxl: Option<Voxl>,
    streams: usize,
    idle_since: Instant,
}

/// The machine's one Desktop.
pub struct Desktop {
    state: Mutex<State>,
    /// One `ensure` at a time, so two viewers never start two voxls.
    starting: Mutex<()>,
    /// The sandbox self-test proved Thread commands cannot reach the port.
    confined: bool,
}

pub fn pid_file(paths: &Paths) -> PathBuf {
    paths.runner.join("voxl.pid")
}

pub fn log_file(paths: &Paths) -> PathBuf {
    paths.runner.join("voxl.log")
}

impl Desktop {
    pub fn new(paths: &Paths, confined: bool) -> Self {
        stop_recorded(paths);
        Desktop {
            state: Mutex::new(State {
                voxl: None,
                streams: 0,
                idle_since: Instant::now(),
            }),
            starting: Mutex::new(()),
            confined,
        }
    }

    /// `desktop.ensure`: voxl runs and answers, or why not.
    pub fn ensure(&self, paths: &Paths, config: &Config) -> Value {
        if !supported() {
            return status("unsupported", "The Desktop needs a Mac runner.");
        }
        if !self.confined {
            return status(
                "failed",
                "This Mac's sandbox did not block Threads from the Desktop's port, so the Desktop stays off. Run `dxd runner doctor` for details.",
            );
        }
        let _starting = self.starting.lock().unwrap();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(v) = &state.voxl {
                if v.alive() {
                    let head = log_head(&v.log);
                    if head.contains(CAPTURE_DENIED) {
                        v.stop();
                        let tail = log_tail(&v.log);
                        state.voxl = None;
                        return denied(&head, &tail);
                    }
                    // voxl checks Accessibility only as it starts: with
                    // nobody watching, start it again so a permission the
                    // person just turned on takes effect.
                    if !(head.contains(INPUT_DENIED) && state.streams == 0) {
                        return running(&head);
                    }
                    log("desktop: restarting voxl to check Accessibility again");
                    v.stop();
                    let _ = fs::remove_file(pid_file(paths));
                    state.voxl = None;
                }
            }
            // Still here with a voxl: it exited by itself.
            if let Some(v) = &state.voxl {
                let tail = log_tail(&v.log);
                log(&format!("desktop: voxl exited: {}", last_line(&tail)));
                state.voxl = None;
            }
        }
        let binary = match binary(paths, config) {
            Ok(Some(b)) => b,
            Ok(None) => {
                return status(
                    "missing",
                    &format!(
                        "voxl is not installed on this Mac. Build it there with `{BUILD_COMMAND}`, then open the Desktop again."
                    ),
                );
            }
            Err(e) => return status("failed", &e),
        };
        if listening() {
            return status(
                "failed",
                &format!(
                    "Another program on this Mac listens on port {VOXL_PORT}, which the Desktop needs. Quit it and try again."
                ),
            );
        }
        let password = new_password();
        let log_path = log_file(paths);
        let pid = match spawn(&binary, &password, &log_path) {
            Ok(pid) => pid,
            Err(e) => return status("failed", &format!("voxl did not start: {e}")),
        };
        let _ = fs::write(pid_file(paths), pid.to_string());
        let voxl = Voxl {
            pid,
            password,
            log: log_path.clone(),
        };
        log(&format!(
            "desktop: started voxl ({}) as pid {pid}",
            binary.display()
        ));
        let deadline = Instant::now() + START_WAIT;
        loop {
            if !voxl.alive() {
                let _ = fs::remove_file(pid_file(paths));
                let tail = log_tail(&log_path);
                let head = log_head(&log_path);
                if head.contains(CAPTURE_DENIED) || tail.contains(CAPTURE_DENIED) {
                    return denied(&head, &tail);
                }
                return status("failed", &format!("voxl stopped while starting:\n{tail}"));
            }
            if healthz(&voxl.password).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                voxl.stop();
                let _ = fs::remove_file(pid_file(paths));
                return status(
                    "failed",
                    &format!("voxl did not answer in time:\n{}", log_tail(&log_path)),
                );
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let head = log_head(&log_path);
        if head.contains(CAPTURE_DENIED) {
            voxl.stop();
            let _ = fs::remove_file(pid_file(paths));
            return denied(&head, &log_tail(&log_path));
        }
        let mut state = self.state.lock().unwrap();
        state.voxl = Some(voxl);
        state.idle_since = Instant::now();
        running(&head)
    }

    /// `desktop.health`: voxl's `/healthz`, through the supervisor.
    pub fn health(&self) -> Value {
        let Some(password) = self.password() else {
            return json!({ "ok": false, "detail": "The Desktop is not running." });
        };
        match healthz(&password) {
            Ok(body) => json!({ "ok": true, "status": 200, "body": body }),
            Err(e) => json!({ "ok": false, "detail": e }),
        }
    }

    /// `desktop.windows`: voxl's `GET /windows` (window mode, dx's voxl patch):
    /// the Mac's on-screen app windows a viewer may stream instead of the whole
    /// screen. Each entry is checked and bounded here; a voxl without window
    /// mode answers `unsupported`.
    pub fn windows(&self) -> Value {
        let Some(password) = self.password() else {
            return json!({ "ok": false, "detail": "The Desktop is not running." });
        };
        match voxl_get(&password, "/windows", MAX_WINDOWS_BODY) {
            Ok((200, body)) => match serde_json::from_str::<Value>(&body) {
                Ok(listed) => json!({ "ok": true, "windows": windows_of(&listed) }),
                Err(e) => json!({ "ok": false, "detail": format!("voxl's window list: {e}") }),
            },
            Ok((404, _)) => json!({
                "ok": false,
                "unsupported": true,
                "detail": "This Mac's voxl predates window mode; it updates with the runner's next voxl.",
            }),
            Ok((status, _)) => json!({ "ok": false, "detail": format!("voxl answered {status}") }),
            Err(e) => json!({ "ok": false, "detail": e }),
        }
    }

    /// The running voxl's password, for a stream the supervisor opens.
    pub fn password(&self) -> Option<String> {
        let state = self.state.lock().unwrap();
        state
            .voxl
            .as_ref()
            .filter(|v| v.alive())
            .map(|v| v.password.clone())
    }

    /// Someone is viewing the Desktop now (an update waits for them).
    pub fn watched(&self) -> bool {
        self.state.lock().unwrap().streams > 0
    }

    pub fn stream_opened(&self) {
        self.state.lock().unwrap().streams += 1;
    }

    pub fn stream_closed(&self) {
        let mut state = self.state.lock().unwrap();
        state.streams = state.streams.saturating_sub(1);
        state.idle_since = Instant::now();
    }

    /// Stops voxl when nobody has watched for a while.
    pub fn stop_if_idle(&self, paths: &Paths) {
        let mut state = self.state.lock().unwrap();
        if state.streams == 0
            && state.idle_since.elapsed() > IDLE_STOP
            && let Some(v) = state.voxl.take()
        {
            log("desktop: stopping voxl (no viewer)");
            v.stop();
            let _ = fs::remove_file(pid_file(paths));
        }
    }

    pub fn stop(&self, paths: &Paths) {
        if let Some(v) = self.state.lock().unwrap().voxl.take() {
            v.stop();
        }
        let _ = fs::remove_file(pid_file(paths));
    }
}

fn status(status: &str, detail: &str) -> Value {
    json!({ "status": status, "detail": detail })
}

/// What macOS allowed dx's Desktop, as voxl logged it when it started.
fn permissions(head: &str) -> Value {
    json!({
        "screenRecording": !head.contains(CAPTURE_DENIED),
        "accessibility": !head.contains(INPUT_DENIED),
    })
}

/// Running; with the reason input is off when macOS has not allowed voxl
/// Accessibility (Core shows it over the Desktop).
fn running(head: &str) -> Value {
    let mut out = json!({ "status": "running", "permissions": permissions(head) });
    if head.contains(INPUT_DENIED) {
        out["detail"] = json!(
            "Clicks and typing are off: macOS hasn't allowed dx to control this Mac. Turn on dx in System Settings › Privacy & Security › Accessibility, then reopen the Desktop."
        );
    }
    out
}

/// Screen Recording denied: `failed`, with the permissions and voxl's log
/// tail (the viewer keeps the log behind its Details).
fn denied(head: &str, tail: &str) -> Value {
    let mut out = status(
        "failed",
        &format!(
            "macOS has not allowed dx to record this Mac's screen. Allow dx in System Settings › Privacy & Security › Screen Recording and Accessibility, then open the Desktop again. If dx is already listed and on, remove it with − first: each update of dx's Desktop needs a new grant.\n{tail}"
        ),
    );
    let mut granted = permissions(head);
    granted["screenRecording"] = json!(false);
    out["permissions"] = granted;
    out
}

/// The System Settings privacy pane `desktop.settings` opens.
fn settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "screen-recording" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        "accessibility" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        _ => None,
    }
}

/// `desktop.settings` `{ pane }`: opens System Settings on the Mac at the
/// Screen Recording or Accessibility pane, where the person allows dx. The
/// supervisor runs `/usr/bin/open` itself, outside every sandbox; any other
/// pane is refused, and a machine that is not a Mac answers that it cannot.
pub fn open_settings(body: &Value) -> Result<Value, crate::runner::ops::OpError> {
    use crate::runner::ops::OpError;
    let pane = body["pane"].as_str().unwrap_or("");
    let Some(url) = settings_url(pane) else {
        return Err(OpError::invalid(
            "pane must be \"screen-recording\" or \"accessibility\"",
        ));
    };
    if !cfg!(target_os = "macos") {
        return Err(OpError::failed(
            "System Settings opens only on a Mac runner.",
        ));
    }
    let out = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| OpError::failed(format!("open: {e}")))?;
    if !out.status.success() {
        return Err(OpError::failed(format!(
            "open {url}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    log(&format!("desktop: opened System Settings at {pane}"));
    Ok(json!({ "opened": true }))
}

fn last_line(text: &str) -> &str {
    text.lines().last().unwrap_or("")
}

/// The start of voxl's log, where it reports missing macOS permissions; the
/// tail alone loses them once voxl has logged for a while.
fn log_head(path: &Path) -> String {
    let Ok(f) = fs::File::open(path) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = f.take(16 * 1024).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).to_string()
}

/// The end of voxl's log, which holds only its own output (no password).
fn log_tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES)));
    let mut bytes = Vec::new();
    let _ = f.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn new_password() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], VOXL_PORT))
}

fn listening() -> bool {
    TcpStream::connect_timeout(&addr(), Duration::from_millis(300)).is_ok()
}

fn healthz(password: &str) -> Result<String, String> {
    match voxl_get(password, "/healthz", 4096)? {
        (200, body) => Ok(body.chars().take(200).collect()),
        (status, _) => Err(format!("voxl answered {status}")),
    }
}

/// Most of voxl's window list read; more windows than [`MAX_WINDOWS`] are cut.
const MAX_WINDOWS_BODY: u64 = 512 * 1024;
const MAX_WINDOWS: usize = 64;

/// A GET to voxl with its password: the status and at most `limit` bytes.
fn voxl_get(password: &str, path: &str, limit: u64) -> Result<(u16, String), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .get(&format!("http://127.0.0.1:{VOXL_PORT}{path}"))
        .header("Authorization", &format!("Bearer {password}"))
        .call()
        .map_err(|e| format!("voxl did not answer: {e}"))?;
    let body = resp
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_string()
        .unwrap_or_default();
    Ok((resp.status().as_u16(), body))
}

/// voxl's `{"windows":[...]}` as Core's runner window list: each entry with a
/// window ID, app, title, and frame of the expected types, strings cut to 200
/// characters, at most [`MAX_WINDOWS`].
fn windows_of(listed: &Value) -> Vec<Value> {
    let text = |v: &Value| -> String { v.as_str().unwrap_or("").chars().take(200).collect() };
    let id = |v: &Value| v.as_u64().filter(|&n| n > 0 && n <= u32::MAX as u64);
    listed["windows"]
        .as_array()
        .map(|all| all.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|w| {
            let frame = &w["frame"];
            let (x, y, fw, fh) = (
                frame["x"].as_f64()?,
                frame["y"].as_f64()?,
                frame["w"].as_f64()?,
                frame["h"].as_f64()?,
            );
            if !(fw > 0.0 && fh > 0.0) {
                return None;
            }
            Some(json!({
                "id": id(&w["id"])?,
                "app": text(&w["app"]),
                "bundleId": text(&w["bundleId"]),
                "title": text(&w["title"]),
                "frame": { "x": x, "y": y, "w": fw, "h": fh },
                "display": w["display"].as_u64().filter(|&n| n <= u32::MAX as u64).unwrap_or(0),
            }))
        })
        .take(MAX_WINDOWS)
        .collect()
}

/// A voxl left behind by an earlier supervisor (a crash): stop it, since
/// nobody knows its password and it holds the port.
fn stop_recorded(paths: &Paths) {
    let Ok(text) = fs::read_to_string(pid_file(paths)) else {
        return;
    };
    let _ = fs::remove_file(pid_file(paths));
    let Ok(pid) = text.trim().parse::<i32>() else {
        return;
    };
    if pid <= 1 {
        return;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output();
    let comm = out
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    // macOS reports the executable's path; Linux (the runner E2E) its name.
    let ours = format!("{BUNDLE_NAME}.app/Contents/MacOS/{BUNDLE_NAME}");
    if comm.ends_with("voxl") || comm.ends_with(&ours) || comm == BUNDLE_NAME {
        log(&format!(
            "desktop: stopping voxl {pid} left by an earlier runner"
        ));
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}

// ---------- the binary ----------

/// `<asset>-darwin-aarch64` (Core's manifest keys; runners are Apple silicon
/// Macs); `<asset>-linux-<arch>` exists only for the runner E2E.
fn manifest_key(asset: &str) -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    format!("{asset}-{os}-{}", std::env::consts::ARCH)
}

fn bundle(paths: &Paths) -> PathBuf {
    paths.runner.join(format!("{BUNDLE_NAME}.app"))
}

/// The launcher, `dx.app`'s executable.
fn launcher(paths: &Paths) -> PathBuf {
    bundle(paths).join("Contents/MacOS").join(BUNDLE_NAME)
}

/// The SHA-256 of the launcher download the bundle was made from (signing
/// changes the file itself).
fn bundle_source(paths: &Paths) -> PathBuf {
    paths.runner.join(format!("{BUNDLE_NAME}.app.sha256"))
}

/// The deployment's voxl, which the launcher starts.
fn downloaded(paths: &Paths) -> PathBuf {
    paths.bin.join("voxl")
}

/// Fixed, so the bundle's ad-hoc signature (and with it the person's grants)
/// changes only when the launcher does.
const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>dx</string>
  <key>CFBundleIdentifier</key><string>dev.dx.app.desktop</string>
  <key>CFBundleName</key><string>dx</string>
  <key>CFBundleDisplayName</key><string>dx</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>dx shows this Mac's screen or one of its windows in your dx Desktop.</string>
</dict>
</plist>
"#;

fn local_build(paths: &Paths) -> PathBuf {
    paths.runner.join("voxl").join("bin").join("voxl")
}

/// What to start: the launcher when `dx.app` and the deployment's voxl are
/// installed (refreshed when the manifest lists newer ones), else that voxl
/// itself, else a local build, else none.
fn binary(paths: &Paths, config: &Config) -> Result<Option<PathBuf>, String> {
    match manifest(config) {
        Ok(Some(manifest)) => {
            if let Err(e) = refresh_voxl(paths, config, &manifest) {
                log(&format!("desktop: {e}"));
            }
            if let Err(e) = refresh_launcher(paths, config, &manifest) {
                log(&format!("desktop: {e}"));
            }
        }
        Ok(None) => {}
        Err(e) => log(&format!("desktop: {e}")),
    }
    if downloaded(paths).is_file() {
        if launcher(paths).is_file() {
            return Ok(Some(launcher(paths)));
        }
        return Ok(Some(downloaded(paths)));
    }
    let local = local_build(paths);
    Ok(local.is_file().then_some(local))
}

fn manifest(config: &Config) -> Result<Option<Value>, String> {
    let url = config.same_origin("/runner/manifest.json")?;
    let mut resp = crate::runner::http()
        .get(&url)
        .call()
        .map_err(|e| format!("manifest: {e}"))?;
    if resp.status() != 200 {
        return Ok(None);
    }
    resp.body_mut()
        .read_json()
        .map(Some)
        .map_err(|e| format!("manifest: {e}"))
}

/// The manifest's `(path, sha256)` for `asset` on this machine, if listed.
fn manifest_entry(manifest: &Value, asset: &str) -> Result<Option<(String, String)>, String> {
    let entry = &manifest["assets"][manifest_key(asset)];
    let (Some(path), Some(sha)) = (entry["path"].as_str(), entry["sha256"].as_str()) else {
        return Ok(None);
    };
    if !path.starts_with("/runner/") || sha.len() != 64 {
        return Err(format!(
            "manifest: refusing a {asset} entry outside /runner/"
        ));
    }
    Ok(Some((path.to_string(), sha.to_string())))
}

fn refresh_voxl(paths: &Paths, config: &Config, manifest: &Value) -> Result<(), String> {
    let Some((path, sha)) = manifest_entry(manifest, "voxl")? else {
        return Ok(());
    };
    let target = downloaded(paths);
    if sha256_file(&target).is_some_and(|own| own.eq_ignore_ascii_case(&sha)) {
        return Ok(());
    }
    let bytes = download(config, &path, &sha)?;
    fs::create_dir_all(&paths.bin).map_err(|e| e.to_string())?;
    // A new file renamed into place: macOS caches code signatures per inode.
    let staged = paths.bin.join("voxl.new");
    let _ = fs::remove_file(&staged);
    fs::write(&staged, &bytes).map_err(|e| e.to_string())?;
    set_mode(&staged, 0o755);
    fs::rename(&staged, &target).map_err(|e| e.to_string())?;
    log(&format!("desktop: installed voxl {sha}"));
    Ok(())
}

fn refresh_launcher(paths: &Paths, config: &Config, manifest: &Value) -> Result<(), String> {
    let Some((path, sha)) = manifest_entry(manifest, "dx-desktop")? else {
        return Ok(());
    };
    let installed = fs::read_to_string(bundle_source(paths)).unwrap_or_default();
    if launcher(paths).is_file() && installed.trim().eq_ignore_ascii_case(&sha) {
        return Ok(());
    }
    let bytes = download(config, &path, &sha)?;
    install_bundle(paths, &bytes, &sha)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn sha256_file(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

fn download(config: &Config, path: &str, sha: &str) -> Result<Vec<u8>, String> {
    let url = config.same_origin(path)?;
    log(&format!("desktop: downloading {url}"));
    let mut resp = crate::runner::http()
        .get(&url)
        .call()
        .map_err(|e| format!("download {url}: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("download {url} answered {}", resp.status()));
    }
    let mut bytes = Vec::new();
    resp.body_mut()
        .with_config()
        .limit(MAX_VOXL_BINARY)
        .reader()
        .take(MAX_VOXL_BINARY)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let got = sha256_hex(&bytes);
    if !got.eq_ignore_ascii_case(sha) {
        return Err(format!(
            "download {url}: SHA-256 {got} does not match {sha}"
        ));
    }
    Ok(bytes)
}

/// Makes `dx.app` from the verified launcher: a new bundle renamed into place
/// (macOS caches code signatures per inode), signed ad hoc with
/// [`BUNDLE_ID`] so the privacy settings show "dx", then records `sha`.
fn install_bundle(paths: &Paths, bytes: &[u8], sha: &str) -> Result<(), String> {
    let target = bundle(paths);
    let staged = paths.runner.join(format!("{BUNDLE_NAME}.app.new"));
    let _ = fs::remove_dir_all(&staged);
    let macos = staged.join("Contents/MacOS");
    fs::create_dir_all(&macos).map_err(|e| e.to_string())?;
    fs::write(staged.join("Contents/Info.plist"), INFO_PLIST).map_err(|e| e.to_string())?;
    let exe = macos.join(BUNDLE_NAME);
    fs::write(&exe, bytes).map_err(|e| e.to_string())?;
    set_mode(&exe, 0o755);
    if cfg!(target_os = "macos") {
        let signed = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", BUNDLE_ID])
            .arg(&staged)
            .output()
            .map_err(|e| format!("codesign: {e}"))?;
        if !signed.status.success() {
            let _ = fs::remove_dir_all(&staged);
            return Err(format!(
                "codesign {}: {}",
                staged.display(),
                String::from_utf8_lossy(&signed.stderr).trim()
            ));
        }
    }
    let _ = fs::remove_file(bundle_source(paths));
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staged, &target).map_err(|e| e.to_string())?;
    fs::write(bundle_source(paths), format!("{sha}\n")).map_err(|e| e.to_string())?;
    log(&format!("desktop: installed {} ({sha})", target.display()));
    Ok(())
}

// ---------- spawning ----------

fn cstring(s: impl AsRef<[u8]>) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(s.as_ref()).map_err(|_| "NUL in an argument".to_string())
}

/// Starts voxl with the password in its environment, stdout and stderr in
/// `log`, and (macOS) as its own responsible process: posix_spawn with
/// `responsibility_spawnattrs_setdisclaim`, so Screen Recording and
/// Accessibility are granted to voxl, not to the supervisor and every
/// sandboxed command it starts.
fn spawn(binary: &Path, password: &str, log_path: &Path) -> Result<i32, String> {
    use std::os::unix::ffi::OsStrExt;
    let argv_owned = [
        cstring(binary.as_os_str().as_bytes())?,
        cstring("--addr")?,
        cstring("127.0.0.1")?,
        cstring("--port")?,
        cstring(VOXL_PORT.to_string())?,
    ];
    let mut env_owned = vec![
        cstring(format!("VOXL_PASSWORD={password}"))?,
        cstring("PATH=/usr/bin:/bin:/usr/sbin:/sbin")?,
    ];
    for key in [
        "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "DISPLAY", "RUST_LOG",
    ] {
        if let Ok(v) = std::env::var(key) {
            env_owned.push(cstring(format!("{key}={v}"))?);
        }
    }
    let mut argv: Vec<*mut libc::c_char> =
        argv_owned.iter().map(|c| c.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());
    let mut envp: Vec<*mut libc::c_char> = env_owned.iter().map(|c| c.as_ptr() as *mut _).collect();
    envp.push(std::ptr::null_mut());
    let program = cstring(binary.as_os_str().as_bytes())?;
    let log_c = cstring(log_path.as_os_str().as_bytes())?;
    let devnull = cstring("/dev/null")?;
    unsafe {
        let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        if libc::posix_spawn_file_actions_init(&mut actions) != 0
            || libc::posix_spawnattr_init(&mut attr) != 0
        {
            return Err("posix_spawn setup failed".into());
        }
        let cleanup = |actions: &mut libc::posix_spawn_file_actions_t,
                       attr: &mut libc::posix_spawnattr_t| {
            libc::posix_spawn_file_actions_destroy(actions);
            libc::posix_spawnattr_destroy(attr);
        };
        libc::posix_spawn_file_actions_addopen(
            &mut actions,
            0,
            devnull.as_ptr(),
            libc::O_RDONLY,
            0,
        );
        libc::posix_spawn_file_actions_addopen(
            &mut actions,
            1,
            log_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            0o600,
        );
        libc::posix_spawn_file_actions_adddup2(&mut actions, 1, 2);
        // Its own process group: a Ctrl-C to the supervisor's terminal does
        // not reach it; the supervisor stops it.
        libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETPGROUP as _);
        libc::posix_spawnattr_setpgroup(&mut attr, 0);
        if let Err(e) = disclaim(&mut attr) {
            cleanup(&mut actions, &mut attr);
            return Err(e);
        }
        let mut pid: libc::pid_t = 0;
        let rc = libc::posix_spawn(
            &mut pid,
            program.as_ptr(),
            &actions,
            &attr,
            argv.as_ptr(),
            envp.as_ptr(),
        );
        cleanup(&mut actions, &mut attr);
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc).to_string());
        }
        set_mode(log_path, 0o600);
        Ok(pid)
    }
}

#[cfg(target_os = "macos")]
unsafe fn disclaim(attr: &mut libc::posix_spawnattr_t) -> Result<(), String> {
    // libSystem's `responsibility_spawnattrs_setdisclaim` (macOS 10.14+) is
    // not in the public headers; look it up so the link never depends on it.
    type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    let name = c"responsibility_spawnattrs_setdisclaim";
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if symbol.is_null() {
        // Without it macOS would grant Screen Recording to the supervisor,
        // whose sandboxed commands would share it: no Desktop then.
        return Err("this macOS cannot start voxl as its own app (no responsibility_spawnattrs_setdisclaim)".into());
    }
    let f: Disclaim = unsafe { std::mem::transmute(symbol) };
    if unsafe { f(attr, 1) } != 0 {
        return Err("responsibility_spawnattrs_setdisclaim failed".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
unsafe fn disclaim(_attr: &mut libc::posix_spawnattr_t) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    // Ways the stream framing could break the Desktop, each checked below:
    // - a voxl message over one Workers message (1 MiB) is sent whole;
    // - fragments join into a different message than was split;
    // - a close is lost behind a half-joined message;
    // - fragments of two kinds, or past the size bound, join anyway;
    // - a close reason over 123 bytes, or split inside a character.
    use super::*;

    #[test]
    fn large_messages_split_under_a_mebibyte_and_join_back() {
        let payload: Vec<u8> = (0..(STREAM_CHUNK * 2 + 17))
            .map(|i| (i % 251) as u8)
            .collect();
        let frames = split(7, KIND_BINARY, &payload);
        assert_eq!(frames.len(), 3);
        assert!(
            frames
                .iter()
                .all(|f| f.len() <= STREAM_CHUNK + 5 && f.len() < 1 << 20)
        );
        let mut joiner = Joiner::default();
        let mut whole = None;
        for f in &frames {
            let (stream, kind, data) = decode(f).unwrap();
            assert_eq!(stream, 7);
            match joiner.accept(kind, data) {
                Joined::Message(k, d) => whole = Some((k, d)),
                Joined::Partial => assert!(whole.is_none()),
                Joined::Invalid => panic!("invalid"),
            }
        }
        assert_eq!(whole, Some((KIND_BINARY, payload)));
        let small = split(1, KIND_TEXT, b"{\"t\":\"hello\"}");
        assert_eq!(small, vec![encode(1, KIND_TEXT, b"{\"t\":\"hello\"}")]);
    }

    #[test]
    fn mixed_or_oversized_fragments_and_closes() {
        let mut joiner = Joiner::default();
        assert!(matches!(
            joiner.accept(KIND_TEXT | MORE, b"ab"),
            Joined::Partial
        ));
        assert!(matches!(joiner.accept(KIND_BINARY, b"cd"), Joined::Invalid));
        let mut joiner = Joiner::default();
        assert!(matches!(
            joiner.accept(KIND_TEXT | MORE, b"ab"),
            Joined::Partial
        ));
        assert!(matches!(
            joiner.accept(KIND_CLOSE, &close_payload(1000, "bye")),
            Joined::Message(KIND_CLOSE, _)
        ));
        let mut joiner = Joiner::default();
        let big = vec![0u8; MAX_STREAM_MESSAGE];
        assert!(matches!(
            joiner.accept(KIND_BINARY | MORE, &big),
            Joined::Partial
        ));
        assert!(matches!(joiner.accept(KIND_BINARY, b"x"), Joined::Invalid));
        let reason = "é".repeat(100);
        let close = close_payload(4000, &reason);
        assert!(close.len() <= 125);
        assert!(std::str::from_utf8(&close[2..]).is_ok());
    }
}
