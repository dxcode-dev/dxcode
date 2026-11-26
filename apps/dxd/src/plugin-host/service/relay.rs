//! `DX_API`: one HTTP/1.1 listener per daemon on loopback through which a
//! service reaches dx. Each request names its install by the run's bearer
//! token; dxd forwards it to Core as `service.request` without reading its
//! path (Core owns `/state`, `/threads`, `/views`, `/id-token`) and writes
//! Core's `service.response` back as JSON.
//!
//! Accepting runs on the daemon's runtime; each admitted request is served
//! on its own short-lived thread, as the workload-identity socket is.

use super::super::lock;
use crate::proxy::Outbound;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// The largest `service.request` or `service.response` frame.
pub const MAX_SERVICE_FRAME_BYTES: usize = 1024 * 1024 + 16 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_CONCURRENT_REQUESTS: usize = 32;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(10);

struct Lane {
    sender: UnboundedSender<Outbound>,
    generation: String,
}

struct Pending {
    generation: String,
    reply: SyncSender<Reply>,
}

enum Reply {
    Answered(u16, Value),
    Lost,
}

#[derive(Default)]
pub(super) struct Relay {
    port: Mutex<Option<u16>>,
    /// `DX_TOKEN` → install id, one per running service.
    tokens: Mutex<HashMap<String, String>>,
    lane: Mutex<Option<Lane>>,
    pending: Mutex<HashMap<String, Pending>>,
    active: AtomicUsize,
}

struct Admitted(Arc<Relay>);

impl Drop for Admitted {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Relay {
    /// Listens once; later calls return the same port. Needs the daemon's
    /// runtime.
    pub(super) fn start(self: &Arc<Self>) -> io::Result<u16> {
        let mut port = lock(&self.port);
        if let Some(port) = *port {
            return Ok(port);
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let bound = listener.local_addr()?.port();
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let relay = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream.into_std(),
                    Err(error) => Err(error),
                };
                let Ok(stream) = stream.and_then(|stream| {
                    stream.set_nonblocking(false)?;
                    Ok(stream)
                }) else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let admitted = relay
                    .active
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                        (current < MAX_CONCURRENT_REQUESTS).then_some(current + 1)
                    })
                    .is_ok();
                if !admitted {
                    let mut stream = stream;
                    let _ = write_error(&mut stream, 503, "busy", "Too many requests at once.");
                    continue;
                }
                let admitted = Admitted(Arc::clone(&relay));
                let spawned = std::thread::Builder::new()
                    .name("dxd-service-api".into())
                    .spawn(move || {
                        let relay = Arc::clone(&admitted.0);
                        let mut stream = stream;
                        let _ = relay.serve(&mut stream);
                        drop(admitted);
                    });
                if spawned.is_err() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        });
        *port = Some(bound);
        Ok(bound)
    }

    pub(super) fn allow(&self, token: &str, install_id: &str) {
        lock(&self.tokens).insert(token.to_owned(), install_id.to_owned());
    }

    pub(super) fn revoke(&self, token: &str) {
        lock(&self.tokens).remove(token);
    }

    pub(super) fn connect(&self, sender: UnboundedSender<Outbound>, generation: &str) {
        *lock(&self.lane) = Some(Lane {
            sender,
            generation: generation.to_owned(),
        });
    }

    pub(super) fn disconnect(&self) {
        *lock(&self.lane) = None;
        for (_, pending) in lock(&self.pending).drain() {
            let _ = pending.reply.try_send(Reply::Lost);
        }
    }

    pub(super) fn respond(&self, generation: &str, request_id: &str, status: u16, body: Value) {
        let mut pending = lock(&self.pending);
        if pending
            .get(request_id)
            .is_some_and(|waiting| waiting.generation == generation)
            && let Some(waiting) = pending.remove(request_id)
        {
            let _ = waiting.reply.try_send(Reply::Answered(status, body));
        }
    }

    fn serve(&self, stream: &mut TcpStream) -> io::Result<()> {
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let request = match read_request(stream) {
            Ok(request) => request,
            Err(Refusal(status, code, message)) => {
                return write_error(stream, status, code, message);
            }
        };
        let install_id = request
            .token
            .as_ref()
            .and_then(|token| lock(&self.tokens).get(token).cloned());
        let Some(install_id) = install_id else {
            return write_error(
                stream,
                401,
                "unauthorized",
                "DX_TOKEN is missing or not current.",
            );
        };
        let request_id = format!("svc-{:032x}", rand::random::<u128>());
        let (reply, answer) = sync_channel(1);
        {
            let lane = lock(&self.lane);
            let Some(lane) = lane.as_ref() else {
                return write_error(
                    stream,
                    503,
                    "disconnected",
                    "dx is not connected to this Orb.",
                );
            };
            let frame = crate::protocol::ClientMessage::ServiceRequest {
                generation: &lane.generation,
                request_id: &request_id,
                install_id: &install_id,
                method: &request.method,
                path: &request.path,
                body: &request.body,
            };
            let Ok(text) = serde_json::to_string(&frame) else {
                return write_error(stream, 400, "invalid-request", "The body is not JSON.");
            };
            if text.len() > MAX_SERVICE_FRAME_BYTES {
                return write_error(stream, 413, "too-large", "The request is too large.");
            }
            lock(&self.pending).insert(
                request_id.clone(),
                Pending {
                    generation: lane.generation.clone(),
                    reply,
                },
            );
            if lane.sender.send(Outbound::Text(text)).is_err() {
                lock(&self.pending).remove(&request_id);
                return write_error(
                    stream,
                    503,
                    "disconnected",
                    "dx is not connected to this Orb.",
                );
            }
        }
        match answer.recv_timeout(ANSWER_TIMEOUT) {
            Ok(Reply::Answered(status, body)) => write_response(stream, status, &body),
            Ok(Reply::Lost) => write_error(
                stream,
                503,
                "disconnected",
                "dx's connection to this Orb dropped.",
            ),
            Err(_) => {
                lock(&self.pending).remove(&request_id);
                write_error(
                    stream,
                    504,
                    "timeout",
                    "dx did not answer within 60 seconds.",
                )
            }
        }
    }
}

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: Value,
}

