//! The Desktop's windows, for the viewer's app row: list the windows openbox
//! manages, bring one to the front (restoring it when minimized), or start
//! the Terminal or Chromium when none of its windows is open.
//!
//! The Desktop (`deploy/orb/desktop`) is Xvfb and openbox with no panel, so a
//! window the person closes or minimizes has no way back on screen except
//! openbox's right-click menu. This module speaks just enough of the X11
//! protocol to read openbox's EWMH properties and send it
//! `_NET_ACTIVE_WINDOW`, over the display's Unix socket without
//! authentication (Xvfb runs with local access only, `-nolisten tcp`). It
//! adds no dependency and runs on the blocking pool.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// At most this many windows are listed, the most recently stacked kept.
pub const MAX_WINDOWS: usize = 24;
/// A listed title is cut to this many characters.
pub const MAX_TITLE_CHARS: usize = 120;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a launch waits for the new app's first window. Chromium starts
/// in a few seconds on a warm Orb.
const LAUNCH_WAIT: Duration = Duration::from_secs(12);
const LAUNCH_POLL: Duration = Duration::from_millis(150);
/// The terminal the Desktop session and openbox's menu open, with the
/// desktop's environment, in a session of its own carrying the desktop's
/// marker so `stop` ends it with the desktop.
const TERMINAL_SCRIPT: &str = r#"
. "$DX_DESKTOP_DIR/env.sh" || exit 1
state="$HOME/.local/state/dx-desktop"
. "$state/environment" || exit 1
DX_DESKTOP_SESSION=$(cat "$state/session.pid") || exit 1
export DX_DESKTOP_SESSION
cd "$HOME" || exit 1
PATH="$DX_HOST_PATH" exec "$bin/setsid" -f "$bin/xterm" -fa 'DejaVu Sans Mono' -fs 11 -geometry 100x30 </dev/null >>"$state/xterm.log" 2>&1
"#;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopApp {
    Terminal,
    Browser,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DesktopWindow {
    pub id: u32,
    /// The app this window belongs to, when dx knows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<DesktopApp>,
    pub title: String,
    pub minimized: bool,
    pub focused: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum DesktopWindows {
    Windows(Vec<DesktopWindow>),
    /// No Desktop in this Orb.
    Unsupported,
    /// The Desktop is not running, or did not answer.
    Failed,
}

/// Where the Desktop lives; tests point these at their own display.
#[derive(Clone, Debug)]
pub struct DesktopPaths {
    pub home: PathBuf,
    pub desktop: PathBuf,
}

impl Default for DesktopPaths {
    fn default() -> Self {
        Self {
            home: PathBuf::from("/home/user"),
            desktop: PathBuf::from("/opt/dx/desktop"),
        }
    }
}

impl DesktopPaths {
    fn state(&self) -> PathBuf {
        self.home.join(".local/state/dx-desktop")
    }

    fn supported(&self) -> bool {
        self.desktop.join("start").is_file()
    }

    /// The running session's display, from the file `session` writes.
    fn display(&self) -> Option<u32> {
        let text = std::fs::read_to_string(self.state().join("environment")).ok()?;
        text.lines().find_map(|line| {
            let value = line.strip_prefix("export DISPLAY='")?.strip_suffix('\'')?;
            let number = value.strip_prefix(':')?;
            let number = number.split('.').next()?;
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            number.parse().ok()
        })
    }
}

/// The windows openbox manages, oldest first.
pub fn windows(paths: &DesktopPaths) -> DesktopWindows {
    run(paths, |display| display.windows())
}

/// Brings one window to the front, restoring it when minimized.
pub fn focus(paths: &DesktopPaths, window: u32) -> DesktopWindows {
    run(paths, |display| {
        if display.windows()?.iter().any(|listed| listed.id == window) {
            display.activate(window)?;
        }
        display.windows()
    })
}

/// Brings the app's most recent window to the front, or starts the app and
/// waits for its first window.
pub fn open(paths: &DesktopPaths, app: DesktopApp) -> DesktopWindows {
    run(paths, |display| {
        let listed = display.windows()?;
        if let Some(window) = listed.iter().rev().find(|window| window.app == Some(app)) {
            display.activate(window.id)?;
            return display.windows();
        }
        launch(paths, app).ok_or(X11Error)?;
        let deadline = Instant::now() + LAUNCH_WAIT;
        loop {
            let listed = display.windows()?;
            if listed.iter().any(|window| window.app == Some(app)) || Instant::now() >= deadline {
                return Ok(listed);
            }
            std::thread::sleep(LAUNCH_POLL);
        }
    })
}

fn run(
    paths: &DesktopPaths,
    action: impl FnOnce(&mut Display) -> Result<Vec<DesktopWindow>, X11Error>,
) -> DesktopWindows {
    if !paths.supported() {
        return DesktopWindows::Unsupported;
    }
    let Some(number) = paths.display() else {
        return DesktopWindows::Failed;
    };
    match Display::connect(number).and_then(|mut display| action(&mut display)) {
        Ok(windows) => DesktopWindows::Windows(windows),
        Err(X11Error) => DesktopWindows::Failed,
    }
}

/// Starts the app detached, with the environment `start` gets from dxd.
fn launch(paths: &DesktopPaths, app: DesktopApp) -> Option<()> {
    let mut command = match app {
        DesktopApp::Browser => Command::new(paths.desktop.join("chromium")),
        DesktopApp::Terminal => {
            let mut command = Command::new("/bin/bash");
            command.arg("-c").arg(TERMINAL_SCRIPT);
            command
        }
    };
    command
        .env_clear()
        .env("HOME", &paths.home)
        .env("USER", "user")
        .env("LOGNAME", "user")
        .env("SHELL", "/bin/bash")
        .env("LANG", "C.UTF-8")
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .env("DX_DESKTOP_DIR", &paths.desktop)
        .current_dir(&paths.home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    // Both commands detach the app and return at once.
    let status = command.status().ok()?;
    status.success().then_some(())
}

#[derive(Debug)]
struct X11Error;

impl From<std::io::Error> for X11Error {
    fn from(_: std::io::Error) -> Self {
        Self
    }
}

struct Atoms {
    client_list: u32,
    client_list_stacking: u32,
    active_window: u32,
    wm_name: u32,
    wm_state: u32,
    state_hidden: u32,
    utf8_string: u32,
}

const ATOM_STRING: u32 = 31;
const ATOM_WM_NAME: u32 = 39;
const ATOM_WM_CLASS: u32 = 67;
const ATOM_WINDOW: u32 = 33;
const ATOM_ATOM: u32 = 4;

/// One X11 connection, little-endian, one request at a time.
struct Display {
    stream: UnixStream,
    root: u32,
    sequence: u16,
    atoms: Atoms,
}

fn pad4(length: usize) -> usize {
    (4 - length % 4) % 4
}

impl Display {
    fn connect(number: u32) -> Result<Self, X11Error> {
        let stream = UnixStream::connect(format!("/tmp/.X11-unix/X{number}"))?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let mut stream = stream;
        // Little-endian, protocol 11.0, no authorization.
        stream.write_all(&[b'l', 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0])?;
        let mut head = [0u8; 8];
        stream.read_exact(&mut head)?;
        let length = usize::from(u16::from_le_bytes([head[6], head[7]])) * 4;
        if length > 1 << 20 {
            return Err(X11Error);
        }
        let mut setup = vec![0u8; length];
        stream.read_exact(&mut setup)?;
        if head[0] != 1 || setup.len() < 32 {
            return Err(X11Error);
        }
        let vendor = usize::from(u16::from_le_bytes([setup[16], setup[17]]));
        let formats = usize::from(setup[21]);
        let screen = 32 + vendor + pad4(vendor) + 8 * formats;
        let root = setup
            .get(screen..screen + 4)
            .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .ok_or(X11Error)?;
        let mut display = Self {
            stream,
            root,
            sequence: 0,
            atoms: Atoms {
                client_list: 0,
                client_list_stacking: 0,
                active_window: 0,
                wm_name: 0,
                wm_state: 0,
                state_hidden: 0,
                utf8_string: 0,
            },
        };
        display.atoms = Atoms {
            client_list: display.atom("_NET_CLIENT_LIST")?,
            client_list_stacking: display.atom("_NET_CLIENT_LIST_STACKING")?,
            active_window: display.atom("_NET_ACTIVE_WINDOW")?,
            wm_name: display.atom("_NET_WM_NAME")?,
            wm_state: display.atom("_NET_WM_STATE")?,
            state_hidden: display.atom("_NET_WM_STATE_HIDDEN")?,
            utf8_string: display.atom("UTF8_STRING")?,
        };
        Ok(display)
    }

    fn send(&mut self, request: &[u8]) -> Result<u16, X11Error> {
        self.stream.write_all(request)?;
        self.sequence = self.sequence.wrapping_add(1);
        Ok(self.sequence)
    }

    /// The reply to request `sequence`: `None` for an X error (a window that
    /// closed meanwhile). Events, which this client never asks for, are
    /// skipped.
    fn reply(&mut self, sequence: u16) -> Result<Option<Vec<u8>>, X11Error> {
        loop {
            let mut head = [0u8; 32];
            self.stream.read_exact(&mut head)?;
            let seen = u16::from_le_bytes([head[2], head[3]]);
            match head[0] {
                0 if seen == sequence => return Ok(None),
                0 => return Err(X11Error),
                1 => {
                    let extra =
                        u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize * 4;
                    if extra > 1 << 20 {
                        return Err(X11Error);
                    }
                    let mut reply = head.to_vec();
                    reply.resize(32 + extra, 0);
                    self.stream.read_exact(&mut reply[32..])?;
                    if seen != sequence {
                        return Err(X11Error);
                    }
                    return Ok(Some(reply));
                }
                _ => continue,
            }
        }
    }

    fn atom(&mut self, name: &str) -> Result<u32, X11Error> {
        let bytes = name.as_bytes();
        let words = (8 + bytes.len() + pad4(bytes.len())) / 4;
        let mut request = vec![16, 0];
        request.extend_from_slice(&(words as u16).to_le_bytes());
        request.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        request.extend_from_slice(&[0, 0]);
        request.extend_from_slice(bytes);
        request.resize(words * 4, 0);
        let sequence = self.send(&request)?;
        let reply = self.reply(sequence)?.ok_or(X11Error)?;
        Ok(u32::from_le_bytes([
            reply[8], reply[9], reply[10], reply[11],
        ]))
    }

    /// A property's type and value, `None` when the window is gone.
    fn property(
        &mut self,
        window: u32,
        property: u32,
        words: u32,
    ) -> Result<Option<(u32, Vec<u8>)>, X11Error> {
        let mut request = vec![20, 0, 6, 0];
        for value in [window, property, 0, 0, words] {
            request.extend_from_slice(&value.to_le_bytes());
        }
        let sequence = self.send(&request)?;
        let Some(reply) = self.reply(sequence)? else {
            return Ok(None);
        };
        let format = usize::from(reply[1]);
        let kind = u32::from_le_bytes([reply[8], reply[9], reply[10], reply[11]]);
        let items = u32::from_le_bytes([reply[16], reply[17], reply[18], reply[19]]) as usize;
        let bytes = (items * format / 8).min(reply.len() - 32);
        Ok(Some((kind, reply[32..32 + bytes].to_vec())))
    }

    fn ids(&mut self, window: u32, property: u32, kind: u32) -> Result<Vec<u32>, X11Error> {
        let Some((seen, value)) = self.property(window, property, 1024)? else {
            return Ok(Vec::new());
        };
        if seen != kind {
            return Ok(Vec::new());
        }
        Ok(value
            .chunks_exact(4)
            .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
            .collect())
    }

    fn text(&mut self, window: u32, property: u32, kind: u32) -> Result<Option<String>, X11Error> {
        Ok(match self.property(window, property, 256)? {
            Some((seen, value)) if seen == kind && !value.is_empty() => {
                Some(String::from_utf8_lossy(&value).into_owned())
            }
            _ => None,
        })
    }

    fn windows(&mut self) -> Result<Vec<DesktopWindow>, X11Error> {
        let root = self.root;
        let atoms = &self.atoms;
        let (client_list, stacking, active_window) = (
            atoms.client_list,
            atoms.client_list_stacking,
            atoms.active_window,
        );
        let mut clients = self.ids(root, client_list, ATOM_WINDOW)?;
        // Keep the most recently stacked when there are too many.
        if clients.len() > MAX_WINDOWS {
            let stacked = self.ids(root, stacking, ATOM_WINDOW)?;
            let kept: Vec<u32> = stacked.iter().rev().take(MAX_WINDOWS).copied().collect();
            clients.retain(|window| kept.contains(window));
            clients.truncate(MAX_WINDOWS);
        }
        let active = self.ids(root, active_window, ATOM_WINDOW)?.first().copied();
        let mut windows = Vec::with_capacity(clients.len());
        for id in clients {
            let app = self
                .text(id, ATOM_WM_CLASS, ATOM_STRING)?
                .and_then(|class| app_for_class(&class));
            // A window that closed meanwhile is left out.
            if let Some(window) = self.describe(id, app, active)? {
                windows.push(window);
            }
        }
        Ok(windows)
    }

    fn describe(
        &mut self,
        id: u32,
        app: Option<DesktopApp>,
        active: Option<u32>,
    ) -> Result<Option<DesktopWindow>, X11Error> {
        let (wm_name, utf8, wm_state, hidden) = (
            self.atoms.wm_name,
            self.atoms.utf8_string,
            self.atoms.wm_state,
            self.atoms.state_hidden,
        );
        let title = match self.text(id, wm_name, utf8)? {
            Some(title) => title,
            None => self
                .text(id, ATOM_WM_NAME, ATOM_STRING)?
                .unwrap_or_default(),
        };
        let Some((kind, state)) = self.property(id, wm_state, 64)? else {
            return Ok(None);
        };
        let minimized = kind == ATOM_ATOM
            && state
                .chunks_exact(4)
                .any(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]) == hidden);
        Ok(Some(DesktopWindow {
            id,
            app,
            title: title.trim().chars().take(MAX_TITLE_CHARS).collect(),
            minimized,
            focused: active == Some(id),
        }))
    }

    /// Asks openbox, as a pager would, to activate the window: it restores a
    /// minimized window, raises it, and focuses it.
    fn activate(&mut self, window: u32) -> Result<(), X11Error> {
        let mut event = vec![33, 32, 0, 0];
        event.extend_from_slice(&window.to_le_bytes());
        event.extend_from_slice(&self.atoms.active_window.to_le_bytes());
        // Source 2 (a pager), CurrentTime, no window of ours.
        for value in [2u32, 0, 0, 0, 0] {
            event.extend_from_slice(&value.to_le_bytes());
        }
        let mut request = vec![25, 0, 11, 0];
        request.extend_from_slice(&self.root.to_le_bytes());
        // SubstructureNotify | SubstructureRedirect.
        request.extend_from_slice(&((1u32 << 19) | (1u32 << 20)).to_le_bytes());
        request.extend_from_slice(&event);
        self.send(&request)?;
        // GetInputFocus: its reply follows any error, and openbox has the
        // event before the next listing.
        let sequence = self.send(&[43, 0, 1, 0])?;
        self.reply(sequence)?;
        // openbox handles the message asynchronously; let it act first.
        std::thread::sleep(Duration::from_millis(120));
        Ok(())
    }
}

/// `WM_CLASS` is the instance and then the class, each NUL-terminated; the
/// class names the app (`XTerm`, `Chromium` or `Chromium-browser`).
fn app_for_class(class: &str) -> Option<DesktopApp> {
    let class = class
        .split('\0')
        .filter(|name| !name.is_empty())
        .nth(1)?
        .to_ascii_lowercase();
    if class == "xterm" {
        Some(DesktopApp::Terminal)
    } else if class.starts_with("chromium") {
        Some(DesktopApp::Browser)
    } else {
        None
    }
}
