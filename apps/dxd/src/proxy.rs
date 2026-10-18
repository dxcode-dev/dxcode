//! Port forwarding for Portals and the Desktop. Core opens a stream to a
//! loopback port in the guest over this daemon's authenticated session, so a
//! guest service is reachable only through the Thread's channel: nothing in
//! the guest listens for the outside world.
//!
//! A stream is either one HTTP/1.1 exchange or one WebSocket. Every message
//! of a stream, JSON or binary, travels on the session's bulk lane in order.
//! Binary payloads are `DXP1` frames: `DXP1 | u32 BE stream | u8 kind | 3
//! zero bytes | payload`, where kind 0 is bytes (an HTTP body chunk or a
//! binary WebSocket message) and kind 1 is a text WebSocket message. Each
//! side acknowledges every data frame it consumes with `proxy.ack`, and a
//! sender keeps at most `STREAM_WINDOW` frames unacknowledged per stream.
//!
//! Nothing a guest service, a Portal page, or a browser does ends the
//! session: a stream that breaks a bound fails alone with `proxy.error`.
//! Only a message Core could never have sent (a malformed `DXP1` header, a
//! stream id of 0, or a duplicate open) is a session protocol error. Core
//! checks the same request bounds (`apps/core/src/execution/dxd/protocol.ts`)
//! before it sends, so a request it admits never fails here.

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

pub const FRAME_MAGIC: [u8; 4] = *b"DXP1";
pub const FRAME_HEADER_BYTES: usize = 12;
pub const KIND_BYTES: u8 = 0;
pub const KIND_TEXT: u8 = 1;
/// Concurrent streams per session; a browser opens about six per origin.
pub const MAX_STREAMS: usize = 128;
/// Unacknowledged data frames per stream in each direction.
pub const STREAM_WINDOW: usize = 16;
pub const MAX_BODY_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = FRAME_HEADER_BYTES + MAX_WEBSOCKET_MESSAGE_BYTES;
// Request and response head bounds. Core's `DXD_PROXY_MAX_*` constants carry
// the same values and Core rejects a request that breaks one before sending.
pub const MAX_METHOD_BYTES: usize = 16;
pub const MAX_TARGET_BYTES: usize = 8 * 1024;
pub const MAX_HEADERS: usize = 128;
pub const MAX_HEADER_NAME_BYTES: usize = 256;
pub const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;
/// Every header's name and value plus 4 bytes for `: ` and CRLF.
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_PROTOCOLS: usize = 16;
/// A `proxy.response` as sent, after JSON escaping; Core drops a larger one.
pub const MAX_HEAD_FRAME_BYTES: usize = 96 * 1024;
const MAX_RESPONSE_HEAD_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// From the end of the request body; a dev server may compile on its first
/// request.
const RESPONSE_HEAD_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a WebSocket closed by Core waits for the guest's close.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const READ_BUFFER_BYTES: usize = 64 * 1024;
/// Guest ports that belong to dx itself and are never listed as Portals.
pub const INTERNAL_PORTS: [u16; 2] = [DESKTOP_GATEWAY_PORT, 9222];
pub const DESKTOP_GATEWAY_PORT: u16 = 5900;
pub const DESKTOP_START: &str = "/opt/dx/desktop/start";
const DESKTOP_START_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_LISTED_PORTS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyMode {
    Http,
    Websocket,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyOpen {
    pub stream_id: u32,
    pub port: u16,
    pub mode: ProxyMode,
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub protocols: Vec<String>,
    pub body: bool,
}

impl ProxyOpen {
    pub fn valid(&self) -> bool {
        let header_bytes: usize = self
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len() + 4)
            .sum();
        self.port != 0
            && self.method.len() <= MAX_METHOD_BYTES
            && is_token(&self.method)
            && (self.mode == ProxyMode::Http || (self.method == "GET" && !self.body))
            && self.target.starts_with('/')
            && self.target.len() <= MAX_TARGET_BYTES
            && self
                .target
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte))
            && self.headers.len() <= MAX_HEADERS
            && header_bytes <= MAX_HEADER_BYTES
            && self
                .headers
                .iter()
                .all(|(name, value)| valid_header_name(name) && valid_header_value(value))
            && self.protocols.len() <= MAX_PROTOCOLS
            && self
                .protocols
                .iter()
                .all(|protocol| valid_header_name(protocol))
    }
}

/// An RFC 9110 token: methods, header names, and subprotocols.
fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn valid_header_name(name: &str) -> bool {
    name.len() <= MAX_HEADER_NAME_BYTES && is_token(name)
}

fn valid_header_value(value: &str) -> bool {
    value.len() <= MAX_HEADER_VALUE_BYTES
        && value
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte) || byte >= 0x80)
}

