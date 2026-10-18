//! End-to-end proxy test: the real `dxd` binary registers with a mock Core,
//! which opens HTTP and WebSocket streams to real loopback services exactly
//! as the Thread execution Durable Object does for Portals and the Desktop.
//!
//! Failure modes covered: request framing to the upstream (method, target,
//! headers, hop-by-hop removal, chunked request bodies), every response
//! framing (chunked with trailers, content length, close-delimited, empty),
//! the per-stream acknowledgement window, an unreachable port, a service
//! listening on IPv6 loopback only, an abandoned exchange, WebSocket
//! subprotocol selection, text and binary messages, closes from either side,
//! port listing, and the Desktop in a guest without one.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

const DXD: &str = env!("CARGO_BIN_EXE_dxd");
const THREAD_ID: &str = "thr_0123abcd-4567-4abc-8def-0123456789ab";
const WINDOW: usize = 16;

struct Fixture {
    _root: tempfile::TempDir,
    config: PathBuf,
    state: PathBuf,
}

fn fixture(port: u16) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let repo = home.join("workspace/repo");
    let state = root.path().join("runtime");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    for directory in [&home, &state] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let status = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .arg(&repo)
        .status()
        .unwrap();
    assert!(status.success());
    let config = root.path().join("config.json");
    std::fs::write(
        &config,
        json!({
            "version": 2,
            "endpoint": format!("ws://127.0.0.1:{port}/v1/threads/{THREAD_ID}/dxd"),
            "threadId": THREAD_ID,
            "apiKey": "dxd_integration-test-key-0123456789",
            "workspaceRoot": repo.to_str().unwrap(),
            "localRuntime": {
                "homeDirectory": home.to_str().unwrap(),
                "stateDirectory": state.to_str().unwrap(),
            }
        })
        .to_string(),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    Fixture {
        _root: root,
        config,
        state,
    }
}

struct DaemonGuard(Child);

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_daemon(fixture: &Fixture) -> DaemonGuard {
    DaemonGuard(
        Command::new(DXD)
            .arg("--config")
            .arg(&fixture.config)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("USER", "user")
            .env(
                "DX_WORKLOAD_IDENTITY_SOCKET",
                fixture.state.join("workload-identity.sock"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}

async fn connect_daemon() -> (Fixture, DaemonGuard, Socket, String) {
    let core = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = fixture(core.local_addr().unwrap().port());
    let daemon = spawn_daemon(&fixture);
    let (stream, _) = tokio::time::timeout(Duration::from_secs(20), core.accept())
        .await
        .expect("daemon connected")
        .unwrap();
    stream.set_nodelay(true).unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let register = next_text(&mut socket).await;
    assert_eq!(register["type"], "register");
    assert_eq!(register["capabilities"]["proxy"]["version"], 1);
    let generation = format!("gen-{}", rand::random::<u32>());
    send(
        &mut socket,
        json!({
            "type": "registered",
            "generation": generation,
            "heartbeatIntervalMs": 2000,
            "heartbeatLeaseMs": 15000,
        }),
    )
    .await;
    (fixture, daemon, socket, generation)
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn send_frame(socket: &mut Socket, stream: u32, kind: u8, payload: &[u8]) {
    let mut frame = b"DXP1".to_vec();
    frame.extend_from_slice(&stream.to_be_bytes());
    frame.extend_from_slice(&[kind, 0, 0, 0]);
    frame.extend_from_slice(payload);
    socket.send(Message::Binary(frame.into())).await.unwrap();
}

enum Event {
    Text(Value),
    Data(u32, u8, Vec<u8>),
}

/// The next proxy message, skipping heartbeats, dirty hints, and pings.
async fn next_event(socket: &mut Socket) -> Event {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .expect("frame within 20s")
            .expect("socket open")
            .unwrap();
        match message {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if matches!(value["type"].as_str(), Some("heartbeat" | "changes-dirty")) {
                    continue;
                }
                return Event::Text(value);
            }
            Message::Binary(bytes) => {
                assert_eq!(&bytes[..4], b"DXP1");
                assert_eq!(&bytes[9..12], &[0, 0, 0]);
                let stream = u32::from_be_bytes(bytes[4..8].try_into().unwrap());
                return Event::Data(stream, bytes[8], bytes[12..].to_vec());
            }
            Message::Ping(data) => socket.send(Message::Pong(data)).await.unwrap(),
            Message::Close(_) => panic!("daemon closed the socket"),
            _ => {}
        }
    }
}

async fn next_text(socket: &mut Socket) -> Value {
    loop {
        if let Event::Text(value) = next_event(socket).await {
            return value;
        }
    }
}

/// Collect one HTTP stream: its response head and body, acknowledging every
/// body frame as Core does.
async fn collect_http(socket: &mut Socket, stream: u32) -> (Value, Vec<u8>) {
    let mut head = None;
    let mut body = Vec::new();
    loop {
        match next_event(socket).await {
            Event::Text(value) if value["streamId"] == stream => match value["type"].as_str() {
                Some("proxy.response") => head = Some(value),
                Some("proxy.end") => return (head.expect("response before end"), body),
                other => panic!("unexpected {other:?}: {value}"),
            },
            Event::Text(_) => {}
            Event::Data(id, kind, payload) => {
                assert_eq!((id, kind), (stream, 0));
                assert!(head.is_some(), "body before head");
                body.extend_from_slice(&payload);
                send(socket, json!({"type": "proxy.ack", "streamId": stream})).await;
            }
        }
    }
}

fn header<'a>(head: &'a Value, name: &str) -> Option<&'a str> {
    head["headers"].as_array().unwrap().iter().find_map(|pair| {
        (pair[0].as_str().unwrap().eq_ignore_ascii_case(name)).then(|| pair[1].as_str().unwrap())
    })
}

