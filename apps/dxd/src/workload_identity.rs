use crate::protocol::{WorkloadIdentityRequest, WorkloadIdentityResult};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::thread;
use std::time::Duration;

pub const SOCKET_NAME: &str = "workload-identity.sock";
const DEFAULT_SOCKET_PATH: &str = "/home/user/.local/state/dxd/workload-identity.sock";
const MAX_HTTP_REQUEST_BYTES: usize = 80 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 2 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 65_536;
const MAX_HTTP_RESPONSE_BYTES: u64 = 32 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(2);

pub struct LocalRequest {
    pub epoch: u64,
    pub request_id: String,
    pub request: WorkloadIdentityRequest,
    reply: SyncSender<WorkloadIdentityResult>,
}

impl LocalRequest {
    pub fn respond(self, result: WorkloadIdentityResult) {
        let _ = self.reply.try_send(result);
    }
}

pub struct Relay {
    requests: Receiver<LocalRequest>,
}

impl Relay {
    pub fn try_request(&self) -> Result<LocalRequest, TryRecvError> {
        self.requests.try_recv()
    }
}

struct ActiveRequest(Arc<AtomicUsize>);

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn start(
    socket_path: &Path,
    connected: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
) -> io::Result<Relay> {
    let socket_directory = socket_path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    validate_socket_directory(socket_directory)?;
    match fs::symlink_metadata(socket_path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(socket_path)?,
        Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(socket_path)?;
    fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600))?;
    let metadata = fs::symlink_metadata(socket_path)?;
    if !metadata.file_type().is_socket()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let (sender, requests) = sync_channel(MAX_CONCURRENT_REQUESTS);
    let active = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { continue };
            let admitted = active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    (current < MAX_CONCURRENT_REQUESTS).then_some(current + 1)
                })
                .is_ok();
            if !admitted {
                let mut stream = stream;
                let _ = write_error(&mut stream, 503, "unavailable");
                continue;
            }
            let active_request = ActiveRequest(Arc::clone(&active));
            let sender = sender.clone();
            let connected = Arc::clone(&connected);
            let epoch = Arc::clone(&epoch);
            thread::spawn(move || {
                let _active = active_request;
                let _ = handle_stream(stream, &sender, &connected, &epoch);
            });
        }
    });
    Ok(Relay { requests })
}

fn validate_socket_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o777 != 0o700
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn handle_stream(
    mut stream: UnixStream,
    sender: &SyncSender<LocalRequest>,
    connected: &AtomicBool,
    epoch: &AtomicU64,
) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(_) => return write_error(&mut stream, 400, "invalid-request"),
    };
    if !connected.load(Ordering::Acquire) {
        return write_error(&mut stream, 503, "unavailable");
    }
    let request_epoch = epoch.load(Ordering::Acquire);
    if request_epoch == 0 || !connected.load(Ordering::Acquire) {
        return write_error(&mut stream, 503, "unavailable");
    }
    let (reply, response) = sync_channel(1);
    let local = LocalRequest {
        epoch: request_epoch,
        request_id: random_request_id(),
        request,
        reply,
    };
    match sender.try_send(local) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            return write_error(&mut stream, 503, "unavailable");
        }
    }
    let result = response.recv_timeout(REQUEST_TIMEOUT);
    if !connected.load(Ordering::Acquire) || epoch.load(Ordering::Acquire) != request_epoch {
        return write_error(&mut stream, 503, "unavailable");
    }
    match result {
        Ok(WorkloadIdentityResult::Issued { token, expires_at }) => {
            write_token(&mut stream, &token, expires_at)
        }
        Ok(WorkloadIdentityResult::Signed { signature }) => {
            write_result(&mut stream, &WorkloadIdentityResult::Signed { signature })
        }
        Ok(WorkloadIdentityResult::Credential { username, password }) => write_result(
            &mut stream,
            &WorkloadIdentityResult::Credential { username, password },
        ),
        Ok(WorkloadIdentityResult::Unauthorized) => write_error(&mut stream, 403, "unauthorized"),
        Ok(WorkloadIdentityResult::Unavailable) | Err(_) => {
            write_error(&mut stream, 503, "unavailable")
        }
    }
}