/// Headers that describe one connection, never the exchange it carries.
fn hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

/// Headers the WebSocket client writes itself: its key, version, and
/// extensions. `Host` is not one of them; the guest sees the Portal host on
/// a handshake as it does on an HTTP request.
fn websocket_handshake(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("sec-websocket-")
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum StreamMessage<'a> {
    #[serde(rename = "proxy.response")]
    Response {
        #[serde(rename = "streamId")]
        stream_id: u32,
        status: u16,
        headers: Vec<(&'a str, &'a str)>,
    },
    #[serde(rename = "proxy.accepted")]
    Accepted {
        #[serde(rename = "streamId")]
        stream_id: u32,
        protocol: Option<&'a str>,
    },
    #[serde(rename = "proxy.end")]
    End {
        #[serde(rename = "streamId")]
        stream_id: u32,
    },
    #[serde(rename = "proxy.closed")]
    Closed {
        #[serde(rename = "streamId")]
        stream_id: u32,
        code: u16,
        reason: &'a str,
    },
    #[serde(rename = "proxy.error")]
    Error {
        #[serde(rename = "streamId")]
        stream_id: u32,
        reason: &'static str,
    },
    #[serde(rename = "proxy.ack")]
    Ack {
        #[serde(rename = "streamId")]
        stream_id: u32,
    },
}

/// What the session sends for the proxy, in order, on its bulk lane.
pub enum Outbound {
    Text(String),
    Binary(Bytes),
    /// A stream's task ended; the session forgets it. The serial tells a
    /// stream from a later one that reuses its id.
    Finished(u32, u64),
}

enum Input {
    Data(Bytes, u8),
    End,
    Close(Option<u16>, String),
}

struct Stream {
    serial: u64,
    input: mpsc::Sender<Input>,
    /// Data frames from Core this stream has not acknowledged yet.
    inbound: Arc<AtomicUsize>,
    credits: Arc<Semaphore>,
    task: tokio::task::AbortHandle,
}

/// The streams of one session. Dropping it ends every stream: Core fails a
/// stream whose session ends, so none outlives its connection.
pub struct Proxy {
    streams: HashMap<u32, Stream>,
    serial: u64,
    tx: mpsc::UnboundedSender<Outbound>,
    rx: mpsc::UnboundedReceiver<Outbound>,
}

impl Default for Proxy {
    fn default() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            streams: HashMap::new(),
            serial: 0,
            tx,
            rx,
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        for stream in self.streams.values() {
            stream.task.abort();
        }
    }
}

/// A message Core could never have sent; it ends the session.
#[derive(Debug, Eq, PartialEq)]
pub enum ProxyViolation {
    /// A malformed `DXP1` header or a stream id of 0.
    Invalid,
    /// An open for a stream that is still running.
    Duplicate,
}

impl Proxy {
    pub fn is_empty(&self) -> bool {
        self.streams.is_empty()
    }

    /// The next message to send. Never ends: the proxy holds its own sender.
    pub async fn next(&mut self) -> Outbound {
        let outbound = self.rx.recv().await.expect("the proxy holds a sender");
        if let Outbound::Finished(stream_id, serial) = outbound
            && self
                .streams
                .get(&stream_id)
                .is_some_and(|stream| stream.serial == serial)
        {
            self.streams.remove(&stream_id);
        }
        outbound
    }

    /// A sender for request results computed off the connection loop.
    pub fn sender(&self) -> mpsc::UnboundedSender<Outbound> {
        self.tx.clone()
    }

    pub fn open(&mut self, open: ProxyOpen) -> Result<(), ProxyViolation> {
        if open.stream_id == 0 {
            return Err(ProxyViolation::Invalid);
        }
        if self.streams.contains_key(&open.stream_id) {
            return Err(ProxyViolation::Duplicate);
        }
        // Refuse the stream, not the session.
        if !open.valid() {
            self.error(open.stream_id, "invalid-request");
            return Ok(());
        }
        if self.streams.len() >= MAX_STREAMS {
            self.error(open.stream_id, "too-many-streams");
            return Ok(());
        }
        let stream_id = open.stream_id;
        self.serial += 1;
        let serial = self.serial;
        // The window, `proxy.end`, and two closes always fit.
        let (input, input_rx) = mpsc::channel(STREAM_WINDOW + 4);
        let credits = Arc::new(Semaphore::new(STREAM_WINDOW));
        let inbound = Arc::new(AtomicUsize::new(0));
        let link = Link {
            stream_id: open.stream_id,
            tx: self.tx.clone(),
            credits: Arc::clone(&credits),
            inbound: Arc::clone(&inbound),
        };
        let task = tokio::spawn(async move {
            let stream_id = link.stream_id;
            let tx = link.tx.clone();
            let outcome = match open.mode {
                ProxyMode::Http => http(open, input_rx, &link).await,
                ProxyMode::Websocket => websocket(open, input_rx, &link).await,
            };
            if let Err(reason) = outcome {
                let _ = tx.send(text(&StreamMessage::Error { stream_id, reason }));
            }
            let _ = tx.send(Outbound::Finished(stream_id, serial));
        });
        self.streams.insert(
            stream_id,
            Stream {
                serial,
                input,
                inbound,
                credits,
                task: task.abort_handle(),
            },
        );
        Ok(())
    }

