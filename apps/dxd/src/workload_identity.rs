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
use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread;
use std::time::Duration;
use tokio::sync::mpsc::{Receiver, Sender, channel, error::TrySendError};

pub const SOCKET_NAME: &str = "workload-identity.sock";
const DEFAULT_SOCKET_PATH: &str = "/home/user/.local/state/dxd/workload-identity.sock";
const MAX_HTTP_REQUEST_BYTES: usize = 80 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 2 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 65_536;
const MAX_HTTP_RESPONSE_BYTES: u64 = 32 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a helper keeps asking while dxd's connection to Core is down
/// (#2049): a dropped socket is back within about 3 s and a restarted
/// daemon within about 2 s, so this covers several redials, not an outage.
const RECONNECT_WAIT: Duration = Duration::from_secs(30);
const RECONNECT_POLL: Duration = Duration::from_millis(250);
/// The socket's answer when no connection carried the request to Core, or
/// the connection ended before Core answered: asking again is safe.
const DISCONNECTED: &str = "disconnected";

/// What became of a request the daemon relayed.
#[derive(Debug)]
pub enum Relayed {
    /// Core answered on the connection that carried the request.
    Answered(WorkloadIdentityResult),
    /// No answer will come: the connection ended, or Core did not answer
    /// within the request lease. Core never saw it, or its answer is lost.
    Lost,
}

pub struct LocalRequest {
    pub epoch: u64,
    pub request_id: String,
    pub request: WorkloadIdentityRequest,
    reply: SyncSender<Relayed>,
}

impl LocalRequest {
    pub fn respond(self, result: WorkloadIdentityResult) {
        let _ = self.reply.try_send(Relayed::Answered(result));
    }

    /// The request will get no answer from Core; the helper asks again.
    pub fn lost(self) {
        let _ = self.reply.try_send(Relayed::Lost);
    }
}

pub struct Relay {
    requests: Receiver<LocalRequest>,
}

