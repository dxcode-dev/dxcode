//! The one outbound connection to Core: hello, ping every 15 s, requests
//! served concurrently, reconnect with backoff. Requests run on the blocking
//! pool; a reply is one JSON frame. Desktop streams (`stream-open`, then
//! binary data messages, see `desktop.rs`) relay between Core and voxl.

use crate::runner::daemon::Daemons;
use crate::runner::desktop::{self, Desktop, Joined, Joiner as StreamJoiner};
use crate::runner::ops::{self, Ctx};
use crate::runner::{
    Config, Paths, VERSION, ensure_owned_dir, exec, log, sandbox, start_logging, update,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const PING_EVERY: Duration = Duration::from_secs(15);
const SILENT_LIMIT: Duration = Duration::from_secs(45);
/// Re-sends hello this often, so Core can offer a build deployed while the
/// connection stayed open (a deploy keeps hibernated sockets).
const HELLO_EVERY: Duration = Duration::from_secs(30 * 60);
const MAX_FRAME: usize = 16 * 1024 * 1024;
const CONCURRENT_OPS: usize = 8;
/// A Workers WebSocket message is at most 1 MiB, so a frame over 256 Ki
/// UTF-16 units travels as `part` frames of at most 128 Ki units each (Core's
/// `runnerFrames` / `RunnerFrameJoiner` in apps/core/src/runners/protocol.ts).
const WHOLE_UNITS: usize = 256 * 1024;
const PART_UNITS: usize = 128 * 1024;
static NEXT_PART: AtomicUsize = AtomicUsize::new(0);

/// The frames that carry one message's JSON text.
fn frames(text: String) -> Vec<String> {
    let units: usize = text.chars().map(char::len_utf16).sum();
    if units <= WHOLE_UNITS {
        return vec![text];
    }
    let msg = format!(
        "r{}-{}",
        std::process::id(),
        NEXT_PART.fetch_add(1, Ordering::SeqCst)
    );
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut current_units = 0;
    for c in text.chars() {
        if current_units + c.len_utf16() > PART_UNITS {
            parts.push(std::mem::take(&mut current));
            current_units = 0;
        }
        current.push(c);
        current_units += c.len_utf16();
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let last = parts.len() - 1;
    parts
        .into_iter()
        .enumerate()
        .map(|(seq, data)| {
            json!({ "type": "part", "msg": msg, "seq": seq, "last": seq == last, "data": data })
                .to_string()
        })
        .collect()
}

async fn send_frames(tx: &mpsc::Sender<Message>, value: &Value) {
    for frame in frames(value.to_string()) {
        if tx.send(Message::Text(frame.into())).await.is_err() {
            return;
        }
    }
}

/// Joins Core's `part` frames, in order; a gap drops that message.
#[derive(Default)]
struct Joiner {
    pending: std::collections::HashMap<String, (u64, String)>,
}

impl Joiner {
    fn accept(&mut self, part: &Value) -> Option<String> {
        let msg = part["msg"].as_str()?.to_string();
        let seq = part["seq"].as_u64()?;
        let data = part["data"].as_str()?;
        let entry = self
            .pending
            .entry(msg.clone())
            .or_insert((0, String::new()));
        if entry.0 != seq || entry.1.len() + data.len() > MAX_FRAME {
            self.pending.remove(&msg);
            return None;
        }
        entry.0 += 1;
        entry.1.push_str(data);
        if part["last"] != json!(true) {
            if self.pending.len() > 16 {
                let oldest = self.pending.keys().next().cloned();
                if let Some(k) = oldest {
                    self.pending.remove(&k);
                }
            }
            return None;
        }
        self.pending.remove(&msg).map(|(_, text)| text)
    }
}

/// SHA-256 of this executable, so Core can tell a rebuilt preview binary
/// with an unchanged version apart.
fn own_sha256() -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(std::env::current_exe().ok()?).ok()?;
    Some(
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

pub fn run(paths: Paths) -> Result<(), String> {
    start_logging(&paths)?;
    // Uninstall reads it to stop a runner started in the foreground.
    let _ = std::fs::write(paths.runner.join("run.pid"), std::process::id().to_string());
    ensure_owned_dir(&paths.threads)?;
    let config = Config::load(&paths)?;
    exec::set_base_path(&paths, config.path.as_deref());
    let test = sandbox::self_test(&paths, config.unsandboxed)?;
    if test["ok"] != json!(true) {
        return Err(format!(
            "sandbox self-test failed, refusing to run: {test}\n(on Linux without Landlock, pair again without --sandbox)"
        ));
    }
    if config.unsandboxed {
        log("full access: Thread commands run as you (pair with --sandbox to confine them)");
    }
    // With full access the Desktop is as open to Threads as the rest of the
    // machine; its per-start password still keeps everything else off it.
    let confined = config.unsandboxed || test["desktopConfined"] == json!(true);
    if !confined && cfg!(target_os = "macos") {
        log(&format!(
            "the sandbox did not keep Threads off the Desktop's port; the Desktop stays off: {}",
            test["desktop"]
        ));
    }
    // One connection loop on a current-thread runtime (as dxd's own); every
    // operation runs on the bounded blocking pool.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(32)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(supervise(paths, config, confined))
}

struct State {
    ctx: Arc<Ctx>,
    inflight: AtomicUsize,
    pending_update: Mutex<Option<Value>>,
}

async fn supervise(paths: Paths, config: Config, confined: bool) -> Result<(), String> {
    let daemons = Arc::new(Daemons::new());
    let desktop = Arc::new(Desktop::new(&paths, confined));
    let ctx = Arc::new(Ctx {
        paths: paths.clone(),
        config: config.clone(),
        daemons: daemons.clone(),
        desktop: desktop.clone(),
    });
    {
        let (p, c, d) = (paths.clone(), config.clone(), daemons.clone());
        let _ = tokio::task::spawn_blocking(move || d.adopt_all(&p, &c)).await;
    }
    let state = Arc::new(State {
        ctx,
        inflight: AtomicUsize::new(0),
        pending_update: Mutex::new(None),
    });
    {
        let (paths, daemons, desktop) = (paths.clone(), daemons.clone(), desktop.clone());
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let mut int = signal(SignalKind::interrupt()).expect("signal");
            let mut term = signal(SignalKind::terminate()).expect("signal");
            let mut hup = signal(SignalKind::hangup()).expect("signal");
            tokio::select! { _ = int.recv() => {}, _ = term.recv() => {}, _ = hup.recv() => {} }
            log("stopping: ending jobs and every Thread's dxd");
            exec::kill_all_jobs();
            daemons.stop_all(&paths);
            desktop.stop(&paths);
            std::process::exit(130);
        });
    }
    log(&format!(
        "run: version {VERSION}, {} as {} ({})",
        config.server, config.name, config.machine_id
    ));
    let mut backoff = 1u64;
    loop {
        let started = Instant::now();
        match connection(&state).await {
            Ok(()) => log("connection closed"),
            Err(Exit::Unauthorized) => {
                // Paired again while this runner kept the old token: start
                // over with the new pairing at once.
                if Config::load(&state.ctx.paths)
                    .is_ok_and(|fresh| fresh.token != state.ctx.config.token)
                {
                    log("this machine was paired again; restarting with the new pairing");
                    exec::kill_all_jobs();
                    let (paths, daemons, desktop) = (
                        state.ctx.paths.clone(),
                        state.ctx.daemons.clone(),
                        state.ctx.desktop.clone(),
                    );
                    let _ = tokio::task::spawn_blocking(move || {
                        daemons.stop_all(&paths);
                        desktop.stop(&paths);
                    })
                    .await;
                    log(&update::restart(&state.ctx.paths));
                }
                log(
                    "dx refused this runner's token (removed in Settings?); retrying in a minute. Pair again to reconnect.",
                );
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
            Err(Exit::Other(e)) => log(&format!("connection: {e}")),
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = 1;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

enum Exit {
    Unauthorized,
    Other(String),
}

fn hello(state: &State) -> Value {
    let ctx = &state.ctx;
    json!({
        "type": "hello",
        "version": VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "sandbox": sandbox::kind(ctx.config.unsandboxed),
        "threads": ops::thread_ids(&ctx.paths),
        "sha256": own_sha256(),
    })
}

async fn connection(state: &Arc<State>) -> Result<(), Exit> {
    let config = &state.ctx.config;
    let mut request = config
        .connect_url()
        .into_client_request()
        .map_err(|e| Exit::Other(format!("bad server URL: {e}")))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.token)
            .parse()
            .map_err(|_| Exit::Other("bad token".into()))?,
    );
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false),
    )
    .await
    .map_err(|_| Exit::Other("connect timed out".into()))?
    .map_err(|e| match &e {
        tokio_tungstenite::tungstenite::Error::Http(r)
            if r.status() == 401 || r.status() == 403 =>
        {
            Exit::Unauthorized
        }
        _ => Exit::Other(e.to_string()),
    })?;
    log("connected");
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let send = |v: Value| {
        let tx = tx.clone();
        async move {
            send_frames(&tx, &v).await;
        }
    };
    send(hello(state)).await;
    let permits = Arc::new(Semaphore::new(CONCURRENT_OPS));
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut last_heard = Instant::now();
    let mut joiner = Joiner::default();
    let mut last_hello = Instant::now();
    let streams: Streams = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let result = loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENT_LIMIT {
                    break Err(Exit::Other("dx went silent".into()));
                }
                send(json!({ "type": "ping" })).await;
                if last_hello.elapsed() > HELLO_EVERY {
                    last_hello = Instant::now();
                    send(hello(state)).await;
                }
                maybe_update(state).await;
                let ctx = state.ctx.clone();
                tokio::task::spawn_blocking(move || ctx.desktop.stop_if_idle(&ctx.paths));
            }
            frame = stream.next() => {
                let Some(frame) = frame else { break Ok(()) };
                let frame = match frame {
                    Ok(f) => f,
                    Err(e) => break Err(Exit::Other(e.to_string())),
                };
                last_heard = Instant::now();
                let text = match frame {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => {
                        stream_data(&streams, &tx, &b).await;
                        continue;
                    }
                    Message::Close(_) => break Ok(()),
                    _ => continue,
                };
                let Ok(mut msg) = serde_json::from_str::<Value>(&text) else { continue };
                if msg["type"] == json!("part") {
                    let Some(whole) = joiner.accept(&msg) else { continue };
                    let Ok(joined) = serde_json::from_str::<Value>(&whole) else { continue };
                    msg = joined;
                }
                match msg["type"].as_str() {
                    Some("ping") => send(json!({ "type": "pong" })).await,
                    Some("stream-open") => open_stream(state, &streams, &tx, &msg).await,
                    Some("hello") => {
                        if msg["update"].is_object() {
                            *state.pending_update.lock().await = Some(msg["update"].clone());
                        }
                        maybe_update(state).await;
                    }
                    Some("request") => {
                        let state = state.clone();
                        let tx = tx.clone();
                        let permits = permits.clone();
                        state.inflight.fetch_add(1, Ordering::SeqCst);
                        tokio::spawn(async move {
                            let _permit = permits.acquire_owned().await;
                            let reply = serve(&state, msg).await;
                            send_frames(&tx, &reply).await;
                            state.inflight.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    _ => {}
                }
            }
        }
    };
    // Every stream's sender goes: its relay closes the voxl side.
    streams.lock().unwrap().clear();
    drop(tx);
    writer.abort();
    result
}

/// The open Desktop streams of one connection: each relay's inbox.
type Streams = Arc<std::sync::Mutex<HashMap<u32, mpsc::Sender<(u8, Vec<u8>)>>>>;
/// Data messages from Core waiting for a relay that has not caught up; a
/// relay this far behind is ended rather than stalling the connection.
const STREAM_INBOX: usize = 256;

async fn send_close(tx: &mpsc::Sender<Message>, stream: u32, code: u16, reason: &str) {
    let frame = desktop::encode(
        stream,
        desktop::KIND_CLOSE,
        &desktop::close_payload(code, reason),
    );
    let _ = tx.send(Message::Binary(frame.into())).await;
}

/// `{"type":"stream-open","stream":n,"path":"/ws"}`: a viewer opened the
/// Desktop; connect to voxl as this supervisor and relay.
async fn open_stream(
    state: &Arc<State>,
    streams: &Streams,
    tx: &mpsc::Sender<Message>,
    msg: &Value,
) {
    let Some(stream) = msg["stream"].as_u64().and_then(|s| u32::try_from(s).ok()) else {
        return;
    };
    if msg["path"] != json!("/ws") {
        send_close(tx, stream, 1008, "Only the Desktop's /ws opens.").await;
        return;
    }
    let (inbox, from_core) = mpsc::channel(STREAM_INBOX);
    {
        let mut open = streams.lock().unwrap();
        if open.contains_key(&stream) {
            return;
        }
        open.insert(stream, inbox);
    }
    let (desktop, tx, streams) = (state.ctx.desktop.clone(), tx.clone(), streams.clone());
    tokio::spawn(async move {
        relay(stream, from_core, &tx, &desktop).await;
        streams.lock().unwrap().remove(&stream);
    });
}

/// A binary data message from Core, for one stream's relay.
async fn stream_data(streams: &Streams, tx: &mpsc::Sender<Message>, frame: &[u8]) {
    let Some((stream, kind, payload)) = desktop::decode(frame) else {
        return;
    };
    let inbox = streams.lock().unwrap().get(&stream).cloned();
    let Some(inbox) = inbox else {
        if kind & !desktop::MORE != desktop::KIND_CLOSE {
            send_close(tx, stream, 1011, "The Desktop stream ended.").await;
        }
        return;
    };
    if inbox.try_send((kind, payload.to_vec())).is_err() {
        streams.lock().unwrap().remove(&stream);
        send_close(tx, stream, 1013, "The Desktop is not keeping up.").await;
    }
}

/// One viewer's WebSocket to voxl, with the password only this process
/// holds, relayed both ways until either side closes.
async fn relay(
    stream: u32,
    mut from_core: mpsc::Receiver<(u8, Vec<u8>)>,
    tx: &mpsc::Sender<Message>,
    desktop_state: &Desktop,
) {
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    let Some(password) = desktop_state.password() else {
        send_close(tx, stream, 1011, "The Desktop is not running.").await;
        return;
    };
    let mut request =
        match format!("ws://127.0.0.1:{}/ws", desktop::VOXL_PORT).into_client_request() {
            Ok(r) => r,
            Err(_) => return,
        };
    if let Ok(value) = format!("Bearer {password}").parse() {
        request.headers_mut().insert("Authorization", value);
    }
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(desktop::MAX_STREAM_MESSAGE))
        .max_frame_size(Some(desktop::MAX_STREAM_MESSAGE));
    let connected = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false),
    )
    .await;
    let socket = match connected {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(e)) => {
            log(&format!("desktop: stream {stream}: voxl refused: {e}"));
            send_close(tx, stream, 1011, "voxl refused the Desktop connection.").await;
            return;
        }
        Err(_) => {
            send_close(tx, stream, 1011, "voxl did not answer.").await;
            return;
        }
    };
    desktop_state.stream_opened();
    let (mut up, mut down) = socket.split();
    let mut joiner = StreamJoiner::default();
    let to_core = |kind: u8, payload: &[u8]| {
        desktop::split(stream, kind, payload)
            .into_iter()
            .map(|f| Message::Binary(f.into()))
            .collect::<Vec<_>>()
    };
    loop {
        tokio::select! {
            message = down.next() => {
                let frames = match message {
                    Some(Ok(Message::Text(t))) => to_core(desktop::KIND_TEXT, t.as_bytes()),
                    Some(Ok(Message::Binary(b))) => to_core(desktop::KIND_BINARY, &b),
                    Some(Ok(Message::Close(c))) => {
                        let (code, reason) = c
                            .map(|c| (u16::from(c.code), c.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        send_close(tx, stream, code, &reason).await;
                        break;
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(_)) | None => {
                        send_close(tx, stream, 1011, "voxl closed the Desktop connection.").await;
                        break;
                    }
                };
                let mut sent = true;
                for f in frames {
                    if tx.send(f).await.is_err() {
                        sent = false;
                        break;
                    }
                }
                if !sent {
                    break;
                }
            }
            inbound = from_core.recv() => {
                let Some((kind, payload)) = inbound else {
                    // The connection to Core ended.
                    let _ = up.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Away,
                        reason: "dx disconnected".into(),
                    }))).await;
                    break;
                };
                match joiner.accept(kind, &payload) {
                    Joined::Partial => {}
                    Joined::Invalid => {
                        let _ = up.send(Message::Close(None)).await;
                        send_close(tx, stream, 1009, "Desktop message too large or out of order.").await;
                        break;
                    }
                    Joined::Message(desktop::KIND_CLOSE, data) => {
                        let code = if data.len() >= 2 { u16::from_be_bytes([data[0], data[1]]) } else { 1000 };
                        // Only codes a peer may send; anything else closes normally.
                        let code = if code == 1000 || (3000..5000).contains(&code) { code } else { 1000 };
                        let reason = String::from_utf8_lossy(data.get(2..).unwrap_or_default()).to_string();
                        let _ = up.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                        break;
                    }
                    Joined::Message(desktop::KIND_TEXT, data) => {
                        let Ok(text) = String::from_utf8(data) else { break };
                        if up.send(Message::Text(text.into())).await.is_err() {
                            send_close(tx, stream, 1011, "voxl closed the Desktop connection.").await;
                            break;
                        }
                    }
                    Joined::Message(_, data) => {
                        if up.send(Message::Binary(data.into())).await.is_err() {
                            send_close(tx, stream, 1011, "voxl closed the Desktop connection.").await;
                            break;
                        }
                    }
                }
            }
        }
    }
    desktop_state.stream_closed();
}