    fn error(&self, stream_id: u32, reason: &'static str) {
        let _ = self
            .tx
            .send(text(&StreamMessage::Error { stream_id, reason }));
    }

    /// End one stream that broke the protocol, and only that stream.
    fn fail(&mut self, stream_id: u32, reason: &'static str) {
        if let Some(stream) = self.streams.remove(&stream_id) {
            stream.task.abort();
            self.error(stream_id, reason);
        }
    }

    /// Hand one input to a stream's task. A task that already returned is a
    /// race with its `Finished`, not a fault; a full queue means Core broke
    /// the window, which fails the stream.
    fn deliver(&mut self, stream_id: u32, input: Input) {
        let Some(stream) = self.streams.get(&stream_id) else {
            return;
        };
        match stream.input.try_send(input) {
            Ok(()) | Err(TrySendError::Closed(_)) => {}
            Err(TrySendError::Full(_)) => self.fail(stream_id, "invalid-request"),
        }
    }

    /// One `DXP1` frame from Core.
    pub fn input(&mut self, frame: &[u8]) -> Result<(), ProxyViolation> {
        let (stream_id, kind, payload) = decode_frame(frame).ok_or(ProxyViolation::Invalid)?;
        // A frame for a stream that already ended is a race, not a fault.
        let Some(stream) = self.streams.get(&stream_id) else {
            return Ok(());
        };
        if stream.inbound.fetch_add(1, Ordering::AcqRel) >= STREAM_WINDOW {
            self.fail(stream_id, "invalid-request");
            return Ok(());
        }
        self.deliver(
            stream_id,
            Input::Data(Bytes::copy_from_slice(payload), kind),
        );
        Ok(())
    }

    pub fn end(&mut self, stream_id: u32) {
        self.deliver(stream_id, Input::End);
    }

    /// Core closed the stream: a WebSocket closes with `code`, and an HTTP
    /// exchange is abandoned.
    pub fn close(&mut self, stream_id: u32, code: Option<u16>, reason: String) {
        let Some(stream) = self.streams.get(&stream_id) else {
            return;
        };
        if let Err(TrySendError::Full(_)) = stream.input.try_send(Input::Close(code, reason)) {
            stream.task.abort();
            self.streams.remove(&stream_id);
        }
    }

    /// Core consumed one frame. An acknowledgement beyond the window fails
    /// that stream alone.
    pub fn ack(&mut self, stream_id: u32) {
        let Some(stream) = self.streams.get(&stream_id) else {
            return;
        };
        if stream.credits.available_permits() >= STREAM_WINDOW {
            self.fail(stream_id, "invalid-request");
            return;
        }
        stream.credits.add_permits(1);
    }
}

struct Link {
    stream_id: u32,
    tx: mpsc::UnboundedSender<Outbound>,
    credits: Arc<Semaphore>,
    inbound: Arc<AtomicUsize>,
}

impl Link {
    fn send(&self, message: &StreamMessage<'_>) -> Result<(), &'static str> {
        self.tx.send(text(message)).map_err(|_| "closed")
    }

    /// Send one data frame once the window has room.
    async fn data(&self, kind: u8, payload: &[u8]) -> Result<(), &'static str> {
        self.credits.acquire().await.map_err(|_| "closed")?.forget();
        self.frame(kind, payload)
    }

    /// Send one data frame whose credit is already taken.
    fn frame(&self, kind: u8, payload: &[u8]) -> Result<(), &'static str> {
        self.tx
            .send(Outbound::Binary(Bytes::from(encode_frame(
                self.stream_id,
                kind,
                payload,
            ))))
            .map_err(|_| "closed")
    }

    /// This stream consumed one frame from Core.
    fn ack(&self) -> Result<(), &'static str> {
        self.inbound.fetch_sub(1, Ordering::AcqRel);
        self.send(&StreamMessage::Ack {
            stream_id: self.stream_id,
        })
    }
}

fn text(message: &StreamMessage<'_>) -> Outbound {
    Outbound::Text(serde_json::to_string(message).expect("stream messages serialize"))
}

