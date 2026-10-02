//! Resource footprint of the real `dxd` binary against a mock Core: start →
//! registration, threads, RSS, idle CPU and context switches, and the
//! latency and daemon CPU of Files, Changes, and Terminal operations, read
//! from `/proc`. Ignored by default:
//!
//! ```sh
//! cargo test --release --test footprint -- --ignored --nocapture
//! ```
//!
//! `DXD_BIN` measures another binary (e.g. a release build copied to an E2B
//! guest together with this test binary), `DX_FOOTPRINT_IDLE_SECS` sets the
//! idle window (default 300), and `DX_FOOTPRINT_GUEST=1` uses the guest
//! layout (`/home/user/.local/state/dxd/config.json`, no `localRuntime`).

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

const THREAD_ID: &str = "thr_0123abcd-4567-4abc-8def-0123456789ab";
const API_KEY: &str = "dxd_footprint-test-key-0123456789";
const OPERATIONS: usize = 100;

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {arguments:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn private(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A checkout with 2,000 files in one directory, 50 sources, and a few
/// uncommitted edits. Returns (config path, repository, baseline).
fn fixture(root: &Path, port: u16, guest: bool) -> (PathBuf, PathBuf, String) {
    let home = if guest {
        PathBuf::from("/home/user")
    } else {
        root.join("home")
    };
    let repo = if guest {
        root.join("repo")
    } else {
        home.join("workspace/repo")
    };
    let state = if guest {
        home.join(".local/state/dxd")
    } else {
        root.join("runtime")
    };
    for directory in [&repo.join("many"), &repo.join("src"), &state] {
        std::fs::create_dir_all(directory).unwrap();
    }
    private(&state, 0o700);
    if !guest {
        private(&home, 0o700);
    }
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "a@b.c"]);
    git(&repo, &["config", "user.name", "a"]);
    std::fs::write(repo.join("README.md"), "hello\n".repeat(200)).unwrap();
    for index in 0..2_000 {
        std::fs::write(repo.join(format!("many/file-{index:04}.txt")), "x\n").unwrap();
    }
    for index in 0..50 {
        std::fs::write(
            repo.join(format!("src/module_{index}.rs")),
            "pub fn f() {}\n".repeat(40),
        )
        .unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let baseline = git(&repo, &["rev-parse", "HEAD"]);
    for index in 0..3 {
        std::fs::write(repo.join(format!("src/module_{index}.rs")), "changed\n").unwrap();
    }
    let config = if guest {
        state.join("config.json")
    } else {
        root.join("config.json")
    };
    let mut document = json!({
        "version": 2,
        "endpoint": format!("ws://127.0.0.1:{port}/v1/threads/{THREAD_ID}/dxd"),
        "threadId": THREAD_ID,
        "apiKey": API_KEY,
        "workspaceRoot": repo.to_str().unwrap(),
    });
    if !guest {
        document["localRuntime"] = json!({
            "homeDirectory": home.to_str().unwrap(),
            "stateDirectory": state.to_str().unwrap(),
        });
    }
    std::fs::write(&config, document.to_string()).unwrap();
    private(&config, 0o600);
    (config, repo, baseline)
}

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn clock_ticks() -> f64 {
    // SAFETY: sysconf has no preconditions.
    (unsafe { libc::sysconf(libc::_SC_CLK_TCK) }) as f64
}

/// (own CPU ms, reaped children's CPU ms)
fn cpu_ms(pid: u32) -> (f64, f64) {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let field = |index: usize| fields[index].parse::<f64>().unwrap();
    // After the command name: state is field 3, utime 14 … cstime 17.
    let per_tick = 1_000.0 / clock_ticks();
    (
        (field(11) + field(12)) * per_tick,
        (field(13) + field(14)) * per_tick,
    )
}

fn status_kib(pid: u32, key: &str) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
        .and_then(|value| value.split_whitespace().next()?.parse().ok())
        .unwrap_or(0)
}

