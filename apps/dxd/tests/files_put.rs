//! `dxd files put` and `dxd files get` on Thread storage, end to end: the
//! real binary asks a mock Core with the Thread's daemon key, PUTs each part
//! to the presigned URL Core returns, and completes the upload.
//!
//! Ways it could fail, each covered below: it asks the wrong path or Thread;
//! it omits the daemon key from Core or sends it to storage; it cuts parts
//! at the wrong offsets or sizes, or sends them out of order; it completes
//! without the parts' ETags; it uploads a missing, empty, or directory path;
//! it reports success, or prints a URL, after Core or storage refused; it
//! prints something other than one URL per file; `files get` does not
//! recognize a storage URL.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::thread;

const DXD: &str = env!("CARGO_BIN_EXE_dxd");
const THREAD_ID: &str = "thr_0123abcd-4567-4abc-8def-0123456789ab";
const SOURCE_THREAD_ID: &str = "thr_99999999-4567-4abc-8def-0123456789ab";
const KEY: &str = "dxd_integration-test-key-0123456789";
const FILE_ID: &str = "tsf_0123456789abcdef0123456789abcdef";
const SECOND_ID: &str = "tsf_fedcba9876543210fedcba9876543210";

#[derive(Debug)]
struct Seen {
    method: String,
    target: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

/// Serve `responses` in order, one request each, reporting what arrived.
/// Each response is a status, extra headers, and a body.
fn serve(
    responses: Vec<(u16, Vec<(&'static str, String)>, Vec<u8>)>,
) -> (u16, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for (status, headers, body) in responses {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut authorization = None;
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("authorization") {
                        authorization = Some(value.trim().to_owned());
                    }
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut request_body = vec![0; length];
            reader.read_exact(&mut request_body).unwrap();
            let mut parts = request_line.split_whitespace();
            sender
                .send(Seen {
                    method: parts.next().unwrap_or_default().to_owned(),
                    target: parts.next().unwrap_or_default().to_owned(),
                    authorization,
                    body: request_body,
                })
                .unwrap();
            let mut stream = stream;
            let extra: String = headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect();
            write!(
                stream,
                "HTTP/1.1 {status} X\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            let _ = stream.flush();
        }
    });
    (port, receiver)
}

fn write_config(directory: &Path, port: u16) -> std::path::PathBuf {
    let config = directory.join("config.json");
    std::fs::write(
        &config,
        json!({
            "version": 2,
            "endpoint": format!("ws://127.0.0.1:{port}/v1/dxd/{THREAD_ID}"),
            "threadId": THREAD_ID,
            "apiKey": KEY,
            "workspaceRoot": directory.to_str().unwrap(),
        })
        .to_string(),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    config
}

fn files(config: &Path, cwd: &Path, arguments: &[&str]) -> Output {
    Command::new(DXD)
        .current_dir(cwd)
        .env_clear()
        .env("DXD_CONFIG", config)
        .arg("files")
        .args(arguments)
        .output()
        .unwrap()
}

fn created(id: &str, storage: u16, part_size: usize, sizes: &[usize]) -> Vec<u8> {
    json!({
        "id": id,
        "partSize": part_size,
        "partCount": sizes.len(),
        "parts": sizes.iter().enumerate().map(|(index, _)| json!({
            "partNumber": index + 1,
            "url": format!("http://127.0.0.1:{storage}/bucket/{id}?partNumber={}&X-Amz-Signature=sig", index + 1),
        })).collect::<Vec<_>>(),
    })
    .to_string()
    .into_bytes()
}

fn stored(id: &str, name: &str, size: usize) -> Vec<u8> {
    json!({
        "id": id,
        "threadId": THREAD_ID,
        "name": name,
        "mimeType": "image/png",
        "size": size,
        "url": format!("https://dx.example/v1/threads/{THREAD_ID}/storage/{id}/{name}"),
        "createdAt": 1,
    })
    .to_string()
    .into_bytes()
}

fn etag(value: &str) -> Vec<(&'static str, String)> {
    vec![("ETag", format!("\"{value}\""))]
}

#[test]
fn uploads_each_file_in_parts_straight_to_storage_and_prints_its_url() {
    let root = tempfile::tempdir().unwrap();
    let shot: Vec<u8> = (0..10u8).collect();
    std::fs::write(root.path().join("login shot.png"), &shot).unwrap();
    std::fs::create_dir_all(root.path().join("rec")).unwrap();
    std::fs::write(root.path().join("rec/flow.webm"), b"webm").unwrap();
    let (storage, storage_requests) = serve(vec![
        (200, etag("e1"), Vec::new()),
        (200, etag("e2"), Vec::new()),
        (200, etag("e3"), Vec::new()),
        (200, etag("w1"), Vec::new()),
    ]);
    let (core, core_requests) = serve(vec![
        (201, vec![], created(FILE_ID, storage, 4, &[4, 4, 2])),
        (200, vec![], stored(FILE_ID, "login%20shot.png", 10)),
        (201, vec![], created(SECOND_ID, storage, 4, &[4])),
        (200, vec![], stored(SECOND_ID, "flow.webm", 4)),
    ]);
    let config = write_config(root.path(), core);
    let result = files(
        &config,
        root.path(),
        &["put", "login shot.png", "rec/flow.webm"],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    // Create: this Thread's storage, with its key, naming the file.
    let create = core_requests.recv().unwrap();
    assert_eq!(create.method, "POST");
    assert_eq!(create.target, format!("/v1/dxd/{THREAD_ID}/storage"));
    assert_eq!(create.authorization, Some(format!("Bearer {KEY}")));
    let body: Value = serde_json::from_slice(&create.body).unwrap();
    assert_eq!(
        body,
        json!({ "name": "login shot.png", "mimeType": "image/png", "size": 10 })
    );

    // Parts: in order, at the right offsets and sizes, without the key.
    for (number, expected) in [(1, &shot[0..4]), (2, &shot[4..8]), (3, &shot[8..10])] {
        let part = storage_requests.recv().unwrap();
        assert_eq!(part.method, "PUT");
        assert_eq!(
            part.target,
            format!("/bucket/{FILE_ID}?partNumber={number}&X-Amz-Signature=sig")
        );
        assert_eq!(part.authorization, None);
        assert_eq!(part.body, expected);
    }

    // Complete: every part's ETag, in order.
    let complete = core_requests.recv().unwrap();
    assert_eq!(complete.method, "POST");
    assert_eq!(
        complete.target,
        format!("/v1/dxd/{THREAD_ID}/storage/{FILE_ID}/complete")
    );
    assert_eq!(complete.authorization, Some(format!("Bearer {KEY}")));
    let body: Value = serde_json::from_slice(&complete.body).unwrap();
    assert_eq!(
        body,
        json!({ "parts": [
            { "partNumber": 1, "etag": "\"e1\"" },
            { "partNumber": 2, "etag": "\"e2\"" },
            { "partNumber": 3, "etag": "\"e3\"" },
        ] })
    );

    // The second file declares its own type.
    let create = core_requests.recv().unwrap();
    let body: Value = serde_json::from_slice(&create.body).unwrap();
    assert_eq!(
        body,
        json!({ "name": "flow.webm", "mimeType": "video/webm", "size": 4 })
    );
    assert_eq!(storage_requests.recv().unwrap().body, b"webm");

    // One URL per file, in order, and nothing else.
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        format!(
            "https://dx.example/v1/threads/{THREAD_ID}/storage/{FILE_ID}/login%20shot.png\nhttps://dx.example/v1/threads/{THREAD_ID}/storage/{SECOND_ID}/flow.webm\n"
        )
    );
}

#[test]
fn refuses_missing_empty_and_directory_paths_before_asking_core() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("empty.png"), b"").unwrap();
    std::fs::create_dir_all(root.path().join("folder")).unwrap();
    // Port 9 answers nothing: any request would fail differently.
    let config = write_config(root.path(), 9);
    for (path, message) in [
        ("missing.png", "cannot read missing.png"),
        ("empty.png", "empty.png is empty"),
        ("folder", "folder is not a file"),
    ] {
        let result = files(&config, root.path(), &["put", path]);
        assert!(!result.status.success());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(message),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(result.stdout.is_empty());
    }
    let usage = files(&config, root.path(), &["put"]);
    assert!(!usage.status.success());
    assert!(String::from_utf8_lossy(&usage.stderr).contains("usage: dxd files put"));
}

#[test]
fn prints_nothing_when_core_or_storage_refuses() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("shot.png"), b"12345").unwrap();

    let (core, _core_requests) = serve(vec![(401, vec![], Vec::new())]);
    let config = write_config(root.path(), core);
    let result = files(&config, root.path(), &["put", "shot.png"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("daemon key was rejected"));
    assert!(result.stdout.is_empty());

    // A refused part stops the upload: no completion is sent.
    let (storage, _storage_requests) = serve(vec![(403, vec![], Vec::new()); 3]);
    let (core, core_requests) = serve(vec![
        (201, vec![], created(FILE_ID, storage, 5, &[5])),
        (200, vec![], stored(FILE_ID, "shot.png", 5)),
    ]);
    let config = write_config(root.path(), core);
    let result = files(&config, root.path(), &["put", "shot.png"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("storage refused part 1"));
    assert!(result.stdout.is_empty());
    core_requests.recv().unwrap();
    assert!(
        core_requests
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err()
    );
}

#[test]
fn gets_a_stored_file_from_another_thread_by_its_url() {
    let root = tempfile::tempdir().unwrap();
    let bytes = b"\x89PNG stored bytes".to_vec();
    let (storage, storage_requests) = serve(vec![(200, vec![], bytes.clone())]);
    let signed = format!("http://127.0.0.1:{storage}/bucket/key?X-Amz-Signature=abc");
    let descriptor = json!({ "url": signed, "name": "shot.png", "size": bytes.len() })
        .to_string()
        .into_bytes();
    let (core, core_requests) = serve(vec![(200, vec![], descriptor)]);
    let config = write_config(root.path(), core);
    let url =
        format!("https://dx.example/v1/threads/{SOURCE_THREAD_ID}/storage/{FILE_ID}/shot.png");
    let result = files(&config, root.path(), &["get", &url]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let asked = core_requests.recv().unwrap();
    assert_eq!(asked.method, "GET");
    // Asked through this Thread's own daemon route, with its own key.
    assert_eq!(
        asked.target,
        format!("/v1/dxd/{THREAD_ID}/storage/{FILE_ID}")
    );
    assert_eq!(asked.authorization, Some(format!("Bearer {KEY}")));
    assert_eq!(storage_requests.recv().unwrap().authorization, None);
    assert_eq!(std::fs::read(root.path().join("shot.png")).unwrap(), bytes);
}