pub fn encode_frame(stream_id: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.extend_from_slice(&stream_id.to_be_bytes());
    frame.extend_from_slice(&[kind, 0, 0, 0]);
    frame.extend_from_slice(payload);
    frame
}

pub fn is_frame(bytes: &[u8]) -> bool {
    bytes.len() >= FRAME_HEADER_BYTES && bytes[..4] == FRAME_MAGIC
}

pub fn decode_frame(bytes: &[u8]) -> Option<(u32, u8, &[u8])> {
    if !is_frame(bytes) || bytes.len() > MAX_FRAME_BYTES || bytes[9..12] != [0, 0, 0] {
        return None;
    }
    let stream_id = u32::from_be_bytes(bytes[4..8].try_into().ok()?);
    let kind = bytes[8];
    if stream_id == 0 || kind > KIND_TEXT {
        return None;
    }
    Some((stream_id, kind, &bytes[FRAME_HEADER_BYTES..]))
}

/// Connect to a guest service on IPv4 loopback, then IPv6 loopback: Node
/// binds `localhost` to `::1` alone on some systems.
async fn connect(port: u16) -> Result<TcpStream, &'static str> {
    for address in [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ] {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(_)) => continue,
            Err(_) => return Err("upstream-timeout"),
        }
    }
    Err("upstream-unreachable")
}

/// What the request writer is doing while the response is read.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Writer {
    Writing,
    Done,
    /// The guest stopped reading the request (it may still answer).
    Failed,
}

/// One HTTP exchange. The request body is written while the response is
/// read, so a guest that answers early (a 413 or a 401) is served, and a
/// guest that never reads the body never stops Core from abandoning it.
async fn http(
    open: ProxyOpen,
    mut input: mpsc::Receiver<Input>,
    link: &Link,
) -> Result<(), &'static str> {
    let upstream = connect(open.port).await?;
    let mut head = format!("{} {} HTTP/1.1\r\n", open.method, open.target);
    let mut length = None;
    for (name, value) in &open.headers {
        if hop_by_hop(name) {
            continue;
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.trim().parse::<u64>().map_err(|_| "invalid-request")?);
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    let chunked = open.body && length.is_none();
    if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
    }
    head.push_str("Connection: close\r\n\r\n");
    let (read_half, write_half) = upstream.into_split();
    let (body, body_rx) = mpsc::unbounded_channel();
    let writer = write_request(
        write_half,
        head,
        RequestBody {
            present: open.body,
            chunked,
            length,
        },
        body_rx,
        link,
    );
    tokio::pin!(writer);
    let mut writing = Writer::Writing;
    let mut reader = Reader::new(read_half);

    let response = {
        let read = read_response_head(&mut reader);
        tokio::pin!(read);
        let mut deadline: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                response = &mut read => break response,
                message = input.recv() => {
                    if !forward_body(message, writing, &body)? {
                        return Ok(());
                    }
                }
                result = &mut writer, if writing == Writer::Writing => {
                    writing = match result {
                        Ok(()) => Writer::Done,
                        Err("upstream-reset") => Writer::Failed,
                        Err(reason) => return Err(reason),
                    };
                    deadline = Some(tokio::time::Instant::now() + RESPONSE_HEAD_TIMEOUT);
                }
                _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                    return Err("upstream-timeout");
                }
            }
        }
    }?;
    let headers: Vec<(&str, &str)> = response
        .headers
        .iter()
        .filter(|(name, _)| !hop_by_hop(name))
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    if headers.iter().any(|(name, value)| {
        name.len() > MAX_HEADER_NAME_BYTES || value.len() > MAX_HEADER_VALUE_BYTES
    }) {
        return Err("invalid-response");
    }
    let message = serde_json::to_string(&StreamMessage::Response {
        stream_id: link.stream_id,
        status: response.status,
        headers,
    })
    .map_err(|_| "invalid-response")?;
    if message.len() > MAX_HEAD_FRAME_BYTES {
        return Err("invalid-response");
    }
    link.tx
        .send(Outbound::Text(message))
        .map_err(|_| "closed")?;
    let framing = if open.method == "HEAD" || matches!(response.status, 204 | 205 | 304) {
        Framing::Length(0)
    } else if response.chunked {
        Framing::Chunked
    } else if let Some(length) = response.length {
        Framing::Length(length)
    } else {
        Framing::Close
    };
    {
        // The request body keeps flowing while the response does: a guest
        // may answer before it reads everything.
        let relay = relay_body(&mut reader, framing, link);
        tokio::pin!(relay);
        loop {
            tokio::select! {
                result = &mut relay => break result?,
                message = input.recv() => {
                    if !forward_body(message, writing, &body)? {
                        return Ok(());
                    }
                }
                result = &mut writer, if writing == Writer::Writing => {
                    writing = if result.is_ok() { Writer::Done } else { Writer::Failed };
                }
            }
        }
    }
    link.send(&StreamMessage::End {
        stream_id: link.stream_id,
    })
}

