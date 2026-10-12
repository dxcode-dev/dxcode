//! `dxd files get` end to end: the real binary asks a mock Core for an
//! attachment with the Thread's daemon key, then downloads it from the URL
//! Core returns.
//!
//! Ways it could fail, each covered below: it asks the wrong path or Thread;
//! it omits or alters the daemon key; it leaks the key to storage; it drops
//! the key on Core's own (local) content route; a refused or short download
//! still leaves a file; a file name escapes the working directory; it writes
//! to a missing directory; it prints something other than the saved path.

use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::thread;

const DXD: &str = env!("CARGO_BIN_EXE_dxd");
const THREAD_ID: &str = "thr_0123abcd-4567-4abc-8def-0123456789ab";
const KEY: &str = "dxd_integration-test-key-0123456789";
const ID: &str = "att_0123456789abcdef0123456789abcdef";

struct Seen {
    request_line: String,
    authorization: Option<String>,
}

/// Serve `responses` in order, one request each, reporting what arrived.
fn serve(responses: Vec<(u16, Vec<u8>)>) -> (u16, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for (status, body) in responses {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut authorization = None;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("authorization")
                {
                    authorization = Some(value.trim().to_owned());
                }
            }
            sender
                .send(Seen {
                    request_line: request_line.trim().to_owned(),
                    authorization,
                })
                .unwrap();
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            let _ = stream.flush();
            let mut rest = Vec::new();
            let _ = reader.read_to_end(&mut rest);
        }
    });
    (port, receiver)
}

fn descriptor(url: &str, name: &str, size: usize) -> Vec<u8> {
    json!({ "url": url, "name": name, "size": size })
        .to_string()
        .into_bytes()
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

fn files_get(config: &Path, cwd: &Path, arguments: &[&str]) -> Output {
    Command::new(DXD)
        .current_dir(cwd)
        .env_clear()
        .env("DXD_CONFIG", config)
        .args(["files", "get"])
        .args(arguments)
        .output()
        .unwrap()
}

fn leftovers(directory: &Path) -> usize {
    std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".dxd-download-")
        })
        .count()
}

#[test]
fn downloads_from_storage_without_sending_the_key_there() {
    let root = tempfile::tempdir().unwrap();
    let bytes = b"\x89PNG attachment bytes".to_vec();
    let (storage, storage_requests) = serve(vec![(200, bytes.clone())]);
    let signed = format!("http://127.0.0.1:{storage}/bucket/key?X-Amz-Signature=abc");
    let (core, core_requests) = serve(vec![(200, descriptor(&signed, "shot.png", bytes.len()))]);
    let config = write_config(root.path(), core);
    let output = root.path().join("attachments/nested/shot.png");
    let url = format!("https://dx.example/v1/attachments/{ID}/shot.png");
    let result = files_get(
        &config,
        root.path(),
        &[&url, "-o", output.to_str().unwrap()],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let asked = core_requests.recv().unwrap();
    assert_eq!(
        asked.request_line,
        format!("GET /v1/dxd/{THREAD_ID}/attachments/{ID} HTTP/1.1")
    );
    assert_eq!(asked.authorization, Some(format!("Bearer {KEY}")));
    let fetched = storage_requests.recv().unwrap();
    assert_eq!(
        fetched.request_line,
        "GET /bucket/key?X-Amz-Signature=abc HTTP/1.1"
    );
    assert_eq!(fetched.authorization, None);
    assert_eq!(std::fs::read(&output).unwrap(), bytes);
    assert_eq!(
        String::from_utf8(result.stdout).unwrap().trim(),
        std::fs::canonicalize(&output).unwrap().to_str().unwrap()
    );
}

#[test]
fn keeps_the_key_on_cores_own_content_route() {
    let root = tempfile::tempdir().unwrap();
    let content = format!("/v1/dxd/{THREAD_ID}/attachments/{ID}?content=1");
    let (core, core_requests) = serve(vec![
        (200, descriptor(&content, "notes.txt", 5)),
        (200, b"hello".to_vec()),
    ]);
    let config = write_config(root.path(), core);
    let result = files_get(&config, root.path(), &[ID]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    core_requests.recv().unwrap();
    let fetched = core_requests.recv().unwrap();
    assert_eq!(fetched.request_line, format!("GET {content} HTTP/1.1"));
    assert_eq!(fetched.authorization, Some(format!("Bearer {KEY}")));
    // A bare id names the file from Core's description.
    assert_eq!(
        std::fs::read(root.path().join("notes.txt")).unwrap(),
        b"hello"
    );
}

#[test]
fn names_the_file_safely_inside_the_working_directory() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let (storage, _storage_requests) = serve(vec![(200, b"bytes".to_vec())]);
    let signed = format!("http://127.0.0.1:{storage}/bucket/key");
    let (core, _core_requests) = serve(vec![(200, descriptor(&signed, "../escaped", 5))]);
    let config = write_config(root.path(), core);
    let escape = format!("https://dx.example/v1/attachments/{ID}/..%2F..%2Fescaped");
    let result = files_get(&config, &work, &[&escape]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(work.join(ID)).unwrap(), b"bytes");
    assert!(!root.path().join("escaped").exists());
}

#[test]
fn a_refused_or_short_download_leaves_no_file() {
    let root = tempfile::tempdir().unwrap();
    let (core, _core_requests) = serve(vec![(404, Vec::new())]);
    let config = write_config(root.path(), core);
    let output = root.path().join("missing.png");
    let result = files_get(&config, root.path(), &[ID, "-o", output.to_str().unwrap()]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("no such attachment"));
    assert!(!output.exists());

    let (storage, _storage_requests) = serve(vec![(200, b"short".to_vec())]);
    let signed = format!("http://127.0.0.1:{storage}/bucket/key");
    let (core, _core_requests) = serve(vec![(200, descriptor(&signed, "long.bin", 50))]);
    let config = write_config(root.path(), core);
    let result = files_get(&config, root.path(), &[ID, "-o", output.to_str().unwrap()]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("ended early"));
    assert!(!output.exists());
    assert_eq!(leftovers(root.path()), 0);
}

#[test]
fn rejects_an_argument_that_names_no_attachment() {
    let root = tempfile::tempdir().unwrap();
    let config = write_config(root.path(), 9);
    let result = files_get(&config, root.path(), &["https://example.com/image.png"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("not a dx attachment"));
}