/// A one-shot HTTP service: it records the raw request it read and writes
/// `response` verbatim, then closes.
async fn upstream(
    listener: TcpListener,
    response: &'static [u8],
) -> tokio::task::JoinHandle<Vec<u8>> {
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 8192];
        // Read the head, then any chunked body through its last chunk.
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request);
            if let Some(end) = text.find("\r\n\r\n") {
                let head = &text[..end].to_ascii_lowercase();
                if !head.contains("transfer-encoding: chunked") || text.ends_with("0\r\n\r\n") {
                    break;
                }
            }
            if read == 0 {
                break;
            }
        }
        stream.write_all(response).await.unwrap();
        stream.shutdown().await.unwrap();
        request
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_relays_http_exchanges_with_every_framing() {
    let (_fixture, _daemon, mut socket, generation) = connect_daemon().await;

    // Chunked response with a trailer; request headers pass through, and
    // hop-by-hop ones are replaced by `Connection: close`.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = upstream(
        listener,
        b"HTTP/1.1 200 OK\r\nX-Test: one\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n6\r\nhello \r\n5;ext=1\r\nworld\r\n0\r\nX-Trailer: t\r\n\r\n",
    )
    .await;
    send(
        &mut socket,
        json!({
            "type": "proxy.open", "streamId": 1, "port": port, "mode": "http",
            "method": "GET", "target": "/hello?x=1&y=%20",
            "headers": [["Host", "t-x-p1.portal.test"], ["Connection", "keep-alive"], ["X-Forwarded-Proto", "https"]],
            "body": false
        }),
    )
    .await;
    let (head, body) = collect_http(&mut socket, 1).await;
    assert_eq!(head["status"], 200);
    assert_eq!(header(&head, "x-test"), Some("one"));
    assert_eq!(header(&head, "transfer-encoding"), None);
    assert_eq!(header(&head, "connection"), None);
    assert_eq!(body, b"hello world");
    let request = String::from_utf8(served.await.unwrap()).unwrap();
    assert!(
        request.starts_with("GET /hello?x=1&y=%20 HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(request.contains("Host: t-x-p1.portal.test\r\n"));
    assert!(request.contains("X-Forwarded-Proto: https\r\n"));
    assert!(request.contains("Connection: close\r\n"));
    assert!(!request.contains("keep-alive"));

    // A request body of unknown length goes upstream chunked; dxd
    // acknowledges each frame it writes. The response has a length.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = upstream(
        listener,
        b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok",
    )
    .await;
    send(
        &mut socket,
        json!({
            "type": "proxy.open", "streamId": 2, "port": port, "mode": "http",
            "method": "POST", "target": "/echo",
            "headers": [["Content-Type", "text/plain"]], "body": true
        }),
    )
    .await;
    send_frame(&mut socket, 2, 0, b"abc").await;
    send_frame(&mut socket, 2, 0, b"defg").await;
    send(&mut socket, json!({"type": "proxy.end", "streamId": 2})).await;
    let mut acks = 0;
    let mut head = None;
    let mut body = Vec::new();
    loop {
        match next_event(&mut socket).await {
            Event::Text(value) => match value["type"].as_str() {
                Some("proxy.ack") => acks += 1,
                Some("proxy.response") => head = Some(value),
                Some("proxy.end") => break,
                other => panic!("unexpected {other:?}"),
            },
            Event::Data(2, 0, payload) => {
                body.extend_from_slice(&payload);
                send(&mut socket, json!({"type": "proxy.ack", "streamId": 2})).await;
            }
            Event::Data(..) => panic!("frame for another stream"),
        }
    }
    assert_eq!(acks, 2);
    assert_eq!(head.unwrap()["status"], 201);
    assert_eq!(body, b"ok");
    let request = String::from_utf8(served.await.unwrap()).unwrap();
    assert!(request.contains("Transfer-Encoding: chunked\r\n"));
    assert!(
        request.ends_with("\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n"),
        "{request}"
    );

    // A close-delimited body (no length, not chunked) ends at EOF, and an
    // interim 100 Continue is skipped.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _served = upstream(
        listener,
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: 1\n\ndata: 2\n\n",
    )
    .await;
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 3, "port": port, "mode": "http",
               "method": "GET", "target": "/events", "headers": [], "body": false}),
    )
    .await;
    let (head, body) = collect_http(&mut socket, 3).await;
    assert_eq!(head["status"], 200);
    assert_eq!(body, b"data: 1\n\ndata: 2\n\n");

    // HEAD has no body even with a length.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _served = upstream(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n").await;
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 4, "port": port, "mode": "http",
               "method": "HEAD", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let (head, body) = collect_http(&mut socket, 4).await;
    assert_eq!(header(&head, "content-length"), Some("999"));
    assert!(body.is_empty());

    // Nothing listens: the stream fails, the session stays.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 5, "port": port, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let error = next_text(&mut socket).await;
    assert_eq!(
        error,
        json!({"type": "proxy.error", "streamId": 5, "reason": "upstream-unreachable"})
    );

    // A service bound to IPv6 loopback alone is still reached.
    if let Ok(listener) = TcpListener::bind("[::1]:0").await {
        let port = listener.local_addr().unwrap().port();
        let _served = upstream(listener, b"HTTP/1.1 204 No Content\r\n\r\n").await;
        send(
            &mut socket,
            json!({"type": "proxy.open", "streamId": 6, "port": port, "mode": "http",
                   "method": "GET", "target": "/", "headers": [], "body": false}),
        )
        .await;
        let (head, body) = collect_http(&mut socket, 6).await;
        assert_eq!(head["status"], 204);
        assert!(body.is_empty());
    }

    // The port list names this test's own listener.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    send(
        &mut socket,
        json!({"type": "request", "generation": generation, "requestId": "ports-1",
               "operation": {"operation": "proxy.ports"}}),
    )
    .await;
    let response = next_text(&mut socket).await;
    assert_eq!(response["requestId"], "ports-1");
    assert_eq!(response["result"]["kind"], "ports");
    assert!(
        response["result"]["ports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["port"] == port && entry["address"] == "127.0.0.1"),
        "{response}"
    );
    drop(listener);

    // A local guest has no Desktop.
    send(
        &mut socket,
        json!({"type": "request", "generation": generation, "requestId": "desktop-1",
               "operation": {"operation": "desktop.ensure"}}),
    )
    .await;
    let response = next_text(&mut socket).await;
    assert_eq!(response["requestId"], "desktop-1");
    assert_eq!(
        response["result"],
        json!({"kind": "unavailable", "reason": "unsupported"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_bounds_unacknowledged_frames_and_abandons_on_close() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;

    // 40 chunks of 256 KiB: dxd stops at the window until Core acknowledges.
    static BIG: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let size = 40 * 256 * 1024;
    let response = BIG.get_or_init(|| {
        let mut response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\n\r\n").into_bytes();
        response.extend((0..size).map(|index| (index % 251) as u8));
        response
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _served = upstream(listener, response.as_slice()).await;
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 9, "port": port, "mode": "http",
               "method": "GET", "target": "/big", "headers": [], "body": false}),
    )
    .await;
    let mut unacknowledged = Vec::new();
    let mut received = Vec::with_capacity(size);
    loop {
        // Hold acknowledgements until the daemon stalls at the window.
        let event = tokio::time::timeout(Duration::from_millis(500), next_event(&mut socket)).await;
        match event {
            Ok(Event::Text(value)) if value["type"] == "proxy.response" => {}
            Ok(Event::Text(value)) if value["type"] == "proxy.end" => break,
            Ok(Event::Text(value)) => panic!("unexpected {value}"),
            Ok(Event::Data(9, 0, payload)) => {
                received.extend_from_slice(&payload);
                unacknowledged.push(());
                assert!(unacknowledged.len() <= WINDOW, "window exceeded");
            }
            Ok(Event::Data(..)) => panic!("frame for another stream"),
            Err(_) => {
                assert_eq!(unacknowledged.len(), WINDOW, "stalled below the window");
                for _ in unacknowledged.drain(..) {
                    send(&mut socket, json!({"type": "proxy.ack", "streamId": 9})).await;
                }
            }
        }
    }
    assert_eq!(received.len(), size);
    assert!(
        received
            .iter()
            .enumerate()
            .all(|(index, byte)| *byte == (index % 251) as u8)
    );

    // A service that never answers: Core abandons the exchange, dxd drops
    // the upstream connection, and the session goes on serving other streams.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    let hold = tokio::spawn(async move {
        let (mut stream, _) = silent.accept().await.unwrap();
        // Read the request, then wait for dxd to hang up.
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut buffer = [0_u8; 4096];
            while stream.read(&mut buffer).await.is_ok_and(|read| read > 0) {}
        })
        .await
        .is_ok()
    });
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 10, "port": silent_port, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    send(
        &mut socket,
        json!({"type": "proxy.close", "streamId": 10, "code": null, "reason": null}),
    )
    .await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _served = upstream(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx").await;
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 11, "port": port, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let (head, body) = collect_http(&mut socket, 11).await;
    assert_eq!(head["status"], 200);
    assert_eq!(body, b"x");
    assert!(
        hold.await.unwrap(),
        "the abandoned exchange kept its upstream connection"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_relays_websockets_with_subprotocols_and_closes() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let seen = seen_tx.clone();
            tokio::spawn(async move {
                let mut offered = String::new();
                let mut path = String::new();
                let mut cookie = String::new();
                let mut host = String::new();
                let mut handshake = String::new();
                let mut websocket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        path = request.uri().to_string();
                        offered = request
                            .headers()
                            .get("sec-websocket-protocol")
                            .map(|value| value.to_str().unwrap().to_owned())
                            .unwrap_or_default();
                        cookie = request
                            .headers()
                            .get("cookie")
                            .map(|value| value.to_str().unwrap().to_owned())
                            .unwrap_or_default();
                        let all = |name: &str| {
                            request
                                .headers()
                                .get_all(name)
                                .iter()
                                .map(|value| value.to_str().unwrap())
                                .collect::<Vec<_>>()
                                .join(";")
                        };
                        host = all("host");
                        let key = all("sec-websocket-key");
                        handshake = format!(
                            "{}|{}|{}",
                            !key.is_empty() && !key.contains(';') && key != "ignored",
                            all("sec-websocket-version"),
                            all("sec-websocket-extensions"),
                        );
                        if offered.split(',').any(|protocol| protocol.trim() == "waymote") {
                            response
                                .headers_mut()
                                .insert("sec-websocket-protocol", "waymote".parse().unwrap());
                        }
                        Ok(response)
                    },
                )
                .await
                .unwrap();
                seen.send(format!("{path}|{offered}|{cookie}|{host}|{handshake}"))
                    .unwrap();
                while let Some(Ok(message)) = websocket.next().await {
                    match message {
                        Message::Text(text) if text.as_str() == "close-me" => {
                            websocket
                                .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                    code: 4000.into(),
                                    reason: "bye".into(),
                                }))
                                .await
                                .unwrap();
                        }
                        Message::Text(_) | Message::Binary(_) => {
                            websocket.send(message).await.unwrap();
                        }
                        Message::Close(frame) => {
                            seen.send(format!(
                                "closed {}",
                                frame.map_or(0, |frame| u16::from(frame.code))
                            ))
                            .unwrap();
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
    });

    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 21, "port": port, "mode": "websocket",
               "method": "GET", "target": "/stream?x=1",
               "headers": [["Host", "t-0-p5173.portal.example"], ["Cookie", "app=1"],
                           ["Sec-WebSocket-Key", "ignored"], ["Sec-WebSocket-Version", "8"],
                           ["Sec-WebSocket-Extensions", "permessage-deflate"],
                           ["Upgrade", "websocket"]],
               "protocols": ["other", "waymote"], "body": false}),
    )
    .await;
    let accepted = next_text(&mut socket).await;
    assert_eq!(
        accepted,
        json!({"type": "proxy.accepted", "streamId": 21, "protocol": "waymote"})
    );
    assert_eq!(
        seen_rx.recv().await.unwrap(),
        "/stream?x=1|other, waymote|app=1|t-0-p5173.portal.example|true|13|"
    );

    send_frame(&mut socket, 21, 1, "héllo".as_bytes()).await;
    send_frame(&mut socket, 21, 0, &[0, 1, 2, 255]).await;
    let mut acks = 0;
    let mut echoes = Vec::new();
    while echoes.len() < 2 || acks < 2 {
        match next_event(&mut socket).await {
            Event::Text(value) if value["type"] == "proxy.ack" => acks += 1,
            Event::Text(value) => panic!("unexpected {value}"),
            Event::Data(21, kind, payload) => {
                echoes.push((kind, payload));
                send(&mut socket, json!({"type": "proxy.ack", "streamId": 21})).await;
            }
            Event::Data(..) => panic!("frame for another stream"),
        }
    }
    assert_eq!(
        echoes,
        vec![(1, "héllo".as_bytes().to_vec()), (0, vec![0, 1, 2, 255])]
    );

    // The service closes with its own code and reason.
    send_frame(&mut socket, 21, 1, b"close-me").await;
    let closed = loop {
        let value = next_text(&mut socket).await;
        if value["type"] != "proxy.ack" {
            break value;
        }
    };
    assert_eq!(
        closed,
        json!({"type": "proxy.closed", "streamId": 21, "code": 4000, "reason": "bye"})
    );

    // Core closes a second socket; the service sees the code.
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 22, "port": port, "mode": "websocket",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let accepted = next_text(&mut socket).await;
    assert_eq!(
        accepted,
        json!({"type": "proxy.accepted", "streamId": 22, "protocol": null})
    );
    // Without a Host in the open, the guest sees the loopback authority.
    assert_eq!(
        seen_rx.recv().await.unwrap(),
        format!("/|||127.0.0.1:{port}|true|13|")
    );
    send(
        &mut socket,
        json!({"type": "proxy.close", "streamId": 22, "code": 1001, "reason": "gone"}),
    )
    .await;
    assert_eq!(seen_rx.recv().await.unwrap(), "closed 1001");
}