/// Pass one input to the request writer. False when Core abandoned the
/// exchange. A body frame after the writer stopped is dropped unacknowledged,
/// which holds Core's body at the window until the exchange ends.
fn forward_body(
    message: Option<Input>,
    writing: Writer,
    body: &mpsc::UnboundedSender<Option<Bytes>>,
) -> Result<bool, &'static str> {
    match message {
        Some(Input::Data(bytes, KIND_BYTES)) => {
            if writing == Writer::Writing {
                let _ = body.send(Some(bytes));
            }
            Ok(true)
        }
        Some(Input::Data(..)) => Err("invalid-request"),
        Some(Input::End) => {
            if writing == Writer::Writing {
                let _ = body.send(None);
            }
            Ok(true)
        }
        Some(Input::Close(..)) | None => Ok(false),
    }
}

struct RequestBody {
    present: bool,
    chunked: bool,
    length: Option<u64>,
}

/// Write the request head and body upstream, acknowledging each body frame
/// once written. `None` on the channel is Core's `proxy.end`.
async fn write_request(
    mut upstream: OwnedWriteHalf,
    head: String,
    body: RequestBody,
    mut frames: mpsc::UnboundedReceiver<Option<Bytes>>,
    link: &Link,
) -> Result<(), &'static str> {
    upstream
        .write_all(head.as_bytes())
        .await
        .map_err(|_| "upstream-reset")?;
    if !body.present {
        return Ok(());
    }
    let mut written = 0_u64;
    while let Some(Some(bytes)) = frames.recv().await {
        written += bytes.len() as u64;
        if body.length.is_some_and(|length| written > length) {
            return Err("invalid-request");
        }
        // An empty chunk would end a chunked body early.
        if !bytes.is_empty() {
            if body.chunked {
                upstream
                    .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
                    .await
                    .map_err(|_| "upstream-reset")?;
            }
            upstream
                .write_all(&bytes)
                .await
                .map_err(|_| "upstream-reset")?;
            if body.chunked {
                upstream
                    .write_all(b"\r\n")
                    .await
                    .map_err(|_| "upstream-reset")?;
            }
        }
        link.ack()?;
    }
    if body.length.is_some_and(|length| written != length) {
        return Err("invalid-request");
    }
    if body.chunked {
        upstream
            .write_all(b"0\r\n\r\n")
            .await
            .map_err(|_| "upstream-reset")?;
    }
    Ok(())
}

/// Resolves when Core closes the stream or ends the session.
async fn wait_close(input: &mut mpsc::Receiver<Input>) {
    loop {
        match input.recv().await {
            Some(Input::Close(..)) | None => return,
            Some(_) => continue,
        }
    }
}

enum Framing {
    Length(u64),
    Chunked,
    Close,
}

struct ResponseHead {
    status: u16,
    headers: Vec<(String, String)>,
    chunked: bool,
    length: Option<u64>,
}

/// A buffered reader over the upstream connection.
struct Reader {
    stream: OwnedReadHalf,
    buffer: Vec<u8>,
    start: usize,
}

impl Reader {
    fn new(stream: OwnedReadHalf) -> Self {
        Self {
            stream,
            buffer: Vec::with_capacity(READ_BUFFER_BYTES),
            start: 0,
        }
    }

    fn buffered(&self) -> &[u8] {
        &self.buffer[self.start..]
    }

    fn consume(&mut self, count: usize) {
        self.start += count;
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        }
    }

    /// Read more bytes; false at end of stream.
    async fn fill(&mut self) -> Result<bool, &'static str> {
        if self.start > 0 && self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        }
        let mut chunk = [0_u8; READ_BUFFER_BYTES];
        let read = self
            .stream
            .read(&mut chunk)
            .await
            .map_err(|_| "upstream-reset")?;
        self.buffer.extend_from_slice(&chunk[..read]);
        Ok(read > 0)
    }

    /// One CRLF-terminated line, without the terminator.
    async fn line(&mut self, limit: usize) -> Result<Vec<u8>, &'static str> {
        loop {
            if let Some(end) = self.buffered().windows(2).position(|pair| pair == b"\r\n") {
                let line = self.buffered()[..end].to_vec();
                self.consume(end + 2);
                return Ok(line);
            }
            if self.buffered().len() > limit {
                return Err("invalid-response");
            }
            if !self.fill().await? {
                return Err("invalid-response");
            }
        }
    }
}

