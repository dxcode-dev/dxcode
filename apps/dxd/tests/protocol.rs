//! End-to-end protocol test: the real `dxd` binary connects to a mock Core
//! (a plain-`ws://` WebSocket server speaking protocol major 2) and every
//! resident feature is driven through the wire exactly as the Thread
//! execution Durable Object would drive it.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

const DXD: &str = env!("CARGO_BIN_EXE_dxd");
const THREAD_ID: &str = "thr_0123abcd-4567-4abc-8def-0123456789ab";

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    repo: PathBuf,
    state: PathBuf,
    config: PathBuf,
    baseline: String,
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
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
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "a@b.c"]);
    git(&repo, &["config", "user.name", "a"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/main.rs"), "fn main() {}\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let baseline = git(&repo, &["rev-parse", "HEAD"]);
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
        home,
        repo,
        state,
        config,
        baseline,
    }
}

fn spawn_daemon(fixture: &Fixture) -> Child {
    spawn_daemon_at(fixture, Path::new(DXD))
}

fn spawn_daemon_at(fixture: &Fixture, binary: &Path) -> Child {
    Command::new(binary)
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
        .unwrap()
}

struct DaemonGuard(Child);

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn accept(listener: &TcpListener) -> Socket {
    let (stream, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
        .await
        .expect("daemon connected")
        .unwrap();
    // Core's edge acknowledges promptly; keep the mock from adding Nagle
    // delays of its own so latencies below are the daemon's.
    stream.set_nodelay(true).unwrap();
    let mut authorization = None;
    let socket = tokio_tungstenite::accept_hdr_async(
        stream,
        |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
         response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            authorization = request
                .headers()
                .get("authorization")
                .map(|value| value.to_str().unwrap().to_owned());
            Ok(response)
        },
    )
    .await
    .unwrap();
    // The fixture key, or the rotated one a SIGHUP reload adopts.
    assert!(matches!(
        authorization.as_deref(),
        Some(
            "Bearer dxd_integration-test-key-0123456789"
                | "Bearer dxd_integration-test-key-rotated-0123"
        )
    ));
    socket
}

async fn next_text(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .expect("frame within 20s")
            .expect("socket open")
            .unwrap()
        {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Binary(_) => continue,
            Message::Ping(data) => socket.send(Message::Pong(data)).await.unwrap(),
            Message::Close(_) => panic!("daemon closed the socket"),
            _ => {}
        }
    }
}

/// Next frame of any kind, skipping heartbeats and dirty hints.
async fn next_frame(socket: &mut Socket) -> Message {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(20), socket.next())
            .await
            .expect("frame within 20s")
            .expect("socket open")
            .unwrap();
        if let Message::Text(text) = &message {
            let value: Value = serde_json::from_str(text.as_str()).unwrap();
            if matches!(value["type"].as_str(), Some("heartbeat" | "changes-dirty")) {
                continue;
            }
        }
        if let Message::Ping(data) = &message {
            socket.send(Message::Pong(data.clone())).await.unwrap();
            continue;
        }
        return message;
    }
}

async fn wait_for(socket: &mut Socket, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "expected frame never arrived");
        let value = next_text(socket).await;
        if predicate(&value) {
            return value;
        }
    }
}