/// The stream's `proxy.error` reason, skipping other streams' messages.
async fn stream_error(socket: &mut Socket, stream: u32) -> String {
    loop {
        match next_event(socket).await {
            Event::Text(value) if value["streamId"] == stream && value["type"] != "proxy.ack" => {
                assert_eq!(value["type"], "proxy.error", "{value}");
                return value["reason"].as_str().unwrap().to_owned();
            }
            _ => {}
        }
    }
}

/// One GET that must succeed: the session still serves streams.
async fn assert_serves(socket: &mut Socket, stream: u32) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _served = upstream(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;
    send(
        socket,
        json!({"type": "proxy.open", "streamId": stream, "port": port, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let (head, body) = collect_http(socket, stream).await;
    assert_eq!(head["status"], 200);
    assert_eq!(body, b"ok");
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_fails_only_the_stream_for_requests_beyond_the_shared_bounds() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    let invalid = [
        // A header value with a line break would smuggle a second header.
        json!({"method": "GET", "headers": [["X-A", "1\r\nX-B: 2"]]}),
        json!({"method": "GET", "headers": (0..129).map(|index| json!([format!("x-{index}"), "1"])).collect::<Vec<_>>()}),
        json!({"method": "GET", "headers": [["X-Big", "v".repeat(16 * 1024 + 1)]]}),
        json!({"method": "GET", "headers": (0..5).map(|index| json!([format!("x-{index}"), "v".repeat(16 * 1024)])).collect::<Vec<_>>()}),
        json!({"method": "GET", "headers": [["Bad Name", "1"]]}),
        json!({"method": "GE(T", "headers": []}),
        json!({"method": "SEVENTEEN-LETTERS", "headers": []}),
        json!({"method": "", "headers": []}),
    ];
    for (index, request) in invalid.iter().enumerate() {
        let stream = 1 + index as u32;
        send(
            &mut socket,
            json!({"type": "proxy.open", "streamId": stream, "port": 80, "mode": "http",
                   "method": request["method"], "target": "/", "headers": request["headers"],
                   "body": false}),
        )
        .await;
        assert_eq!(
            stream_error(&mut socket, stream).await,
            "invalid-request",
            "{request}"
        );
    }
    // Seventeen subprotocols, a WebSocket that is not a GET, port 0.
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 20, "port": 80, "mode": "websocket",
               "method": "GET", "target": "/", "headers": [],
               "protocols": (0..17).map(|index| format!("p{index}")).collect::<Vec<_>>(),
               "body": false}),
    )
    .await;
    assert_eq!(stream_error(&mut socket, 20).await, "invalid-request");
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 21, "port": 80, "mode": "websocket",
               "method": "POST", "target": "/", "headers": [], "body": false}),
    )
    .await;
    assert_eq!(stream_error(&mut socket, 21).await, "invalid-request");
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 22, "port": 0, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    assert_eq!(stream_error(&mut socket, 22).await, "invalid-request");

    // Any RFC 9110 token is a method, case and all: fetch passes `patch`
    // through unchanged.
    for (stream, method) in [(30, "patch"), (31, "M-SEARCH"), (32, "PROPFIND")] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = upstream(listener, b"HTTP/1.1 204 No Content\r\n\r\n").await;
        send(
            &mut socket,
            json!({"type": "proxy.open", "streamId": stream, "port": port, "mode": "http",
                   "method": method, "target": "/", "headers": [], "body": false}),
        )
        .await;
        let (head, _) = collect_http(&mut socket, stream).await;
        assert_eq!(head["status"], 204);
        let request = String::from_utf8(served.await.unwrap()).unwrap();
        assert!(request.starts_with(&format!("{method} / HTTP/1.1\r\n")));
    }
    assert_serves(&mut socket, 40).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_ends_the_session_only_for_messages_core_never_sends() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    // Stream 0 cannot be answered: it names no stream.
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 0, "port": 80, "mode": "http",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(
        ended.is_ok(),
        "daemon kept a session that sent an invalid stream"
    );
}