/// The final response head. Interim responses are skipped; a final status
/// outside 200–599 (including `101`, since Core strips `Upgrade`) is
/// `invalid-response`.
async fn read_response_head(reader: &mut Reader) -> Result<ResponseHead, &'static str> {
    loop {
        let (status, headers, consumed) = loop {
            let mut parsed = [httparse::EMPTY_HEADER; MAX_HEADERS];
            let mut response = httparse::Response::new(&mut parsed);
            match response.parse(reader.buffered()) {
                Ok(httparse::Status::Complete(consumed)) => {
                    let status = response.code.ok_or("invalid-response")?;
                    let headers = response
                        .headers
                        .iter()
                        .map(|header| {
                            (
                                header.name.to_owned(),
                                String::from_utf8_lossy(header.value).into_owned(),
                            )
                        })
                        .collect::<Vec<_>>();
                    break (status, headers, consumed);
                }
                Ok(httparse::Status::Partial) => {
                    if reader.buffered().len() > MAX_RESPONSE_HEAD_BYTES {
                        return Err("invalid-response");
                    }
                    if !reader.fill().await? {
                        return Err("upstream-reset");
                    }
                }
                Err(_) => return Err("invalid-response"),
            }
        };
        reader.consume(consumed);
        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        if !(200..=599).contains(&status) {
            return Err("invalid-response");
        }
        let chunked = headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|coding| coding.trim().eq_ignore_ascii_case("chunked"))
        });
        let length = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<u64>())
            .transpose()
            .map_err(|_| "invalid-response")?;
        return Ok(ResponseHead {
            status,
            headers,
            chunked,
            length,
        });
    }
}

async fn relay_body(
    reader: &mut Reader,
    framing: Framing,
    link: &Link,
) -> Result<(), &'static str> {
    match framing {
        Framing::Length(mut remaining) => {
            while remaining > 0 {
                if reader.buffered().is_empty() && !reader.fill().await? {
                    return Err("upstream-reset");
                }
                let take = reader
                    .buffered()
                    .len()
                    .min(MAX_BODY_CHUNK_BYTES)
                    .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                link.data(KIND_BYTES, &reader.buffered()[..take]).await?;
                reader.consume(take);
                remaining -= take as u64;
            }
            Ok(())
        }
        Framing::Close => loop {
            if reader.buffered().is_empty() && !reader.fill().await? {
                return Ok(());
            }
            let take = reader.buffered().len().min(MAX_BODY_CHUNK_BYTES);
            link.data(KIND_BYTES, &reader.buffered()[..take]).await?;
            reader.consume(take);
        },
        Framing::Chunked => loop {
            let line = reader.line(4096).await?;
            let size = std::str::from_utf8(&line)
                .ok()
                .and_then(|line| line.split(';').next())
                .and_then(|size| u64::from_str_radix(size.trim(), 16).ok())
                .ok_or("invalid-response")?;
            if size == 0 {
                // Trailers end with an empty line.
                while !reader.line(MAX_RESPONSE_HEAD_BYTES).await?.is_empty() {}
                return Ok(());
            }
            let mut remaining = size;
            while remaining > 0 {
                if reader.buffered().is_empty() && !reader.fill().await? {
                    return Err("upstream-reset");
                }
                let take = reader
                    .buffered()
                    .len()
                    .min(MAX_BODY_CHUNK_BYTES)
                    .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                link.data(KIND_BYTES, &reader.buffered()[..take]).await?;
                reader.consume(take);
                remaining -= take as u64;
            }
            if !reader.line(2).await?.is_empty() {
                return Err("invalid-response");
            }
        },
    }
}

type GuestSink =
    futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>;

/// Write Core's messages to the guest, acknowledging each once written, and
/// send Core's close when it comes, even while a write waits on a guest that
/// does not read.
async fn write_guest(
    mut sink: GuestSink,
    mut messages: mpsc::UnboundedReceiver<Message>,
    mut close: oneshot::Receiver<CloseFrame>,
    link: &Link,
) -> Result<(), &'static str> {
    loop {
        let message = tokio::select! {
            biased;
            frame = &mut close => {
                if let Ok(frame) = frame {
                    let _ = sink.send(Message::Close(Some(frame))).await;
                }
                return Ok(());
            }
            message = messages.recv() => match message {
                Some(message) => message,
                None => return Ok(()),
            },
        };
        tokio::select! {
            biased;
            frame = &mut close => {
                if let Ok(frame) = frame {
                    let _ = sink.send(Message::Close(Some(frame))).await;
                }
                return Ok(());
            }
            result = sink.send(message) => {
                result.map_err(|_| "upstream-reset")?;
                link.ack()?;
            }
        }
    }
}