fn random_request_id() -> String {
    let mut bytes = [0_u8; 18];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn read_request(stream: &mut UnixStream) -> io::Result<WorkloadIdentityRequest> {
    let mut bytes = Vec::with_capacity(512);
    let mut chunk = [0_u8; 512];
    let end = loop {
        if let Some(end) = header_end(&bytes) {
            break end;
        }
        if bytes.len() >= MAX_HTTP_HEADER_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_HTTP_REQUEST_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
    };
    if end > MAX_HTTP_HEADER_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| io::ErrorKind::InvalidData)?;
    let mut lines = header[..header.len() - 4].split("\r\n");
    if lines.next() != Some("POST /token HTTP/1.1") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut content_length = None;
    let mut content_type = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(io::ErrorKind::InvalidData)?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            content_length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| io::ErrorKind::InvalidData)?,
            );
        } else if name.eq_ignore_ascii_case("content-type") {
            if content_type.is_some() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            content_type = Some(value);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    let body_length = content_length.ok_or(io::ErrorKind::InvalidData)?;
    if body_length == 0
        || body_length > MAX_HTTP_BODY_BYTES
        || content_type != Some("application/json")
        || end + body_length > MAX_HTTP_REQUEST_BYTES
        || bytes.len() > end + body_length
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    while bytes.len() < end + body_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > end + body_length {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    let request: WorkloadIdentityRequest =
        serde_json::from_slice(&bytes[end..]).map_err(|_| io::ErrorKind::InvalidData)?;
    if !request.valid() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(request)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenResponse {
    token: String,
    expires_at: u64,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

fn write_token(stream: &mut UnixStream, token: &str, expires_at: u64) -> io::Result<()> {
    let body = serde_json::to_vec(&TokenResponse {
        token: token.to_owned(),
        expires_at,
    })
    .map_err(|_| io::ErrorKind::InvalidData)?;
    write_response(stream, 200, "OK", &body)
}

fn write_result(stream: &mut UnixStream, result: &WorkloadIdentityResult) -> io::Result<()> {
    let body = serde_json::to_vec(result).map_err(|_| io::ErrorKind::InvalidData)?;
    write_response(stream, 200, "OK", &body)
}

fn write_error(stream: &mut UnixStream, status: u16, error: &str) -> io::Result<()> {
    let label = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        _ => "Service Unavailable",
    };
    let body =
        serde_json::to_vec(&ErrorResponse { error }).map_err(|_| io::ErrorKind::InvalidData)?;
    write_response(stream, status, label, &body)
}

fn write_response(
    stream: &mut UnixStream,
    status: u16,
    label: &str,
    body: &[u8],
) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {label}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nConnection: close\r\n\r\n",
        body.len(),
    )?;
    stream.write_all(body)
}

fn request_token(arguments: &[String]) -> Result<TokenResponse, ()> {
    let mut audience = None;
    let mut ttl_seconds = None;
    let mut index = 1;
    while index < arguments.len() {
        let flag = &arguments[index];
        let value = arguments.get(index + 1).ok_or(())?;
        match flag.as_str() {
            "--audience" if audience.is_none() => audience = Some(value.clone()),
            "--ttl-seconds" if ttl_seconds.is_none() => {
                ttl_seconds = Some(value.parse::<u64>().map_err(|_| ())?)
            }
            _ => return Err(()),
        }
        index += 2;
    }
    let request = WorkloadIdentityRequest {
        audience: Some(audience.ok_or(())?),
        ttl_seconds,
        kind: None,
        payload_base64: None,
        protocol: None,
        host: None,
        path: None,
    };
    if !request.valid() {
        return Err(());
    }
    let socket_path = std::env::var("DX_WORKLOAD_IDENTITY_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_SOCKET_PATH));
    if !socket_path.is_absolute() {
        return Err(());
    }
    let metadata = fs::symlink_metadata(&socket_path).map_err(|_| ())?;
    if !metadata.file_type().is_socket()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(());
    }
    let body = serde_json::to_vec(&request).map_err(|_| ())?;
    let mut stream = UnixStream::connect(socket_path).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| ())?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|_| ())?;
    write!(
        stream,
        "POST /token HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    )
    .map_err(|_| ())?;
    stream.write_all(&body).map_err(|_| ())?;
    let mut response = Vec::new();
    stream
        .take(MAX_HTTP_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|_| ())?;
    if response.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
        return Err(());
    }
    let end = header_end(&response).ok_or(())?;
    let header = std::str::from_utf8(&response[..end]).map_err(|_| ())?;
    if !header.starts_with("HTTP/1.1 200 OK\r\n") {
        return Err(());
    }
    let token: TokenResponse = serde_json::from_slice(&response[end..]).map_err(|_| ())?;
    let result = WorkloadIdentityResult::Issued {
        token: token.token,
        expires_at: token.expires_at,
    };
    if !result.valid() {
        return Err(());
    }
    let WorkloadIdentityResult::Issued { token, expires_at } = result else {
        return Err(());
    };
    Ok(TokenResponse { token, expires_at })
}