struct Refusal(u16, &'static str, &'static str);

fn invalid(message: &'static str) -> Refusal {
    Refusal(400, "invalid-request", message)
}

fn read_request(stream: &mut TcpStream) -> Result<Request, Refusal> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 4096];
    let end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(Refusal(
                431,
                "too-large",
                "The request's headers are too large.",
            ));
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|_| invalid("The request ended early."))?;
        if read == 0 {
            return Err(invalid("The request ended early."));
        }
        bytes.extend_from_slice(&chunk[..read]);
    };
    if end > MAX_HEADER_BYTES {
        return Err(Refusal(
            431,
            "too-large",
            "The request's headers are too large.",
        ));
    }
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut headers);
    match parsed.parse(&bytes[..end]) {
        Ok(httparse::Status::Complete(_)) => {}
        _ => return Err(invalid("The request is not HTTP/1.1.")),
    }
    let method = parsed.method.unwrap_or_default().to_owned();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err(Refusal(
            405,
            "method-not-allowed",
            "dx serves GET, POST, PUT, PATCH, and DELETE.",
        ));
    }
    let path = parsed.path.unwrap_or_default().to_owned();
    if !path.starts_with('/') || path.len() > 2048 {
        return Err(invalid("The path must start with /."));
    }
    let mut length = None;
    let mut token = None;
    for header in parsed.headers.iter() {
        let value = std::str::from_utf8(header.value).unwrap_or_default().trim();
        if header.name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(invalid("The request has two lengths."));
            }
            length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| invalid("The length is invalid."))?,
            );
        } else if header.name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(Refusal(
                411,
                "length-required",
                "Send the body with Content-Length.",
            ));
        } else if header.name.eq_ignore_ascii_case("authorization") {
            token = value
                .strip_prefix("Bearer ")
                .map(|token| token.trim().to_owned());
        }
    }
    let length = length.unwrap_or(0);
    if length > MAX_BODY_BYTES {
        return Err(Refusal(413, "too-large", "The body is larger than 1 MiB."));
    }
    let mut body = bytes.split_off(end);
    if body.len() > length {
        return Err(invalid("The request carries more than its length."));
    }
    while body.len() < length {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| invalid("The body ended early."))?;
        if read == 0 {
            return Err(invalid("The body ended early."));
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > length {
            return Err(invalid("The request carries more than its length."));
        }
    }
    let body = if body.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|_| invalid("The body is not JSON."))?
    };
    Ok(Request {
        method,
        path,
        token,
        body,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

fn write_response(stream: &mut TcpStream, status: u16, body: &Value) -> io::Result<()> {
    // Core's status is relayed as it is; one HTTP cannot carry is a 502.
    let (status, body) = if (200..=599).contains(&status) {
        (status, body.clone())
    } else {
        (
            502,
            json!({"error": {"code": "invalid-response", "message": "dx answered with an invalid status."}}),
        )
    };
    let bytes = if matches!(status, 204 | 304) {
        Vec::new()
    } else {
        serde_json::to_vec(&body).map_err(|_| io::ErrorKind::InvalidData)?
    };
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        reason(status),
        bytes.len(),
    )?;
    stream.write_all(&bytes)
}

fn write_error(stream: &mut TcpStream, status: u16, code: &str, message: &str) -> io::Result<()> {
    write_response(
        stream,
        status,
        &json!({"error": {"code": code, "message": message}}),
    )
}