async fn ensure_services(
    socket: &mut Socket,
    generation: &str,
    id: &str,
    services: Value,
) -> Value {
    send(
        socket,
        json!({"type": "request", "generation": generation, "requestId": id,
               "operation": {"operation": "services.ensure", "services": services}}),
    )
    .await;
    loop {
        let value = next_text(socket).await;
        if value["type"] == "response" && value["requestId"] == id {
            return value["result"].clone();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn declared_services_start_on_demand_and_come_back_after_exit() {
    let (fixture, _daemon, mut socket, generation) = connect_daemon().await;
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(&fixture.config).unwrap()).unwrap();
    let repo = PathBuf::from(config["workspaceRoot"].as_str().unwrap());
    std::fs::create_dir_all(repo.join("site")).unwrap();
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    };
    // The service records its PID (so the test can stop it), proves it got
    // its environment and working directory, then serves that directory.
    let services = json!([{
        "name": "web",
        "command": "echo $$ > ../web.pid; printf '%s:%s' \"$GREETING\" \"$PORT\" > greeting.txt; exec python3 -m http.server \"$PORT\" --bind 127.0.0.1",
        "cwd": "site",
        "port": port,
        "env": {"GREETING": "hello"}
    }]);
    let result = ensure_services(&mut socket, &generation, "svc-1", services.clone()).await;
    assert_eq!(
        result,
        json!({"kind": "services", "services": [{"name": "web", "state": "started"}]})
    );

    let mut stream = 100;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let body = loop {
        stream += 1;
        if let Some(body) = serve_greeting(&mut socket, stream, port).await {
            break body;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "service never listened"
        );
        let again = ensure_services(
            &mut socket,
            &generation,
            &format!("svc-{stream}"),
            services.clone(),
        )
        .await;
        assert_eq!(again["services"][0]["state"], "starting");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(String::from_utf8(body).unwrap(), format!("hello:{port}"));
    let result = ensure_services(&mut socket, &generation, "svc-running", services.clone()).await;
    assert_eq!(result["services"][0]["state"], "running");
    // More listeners than a port listing names, all on lower ports: the
    // service is still found listening.
    let crowd: Vec<_> = (20_000..20_400)
        .filter_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
        .take(70)
        .collect();
    assert_eq!(crowd.len(), 70);
    assert!(port > 20_400);
    let result = ensure_services(&mut socket, &generation, "svc-crowded", services.clone()).await;
    assert_eq!(result["services"][0]["state"], "running");
    drop(crowd);

    // The service exits (a crash, or a provider that restored only files):
    // dxd reaps it without being asked, and the next request starts it again.
    let pid: i32 = std::fs::read_to_string(repo.join("web.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::path::Path::new(&format!("/proc/{pid}")).exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the exited service stayed a zombie"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let restarted = loop {
        let result =
            ensure_services(&mut socket, &generation, "svc-after-exit", services.clone()).await;
        let state = result["services"][0]["state"].as_str().unwrap().to_owned();
        if state != "running" && state != "starting" {
            break state;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "exit never noticed: {state}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(restarted, "started");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let pid: i32 = std::fs::read_to_string(repo.join("web.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe { libc::kill(-pid, libc::SIGKILL) };
}

/// The body of an HTTP stream whose head has already arrived.
async fn collect_rest(socket: &mut Socket, stream: u32, head: Value) -> (Value, Vec<u8>) {
    let mut body = Vec::new();
    loop {
        match next_event(socket).await {
            Event::Text(value) if value["streamId"] == stream && value["type"] == "proxy.end" => {
                return (head, body);
            }
            Event::Text(_) => {}
            Event::Data(id, _, payload) => {
                assert_eq!(id, stream);
                body.extend_from_slice(&payload);
                send(socket, json!({"type": "proxy.ack", "streamId": stream})).await;
            }
        }
    }
}

/// One GET of the service's greeting; `None` while nothing listens.
async fn serve_greeting(socket: &mut Socket, stream: u32, port: u16) -> Option<Vec<u8>> {
    send(
        socket,
        json!({"type": "proxy.open", "streamId": stream, "port": port, "mode": "http",
               "method": "GET", "target": "/greeting.txt", "headers": [], "body": false}),
    )
    .await;
    loop {
        match next_event(socket).await {
            Event::Text(value) if value["type"] == "proxy.error" => return None,
            Event::Text(value) if value["type"] == "proxy.response" => {
                assert_eq!(value["status"], 200);
                return Some(collect_rest(socket, stream, value).await.1);
            }
            Event::Text(_) => {}
            Event::Data(..) => panic!("data before head"),
        }
    }
}

/// A WebSocket service that accepts one connection, then behaves as `serve`
/// says, reporting what it saw.
async fn websocket_service<F, Fut>(serve: F) -> (u16, tokio::task::JoinHandle<Vec<String>>)
where
    F: FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Vec<String>> + Send,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let websocket = tokio_tungstenite::accept_async(stream).await.unwrap();
        serve(websocket).await
    });
    (port, task)
}

async fn open_websocket(socket: &mut Socket, stream: u32, port: u16) {
    send(
        socket,
        json!({"type": "proxy.open", "streamId": stream, "port": port, "mode": "websocket",
               "method": "GET", "target": "/", "headers": [], "body": false}),
    )
    .await;
    loop {
        let accepted = next_text(socket).await;
        if accepted["streamId"] == stream {
            assert_eq!(accepted["type"], "proxy.accepted", "{accepted}");
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_holds_browser_bursts_to_the_window_and_fails_only_an_overrun_stream() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;

    // Within the window, 100 messages reach a guest that reads slowly, in
    // order, each acknowledged once written.
    let (port, service) = websocket_service(|mut websocket| async move {
        let mut seen = Vec::new();
        while seen.len() < 100 {
            match websocket.next().await {
                Some(Ok(Message::Text(text))) => seen.push(text.to_string()),
                Some(Ok(_)) => {}
                _ => break,
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        seen
    })
    .await;
    open_websocket(&mut socket, 1, port).await;
    let mut sent = 0;
    let mut unacknowledged = 0;
    while sent < 100 || unacknowledged > 0 {
        while unacknowledged < WINDOW && sent < 100 {
            send_frame(&mut socket, 1, 1, format!("m{sent}").as_bytes()).await;
            sent += 1;
            unacknowledged += 1;
        }
        let ack = next_text(&mut socket).await;
        assert_eq!(ack, json!({"type": "proxy.ack", "streamId": 1}));
        unacknowledged -= 1;
    }
    assert_eq!(
        service.await.unwrap(),
        (0..100)
            .map(|index| format!("m{index}"))
            .collect::<Vec<_>>()
    );

    // A burst beyond the window to a guest that never reads fails that
    // stream, not the session.
    let (port, _service) = websocket_service(|websocket| async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(websocket);
        Vec::new()
    })
    .await;
    open_websocket(&mut socket, 2, port).await;
    let payload = vec![b'x'; 64 * 1024];
    for _ in 0..100 {
        send_frame(&mut socket, 2, 0, &payload).await;
    }
    assert_eq!(stream_error(&mut socket, 2).await, "invalid-request");
    assert_serves(&mut socket, 3).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_ignores_frames_and_ends_for_a_stream_that_already_finished() {
    let (_fixture, _daemon, mut socket, generation) = connect_daemon().await;
    // A stream fails (a text frame in an HTTP body) while Core's next
    // messages are already queued behind enough other traffic that the
    // daemon reads them after the stream's task returned but before it
    // forgets the stream.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _held = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        drop(stream);
    });
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 1, "port": port, "mode": "http",
               "method": "POST", "target": "/", "headers": [], "body": true}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut batch = vec![{
        let mut frame = b"DXP1".to_vec();
        frame.extend_from_slice(&1_u32.to_be_bytes());
        frame.extend_from_slice(&[1, 0, 0, 0]);
        frame.extend_from_slice(b"text in a body");
        Message::Binary(frame.into())
    }];
    for index in 0..400 {
        batch.push(Message::Text(
            json!({"type": "readiness-ping", "generation": generation,
                   "requestId": format!("ping-{index}")})
            .to_string()
            .into(),
        ));
    }
    let mut late = b"DXP1".to_vec();
    late.extend_from_slice(&1_u32.to_be_bytes());
    late.extend_from_slice(&[0, 0, 0, 0, b'x']);
    batch.push(Message::Binary(late.into()));
    batch.push(Message::Text(
        json!({"type": "proxy.end", "streamId": 1})
            .to_string()
            .into(),
    ));
    for message in batch {
        socket.feed(message).await.unwrap();
    }
    socket.flush().await.unwrap();
    assert_eq!(stream_error(&mut socket, 1).await, "invalid-request");

    for round in 0..20_u32 {
        // The guest closes as soon as it accepts; Core's frames, sent while
        // the stream ends, race its end.
        let (port, _service) = websocket_service(|mut websocket| async move {
            let _ = websocket.close(None).await;
            Vec::new()
        })
        .await;
        let stream = 100 + round;
        open_websocket(&mut socket, stream, port).await;
        for index in 0..WINDOW {
            send_frame(&mut socket, stream, 0, &[index as u8]).await;
        }
        send(
            &mut socket,
            json!({"type": "proxy.end", "streamId": stream}),
        )
        .await;
        send(
            &mut socket,
            json!({"type": "proxy.close", "streamId": stream, "code": 1000, "reason": null}),
        )
        .await;
        // An HTTP stream that has finished takes a late frame and end too.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = listener.local_addr().unwrap().port();
        let _served = upstream(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
        let http_stream = 1000 + round;
        send(
            &mut socket,
            json!({"type": "proxy.open", "streamId": http_stream, "port": http_port, "mode": "http",
                   "method": "POST", "target": "/", "headers": [["Content-Length", "1"]], "body": true}),
        )
        .await;
        send_frame(&mut socket, http_stream, 0, b"x").await;
        send(
            &mut socket,
            json!({"type": "proxy.end", "streamId": http_stream}),
        )
        .await;
        loop {
            match next_event(&mut socket).await {
                Event::Text(value)
                    if value["streamId"] == http_stream && value["type"] == "proxy.end" =>
                {
                    break;
                }
                _ => {}
            }
        }
        send_frame(&mut socket, http_stream, 0, b"late").await;
        send(
            &mut socket,
            json!({"type": "proxy.end", "streamId": http_stream}),
        )
        .await;
        send(
            &mut socket,
            json!({"type": "proxy.ack", "streamId": http_stream}),
        )
        .await;
    }
    assert_serves(&mut socket, 5000).await;
}

/// A one-shot service that answers with `response` without reading the
/// request.
async fn answering(response: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0_u8; 4096];
        let _ = stream.read(&mut buffer).await;
        let _ = stream.write_all(&response).await;
        let _ = stream.shutdown().await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_refuses_response_heads_core_cannot_take() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    let long_name = "n".repeat(300);
    let long_value = "v".repeat(16 * 1024 + 1);
    // Every byte becomes U+FFFD (three bytes) in the JSON Core reads.
    let mut opaque = b"HTTP/1.1 200 OK\r\n".to_vec();
    for index in 0..4 {
        opaque.extend_from_slice(format!("X-Opaque-{index}: ").as_bytes());
        opaque.extend(std::iter::repeat_n(0xff_u8, 12 * 1024));
        opaque.extend_from_slice(b"\r\n");
    }
    opaque.extend_from_slice(b"Content-Length: 0\r\n\r\n");
    let heads = [
        b"HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 600 Odd\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n".to_vec(),
        format!("HTTP/1.1 200 OK\r\n{long_name}: 1\r\nContent-Length: 0\r\n\r\n").into_bytes(),
        format!("HTTP/1.1 200 OK\r\nX-Long: {long_value}\r\nContent-Length: 0\r\n\r\n")
            .into_bytes(),
        opaque,
    ];
    for (index, head) in heads.into_iter().enumerate() {
        let stream = 1 + index as u32;
        let port = answering(head).await;
        send(
            &mut socket,
            json!({"type": "proxy.open", "streamId": stream, "port": port, "mode": "http",
                   "method": "GET", "target": "/", "headers": [], "body": false}),
        )
        .await;
        assert_eq!(stream_error(&mut socket, stream).await, "invalid-response");
    }

    // A WebSocket guest may only choose a subprotocol the browser offered.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = tokio_tungstenite::accept_hdr_async(
            stream,
            |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
             mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", "unoffered".parse().unwrap());
                Ok(response)
            },
        )
        .await;
    });
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 10, "port": port, "mode": "websocket",
               "method": "GET", "target": "/", "headers": [], "protocols": ["offered"],
               "body": false}),
    )
    .await;
    let reason = stream_error(&mut socket, 10).await;
    assert!(
        reason == "invalid-response" || reason == "upstream-rejected",
        "{reason}"
    );
    assert_serves(&mut socket, 11).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_closes_a_websocket_whose_guest_streams_past_the_window() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    // The guest streams without end; Core stops acknowledging (its browser
    // left) and closes the stream. The guest must see the close.
    let (port, service) = websocket_service(|websocket| async move {
        let mut index = 0_u64;
        let (mut sink, mut stream) = websocket.split();
        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                tokio::select! {
                    message = stream.next() => match message {
                        Some(Ok(Message::Close(frame))) => {
                            return format!("closed {}", frame.map_or(0, |frame| u16::from(frame.code)));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return "dropped".to_owned(),
                    },
                    result = sink.send(Message::Text(format!("tick {index}").into())) => {
                        if result.is_err() {
                            return "dropped".to_owned();
                        }
                        index += 1;
                    }
                }
            }
        })
        .await;
        vec![outcome.unwrap_or_else(|_| "never closed".to_owned())]
    })
    .await;
    open_websocket(&mut socket, 1, port).await;
    let mut received = 0;
    while received < WINDOW {
        if let Event::Data(1, 1, _) = next_event(&mut socket).await {
            received += 1;
        }
    }
    send(
        &mut socket,
        json!({"type": "proxy.close", "streamId": 1, "code": 1001, "reason": "gone"}),
    )
    .await;
    let outcome = service.await.unwrap();
    assert!(
        outcome == ["closed 1001"] || outcome == ["dropped"],
        "{outcome:?}"
    );
    // The stream's slot is free: the session still serves.
    assert_serves(&mut socket, 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_serves_an_early_response_while_the_request_body_is_unread() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    // The guest reads only the head, answers 413, and holds the connection
    // without reading the body.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.unwrap();
            head.push(byte[0]);
        }
        stream
            .write_all(b"HTTP/1.1 413 Content Too Large\r\nContent-Length: 4\r\n\r\nbig!")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 1, "port": port, "mode": "http",
               "method": "POST", "target": "/upload", "headers": [], "body": true}),
    )
    .await;
    // A full window of 256 KiB frames: more than the socket buffers hold.
    let chunk = vec![b'u'; 256 * 1024];
    for _ in 0..WINDOW {
        send_frame(&mut socket, 1, 0, &chunk).await;
    }
    let mut status = None;
    let mut body = Vec::new();
    let early = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match next_event(&mut socket).await {
                Event::Text(value) if value["type"] == "proxy.response" => {
                    status = value["status"].as_u64();
                }
                Event::Text(value) if value["type"] == "proxy.end" => return,
                Event::Text(value) if value["type"] == "proxy.ack" => {}
                Event::Text(value) => panic!("unexpected {value}"),
                Event::Data(1, 0, payload) => {
                    body.extend_from_slice(&payload);
                    send(&mut socket, json!({"type": "proxy.ack", "streamId": 1})).await;
                }
                Event::Data(..) => panic!("frame for another stream"),
            }
        }
    })
    .await;
    assert!(early.is_ok(), "the early response waited for the body");
    assert_eq!(status, Some(413));
    assert_eq!(body, b"big!");

    // A guest that never reads and never answers: Core's close still ends
    // the exchange and drops the upstream connection.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dropped = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        // Drain what dxd wrote, then expect its hang-up.
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut buffer = vec![0_u8; 64 * 1024];
            while stream.read(&mut buffer).await.is_ok_and(|read| read > 0) {}
        })
        .await
        .is_ok()
    });
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 2, "port": port, "mode": "http",
               "method": "PUT", "target": "/", "headers": [], "body": true}),
    )
    .await;
    for _ in 0..WINDOW {
        send_frame(&mut socket, 2, 0, &chunk).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    send(
        &mut socket,
        json!({"type": "proxy.close", "streamId": 2, "code": null, "reason": null}),
    )
    .await;
    assert!(
        dropped.await.unwrap(),
        "the upstream connection outlived the close"
    );
    assert_serves(&mut socket, 3).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proxy_writes_an_empty_body_frame_as_nothing() {
    let (_fixture, _daemon, mut socket, _generation) = connect_daemon().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = upstream(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
    send(
        &mut socket,
        json!({"type": "proxy.open", "streamId": 1, "port": port, "mode": "http",
               "method": "POST", "target": "/", "headers": [], "body": true}),
    )
    .await;
    send_frame(&mut socket, 1, 0, b"abc").await;
    send_frame(&mut socket, 1, 0, b"").await;
    send_frame(&mut socket, 1, 0, b"defg").await;
    send(&mut socket, json!({"type": "proxy.end", "streamId": 1})).await;
    let request = String::from_utf8(served.await.unwrap()).unwrap();
    assert!(
        request.ends_with("\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n"),
        "{request}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn services_beyond_the_shared_bounds_fail_without_ending_the_session() {
    let (_fixture, _daemon, mut socket, generation) = connect_daemon().await;
    let env: serde_json::Map<String, Value> = (0..65)
        .map(|index| (format!("V{index}"), json!("1")))
        .collect();
    let result = ensure_services(
        &mut socket,
        &generation,
        "svc-env",
        json!([{"name": "web", "command": "true", "port": 3000, "env": env}]),
    )
    .await;
    assert_eq!(
        result,
        json!({"kind": "services", "services": [{"name": "web", "state": "failed"}]})
    );
    // 2049 two-byte characters: within 4096 UTF-16 units, beyond 4096 bytes.
    let result = ensure_services(
        &mut socket,
        &generation,
        "svc-value",
        json!([{"name": "web", "command": "true", "port": 3000,
                "env": {"BIG": "é".repeat(2049)}}]),
    )
    .await;
    assert_eq!(result["services"][0]["state"], "failed");
    let many: Vec<Value> = (0..17)
        .map(|index| json!({"name": format!("s{index}"), "command": "true", "port": 3000 + index, "env": {}}))
        .collect();
    let result = ensure_services(&mut socket, &generation, "svc-many", json!(many)).await;
    assert_eq!(result, json!({"kind": "unavailable", "reason": "invalid"}));
    assert_serves(&mut socket, 1).await;
}