/// Per-thread (tid, name, voluntary, involuntary) context switches.
fn switches(pid: u32) -> Vec<(String, String, u64, u64)> {
    let mut threads = Vec::new();
    for task in std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .flatten()
    {
        let Ok(status) = std::fs::read_to_string(task.path().join("status")) else {
            continue;
        };
        let value = |key: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(0)
        };
        let name = std::fs::read_to_string(task.path().join("comm"))
            .unwrap_or_default()
            .trim()
            .to_owned();
        threads.push((
            task.file_name().to_string_lossy().into_owned(),
            name,
            value("voluntary_ctxt_switches:"),
            value("nonvoluntary_ctxt_switches:"),
        ));
    }
    threads.sort();
    threads
}

fn snapshot(label: &str, pid: u32) {
    let threads = switches(pid);
    eprintln!(
        "footprint: {label}: threads {} [{}], VmRSS {} KiB, VmHWM {} KiB, RssAnon {} KiB",
        threads.len(),
        threads
            .iter()
            .map(|(_, name, ..)| name.as_str())
            .collect::<Vec<_>>()
            .join(","),
        status_kib(pid, "VmRSS"),
        status_kib(pid, "VmHWM"),
        status_kib(pid, "RssAnon"),
    );
}

struct Mock {
    socket: Socket,
    generation: String,
}

impl Mock {
    async fn send(&mut self, value: Value) {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    /// Next frame that is not a heartbeat (heartbeats are acknowledged as
    /// Core does) or a dirty hint.
    async fn next(&mut self, deadline: Instant) -> Option<Message> {
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let message = tokio::time::timeout(remaining, self.socket.next())
                .await
                .ok()?
                .expect("socket open")
                .unwrap();
            if let Message::Text(text) = &message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                match value["type"].as_str() {
                    Some("heartbeat") => {
                        let generation = self.generation.clone();
                        self.send(json!({"type": "heartbeat-ack", "generation": generation}))
                            .await;
                        continue;
                    }
                    Some("changes-dirty") => continue,
                    _ => {}
                }
            }
            return Some(message);
        }
    }

    async fn text(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut skipped = Vec::new();
        loop {
            let message = self.next(deadline).await;
            let Some(message) = message else {
                panic!("expected frame never arrived; skipped {skipped:?}")
            };
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if predicate(&value) {
                    return value;
                }
                skipped.push(value.to_string());
            }
        }
    }

    async fn request(&mut self, id: &str, operation: Value) -> Value {
        let generation = self.generation.clone();
        self.send(json!({"type": "request", "generation": generation, "requestId": id, "operation": operation}))
            .await;
        self.text(|value| value["type"] == "response" && value["requestId"] == id)
            .await["result"]
            .clone()
    }

    async fn refresh(&mut self, token: &str, baseline: &str, expected: &Value) -> Value {
        self.send(json!({
            "type": "changes-refresh", "token": token,
            "source": {"baseline": baseline, "defaultBranch": "main"},
            "expectedFingerprint": expected,
        }))
        .await;
        self.text(|value| value["type"] == "changes-candidate" && value["token"] == token)
            .await["outcome"]
            .clone()
    }
}