async fn serve(state: &Arc<State>, msg: Value) -> Value {
    let id = msg["id"].clone();
    let op = msg["op"].as_str().unwrap_or_default().to_string();
    let thread = msg["thread"].as_str().unwrap_or_default().to_string();
    let body = msg["body"].clone();
    let ctx = state.ctx.clone();
    let started = Instant::now();
    let summary = match op.as_str() {
        "exec" => format!(
            " {:?}",
            body["command"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect::<String>()
        ),
        "read" | "write" | "stat" | "readdir" | "mkdir" | "rm" => {
            format!(" {}", body["path"].as_str().unwrap_or(""))
        }
        _ => String::new(),
    };
    let quiet = matches!(
        op.as_str(),
        "read" | "stat" | "readdir" | "snapshot" | "threads" | "desktop.health" | "desktop.windows"
    );
    if !quiet {
        log(&format!("{op} {thread}{summary}"));
    }
    let (op2, thread2) = (op.clone(), thread.clone());
    let result = tokio::task::spawn_blocking(move || ops::handle(&ctx, &op2, &thread2, &body))
        .await
        .unwrap_or_else(|e| Err(ops::OpError::failed(format!("operation panicked: {e}"))));
    match result {
        Ok(result) => {
            if !quiet {
                let exit = result
                    .get("exitCode")
                    .map(|c| format!(" exit={c}"))
                    .unwrap_or_default();
                log(&format!(
                    "{op} {thread} ok in {}ms{exit}",
                    started.elapsed().as_millis()
                ));
            }
            json!({ "type": "reply", "id": id, "ok": true, "result": result })
        }
        Err(e) => {
            log(&format!("{op} {thread} failed ({}): {}", e.code, e.message));
            json!({ "type": "reply", "id": id, "ok": false, "error": { "code": e.code, "message": e.message } })
        }
    }
}

/// Applies a pending runner or dxd update once nothing is running.
async fn maybe_update(state: &Arc<State>) {
    if state.inflight.load(Ordering::SeqCst) > 0
        || exec::running_jobs() > 0
        || state.ctx.desktop.watched()
    {
        return;
    }
    let Some(offer) = state.pending_update.lock().await.take() else {
        return;
    };
    let ctx = state.ctx.clone();
    let staged =
        tokio::task::spawn_blocking(move || update::stage_update(&ctx.paths, &ctx.config, &offer))
            .await;
    match staged {
        Ok(Ok(true)) => {
            log("update: restarting into the new dxd");
            exec::kill_all_jobs();
            let (paths, daemons, desktop) = (
                state.ctx.paths.clone(),
                state.ctx.daemons.clone(),
                state.ctx.desktop.clone(),
            );
            let _ = tokio::task::spawn_blocking(move || {
                daemons.stop_all(&paths);
                desktop.stop(&paths);
            })
            .await;
            let err = update::restart(&state.ctx.paths);
            log(&format!("update: {err}"));
        }
        Ok(Ok(false)) => {}
        Ok(Err(e)) => log(&format!("update: {e}")),
        Err(e) => log(&format!("update: {e}")),
    }
}