async fn websocket(
    open: ProxyOpen,
    mut input: mpsc::Receiver<Input>,
    link: &Link,
) -> Result<(), &'static str> {
    let upstream = connect(open.port).await?;
    let mut request = format!("ws://127.0.0.1:{}{}", open.port, open.target)
        .into_client_request()
        .map_err(|_| "invalid-request")?;
    let headers = request.headers_mut();
    for (name, value) in &open.headers {
        if hop_by_hop(name) || websocket_handshake(name) {
            continue;
        }
        let name = tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "invalid-request")?;
        let value = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(value)
            .map_err(|_| "invalid-request")?;
        // The URI's loopback authority only names the socket already
        // connected; the open's Host replaces the one derived from it.
        if name == tokio_tungstenite::tungstenite::http::header::HOST {
            headers.insert(name, value);
        } else {
            headers.append(name, value);
        }
    }
    if !open.protocols.is_empty() {
        headers.insert(
            "sec-websocket-protocol",
            open.protocols
                .join(", ")
                .parse()
                .map_err(|_| "invalid-request")?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES));
    let handshake = tokio_tungstenite::client_async_with_config(request, upstream, Some(config));
    let (socket, response) = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, handshake) => match result {
            Ok(Ok(accepted)) => accepted,
            Ok(Err(_)) => return Err("upstream-rejected"),
            Err(_) => return Err("upstream-timeout"),
        },
        _ = wait_close(&mut input) => return Ok(()),
    };
    // A guest may only choose a subprotocol the browser offered.
    let protocol = match response.headers().get("sec-websocket-protocol") {
        None => None,
        Some(value) => {
            let value = value.to_str().map_err(|_| "invalid-response")?;
            if !open.protocols.iter().any(|offered| offered == value) {
                return Err("invalid-response");
            }
            Some(value)
        }
    };
    link.send(&StreamMessage::Accepted {
        stream_id: link.stream_id,
        protocol,
    })?;
    let (sink, mut stream) = socket.split();
    let (to_guest, to_guest_rx) = mpsc::unbounded_channel();
    let (close, close_rx) = oneshot::channel();
    let mut close = Some(close);
    let writer = write_guest(sink, to_guest_rx, close_rx, link);
    tokio::pin!(writer);
    let mut writing = true;
    // A guest message waiting for a credit; the guest is not read meanwhile.
    let mut pending: Option<(u8, Bytes)> = None;
    let mut closing: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            message = input.recv() => match message {
                Some(Input::Data(bytes, kind)) => {
                    if closing.is_some() || !writing {
                        link.ack()?;
                        continue;
                    }
                    let message = if kind == KIND_TEXT {
                        Message::Text(
                            String::from_utf8(bytes.to_vec())
                                .map_err(|_| "invalid-request")?
                                .into(),
                        )
                    } else {
                        Message::Binary(bytes)
                    };
                    let _ = to_guest.send(message);
                }
                Some(Input::End) => {}
                Some(Input::Close(code, reason)) => {
                    if let Some(close) = close.take() {
                        let _ = close.send(CloseFrame {
                            code: code.map_or(CloseCode::Normal, CloseCode::from),
                            reason: reason.into(),
                        });
                    }
                    // Nobody reads the guest's messages any more.
                    pending = None;
                    closing.get_or_insert_with(|| tokio::time::Instant::now() + CLOSE_TIMEOUT);
                }
                None => return Ok(()),
            },
            result = &mut writer, if writing => {
                writing = false;
                if closing.is_none() {
                    result?;
                    return Err("upstream-reset");
                }
            }
            permit = link.credits.acquire(), if pending.is_some() => {
                permit.map_err(|_| "closed")?.forget();
                let (kind, payload) = pending.take().expect("a message is pending");
                link.frame(kind, &payload)?;
            }
            message = stream.next(), if pending.is_none() => match message {
                Some(Ok(Message::Binary(bytes))) if closing.is_none() => {
                    pending = Some((KIND_BYTES, bytes));
                }
                Some(Ok(Message::Text(text))) if closing.is_none() => {
                    pending = Some((KIND_TEXT, Bytes::from(text)));
                }
                Some(Ok(Message::Close(frame))) => {
                    if closing.is_some() {
                        return Ok(());
                    }
                    let (code, reason) = frame.map_or((1005, String::new()), |frame| {
                        (u16::from(frame.code), frame.reason.to_string())
                    });
                    let code = if (1000..=4999).contains(&code) { code } else { 1002 };
                    link.send(&StreamMessage::Closed {
                        stream_id: link.stream_id,
                        code,
                        reason: &reason,
                    })?;
                    return Ok(());
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    if closing.is_some() {
                        return Ok(());
                    }
                    return Err("upstream-reset");
                }
            },
            _ = async { tokio::time::sleep_until(closing.unwrap()).await }, if closing.is_some() => {
                return Ok(());
            }
        }
    }
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ListeningPort {
    pub port: u16,
    pub address: String,
}