async fn register(socket: &mut Socket) -> String {
    let register = next_text(socket).await;
    assert_eq!(register["type"], "register");
    assert_eq!(register["protocolMajor"], 2);
    assert_eq!(register["release"], env!("CARGO_PKG_VERSION"));
    assert_eq!(register["capabilities"]["terminal"]["version"], 1);
    assert_eq!(register["capabilities"]["files"]["version"], 1);
    let generation = format!("gen-{}", rand::random::<u32>());
    socket
        .send(Message::Text(
            json!({
                "type": "registered",
                "generation": generation,
                "heartbeatIntervalMs": 2000,
                "heartbeatLeaseMs": 15000,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let heartbeat = next_text(socket).await;
    assert_eq!(heartbeat["type"], "heartbeat");
    assert_eq!(heartbeat["generation"], generation);
    generation
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn request(socket: &mut Socket, generation: &str, id: &str, operation: Value) -> Value {
    send(
        socket,
        json!({"type": "request", "generation": generation, "requestId": id, "operation": operation}),
    )
    .await;
    wait_for(socket, |value| {
        value["type"] == "response" && value["requestId"] == id
    })
    .await["result"]
        .clone()
}

fn b64(value: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes())
}

fn environment_operation(generation: u64) -> Value {
    json!({
        "operation": "environment.activate",
        "generation": generation,
        "entries": [
            {"name": "DX_TEST_VALUE", "valueBase64Url": b64("from-core")},
        ],
        "git": {
            "authorName": "Ada",
            "authorEmail": "ada@example.com",
            "threadUrl": format!("https://dx.example/threads/{THREAD_ID}"),
            "signingEnabled": false,
        }
    })
}

fn digest_of(operation: &Value) -> String {
    use sha2::Digest;
    let mut text = String::from("dxd-environment-digest-v1\n");
    for entry in operation["entries"].as_array().unwrap() {
        text.push_str(&format!(
            "{}={}\n",
            entry["name"].as_str().unwrap(),
            entry["valueBase64Url"].as_str().unwrap()
        ));
    }
    let git = &operation["git"];
    text.push_str(&format!(
        "git.authorName={}\n",
        git["authorName"].as_str().unwrap()
    ));
    text.push_str(&format!(
        "git.authorEmail={}\n",
        git["authorEmail"].as_str().unwrap()
    ));
    text.push_str(&format!(
        "git.threadUrl={}\n",
        git["threadUrl"].as_str().unwrap()
    ));
    text.push_str(&format!(
        "git.signingEnabled={}\n",
        if git["signingEnabled"].as_bool().unwrap() {
            "true"
        } else {
            "false"
        }
    ));
    text.push_str("git.bitbucketGateway=\n");
    format!("{:x}", sha2::Sha256::digest(text.as_bytes()))
}

fn terminal_frame(
    kind: u8,
    resident: &str,
    attachment: Option<&str>,
    sequence: u64,
    payload: &[u8],
) -> Vec<u8> {
    use base64::Engine;
    let decode = |value: &str| -> [u8; 16] {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .unwrap()
            .try_into()
            .unwrap()
    };
    let mut frame = Vec::new();
    frame.extend_from_slice(b"DXT1");
    frame.push(kind);
    frame.push(0);
    frame.extend_from_slice(&decode(resident));
    frame.extend_from_slice(&attachment.map_or([0_u8; 16], decode));
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn random_generation() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_daemon_serves_every_feature_over_protocol_v2() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = fixture(port);
    let started = Instant::now();
    let mut daemon = DaemonGuard(spawn_daemon(&fixture));
    let mut socket = accept(&listener).await;
    let generation = register(&mut socket).await;
    let connect_ms = started.elapsed().as_millis();
    eprintln!("measured: process start to registered {connect_ms} ms");
    assert!(connect_ms < 5_000);
    // A fresh daemon has no terminal yet; the reconnect below proves it kept one.

    // The first dirty hint follows registration.
    let dirty = next_text(&mut socket).await;
    assert_eq!(dirty["type"], "changes-dirty");

    // Readiness probe round trip.
    let probe_started = Instant::now();
    send(
        &mut socket,
        json!({"type": "readiness-ping", "generation": generation, "requestId": "probe-1"}),
    )
    .await;
    let pong = wait_for(&mut socket, |value| value["type"] == "readiness-pong").await;
    assert_eq!(pong["requestId"], "probe-1");
    eprintln!(
        "measured: readiness round trip {} µs",
        probe_started.elapsed().as_micros()
    );

    // Files: whole directory in one response, read, save with refresh.
    let list_started = Instant::now();
    let tree = request(
        &mut socket,
        &generation,
        "list-1",
        json!({"operation": "files.list", "path": null}),
    )
    .await;
    eprintln!(
        "measured: files.list round trip {} µs",
        list_started.elapsed().as_micros()
    );
    assert_eq!(tree["kind"], "tree");
    let names = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, ["README.md", "src"]);
    assert!(tree["nextIndex"].is_null());
    let read = request(
        &mut socket,
        &generation,
        "read-1",
        json!({"operation": "files.read", "path": "README.md"}),
    )
    .await;
    assert_eq!(read["kind"], "editable");
    assert_eq!(read["content"], "hello\n");
    let version = read["version"].as_str().unwrap().to_owned();
    let refresh = json!({
        "type": "changes-refresh",
        "token": "opaque-refresh-token-1",
        "source": {"baseline": fixture.baseline, "defaultBranch": "main"},
        "expectedFingerprint": null,
    });
    let saved = request(
        &mut socket,
        &generation,
        "save-1",
        json!({
            "operation": "files.save", "path": "README.md", "expectedVersion": version,
            "content": "hello world\n", "refresh": refresh,
        }),
    )
    .await;
    assert_eq!(saved["kind"], "saved");
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("README.md")).unwrap(),
        "hello world\n"
    );
    let stale = request(
        &mut socket,
        &generation,
        "save-2",
        json!({
            "operation": "files.save", "path": "README.md", "expectedVersion": version,
            "content": "lost update\n", "refresh": refresh,
        }),
    )
    .await;
    assert_eq!(stale["kind"], "conflict");
    // The save's refresh produced a Changes candidate.
    let candidate = wait_for(&mut socket, |value| value["type"] == "changes-candidate").await;
    assert_eq!(candidate["token"], "opaque-refresh-token-1");
    assert_eq!(candidate["outcome"]["kind"], "complete");
    let capture = &candidate["outcome"]["capture"];
    assert_eq!(capture["ranges"][0]["files"][0]["path"], "README.md");
    assert_eq!(capture["ranges"][0]["files"][0]["status"], "modified");
    let fingerprint = capture["fingerprint"].as_str().unwrap().to_owned();

    // Explicit refresh with the known fingerprint short-circuits.
    send(
        &mut socket,
        json!({
            "type": "changes-refresh", "token": "opaque-refresh-token-2",
            "source": {"baseline": fixture.baseline, "defaultBranch": "main"},
            "expectedFingerprint": fingerprint,
        }),
    )
    .await;
    let unchanged = wait_for(&mut socket, |value| {
        value["type"] == "changes-candidate" && value["token"] == "opaque-refresh-token-2"
    })
    .await;
    assert_eq!(unchanged["outcome"]["kind"], "unchanged");
    assert_eq!(unchanged["outcome"]["fingerprint"], fingerprint);

    // Filesystem observation: an external write yields a dirty hint.
    std::fs::write(fixture.repo.join("src/lib.rs"), "pub fn x() {}\n").unwrap();
    wait_for(&mut socket, |value| value["type"] == "changes-dirty").await;

    // Sandbox read: raw bytes in DXF1 frames, split at consecutive offsets.
    std::fs::write(fixture.home.join("notes.bin"), [0_u8, 1, 2, 255, 10]).unwrap();
    send(&mut socket, json!({"type": "request", "generation": generation, "requestId": "sandbox-1", "operation": {
        "operation": "files.readSandbox", "path": "/home/user/notes.bin", "offset": 1, "length": 3,
    }})).await;
    let frame = loop {
        match next_frame(&mut socket).await {
            Message::Binary(bytes) if bytes.starts_with(b"DXF1") => break bytes,
            Message::Binary(_) => continue,
            Message::Text(text) => panic!("unexpected text frame {text}"),
            _ => continue,
        }
    };
    let header_length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
    let header: Value = serde_json::from_slice(&frame[8..8 + header_length]).unwrap();
    assert_eq!(header["requestId"], "sandbox-1");
    assert_eq!(header["sizeBytes"], 5);
    assert_eq!(header["offset"], 1);
    assert_eq!(&frame[8 + header_length..], &[1, 2, 255]);
    send(&mut socket, json!({"type": "chunk-ack"})).await;
    // A large read crosses as 256 KiB frames. At most four are unacknowledged,
    // and control frames still flow while the window is full.
    let large = (0..2_000_000_u32)
        .map(|value| (value % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(fixture.home.join("large.bin"), &large).unwrap();
    send(&mut socket, json!({"type": "request", "generation": generation, "requestId": "sandbox-2", "operation": {
        "operation": "files.readSandbox", "path": "/home/user/large.bin", "offset": 10, "length": 1_600_000,
    }})).await;
    let mut assembled = Vec::new();
    let mut frames = 0;
    let mut acknowledged = false;
    while assembled.len() < 1_600_000 {
        if frames == 4 && !acknowledged {
            send(
                &mut socket,
                json!({"type": "readiness-ping", "generation": generation, "requestId": "probe-window"}),
            )
            .await;
            loop {
                match next_frame(&mut socket).await {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(text.as_str()).unwrap();
                        if value["type"] == "readiness-pong" {
                            break;
                        }
                    }
                    Message::Binary(frame) if frame.starts_with(b"DXF1") => {
                        panic!("a fifth frame was sent before any acknowledgement")
                    }
                    _ => {}
                }
            }
            for _ in 0..4 {
                send(&mut socket, json!({"type": "chunk-ack"})).await;
            }
            acknowledged = true;
        }
        let Message::Binary(frame) = next_frame(&mut socket).await else {
            continue;
        };
        if !frame.starts_with(b"DXF1") {
            continue;
        }
        let header_length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&frame[8..8 + header_length]).unwrap();
        assert_eq!(header["requestId"], "sandbox-2");
        assert_eq!(header["sizeBytes"], 2_000_000);
        assert_eq!(header["offset"], 10 + assembled.len() as u64);
        assembled.extend_from_slice(&frame[8 + header_length..]);
        frames += 1;
    }
    assert_eq!(assembled, large[10..1_600_010]);
    assert_eq!(frames, 7, "1,600,000 bytes cross as 256 KiB frames");
    for _ in 0..3 {
        send(&mut socket, json!({"type": "chunk-ack"})).await;
    }

    // Environment: check → missing, activate → applied, check → unchanged.
    let operation = environment_operation(1);
    let digest = digest_of(&operation);
    let check = request(
        &mut socket,
        &generation,
        "env-check-1",
        json!({"operation": "environment.check", "generation": 1, "digest": digest}),
    )
    .await;
    assert_eq!(check["kind"], "missing");
    let activate_started = Instant::now();
    let applied = request(&mut socket, &generation, "env-1", operation.clone()).await;
    eprintln!(
        "measured: environment.activate {} ms",
        activate_started.elapsed().as_millis()
    );
    assert_eq!(applied["kind"], "applied");
    assert_eq!(applied["shell"], "no-shell");
    let env_file = std::fs::read_to_string(fixture.home.join(".env")).unwrap();
    assert!(env_file.contains("DX_TEST_VALUE='from-core'"));
    assert!(fixture.state.join("dx-terminal/gitconfig").is_file());
    let check_started = Instant::now();
    let check = request(
        &mut socket,
        &generation,
        "env-check-2",
        json!({"operation": "environment.check", "generation": 1, "digest": digest}),
    )
    .await;
    eprintln!(
        "measured: environment.check {} µs",
        check_started.elapsed().as_micros()
    );
    assert_eq!(check["kind"], "unchanged");
    let same_values_new_generation =
        request(&mut socket, &generation, "env-2", environment_operation(2)).await;
    assert_eq!(same_values_new_generation["kind"], "unchanged");
    // Core numbers each activation afresh, so a wake checks a later
    // generation: the same digest still needs no payload.
    let later_check = request(
        &mut socket,
        &generation,
        "env-check-3",
        json!({"operation": "environment.check", "generation": 3, "digest": digest}),
    )
    .await;
    assert_eq!(later_check["kind"], "unchanged");
    assert_eq!(later_check["generation"], 3);

    // Terminal: open, ready, attach, echo, resize, detach.
    let open_started = Instant::now();
    send(
        &mut socket,
        json!({
            "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
            "mode": "open-if-absent", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    let starting = wait_for(&mut socket, |value| {
        value["type"] == "terminal.resident-state"
    })
    .await;
    assert_eq!(starting["state"], "starting");
    let resident = starting["residentGeneration"].as_str().unwrap().to_owned();
    let ready = wait_for(&mut socket, |value| {
        value["type"] == "terminal.resident-state" && value["state"] == "ready"
    })
    .await;
    eprintln!(
        "measured: terminal open to ready {} ms",
        open_started.elapsed().as_millis()
    );
    assert_eq!(ready["residentGeneration"], resident);
    let heartbeat = wait_for(&mut socket, |value| value["type"] == "heartbeat").await;
    assert_eq!(heartbeat["terminal"]["state"], "ready");
    assert_eq!(heartbeat["terminal"]["foregroundCommand"], false);

    let attachment = random_generation();
    send(
        &mut socket,
        json!({
            "type": "terminal.attach", "terminalVersion": 1, "terminal": "default",
            "residentGeneration": resident, "attachmentGeneration": attachment,
            "resizeOrdinal": "1", "dimensions": {"columns": 100, "rows": 30},
        }),
    )
    .await;
    let dimensions = wait_for(&mut socket, |value| value["type"] == "terminal.dimensions").await;
    assert_eq!(dimensions["dimensions"]["columns"], 100);
    let replay_start = wait_for(&mut socket, |value| {
        value["type"] == "terminal.replay-start"
    })
    .await;
    assert_eq!(replay_start["attachmentGeneration"], attachment);
    wait_for(&mut socket, |value| {
        value["type"] == "terminal.attachment-ready"
    })
    .await;

    let echo_started = Instant::now();
    socket
        .send(Message::Binary(
            terminal_frame(1, &resident, Some(&attachment), 1, b"echo dx-$((40+2))\n").into(),
        ))
        .await
        .unwrap();
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains("dx-42") {
        assert!(
            Instant::now() < deadline,
            "shell did not echo: {}",
            String::from_utf8_lossy(&seen)
        );
        if let Message::Binary(bytes) = next_frame(&mut socket).await {
            if bytes.starts_with(b"DXT1") {
                assert_eq!(bytes[4], 3, "live output frame");
                seen.extend_from_slice(&bytes[50..]);
            }
        }
    }
    eprintln!(
        "measured: input to echoed output {} ms",
        echo_started.elapsed().as_millis()
    );

    send(
        &mut socket,
        json!({
            "type": "terminal.resize", "terminalVersion": 1, "terminal": "default",
            "residentGeneration": resident, "attachmentGeneration": attachment,
            "resizeOrdinal": "2", "dimensions": {"columns": 120, "rows": 40},
        }),
    )
    .await;
    let resized = wait_for(&mut socket, |value| {
        value["type"] == "terminal.dimensions" && value["resizeOrdinal"] == "2"
    })
    .await;
    assert_eq!(resized["dimensions"]["rows"], 40);

    // A long-running foreground command is reported through the heartbeat.
    socket
        .send(Message::Binary(
            terminal_frame(1, &resident, Some(&attachment), 2, b"sleep 30\n").into(),
        ))
        .await
        .unwrap();
    wait_for(&mut socket, |value| {
        value["type"] == "heartbeat" && value["terminal"]["foregroundCommand"] == true
    })
    .await;

    send(&mut socket, json!({
        "type": "terminal.detach", "terminalVersion": 1, "terminal": "default",
        "residentGeneration": resident, "attachmentGeneration": attachment, "reason": "browser-detached",
    })).await;
    let detached = wait_for(&mut socket, |value| value["type"] == "terminal.detached").await;
    assert_eq!(detached["attachmentGeneration"], attachment);

    // Workload identity: the guest helper CLI relays through the daemon.
    let helper_socket = fixture.state.join("workload-identity.sock");
    let helper = tokio::task::spawn_blocking({
        let helper_socket = helper_socket.clone();
        move || {
            Command::new(DXD)
                .args([
                    "id-token",
                    "--audience",
                    "urn:dx:test",
                    "--ttl-seconds",
                    "60",
                ])
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap())
                .env("DX_WORKLOAD_IDENTITY_SOCKET", &helper_socket)
                .output()
                .unwrap()
        }
    });
    let identity_request = wait_for(&mut socket, |value| {
        value["type"] == "workload-identity.request"
    })
    .await;
    assert_eq!(identity_request["request"]["audience"], "urn:dx:test");
    assert_eq!(identity_request["request"]["ttlSeconds"], 60);
    send(&mut socket, json!({
        "type": "workload-identity.response", "generation": generation,
        "requestId": identity_request["requestId"],
        "result": {"kind": "issued", "token": "header.payload.signature", "expiresAt": 4_102_444_800_u64},
    })).await;
    let output = helper.await.unwrap();
    assert!(
        output.status.success(),
        "id-token failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "header.payload.signature"
    );

    // Self-update: a checksum mismatch is reported and leaves the daemon running.
    let (release_listener, release_url) = release_server(b"not the real binary").await;
    send(
        &mut socket,
        json!({
            "type": "update", "generation": generation, "url": release_url,
            "sha256": "0".repeat(64), "release": "9.9.9",
        }),
    )
    .await;
    let status = wait_for(&mut socket, |value| value["type"] == "update-status").await;
    assert_eq!(status["status"], "failed");
    assert_eq!(status["release"], "9.9.9");
    drop(release_listener);

    // Reconnect: Core drops the socket; the daemon is back within a second
    // and its shell survived.
    drop(socket);
    let reconnect_started = Instant::now();
    let mut socket = accept(&listener).await;
    let generation = register(&mut socket).await;
    eprintln!(
        "measured: reconnect after Core closed the socket {} ms",
        reconnect_started.elapsed().as_millis()
    );
    assert!(reconnect_started.elapsed() < Duration::from_secs(3));
    let heartbeat = wait_for(&mut socket, |value| value["type"] == "heartbeat").await;
    assert_eq!(
        heartbeat["terminal"]["state"], "ready",
        "the shell outlives the connection"
    );
    assert_eq!(heartbeat["terminal"]["residentGeneration"], resident);
    let _ = generation;

    // SIGHUP: a bootstrap repair asks the running daemon to re-read its
    // configuration and reconnect now instead of restarting it, so the shell
    // it owns survives. A nudge that changes nothing keeps a live connection.
    {
        let status = Command::new("kill")
            .args(["-HUP", &daemon.0.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(
            tokio::time::timeout(Duration::from_millis(1_500), listener.accept())
                .await
                .is_err(),
            "an unchanged configuration must not drop the registered connection"
        );
        let heartbeat = wait_for(&mut socket, |value| value["type"] == "heartbeat").await;
        assert_eq!(heartbeat["terminal"]["state"], "ready");

        let mut config: Value =
            serde_json::from_str(&std::fs::read_to_string(&fixture.config).unwrap()).unwrap();
        config["apiKey"] = json!("dxd_integration-test-key-rotated-0123");
        std::fs::write(&fixture.config, config.to_string()).unwrap();
        let hangup_started = Instant::now();
        let status = Command::new("kill")
            .args(["-HUP", &daemon.0.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        let mut socket = accept(&listener).await;
        let _ = register(&mut socket).await;
        eprintln!(
            "measured: SIGHUP to re-registered {} ms",
            hangup_started.elapsed().as_millis()
        );
        assert!(hangup_started.elapsed() < Duration::from_secs(2));
        let heartbeat = wait_for(&mut socket, |value| value["type"] == "heartbeat").await;
        assert_eq!(heartbeat["terminal"]["state"], "ready");
        assert_eq!(heartbeat["terminal"]["residentGeneration"], resident);
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "the process kept running"
        );
    }
}

async fn release_server(body: &'static [u8]) -> (tokio::task::JoinHandle<()>, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.write_all(body).await;
        }
    });
    // The daemon requires https for release URLs; the mock uses http to prove
    // the rejection path without TLS, so validation happens in the daemon.
    (task, format!("https://127.0.0.1:{port}/dxd"))
}

/// Self-update: the daemon downloads the release Core names, verifies it,
/// waits until every feature is quiet, replaces its own binary, re-execs, and
/// the shell it was running survives into the new image with the same
/// resident identity and screen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_daemon_updates_itself_in_place_and_keeps_the_shell() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = fixture(port);
    // Run a private copy so the swap never touches the test build.
    let binary = fixture.state.join("bin").join("dxd");
    std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
    std::fs::copy(DXD, &binary).unwrap();
    // A different release: the same executable with trailing bytes, so its
    // digest differs from the running image while it still runs.
    let mut release_bytes = std::fs::read(DXD).unwrap();
    release_bytes.extend_from_slice(b"\ndxd-test-release\n");
    let release_bytes: &'static [u8] = Box::leak(release_bytes.into_boxed_slice());
    let sha256 = {
        use sha2::Digest;
        format!("{:x}", sha2::Sha256::digest(release_bytes))
    };
    let _daemon = DaemonGuard(spawn_daemon_at(&fixture, &binary));
    let mut socket = accept(&listener).await;
    let generation = register(&mut socket).await;

    // A shell must be running so the handoff has something to carry.
    let applied = request(&mut socket, &generation, "env-1", environment_operation(1)).await;
    assert_eq!(applied["kind"], "applied");
    send(
        &mut socket,
        json!({
            "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
            "mode": "open-if-absent", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    let ready = wait_for(&mut socket, |value| {
        value["type"] == "terminal.resident-state" && value["state"] == "ready"
    })
    .await;
    let resident = ready["residentGeneration"].as_str().unwrap().to_owned();
    let attachment = random_generation();
    send(
        &mut socket,
        json!({
            "type": "terminal.attach", "terminalVersion": 1, "terminal": "default",
            "residentGeneration": resident, "attachmentGeneration": attachment,
            "resizeOrdinal": "1", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    wait_for(&mut socket, |value| {
        value["type"] == "terminal.attachment-ready"
    })
    .await;
    // State the shell will remember across the daemon's re-exec.
    socket
        .send(Message::Binary(
            terminal_frame(
                1,
                &resident,
                Some(&attachment),
                1,
                b"DX_MARKER=survived; sleep 30 & SLEEP_PID=$!; echo SCREEN-$((6*7))\n",
            )
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (release_task, url) = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0_u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    release_bytes.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(release_bytes).await;
            }
        });
        (task, format!("http://127.0.0.1:{port}/dxd"))
    };
    let update_started = Instant::now();
    send(
        &mut socket,
        json!({
            "type": "update", "generation": generation, "url": url,
            "sha256": sha256, "release": env!("CARGO_PKG_VERSION"),
        }),
    )
    .await;
    // While the user types, the verified release waits: every keystroke is
    // answered and nothing swaps under it.
    let mut sequence = 2;
    let busy_until = Instant::now() + Duration::from_secs(8);
    let mut slowest_echo = Duration::ZERO;
    while Instant::now() < busy_until {
        let token = format!("busy{sequence}");
        let sent = Instant::now();
        socket
            .send(Message::Binary(
                terminal_frame(
                    1,
                    &resident,
                    Some(&attachment),
                    sequence,
                    format!("echo {token}-$((1+1))\n").as_bytes(),
                )
                .into(),
            ))
            .await
            .unwrap();
        sequence += 1;
        let mut seen = Vec::new();
        while !String::from_utf8_lossy(&seen).contains(&format!("{token}-2")) {
            match next_frame(&mut socket).await {
                Message::Binary(bytes) if bytes.starts_with(b"DXT1") => {
                    seen.extend_from_slice(&bytes[50..]);
                }
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(text.as_str()).unwrap();
                    assert_ne!(value["type"], "update-status", "swapped while busy");
                }
                _ => {}
            }
        }
        slowest_echo = slowest_echo.max(sent.elapsed());
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!(
        "measured: slowest echo while a release was pending {} ms",
        slowest_echo.as_millis()
    );
    let quiet_since = Instant::now();
    let status = wait_for(&mut socket, |value| value["type"] == "update-status").await;
    assert_eq!(status["status"], "applying");
    eprintln!(
        "measured: quiet to swap {} ms",
        quiet_since.elapsed().as_millis()
    );
    let swap_started = Instant::now();
    release_task.abort();

    // The old image exits; the new image registers and still owns the shell.
    let mut socket = accept(&listener).await;
    let generation = register(&mut socket).await;
    eprintln!(
        "measured: update requested to new image registered {} ms (swap {} ms)",
        update_started.elapsed().as_millis(),
        swap_started.elapsed().as_millis()
    );
    let heartbeat = wait_for(&mut socket, |value| value["type"] == "heartbeat").await;
    assert_eq!(heartbeat["terminal"]["state"], "ready");
    assert_eq!(heartbeat["terminal"]["residentGeneration"], resident);
    let attachment = random_generation();
    send(
        &mut socket,
        json!({
            "type": "terminal.attach", "terminalVersion": 1, "terminal": "default",
            "residentGeneration": resident, "attachmentGeneration": attachment,
            "resizeOrdinal": "1", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    let replay = wait_for(&mut socket, |value| {
        value["type"] == "terminal.replay-start"
    })
    .await;
    assert_eq!(
        replay["truncated"], true,
        "replay does not pretend to start at sequence 1"
    );
    // The screen the browser had is replayed from the handed-off ring.
    let mut replayed = Vec::new();
    loop {
        match next_frame(&mut socket).await {
            Message::Binary(bytes) if bytes.starts_with(b"DXT1") => {
                replayed.extend_from_slice(&bytes[50..]);
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value["type"] == "terminal.attachment-ready" {
                    break;
                }
            }
            _ => {}
        }
    }
    assert!(
        String::from_utf8_lossy(&replayed).contains("SCREEN-42"),
        "the pre-update screen was not replayed"
    );
    socket
        .send(Message::Binary(
            terminal_frame(
                1,
                &resident,
                Some(&attachment),
                1,
                b"echo marker=$DX_MARKER sleep=$(kill -0 $SLEEP_PID && echo alive)\n",
            )
            .into(),
        ))
        .await
        .unwrap();
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains("marker=survived sleep=alive") {
        assert!(
            Instant::now() < deadline,
            "shell state was lost: {}",
            String::from_utf8_lossy(&seen)
        );
        if let Message::Binary(bytes) = next_frame(&mut socket).await {
            if bytes.starts_with(b"DXT1") {
                seen.extend_from_slice(&bytes[50..]);
            }
        }
    }
    // The adopted shell's exit is still observed, even with its background
    // job holding the PTY open.
    let exit_started = Instant::now();
    socket
        .send(Message::Binary(
            terminal_frame(1, &resident, Some(&attachment), 2, b"exit\n").into(),
        ))
        .await
        .unwrap();
    let exited = wait_for(&mut socket, |value| {
        value["type"] == "terminal.resident-state" && value["state"] != "ready"
    })
    .await;
    assert_eq!(exited["state"], "exited");
    assert_eq!(exited["residentGeneration"], resident);
    eprintln!(
        "measured: adopted shell exit to exited {} ms",
        exit_started.elapsed().as_millis()
    );
    let _ = generation;
}

async fn open_terminal(socket: &mut Socket) -> String {
    let started = Instant::now();
    send(
        socket,
        json!({
            "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
            "mode": "open-if-absent", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    let ready = wait_for(socket, |value| {
        value["type"] == "terminal.resident-state" && value["state"] == "ready"
    })
    .await;
    eprintln!(
        "measured: terminal open to ready {} ms",
        started.elapsed().as_millis()
    );
    ready["residentGeneration"].as_str().unwrap().to_owned()
}

/// Attach as Core does after a new daemon connection: reset the previous
/// connection's attachments, then attach with fresh ordinals. Returns the
/// attachment and the replayed bytes.
async fn reattach(socket: &mut Socket, resident: &str) -> (String, Vec<u8>) {
    send(
        socket,
        json!({
            "type": "terminal.reset-attachments", "terminalVersion": 1,
            "terminal": "default", "residentGeneration": resident,
        }),
    )
    .await;
    let attachment = random_generation();
    let started = Instant::now();
    send(
        socket,
        json!({
            "type": "terminal.attach", "terminalVersion": 1, "terminal": "default",
            "residentGeneration": resident, "attachmentGeneration": attachment,
            "resizeOrdinal": "1", "dimensions": {"columns": 80, "rows": 24},
        }),
    )
    .await;
    let mut replayed = Vec::new();
    let mut replay_bytes = None;
    loop {
        match next_frame(socket).await {
            Message::Binary(bytes) if bytes.starts_with(b"DXT1") && bytes[4] == 2 => {
                replayed.extend_from_slice(&bytes[50..]);
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                match value["type"].as_str() {
                    Some("terminal.replay-start") => {
                        replay_bytes = value["replayBytes"].as_u64();
                    }
                    Some("terminal.attachment-ready") => break,
                    Some("terminal.error") => panic!("attach failed: {value}"),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    assert_eq!(replay_bytes, Some(replayed.len() as u64));
    eprintln!(
        "measured: attach to attachment-ready {} µs ({} replay bytes)",
        started.elapsed().as_micros(),
        replayed.len()
    );
    (attachment, replayed)
}

/// Type into the shell and wait until `expected` appears in its live output.
async fn type_and_expect(
    socket: &mut Socket,
    resident: &str,
    attachment: &str,
    sequence: u64,
    input: &str,
    expected: &str,
) {
    socket
        .send(Message::Binary(
            terminal_frame(1, resident, Some(attachment), sequence, input.as_bytes()).into(),
        ))
        .await
        .unwrap();
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&seen).contains(expected) {
        assert!(
            Instant::now() < deadline,
            "expected {expected:?} in shell output: {}",
            String::from_utf8_lossy(&seen)
        );
        if let Message::Binary(bytes) = next_frame(socket).await
            && bytes.starts_with(b"DXT1")
            && bytes[4] == 3
        {
            seen.extend_from_slice(&bytes[50..]);
        }
    }
}

/// Next `changes-dirty` or `changes-candidate` frame before `deadline`,
/// keeping the daemon's heartbeat lease alive as Core does and skipping
/// everything else.
async fn next_changes_event(socket: &mut Socket, deadline: Instant) -> Option<Value> {
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let value = tokio::time::timeout(remaining, next_text(socket))
            .await
            .ok()?;
        if value["type"] == "heartbeat" {
            socket.send(Message::Ping(Vec::new().into())).await.unwrap();
        }
        if matches!(
            value["type"].as_str(),
            Some("changes-dirty" | "changes-candidate")
        ) {
            return Some(value);
        }
    }
}

/// The exported variable and the background `sleep` are both still alive.
async fn assert_shell_survived(socket: &mut Socket, resident: &str, probe: &str) {
    let heartbeat = wait_for(socket, |value| value["type"] == "heartbeat").await;
    assert_eq!(heartbeat["terminal"]["state"], "ready", "{probe}");
    assert_eq!(
        heartbeat["terminal"]["residentGeneration"], resident,
        "{probe}"
    );
    let (attachment, _) = reattach(socket, resident).await;
    type_and_expect(
        socket,
        resident,
        &attachment,
        1,
        &format!(
            "echo {probe} mark=$DX_MARK sleep=$(kill -0 $SLEEP_PID 2>/dev/null && echo alive || echo gone)\n"
        ),
        &format!("{probe} mark=kept sleep=alive"),
    )
    .await;
}

/// Register a fresh daemon image and return the terminal state it reports
/// first, plus how long that took from `since`.
async fn first_terminal_state(listener: &TcpListener, since: Instant) -> (Socket, String, Value) {
    let mut socket = accept(listener).await;
    let register_frame = next_text(&mut socket).await;
    assert_eq!(register_frame["type"], "register");
    let generation = format!("gen-{}", rand::random::<u32>());
    send(
        &mut socket,
        json!({
            "type": "registered", "generation": generation,
            "heartbeatIntervalMs": 2000, "heartbeatLeaseMs": 15000,
        }),
    )
    .await;
    let heartbeat = next_text(&mut socket).await;
    assert_eq!(heartbeat["type"], "heartbeat");
    eprintln!(
        "measured: daemon restart to first terminal state {} ms",
        since.elapsed().as_millis()
    );
    (socket, generation, heartbeat["terminal"].clone())
}

/// Terminal lifetime: the shell (an exported variable plus a running
/// `sleep`) survives every connection loss the daemon itself survives, and a
/// daemon that died reports the shell it lost as exited, never a silent new
/// shell, so the browser shows Restart instead of a false ready.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_daemon_terminal_lifetime_matrix() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = fixture(port);
    let mut daemon = DaemonGuard(spawn_daemon(&fixture));
    let mut socket = accept(&listener).await;
    let generation = register(&mut socket).await;
    let applied = request(&mut socket, &generation, "env-1", environment_operation(1)).await;
    assert_eq!(applied["kind"], "applied");
    let resident = open_terminal(&mut socket).await;
    let (attachment, _) = reattach(&mut socket, &resident).await;
    type_and_expect(
        &mut socket,
        &resident,
        &attachment,
        1,
        "export DX_MARK=kept; sleep 600 & SLEEP_PID=$!; echo started-$((1+1))\n",
        "started-2",
    )
    .await;
    // Fill the replay ring so the reattaches below replay a full 64 KiB.
    type_and_expect(
        &mut socket,
        &resident,
        &attachment,
        2,
        "seq 1 20000; echo filled-$((2+2))\n",
        "filled-4",
    )
    .await;

    // Network drop: the socket vanishes without a close frame.
    drop(socket);
    let mut socket = accept(&listener).await;
    register(&mut socket).await;
    assert_shell_survived(&mut socket, &resident, "network-drop").await;

    // Core-only redeploy: the Durable Object restarts and closes the socket
    // with 1012; a new object instance assigns a new generation.
    socket
        .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Restart,
            reason: "redeploy".into(),
        }))
        .await
        .unwrap();
    drop(socket);
    let mut socket = accept(&listener).await;
    register(&mut socket).await;
    assert_shell_survived(&mut socket, &resident, "core-redeploy").await;

    // SIGHUP repair.
    let status = Command::new("kill")
        .args(["-HUP", &daemon.0.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let mut socket = accept(&listener).await;
    register(&mut socket).await;
    assert_shell_survived(&mut socket, &resident, "sighup").await;
    drop(socket);

    // Crash: SIGKILL and SIGABRT (what a release-build panic does) end the
    // daemon and its shell. The next daemon reports the lost resident as
    // exited so the browser offers Restart; it never opens a new shell by
    // itself.
    let mut lost = resident;
    for signal in ["-KILL", "-ABRT"] {
        let status = Command::new("kill")
            .args([signal, &daemon.0.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        let _ = daemon.0.wait();
        let restarted = Instant::now();
        daemon = DaemonGuard(spawn_daemon(&fixture));
        let (mut socket, generation, terminal) = first_terminal_state(&listener, restarted).await;
        assert_eq!(terminal["state"], "exited", "{signal}: {terminal}");
        assert_eq!(terminal["residentGeneration"], lost, "{signal}");
        // A browser that opens the Terminal is told it exited.
        send(
            &mut socket,
            json!({
                "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
                "mode": "open-if-absent", "dimensions": {"columns": 80, "rows": 24},
            }),
        )
        .await;
        let state = wait_for(&mut socket, |value| {
            value["type"] == "terminal.resident-state"
        })
        .await;
        assert_eq!(state["state"], "exited");
        assert_eq!(state["residentGeneration"], lost);
        // Restart opens a fresh shell under a new identity.
        let applied = request(&mut socket, &generation, "env-1", environment_operation(1)).await;
        assert!(matches!(
            applied["kind"].as_str(),
            Some("applied" | "unchanged")
        ));
        let restart_started = Instant::now();
        send(
            &mut socket,
            json!({
                "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
                "mode": "restart-exited", "expectedResidentGeneration": lost,
                "dimensions": {"columns": 80, "rows": 24},
            }),
        )
        .await;
        let ready = wait_for(&mut socket, |value| {
            value["type"] == "terminal.resident-state" && value["state"] == "ready"
        })
        .await;
        eprintln!(
            "measured: restart-exited to ready {} ms",
            restart_started.elapsed().as_millis()
        );
        let fresh = ready["residentGeneration"].as_str().unwrap().to_owned();
        assert_ne!(fresh, lost);
        let (attachment, _) = reattach(&mut socket, &fresh).await;
        type_and_expect(
            &mut socket,
            &fresh,
            &attachment,
            1,
            "echo fresh mark=${DX_MARK:-unset}\n",
            "fresh mark=unset",
        )
        .await;
        lost = fresh;
    }
}

/// Changes as Core drives them: each `changes-dirty` hint is answered with a
/// refresh carrying the last published fingerprint. An idle checkout, even
/// with Git rewriting its index, sends no hint and no candidate; a write is
/// published after the observer's quiet period and one capture.
/// `DX_CHANGES_IDLE_SECS=300` runs the five-minute idle check.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_daemon_is_quiet_while_idle_and_publishes_writes_promptly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fixture = fixture(port);
    // Stale stat data: the first `git status` below rewrites the index.
    std::fs::File::options()
        .write(true)
        .open(fixture.repo.join("README.md"))
        .unwrap()
        .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000))
        .unwrap();
    let _daemon = DaemonGuard(spawn_daemon(&fixture));
    let mut socket = accept(&listener).await;
    register(&mut socket).await;
    let source = json!({"baseline": fixture.baseline, "defaultBranch": "main"});
    let mut fingerprint = Value::Null;
    let mut token = 0;
    let mut refresh = async |socket: &mut Socket, fingerprint: &Value| {
        token += 1;
        let token = format!("refresh-token-{token:04}");
        send(
            socket,
            json!({"type": "changes-refresh", "token": token, "source": source, "expectedFingerprint": fingerprint}),
        )
        .await;
        token
    };
    let far = || Instant::now() + Duration::from_secs(20);

    let dirty = next_changes_event(&mut socket, far()).await.unwrap();
    assert_eq!(dirty["type"], "changes-dirty");
    let first = refresh(&mut socket, &fingerprint).await;
    let candidate = next_changes_event(&mut socket, far()).await.unwrap();
    assert_eq!(candidate["token"], first);
    assert_eq!(candidate["outcome"]["kind"], "complete");
    fingerprint = candidate["outcome"]["capture"]["fingerprint"].clone();

    let idle = Duration::from_secs(
        std::env::var("DX_CHANGES_IDLE_SECS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5),
    );
    let index = fixture.repo.join(".git/index");
    let before = std::fs::metadata(&index).unwrap().modified().unwrap();
    let repo = fixture.repo.clone();
    let git_reader = tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + idle;
        while Instant::now() < deadline {
            // A prompt or editor running Git with optional locks on, and Git's
            // own lock-and-rename index write.
            git(&repo, &["status", "--porcelain"]);
            let index = repo.join(".git/index");
            let lock = repo.join(".git/index.lock");
            std::fs::copy(&index, &lock).unwrap();
            std::fs::rename(&lock, &index).unwrap();
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    let idle_started = Instant::now();
    let event = next_changes_event(&mut socket, idle_started + idle).await;
    assert_eq!(event, None, "idle checkout produced Changes work");
    git_reader.await.unwrap();
    assert_ne!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        before
    );
    eprintln!(
        "measured: {} s idle, 0 dirty hints, 0 candidates",
        idle.as_secs()
    );

    let mut samples = Vec::new();
    for sample in 0..5 {
        let path = format!("src/new-{sample}.rs");
        std::fs::write(fixture.repo.join(&path), "pub fn new() {}\n").unwrap();
        let written = Instant::now();
        let dirty = next_changes_event(&mut socket, far()).await.unwrap();
        assert_eq!(dirty["type"], "changes-dirty");
        let expected = refresh(&mut socket, &fingerprint).await;
        let candidate = next_changes_event(&mut socket, far()).await.unwrap();
        assert_eq!(candidate["token"], expected);
        assert_eq!(candidate["outcome"]["kind"], "complete");
        let capture = &candidate["outcome"]["capture"];
        assert!(
            capture["ranges"][0]["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file["path"] == path.as_str())
        );
        samples.push(written.elapsed().as_millis());
        fingerprint = capture["fingerprint"].clone();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            next_changes_event(&mut socket, Instant::now()).await,
            None,
            "one write, one hint"
        );
    }
    samples.sort_unstable();
    eprintln!(
        "measured: write → candidate p50 {} ms ({samples:?})",
        samples[2]
    );
    assert!(samples[2] < 1_000);
}