pub fn print_token(arguments: &[String]) -> Result<(), ()> {
    let TokenResponse { token, .. } = request_token(arguments)?;
    println!("{token}");
    Ok(())
}

fn request_helper(request: WorkloadIdentityRequest) -> Result<WorkloadIdentityResult, ()> {
    if !request.valid() {
        return Err(());
    }
    let socket_path = std::env::var("DX_WORKLOAD_IDENTITY_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_SOCKET_PATH));
    let metadata = fs::symlink_metadata(&socket_path).map_err(|_| ())?;
    if !socket_path.is_absolute()
        || !metadata.file_type().is_socket()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(());
    }
    let body = serde_json::to_vec(&request).map_err(|_| ())?;
    let mut stream = UnixStream::connect(socket_path).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| ())?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|_| ())?;
    write!(
        stream,
        "POST /token HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    )
    .map_err(|_| ())?;
    stream.write_all(&body).map_err(|_| ())?;
    let mut response = Vec::new();
    stream
        .take(MAX_HTTP_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|_| ())?;
    if response.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
        return Err(());
    }
    let end = header_end(&response).ok_or(())?;
    if !std::str::from_utf8(&response[..end])
        .map_err(|_| ())?
        .starts_with("HTTP/1.1 200 OK\r\n")
    {
        return Err(());
    }
    let result: WorkloadIdentityResult =
        serde_json::from_slice(&response[end..]).map_err(|_| ())?;
    result.valid().then_some(result).ok_or(())
}

pub fn git_sign(arguments: &[String]) -> Result<(), ()> {
    if arguments.len() != 8
        || arguments[1] != "-Y"
        || arguments[2] != "sign"
        || arguments[3] != "-n"
        || arguments[4] != "git"
        || arguments[5] != "-f"
        || arguments[6] != "dx-managed"
        || arguments[7].len() > 4_096
        || !Path::new(&arguments[7]).is_absolute()
    {
        return Err(());
    }
    let payload_path = Path::new(&arguments[7]);
    let metadata = fs::symlink_metadata(payload_path).map_err(|_| ())?;
    if !metadata.file_type().is_file() {
        return Err(());
    }
    let mut payload = Vec::new();
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(payload_path)
        .map_err(|_| ())?
        .take(48_001)
        .read_to_end(&mut payload)
        .map_err(|_| ())?;
    if payload.is_empty() || payload.len() > 48_000 {
        return Err(());
    }
    let result = request_helper(WorkloadIdentityRequest {
        audience: None,
        ttl_seconds: None,
        kind: Some("git-sign".into()),
        payload_base64: Some(URL_SAFE_NO_PAD.encode(payload)),
        protocol: None,
        host: None,
        path: None,
    })?;
    let WorkloadIdentityResult::Signed { signature } = result else {
        return Err(());
    };
    let signature_path = PathBuf::from(format!("{}.sig", arguments[7]));
    let mut signature_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&signature_path)
        .map_err(|_| ())?;
    if signature_file.write_all(signature.as_bytes()).is_err() {
        let _ = fs::remove_file(signature_path);
        return Err(());
    }
    Ok(())
}

pub fn git_credential(arguments: &[String]) -> Result<(), ()> {
    // This helper never stores credentials. Git calls `store` after a
    // successful request and `erase` after a rejected one; both are no-ops.
    let operation = arguments.get(1).map(String::as_str);
    if arguments.len() != 2 || !matches!(operation, Some("get" | "store" | "erase")) {
        return Err(());
    }
    let mut input = String::new();
    std::io::stdin()
        .take(16_385)
        .read_to_string(&mut input)
        .map_err(|_| ())?;
    if operation != Some("get") {
        return Ok(());
    }
    let result = parse_git_credential_request(&input).and_then(request_helper);
    let Ok(WorkloadIdentityResult::Credential { username, password }) = result else {
        eprintln!(
            "dx: Git credentials for this repository are unavailable. Reconnect the repository in dx Settings → Integrations if this persists."
        );
        return Err(());
    };
    println!("username={username}\npassword={password}\n");
    Ok(())
}