fn terminal_frame(resident: &str, attachment: &str, sequence: u64, payload: &[u8]) -> Vec<u8> {
    use base64::Engine;
    let decode = |value: &str| -> [u8; 16] {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .unwrap()
            .try_into()
            .unwrap()
    };
    let mut frame = b"DXT1".to_vec();
    frame.extend_from_slice(&[1, 0]);
    frame.extend_from_slice(&decode(resident));
    frame.extend_from_slice(&decode(attachment));
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Run `operation` `OPERATIONS` times; print p50/p95 latency and the
/// daemon's CPU per operation.
async fn measure<F>(label: &str, pid: u32, mock: &mut Mock, mut operation: F)
where
    F: AsyncFnMut(&mut Mock, usize),
{
    let (own_before, children_before) = cpu_ms(pid);
    let mut samples = Vec::with_capacity(OPERATIONS);
    for index in 0..OPERATIONS {
        let started = Instant::now();
        operation(mock, index).await;
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    let (own_after, children_after) = cpu_ms(pid);
    samples.sort_by(f64::total_cmp);
    eprintln!(
        "footprint: {label}: p50 {:.2} ms, p95 {:.2} ms, dxd CPU {:.3} ms/op, children {:.3} ms/op",
        samples[OPERATIONS / 2],
        samples[OPERATIONS * 95 / 100],
        (own_after - own_before) / OPERATIONS as f64,
        (children_after - children_before) / OPERATIONS as f64,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "resource measurement; run with --ignored --nocapture"]
async fn footprint() {
    let binary = std::env::var("DXD_BIN").unwrap_or_else(|_| env!("CARGO_BIN_EXE_dxd").into());
    let guest = std::env::var("DX_FOOTPRINT_GUEST").is_ok_and(|value| value == "1");
    let idle = Duration::from_secs(
        std::env::var("DX_FOOTPRINT_IDLE_SECS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(300),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let root = tempfile::tempdir().unwrap();
    let (config, repo, baseline) = fixture(root.path(), port, guest);
    eprintln!(
        "footprint: binary {} bytes",
        std::fs::metadata(&binary).unwrap().len()
    );

    let started = Instant::now();
    let mut command = Command::new(&binary);
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("USER", "user")
        .env("HOME", "/home/user")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if !guest {
        command.arg("--config").arg(&config).env(
            "DX_WORKLOAD_IDENTITY_SOCKET",
            root.path().join("runtime/workload-identity.sock"),
        );
    }
    let daemon = Daemon(command.spawn().unwrap());
    let pid = daemon.0.id();

    let (stream, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
        .await
        .unwrap()
        .unwrap();
    stream.set_nodelay(true).unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let Some(Ok(Message::Text(register))) = socket.next().await else {
        panic!("no register frame")
    };
    let register_ms = started.elapsed().as_secs_f64() * 1_000.0;
    assert!(register.as_str().contains("\"register\""));
    let mut mock = Mock {
        socket,
        generation: format!("gen-{}", rand::random::<u32>()),
    };
    let generation = mock.generation.clone();
    mock.send(json!({
        "type": "registered", "generation": generation,
        "heartbeatIntervalMs": 2000, "heartbeatLeaseMs": 15000,
    }))
    .await;
    eprintln!("footprint: start → register frame {register_ms:.1} ms");

    // Core answers the first dirty hint with a capture.
    let outcome = mock
        .refresh("footprint-token-0000", &baseline, &Value::Null)
        .await;
    assert_eq!(outcome["kind"], "complete");
    let mut fingerprint = outcome["capture"]["fingerprint"].clone();
    tokio::time::sleep(Duration::from_secs(5)).await;
    snapshot("idle after registration", pid);

    // Idle: only heartbeats. Count the daemon's wakeups and CPU.
    let (cpu_before, _) = cpu_ms(pid);
    let switches_before = switches(pid);
    let idle_started = Instant::now();
    let mut stray = 0;
    let mut dirty = 0;
    while idle_started.elapsed() < idle {
        let deadline = idle_started + idle;
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, mock.socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                match value["type"].as_str() {
                    Some("heartbeat") => {
                        mock.send(json!({"type": "heartbeat-ack", "generation": generation}))
                            .await
                    }
                    Some("changes-dirty") => dirty += 1,
                    _ => stray += 1,
                }
            }
            Ok(Some(Ok(_))) => stray += 1,
            Ok(other) => panic!("socket ended while idle: {other:?}"),
            Err(_) => break,
        }
    }
    let seconds = idle_started.elapsed().as_secs_f64();
    let (cpu_after, _) = cpu_ms(pid);
    let switches_after = switches(pid);
    // Per thread alive at the end; a thread that exited mid-window is not
    // counted (the daemon's threads are long-lived while idle).
    let mut voluntary = 0;
    let mut involuntary = 0;
    let mut per_thread = Vec::new();
    for (tid, name, after_voluntary, after_involuntary) in &switches_after {
        let (before_voluntary, before_involuntary) = switches_before
            .iter()
            .find(|(other, ..)| other == tid)
            .map_or((0, 0), |(_, _, v, n)| (*v, *n));
        voluntary += after_voluntary - before_voluntary;
        involuntary += after_involuntary - before_involuntary;
        per_thread.push(format!(
            "{name} {:.2}/s",
            (after_voluntary - before_voluntary) as f64 / seconds
        ));
    }
    eprintln!(
        "footprint: idle {seconds:.0} s: CPU {:.1} ms ({:.4}%), voluntary switches {:.2}/s [{}], involuntary {:.3}/s, dirty hints {dirty}, other frames {stray}",
        cpu_after - cpu_before,
        (cpu_after - cpu_before) / (seconds * 10.0),
        voluntary as f64 / seconds,
        per_thread.join(", "),
        involuntary as f64 / seconds,
    );
    snapshot("after idle", pid);

    measure(
        "files.list 2,000 entries",
        pid,
        &mut mock,
        async |mock, index| {
            let tree = mock
                .request(
                    &format!("list-{index}"),
                    json!({"operation": "files.list", "path": "many"}),
                )
                .await;
            assert_eq!(tree["entries"].as_array().unwrap().len(), 2_000);
        },
    )
    .await;
    measure("files.read 1.2 KB", pid, &mut mock, async |mock, index| {
        let read = mock
            .request(
                &format!("read-{index}"),
                json!({"operation": "files.read", "path": "README.md"}),
            )
            .await;
        assert_eq!(read["kind"], "editable");
    })
    .await;
    let unchanged = fingerprint.clone();
    measure(
        "changes probe (unchanged)",
        pid,
        &mut mock,
        async |mock, index| {
            let outcome = mock
                .refresh(
                    &format!("footprint-probe-{index:04}"),
                    &baseline,
                    &unchanged,
                )
                .await;
            assert_eq!(outcome["kind"], "unchanged");
        },
    )
    .await;
    let repo_for_capture = repo.clone();
    measure(
        "changes capture (one edit)",
        pid,
        &mut mock,
        async |mock, index| {
            std::fs::write(
                repo_for_capture.join("src/module_10.rs"),
                format!("edit {index}\n"),
            )
            .unwrap();
            let outcome = mock
                .refresh(
                    &format!("footprint-capture-{index:04}"),
                    &baseline,
                    &fingerprint,
                )
                .await;
            assert_eq!(outcome["kind"], "complete");
            fingerprint = outcome["capture"]["fingerprint"].clone();
        },
    )
    .await;

    // A Terminal opens only after Core has applied the environment.
    let applied = mock
        .request(
            "env-1",
            json!({
                "operation": "environment.activate", "generation": 1,
                "entries": [{"name": "DX_FOOTPRINT", "valueBase64Url": "MQ"}],
                "git": {
                    "authorName": "Ada", "authorEmail": "ada@example.com",
                    "threadUrl": format!("https://dx.example/threads/{THREAD_ID}"),
                    "signingEnabled": false,
                },
            }),
        )
        .await;
    // A guest that ran an earlier measurement already has generation 1.
    assert!(
        matches!(applied["kind"].as_str(), Some("applied" | "unchanged")),
        "{applied}"
    );
    mock.send(json!({
        "type": "terminal.open", "terminalVersion": 1, "terminal": "default",
        "mode": "open-if-absent", "dimensions": {"columns": 80, "rows": 24},
    }))
    .await;
    let ready = mock
        .text(|value| value["type"] == "terminal.resident-state" && value["state"] == "ready")
        .await;
    let resident = ready["residentGeneration"].as_str().unwrap().to_owned();
    let attachment = {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
    };
    mock.send(json!({
        "type": "terminal.attach", "terminalVersion": 1, "terminal": "default",
        "residentGeneration": resident, "attachmentGeneration": attachment,
        "resizeOrdinal": "1", "dimensions": {"columns": 80, "rows": 24},
    }))
    .await;
    mock.text(|value| value["type"] == "terminal.attachment-ready")
        .await;
    // Let the login shell finish its profile before timing echoes.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut sequence = 0;
    measure("terminal echo", pid, &mut mock, async |mock, index| {
        sequence += 1;
        // The quotes keep the typed line from matching the printed one.
        let marker = format!("fp{index:04}x");
        let input = format!("echo fp{index:04}''x\n");
        mock.socket
            .send(Message::Binary(
                terminal_frame(&resident, &attachment, sequence, input.as_bytes()).into(),
            ))
            .await
            .unwrap();
        let expected = format!("{marker}\r\n");
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&seen).contains(&expected) {
            match mock.next(deadline).await {
                Some(Message::Binary(bytes)) if bytes.starts_with(b"DXT1") && bytes[4] == 3 => {
                    seen.extend_from_slice(&bytes[50..]);
                }
                Some(_) => {}
                None => panic!("no echo: {:?}", String::from_utf8_lossy(&seen)),
            }
        }
    })
    .await;
    snapshot("after load", pid);
    drop(daemon);
}