/// TCP listeners owned by this daemon's user, without dx's own ports, at
/// most `MAX_LISTED_PORTS` of them.
pub fn listening_ports() -> Vec<ListeningPort> {
    let mut ports = all_listening_ports();
    ports.truncate(MAX_LISTED_PORTS);
    ports
}

/// Whether this daemon's user listens on `port`, however many ports it has.
pub fn is_listening(port: u16) -> bool {
    all_listening_ports()
        .iter()
        .any(|listener| listener.port == port)
}

fn all_listening_ports() -> Vec<ListeningPort> {
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let mut ports = Vec::new();
    for (path, ipv6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        let Ok(table) = std::fs::read_to_string(path) else {
            continue;
        };
        ports.extend(parse_listeners(&table, ipv6, uid));
    }
    ports.sort();
    ports.dedup_by(|later, earlier| later.port == earlier.port);
    ports
}

fn parse_listeners(table: &str, ipv6: bool, uid: u32) -> Vec<ListeningPort> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // sl local rem st queues timer retransmit uid ...
            if fields.len() < 8 || fields[3] != "0A" || fields[7].parse::<u32>().ok()? != uid {
                return None;
            }
            let (address, port) = fields[1].split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            if port == 0 || INTERNAL_PORTS.contains(&port) {
                return None;
            }
            let address = if ipv6 {
                decode_ipv6(address)?.to_string()
            } else {
                Ipv4Addr::from(u32::from_str_radix(address, 16).ok()?.swap_bytes()).to_string()
            };
            Some(ListeningPort { port, address })
        })
        .collect()
}

/// `/proc/net/tcp6` prints four host-order 32-bit words.
fn decode_ipv6(hex: &str) -> Option<Ipv6Addr> {
    if hex.len() != 32 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    for word in 0..4 {
        let value = u32::from_str_radix(&hex[word * 8..word * 8 + 8], 16).ok()?;
        bytes[word * 4..word * 4 + 4].copy_from_slice(&value.swap_bytes().to_be_bytes());
    }
    Some(Ipv6Addr::from(bytes))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopStart {
    Ready,
    Unsupported,
    Failed,
}

/// Start the guest desktop, or confirm it runs. The image's start script is
/// idempotent and detaches the session, so the desktop outlives this daemon.
/// `single_flight` is held for the whole run, so one daemon never runs two
/// starts at once, whichever session asked.
pub fn ensure_desktop(
    script: &std::path::Path,
    single_flight: &std::sync::Mutex<()>,
) -> DesktopStart {
    let _running = single_flight
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !script.is_file() {
        return DesktopStart::Unsupported;
    }
    let mut command = Command::new(script);
    command
        .env_clear()
        .env("HOME", "/home/user")
        .env("USER", "user")
        .env("LOGNAME", "user")
        .env("SHELL", "/bin/bash")
        .env("LANG", "C.UTF-8")
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .current_dir("/home/user")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let Ok(mut child) = command.spawn() else {
        return DesktopStart::Failed;
    };
    let deadline = Instant::now() + DESKTOP_START_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return DesktopStart::Ready,
            Ok(Some(_)) | Err(_) => return DesktopStart::Failed,
            Ok(None) if Instant::now() >= deadline => {
                // SAFETY: the child leads its own process group and has not
                // been reaped, so the group id still names it.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                return DesktopStart::Failed;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_reject_malformed_headers() {
        let frame = encode_frame(7, KIND_TEXT, b"hello");
        assert_eq!(decode_frame(&frame), Some((7, KIND_TEXT, &b"hello"[..])));
        assert!(decode_frame(&encode_frame(0, KIND_BYTES, b"")).is_none());
        let mut reserved = encode_frame(7, KIND_BYTES, b"");
        reserved[10] = 1;
        assert!(decode_frame(&reserved).is_none());
        assert!(decode_frame(&encode_frame(7, 2, b"")).is_none());
        assert!(!is_frame(b"DXT1........"));
    }

    #[test]
    fn listeners_are_filtered_by_owner_state_and_internal_ports() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1
   1: 00000000:170C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3
   3: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4
   4: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5";
        assert_eq!(
            parse_listeners(table, false, 1000),
            vec![ListeningPort {
                port: 5173,
                address: "127.0.0.1".into()
            }]
        );
        assert_eq!(
            decode_ipv6("00000000000000000000000001000000"),
            Some(Ipv6Addr::LOCALHOST)
        );
    }
}