/// Reads Git's credential description. Only the protocol, host, and path
/// select authority and must be unique; Git's optional attributes such as
/// `username`, `wwwauth[]`, and `capability[]` are accepted and ignored.
fn parse_git_credential_request(input: &str) -> Result<WorkloadIdentityRequest, ()> {
    if input.len() > 16_384 || !input.is_ascii() {
        return Err(());
    }
    let mut protocol = None;
    let mut host = None;
    let mut path = None;
    for line in input.lines() {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once('=').ok_or(())?;
        let slot = match key {
            "protocol" => &mut protocol,
            "host" => &mut host,
            "path" => &mut path,
            _ => continue,
        };
        if slot.replace(value.to_owned()).is_some() {
            return Err(());
        }
    }
    Ok(WorkloadIdentityRequest {
        audience: None,
        ttl_seconds: None,
        kind: Some("git-credential".into()),
        payload_base64: None,
        protocol,
        host,
        path,
    })
}

const GCP_ID_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:id_token";

#[derive(Debug, Deserialize, Serialize)]
struct GcpCredentialSuccess {
    version: u8,
    success: bool,
    token_type: &'static str,
    id_token: String,
    expiration_time: u64,
}

#[derive(Serialize)]
struct GcpCredentialError<'a> {
    version: u8,
    success: bool,
    code: &'a str,
    message: &'a str,
}