impl Relay {
    /// Resolve with the next helper request; pending forever once closed.
    pub async fn next(&mut self) -> LocalRequest {
        match self.requests.recv().await {
            Some(request) => request,
            None => std::future::pending().await,
        }
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
    let (sender, requests) = channel(MAX_CONCURRENT_REQUESTS);
    let active = Arc::new(AtomicUsize::new(0));
    listener.set_nonblocking(true)?;
    let listener = tokio::net::UnixListener::from_std(listener)?;
    // Accepting is readiness on the daemon loop's thread; each admitted
    // request is served on its own short-lived thread.
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
    sender: &Sender<LocalRequest>,
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
        return write_error(&mut stream, 503, DISCONNECTED);
    }
    let request_epoch = epoch.load(Ordering::Acquire);
    if request_epoch == 0 || !connected.load(Ordering::Acquire) {
        return write_error(&mut stream, 503, DISCONNECTED);
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
        Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => {
            return write_error(&mut stream, 503, DISCONNECTED);
        }
    }
    let result = response.recv_timeout(REQUEST_TIMEOUT);
    if !connected.load(Ordering::Acquire) || epoch.load(Ordering::Acquire) != request_epoch {
        return write_error(&mut stream, 503, DISCONNECTED);
    }
    match result {
        Ok(Relayed::Answered(WorkloadIdentityResult::Issued { token, expires_at })) => {
            write_token(&mut stream, &token, expires_at)
        }
        Ok(Relayed::Answered(WorkloadIdentityResult::Signed { signature })) => {
            write_result(&mut stream, &WorkloadIdentityResult::Signed { signature })
        }
        Ok(Relayed::Answered(WorkloadIdentityResult::Credential { username, password })) => {
            write_result(
                &mut stream,
                &WorkloadIdentityResult::Credential { username, password },
            )
        }
        Ok(Relayed::Answered(WorkloadIdentityResult::Unauthorized)) => {
            write_error(&mut stream, 403, "unauthorized")
        }
        Ok(Relayed::Answered(WorkloadIdentityResult::Unavailable)) => {
            write_error(&mut stream, 503, "unavailable")
        }
        Ok(Relayed::Lost) | Err(_) => write_error(&mut stream, 503, DISCONNECTED),
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

/// Why a helper got no credential.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HelperError {
    /// Not a request dx serves.
    Invalid,
    /// dxd's connection to Core stayed down for the whole `RECONNECT_WAIT`.
    Disconnected,
    /// Core refused: the owner's connection is missing or was revoked.
    Refused,
    /// Core answered, but could not issue one now.
    Unavailable,
}

enum Attempt {
    Answered(Vec<u8>),
    Failed(HelperError),
}

fn socket_path() -> Result<PathBuf, HelperError> {
    let path = std::env::var("DX_WORKLOAD_IDENTITY_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_SOCKET_PATH));
    path.is_absolute()
        .then_some(path)
        .ok_or(HelperError::Invalid)
}

/// One request over the daemon's socket. Anything that keeps the request
/// from reaching Core, or Core's answer from coming back, is `Disconnected`:
/// no socket (a daemon restarting), one nobody listens on (a daemon that
/// died), or the daemon's own answer that its connection is down.
fn attempt(socket_path: &Path, body: &[u8]) -> Attempt {
    let disconnected = Attempt::Failed(HelperError::Disconnected);
    // A starting daemon binds the socket before it narrows its mode; one
    // that never becomes private is never used.
    let Ok(metadata) = fs::symlink_metadata(socket_path) else {
        return disconnected;
    };
    if !metadata.file_type().is_socket()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return disconnected;
    }
    let Ok(mut stream) = UnixStream::connect(socket_path) else {
        return disconnected;
    };
    // The daemon answers within its own request timeout.
    if stream
        .set_read_timeout(Some(REQUEST_TIMEOUT + IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .is_err()
    {
        return disconnected;
    }
    let sent = write!(
        stream,
        "POST /token HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    )
    .and_then(|()| stream.write_all(body));
    if sent.is_err() {
        return disconnected;
    }
    let mut response = Vec::new();
    if stream
        .take(MAX_HTTP_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .is_err()
    {
        return disconnected;
    }
    if response.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
        return Attempt::Failed(HelperError::Unavailable);
    }
    let Some(end) = header_end(&response) else {
        return Attempt::Failed(HelperError::Unavailable);
    };
    let Ok(header) = std::str::from_utf8(&response[..end]) else {
        return Attempt::Failed(HelperError::Unavailable);
    };
    if header.starts_with("HTTP/1.1 200 OK\r\n") {
        return Attempt::Answered(response[end..].to_vec());
    }
    if header.starts_with("HTTP/1.1 403 ") {
        return Attempt::Failed(HelperError::Refused);
    }
    if header.starts_with("HTTP/1.1 400 ") {
        return Attempt::Failed(HelperError::Invalid);
    }
    #[derive(Deserialize)]
    struct Error {
        error: String,
    }
    match serde_json::from_slice::<Error>(&response[end..]) {
        Ok(Error { error }) if header.starts_with("HTTP/1.1 503 ") && error == DISCONNECTED => {
            disconnected
        }
        _ => Attempt::Failed(HelperError::Unavailable),
    }
}

/// Asks the daemon, and keeps asking for up to `RECONNECT_WAIT` while its
/// connection to Core is down (#2049), so a dropped connection or a
/// restarting daemon costs a few seconds instead of the command. Every
/// request is safe to repeat: each only asks Core to issue something.
fn exchange(body: &[u8]) -> Result<Vec<u8>, HelperError> {
    let socket_path = socket_path()?;
    let deadline = std::time::Instant::now() + RECONNECT_WAIT;
    let mut announced = false;
    loop {
        match attempt(&socket_path, body) {
            Attempt::Answered(body) => return Ok(body),
            Attempt::Failed(HelperError::Disconnected) => {}
            Attempt::Failed(error) => return Err(error),
        }
        if std::time::Instant::now() + RECONNECT_POLL >= deadline {
            return Err(HelperError::Disconnected);
        }
        if !announced {
            announced = true;
            eprintln!(
                "dx: dx's connection to this Orb dropped; retrying for up to {} s.",
                RECONNECT_WAIT.as_secs()
            );
        }
        thread::sleep(RECONNECT_POLL);
    }
}

fn request_token(arguments: &[String]) -> Result<TokenResponse, HelperError> {
    let mut audience = None;
    let mut ttl_seconds = None;
    let mut index = 1;
    while index < arguments.len() {
        let flag = &arguments[index];
        let value = arguments.get(index + 1).ok_or(HelperError::Invalid)?;
        match flag.as_str() {
            "--audience" if audience.is_none() => audience = Some(value.clone()),
            "--ttl-seconds" if ttl_seconds.is_none() => {
                ttl_seconds = Some(value.parse::<u64>().map_err(|_| HelperError::Invalid)?)
            }
            _ => return Err(HelperError::Invalid),
        }
        index += 2;
    }
    let request = WorkloadIdentityRequest {
        audience: Some(audience.ok_or(HelperError::Invalid)?),
        ttl_seconds,
        kind: None,
        payload_base64: None,
        protocol: None,
        host: None,
        path: None,
    };
    if !request.valid() {
        return Err(HelperError::Invalid);
    }
    let body = serde_json::to_vec(&request).map_err(|_| HelperError::Invalid)?;
    let token: TokenResponse =
        serde_json::from_slice(&exchange(&body)?).map_err(|_| HelperError::Unavailable)?;
    let result = WorkloadIdentityResult::Issued {
        token: token.token,
        expires_at: token.expires_at,
    };
    if !result.valid() {
        return Err(HelperError::Unavailable);
    }
    let WorkloadIdentityResult::Issued { token, expires_at } = result else {
        return Err(HelperError::Unavailable);
    };
    Ok(TokenResponse { token, expires_at })
}

pub fn print_token(arguments: &[String]) -> Result<(), ()> {
    let TokenResponse { token, .. } = request_token(arguments).map_err(|_| ())?;
    println!("{token}");
    Ok(())
}

fn request_helper(request: WorkloadIdentityRequest) -> Result<WorkloadIdentityResult, HelperError> {
    if !request.valid() {
        return Err(HelperError::Invalid);
    }
    let body = serde_json::to_vec(&request).map_err(|_| HelperError::Invalid)?;
    let result: WorkloadIdentityResult =
        serde_json::from_slice(&exchange(&body)?).map_err(|_| HelperError::Unavailable)?;
    result
        .valid()
        .then_some(result)
        .ok_or(HelperError::Unavailable)
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
    });
    if result == Err(HelperError::Disconnected) {
        eprintln!("{}", disconnected_message("sign this commit"));
    }
    let WorkloadIdentityResult::Signed { signature } = result.map_err(|_| ())? else {
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
    let request = parse_git_credential_request(&input).map_err(|()| HelperError::Invalid);
    let host = request
        .as_ref()
        .ok()
        .and_then(|request| request.host.clone())
        .filter(|host| host.len() <= 255 && host.bytes().all(|byte| byte.is_ascii_graphic()))
        .unwrap_or_else(|| "this repository".into());
    let failure = match request.and_then(request_helper) {
        Ok(WorkloadIdentityResult::Credential { username, password }) => {
            println!("username={username}\npassword={password}\n");
            return Ok(());
        }
        Ok(_) | Err(HelperError::Unavailable) => format!(
            "dx: dx could not issue Git credentials for {host} just now; try again in a moment."
        ),
        Err(HelperError::Disconnected) => disconnected_message("give Git credentials"),
        // Only Core's refusal means the owner's connection itself is gone.
        Err(HelperError::Refused) => format!(
            "dx: The Thread owner's connection to {host} is missing or was revoked. Reconnect it in dx Settings → Integrations."
        ),
        Err(HelperError::Invalid) => {
            format!("dx: dx does not provide Git credentials for {host}.")
        }
    };
    eprintln!("{failure}");
    Err(())
}

/// The connection to Core stayed down past the wait: say what happened,
/// never that a GitHub or Bitbucket connection needs repair.
fn disconnected_message(action: &str) -> String {
    format!(
        "dx: dx's connection to this Orb did not come back within {} s, so dx could not {action}. Try again in a moment.",
        RECONNECT_WAIT.as_secs()
    )
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
        Err(_) => {
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
            // Core never answered: the helper asks again (#2049).
            assert!(matches!(response.try_recv(), Ok(Relayed::Lost)));
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
        // Host-only requests (the dx `gh` wrapper) carry no path.
        assert!(
            parse_git_credential_request("protocol=https\nhost=github.com\n")
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

    /// One helper request from a client thread, as `dxd id-token` sends it.
    async fn client(socket: PathBuf) -> Vec<u8> {
        tokio::task::spawn_blocking(move || exchange(&socket, &request_bytes("", VALID_BODY)))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn start_requires_a_private_state_directory_and_creates_a_private_socket() {
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

    #[tokio::test]
    async fn disconnected_requests_are_uncacheable_and_unavailable() {
        let state = secure_state_directory();
        let socket = state.path().join(SOCKET_NAME);
        let _relay = start(
            &socket,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
        .unwrap();
        let response = client(socket).await;
        let response = response_text(&response);
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(response.contains("\r\nCache-Control: no-store\r\n"));
        assert!(response.contains("\r\nPragma: no-cache\r\n"));
    }

    #[tokio::test]
    async fn connected_requests_traverse_the_relay_and_map_issued_responses() {
        let state = secure_state_directory();
        let connected = Arc::new(AtomicBool::new(true));
        let epoch = Arc::new(AtomicU64::new(41));
        let socket = state.path().join(SOCKET_NAME);
        let mut relay = start(&socket, connected, epoch).unwrap();
        let client = tokio::spawn(client(socket));

        let local = relay.next().await;
        assert_eq!(local.epoch, 41);
        assert_eq!(local.request.audience.as_deref(), Some("sts.amazonaws.com"));
        assert!(!local.request_id.is_empty());
        local.respond(WorkloadIdentityResult::Issued {
            token: "abc.def.ghi".into(),
            expires_at: 123,
        });

        let response = client.await.unwrap();
        let response = response_text(&response);
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with(r#"{"token":"abc.def.ghi","expiresAt":123}"#));
    }

    #[tokio::test]
    async fn response_from_a_stale_epoch_is_fenced() {
        let state = secure_state_directory();
        let connected = Arc::new(AtomicBool::new(true));
        let epoch = Arc::new(AtomicU64::new(7));
        let socket = state.path().join(SOCKET_NAME);
        let mut relay = start(&socket, Arc::clone(&connected), Arc::clone(&epoch)).unwrap();
        let client = tokio::spawn(client(socket));
        let local = relay.next().await;
        epoch.store(8, Ordering::Release);
        local.respond(WorkloadIdentityResult::Issued {
            token: "stale.token.value".into(),
            expires_at: 123,
        });

        let response = client.await.unwrap();
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