pub fn print_gcp_credential(arguments: &[String]) -> Result<(), ()> {
    match request_token(arguments) {
        Ok(TokenResponse { token, expires_at }) => {
            let output = GcpCredentialSuccess {
                version: 1,
                success: true,
                token_type: GCP_ID_TOKEN_TYPE,
                id_token: token,
                expiration_time: expires_at,
            };
            println!("{}", serde_json::to_string(&output).map_err(|_| ())?);
            Ok(())
        }
        Err(()) => {
            let output = GcpCredentialError {
                version: 1,
                success: false,
                code: "credential_unavailable",
                message: "dx workload identity credential is unavailable.",
            };
            if let Ok(json) = serde_json::to_string(&output) {
                println!("{json}");
            }
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;

    const VALID_BODY: &[u8] = br#"{"audience":"sts.amazonaws.com","ttlSeconds":60}"#;

    #[test]
    fn expired_requests_discard_late_responses_with_bounded_session_memory() {
        let mut pending = crate::PendingWorkloadIdentity::default();
        let now = std::time::Instant::now();
        for index in 0..257 {
            let (reply, response) = sync_channel(1);
            let request_id = format!("request_{index}");
            pending.requests.insert(
                request_id.clone(),
                (
                    now,
                    LocalRequest {
                        epoch: 1,
                        request_id: request_id.clone(),
                        request: serde_json::from_slice(VALID_BODY).unwrap(),
                        reply,
                    },
                ),
            );
            pending.expire(now + crate::WORKLOAD_IDENTITY_REQUEST_LEASE);
            assert!(matches!(
                response.try_recv(),
                Ok(WorkloadIdentityResult::Unavailable)
            ));
            assert!(pending.requests.is_empty());
            assert!(
                pending
                    .respond(&request_id, WorkloadIdentityResult::Unavailable)
                    .is_ok()
            );
        }
        assert_eq!(pending.expired.len(), 256);
        assert!(
            pending
                .respond("request_0", WorkloadIdentityResult::Unavailable)
                .is_ok()
        );
        assert!(
            pending
                .respond("never-issued", WorkloadIdentityResult::Unavailable)
                .is_ok()
        );
        let mut next_session = crate::PendingWorkloadIdentity::default();
        assert!(
            next_session
                .respond("request_256", WorkloadIdentityResult::Unavailable)
                .is_ok()
        );
    }

    fn request_bytes(extra_headers: &str, body: &[u8]) -> Vec<u8> {
        format!(
            "POST /token HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    fn exchange(socket: &Path, request: &[u8]) -> Vec<u8> {
        let mut stream = UnixStream::connect(socket).unwrap();
        stream.write_all(request).unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }

    fn response_text(response: &[u8]) -> &str {
        std::str::from_utf8(response).unwrap()
    }

    fn secure_state_directory() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    #[test]
    fn gcp_success_uses_the_executable_credential_contract() {
        let output = serde_json::to_value(GcpCredentialSuccess {
            version: 1,
            success: true,
            token_type: GCP_ID_TOKEN_TYPE,
            id_token: "abc.def.ghi".into(),
            expiration_time: 123,
        })
        .unwrap();
        assert_eq!(
            output,
            serde_json::json!({
                "version": 1,
                "success": true,
                "token_type": "urn:ietf:params:oauth:token-type:id_token",
                "id_token": "abc.def.ghi",
                "expiration_time": 123
            })
        );
    }

    #[test]
    fn helper_requires_an_explicit_valid_audience_and_ttl() {
        for arguments in [
            vec!["gcp-credential"],
            vec!["gcp-credential", "--audience"],
            vec!["gcp-credential", "--audience", "contains space"],
            vec![
                "gcp-credential",
                "--audience",
                "urn:dx:gcp:test",
                "--ttl-seconds",
                "59",
            ],
            vec![
                "gcp-credential",
                "--audience",
                "urn:dx:gcp:test",
                "--ttl-seconds",
                "not-a-number",
            ],
        ] {
            let arguments = arguments.into_iter().map(String::from).collect::<Vec<_>>();
            assert!(request_token(&arguments).is_err());
        }
    }

    #[test]
    fn git_helper_requests_are_narrow_and_bounded() {
        let sign = WorkloadIdentityRequest {
            audience: None,
            ttl_seconds: None,
            kind: Some("git-sign".into()),
            payload_base64: Some(URL_SAFE_NO_PAD.encode(b"commit payload")),
            protocol: None,
            host: None,
            path: None,
        };
        assert!(sign.valid());
        let credential = WorkloadIdentityRequest {
            audience: None,
            ttl_seconds: None,
            kind: Some("git-credential".into()),
            payload_base64: None,
            protocol: Some("https".into()),
            host: Some("github.com".into()),
            path: Some("owner/repository.git".into()),
        };
        assert!(credential.valid());
        assert!(
            WorkloadIdentityRequest {
                host: Some("git.example.invalid:8443".into()),
                ..credential.clone()
            }
            .valid()
        );
        assert!(
            !WorkloadIdentityRequest {
                host: Some("github.com:port".into()),
                ..credential
            }
            .valid()
        );
    }

    #[test]
    fn git_credential_requests_ignore_optional_git_attributes() {
        let request = parse_git_credential_request(
            "capability[]=authtype\nprotocol=https\nhost=github.com\npath=owner/repository.git\nusername=x-access-token\nwwwauth[]=Basic realm=\"GitHub\"\nwwwauth[]=Bearer\n\n",
        )
        .unwrap();
        assert_eq!(request.kind.as_deref(), Some("git-credential"));
        assert_eq!(request.protocol.as_deref(), Some("https"));
        assert_eq!(request.host.as_deref(), Some("github.com"));
        assert_eq!(request.path.as_deref(), Some("owner/repository.git"));
        assert!(request.valid());
        for invalid in [
            "protocol=https\nprotocol=http\nhost=github.com\npath=a/b.git\n",
            "protocol=https\nhost=github.com\nnot-an-attribute\n",
            "protocol=https\nhost=gïthub.com\npath=a/b.git\n",
        ] {
            assert!(parse_git_credential_request(invalid).is_err());
        }
        assert!(
            !parse_git_credential_request("protocol=https\nhost=github.com\n")
                .unwrap()
                .valid()
        );
    }

    #[test]
    fn parses_only_bounded_exact_requests() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let body = br#"{"audience":"sts.amazonaws.com","ttlSeconds":60}"#;
        write!(
            client,
            "POST /token HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        client.write_all(body).unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(
            read_request(&mut server).unwrap(),
            WorkloadIdentityRequest {
                audience: Some("sts.amazonaws.com".into()),
                ttl_seconds: Some(60),
                kind: None,
                payload_base64: None,
                protocol: None,
                host: None,
                path: None,
            }
        );

        let (mut client, mut server) = UnixStream::pair().unwrap();
        let body = br#"{"audience":"contains space"}"#;
        write!(
            client,
            "POST /token HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        client.write_all(body).unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert!(read_request(&mut server).is_err());
    }

    #[test]
    fn start_requires_a_private_state_directory_and_creates_a_private_socket() {
        let state = secure_state_directory();
        let socket = state.path().join(SOCKET_NAME);
        let _relay = start(
            &socket,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
        .unwrap();
        let metadata = fs::symlink_metadata(socket).unwrap();
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);

        let unsafe_state = tempfile::tempdir().unwrap();
        fs::set_permissions(unsafe_state.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            start(
                &unsafe_state.path().join(SOCKET_NAME),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicU64::new(0)),
            )
            .is_err()
        );
        assert!(!unsafe_state.path().join(SOCKET_NAME).exists());
    }

    #[test]
    fn disconnected_requests_are_uncacheable_and_unavailable() {
        let state = secure_state_directory();
        let socket = state.path().join(SOCKET_NAME);
        let _relay = start(
            &socket,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
        .unwrap();
        let response = exchange(&socket, &request_bytes("", VALID_BODY));
        let response = response_text(&response);
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(response.contains("\r\nCache-Control: no-store\r\n"));
        assert!(response.contains("\r\nPragma: no-cache\r\n"));
    }

    #[test]
    fn connected_requests_traverse_the_relay_and_map_issued_responses() {
        let state = secure_state_directory();
        let connected = Arc::new(AtomicBool::new(true));
        let epoch = Arc::new(AtomicU64::new(41));
        let socket = state.path().join(SOCKET_NAME);
        let relay = start(&socket, connected, epoch).unwrap();
        let client = thread::spawn(move || exchange(&socket, &request_bytes("", VALID_BODY)));

        let local = loop {
            match relay.try_request() {
                Ok(request) => break request,
                Err(TryRecvError::Empty) => thread::yield_now(),
                Err(error) => panic!("relay disconnected: {error}"),
            }
        };
        assert_eq!(local.epoch, 41);
        assert_eq!(local.request.audience.as_deref(), Some("sts.amazonaws.com"));
        assert!(!local.request_id.is_empty());
        local.respond(WorkloadIdentityResult::Issued {
            token: "abc.def.ghi".into(),
            expires_at: 123,
        });

        let response = client.join().unwrap();
        let response = response_text(&response);
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with(r#"{"token":"abc.def.ghi","expiresAt":123}"#));
    }

    #[test]
    fn response_from_a_stale_epoch_is_fenced() {
        let state = secure_state_directory();
        let connected = Arc::new(AtomicBool::new(true));
        let epoch = Arc::new(AtomicU64::new(7));
        let socket = state.path().join(SOCKET_NAME);
        let relay = start(&socket, Arc::clone(&connected), Arc::clone(&epoch)).unwrap();
        let client = thread::spawn(move || exchange(&socket, &request_bytes("", VALID_BODY)));
        let local = loop {
            if let Ok(request) = relay.try_request() {
                break request;
            }
            thread::yield_now();
        };
        epoch.store(8, Ordering::Release);
        local.respond(WorkloadIdentityResult::Issued {
            token: "stale.token.value".into(),
            expires_at: 123,
        });

        let response = client.join().unwrap();
        assert!(response_text(&response).starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    }

    #[test]
    fn rejects_ambiguous_or_oversized_http_requests() {
        let cases = [
            request_bytes("Content-Length: 49\r\n", VALID_BODY),
            request_bytes("Transfer-Encoding: chunked\r\n", VALID_BODY),
            b"POST /token HTTP/1.1\r\nMalformed\r\n\r\n".to_vec(),
            format!(
                "POST /token HTTP/1.1\r\nX-Fill: {}\r\n\r\n",
                "x".repeat(MAX_HTTP_HEADER_BYTES)
            )
            .into_bytes(),
            format!(
                "POST /token HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                MAX_HTTP_BODY_BYTES + 1
            )
            .into_bytes(),
        ];

        for bytes in cases {
            let (mut client, mut server) = UnixStream::pair().unwrap();
            client.write_all(&bytes).unwrap();
            client.shutdown(std::net::Shutdown::Write).unwrap();
            assert!(read_request(&mut server).is_err());
        }
    }
}
