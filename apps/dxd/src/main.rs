#[cfg(not(target_os = "linux"))]
compile_error!("dxd runs on Linux only; cross-build it from any host with `pnpm build:dxd`");

mod changes;
mod child;
mod environment;
mod files;
mod files_sandbox;
mod observer;
mod protocol;
mod session;
mod terminal;
mod update;
mod workload_identity;
mod worktrees;

use environment::{EnvironmentPaths, EnvironmentRuntime};
use files::FilesContext;
use files_sandbox::SandboxRoots;
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use terminal::TerminalRuntime;

pub const RELEASE: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_MAJOR: u8 = 2;
const STATE_DIR: &str = "/home/user/.local/state/dxd";
const CONFIG_PATH: &str = "/home/user/.local/state/dxd/config.json";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

pub use session::{PendingWorkloadIdentity, WORKLOAD_IDENTITY_REQUEST_LEASE};

/// Static daemon configuration. Nothing in it changes between activations, so
/// the daemon is installed once and never restarted by Core.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    version: u8,
    pub endpoint: String,
    pub thread_id: String,
    pub api_key: String,
    pub workspace_root: String,
    pub local_runtime: Option<LocalRuntime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRuntime {
    pub home_directory: String,
    pub state_directory: String,
}

#[derive(Debug)]
enum StartExit {
    Usage,
    Command,
    Config(io::Error),
    Workspace(io::Error),
    StateDirectory(io::Error),
    WorkloadIdentitySocket,
    WorkloadIdentity(io::Error),
    Files(io::Error),
    Executable(io::Error),
}

impl std::fmt::Display for StartExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage => write!(f, "usage: dxd [--config <absolute path>] | dxd --version"),
            Self::Command => write!(f, "command failed"),
            Self::Config(e) => write!(f, "config: {e}"),
            Self::Workspace(e) => write!(f, "workspace root: {e}"),
            Self::StateDirectory(e) => write!(f, "state directory: {e}"),
            Self::WorkloadIdentitySocket => {
                write!(f, "DX_WORKLOAD_IDENTITY_SOCKET must be an absolute path")
            }
            Self::WorkloadIdentity(e) => write!(f, "workload identity socket: {e}"),
            Self::Files(e) => write!(f, "files: {e}"),
            Self::Executable(e) => write!(f, "executable path: {e}"),
        }
    }
}

fn main() {
    if let Err(exit) = start() {
        eprintln!("dxd stopped: {exit}");
        std::process::exit(1);
    }
}

fn start() -> Result<(), StartExit> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("--version") => {
            println!("dxd {RELEASE} protocol {PROTOCOL_MAJOR}");
            return Ok(());
        }
        Some("changes-capture") => {
            return changes::run_cli().map_err(|()| StartExit::Command);
        }
        Some("id-token") => {
            return workload_identity::print_token(&arguments).map_err(|()| StartExit::Command);
        }
        Some("gcp-credential") => {
            return workload_identity::print_gcp_credential(&arguments)
                .map_err(|()| StartExit::Command);
        }
        Some("git-sign") => {
            return workload_identity::git_sign(&arguments).map_err(|()| StartExit::Command);
        }
        Some("git-credential") => {
            // The helper prints its own one-line diagnostic for Git's output.
            if workload_identity::git_credential(&arguments).is_err() {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {}
    }
    let config_path = match arguments.as_slice() {
        [] => PathBuf::from(CONFIG_PATH),
        [flag, path] if flag == "--config" && Path::new(path).is_absolute() => PathBuf::from(path),
        _ => return Err(StartExit::Usage),
    };
    // SAFETY: umask has no preconditions.
    unsafe {
        libc::umask(0o077);
    }
    let config = load_config(&config_path).map_err(StartExit::Config)?;
    let current_exe = std::env::current_exe().map_err(StartExit::Executable)?;
    update::cleanup_previous(&current_exe);
    let workspace_root = PathBuf::from(&config.workspace_root);
    let workspace_metadata = fs::metadata(&workspace_root).map_err(StartExit::Workspace)?;
    if !workspace_metadata.is_dir() {
        return Err(StartExit::Workspace(io::ErrorKind::NotADirectory.into()));
    }
    let connected = Arc::new(AtomicBool::new(false));
    let (state_directory, mut terminal, environment, sandbox) = match &config.local_runtime {
        Some(local) => {
            let state = PathBuf::from(&local.state_directory);
            fs::create_dir_all(&state).map_err(StartExit::StateDirectory)?;
            set_private_mode(&state).map_err(StartExit::StateDirectory)?;
            let home = PathBuf::from(&local.home_directory);
            (
                state.clone(),
                TerminalRuntime::local(workspace_root.clone(), home.clone(), state.clone()),
                EnvironmentRuntime::new(EnvironmentPaths::local(home.clone(), state)),
                SandboxRoots::Local { home },
            )
        }
        None => {
            let state = PathBuf::from(STATE_DIR);
            fs::create_dir_all(&state).map_err(StartExit::StateDirectory)?;
            set_private_mode(&state).map_err(StartExit::StateDirectory)?;
            (
                state.clone(),
                TerminalRuntime::guest(workspace_root.clone(), &state),
                EnvironmentRuntime::new(EnvironmentPaths::production()),
                SandboxRoots::Guest,
            )
        }
    };
    if let Ok(encoded) = std::env::var(terminal::HANDOFF_VARIABLE) {
        // SAFETY: single-threaded at this point; nothing reads the variable concurrently.
        unsafe {
            std::env::remove_var(terminal::HANDOFF_VARIABLE);
        }
        match terminal.adopt(&encoded) {
            Ok(()) => eprintln!("dxd adopted the running shell after update"),
            Err(error) => eprintln!("dxd could not adopt the shell after update: {error}"),
        }
    }
    let workload_identity_epoch = Arc::new(AtomicU64::new(0));
    let workload_identity_socket = match &config.local_runtime {
        Some(_) => std::env::var("DX_WORKLOAD_IDENTITY_SOCKET")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or(StartExit::WorkloadIdentitySocket)?,
        None => state_directory.join(workload_identity::SOCKET_NAME),
    };
    let files = FilesContext::open(&workspace_root, sandbox).map_err(StartExit::Files)?;

    // One thread runs every connection and feature loop; blocking work (git,
    // Files, environment, release download) runs on a small pool whose
    // threads exit after 10 s idle. The Files lanes, the single Changes
    // capture, the single environment task and the single download bound
    // how many run at once, well below this cap.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(16)
        .thread_name("dxd-worker")
        .enable_all()
        .build()
        .map_err(StartExit::Files)?;
    runtime.block_on(async move {
        let relay = workload_identity::start(
            &workload_identity_socket,
            Arc::clone(&connected),
            Arc::clone(&workload_identity_epoch),
        )
        .map_err(StartExit::WorkloadIdentity)?;
        let observer = observer::Observer::start(&workspace_root);
        let daemon = session::Daemon::new(
            config,
            config_path,
            current_exe,
            terminal,
            environment,
            files,
            observer,
            relay,
            workload_identity_epoch,
            connected,
        )
        .map_err(StartExit::Files)?;
        eprintln!("dxd {RELEASE} started");
        daemon.run().await;
        #[allow(unreachable_code)]
        Ok(())
    })
}

fn set_private_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

pub(crate) fn load_config(path: &Path) -> io::Result<Config> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let file = OpenOptions::new().read(true).open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData)?;
    validate(&config)?;
    Ok(config)
}

fn validate(c: &Config) -> io::Result<()> {
    let token = |s: &str, min, max| {
        s.len() >= min
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    // The same parser the connection uses.
    let endpoint = c
        .endpoint
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .map_err(|_| io::ErrorKind::InvalidData)?;
    let root = Path::new(&c.workspace_root);
    let api_key_valid = c.api_key.starts_with("dxd_")
        && c.api_key.len() <= 1024
        && c.api_key.len() >= 20
        && c.api_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'));
    let valid = c.version == 2
        && api_key_valid
        && token(&c.thread_id, 1, 128)
        && c.endpoint.len() <= 4096
        && matches!(endpoint.scheme_str(), Some("ws" | "wss"))
        && endpoint.host().is_some_and(|host| !host.is_empty())
        && root.is_absolute()
        && c.workspace_root.len() <= 4096
        && c.local_runtime.as_ref().is_none_or(|local| {
            let home = Path::new(&local.home_directory);
            let state = Path::new(&local.state_directory);
            home.is_absolute()
                && state.is_absolute()
                && local.home_directory.len() <= 4096
                && local.state_directory.len() <= 4096
                && root.starts_with(home)
                && state.starts_with(home.parent().unwrap_or(home))
        });
    if valid {
        Ok(())
    } else {
        Err(io::ErrorKind::InvalidData.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::CandidateOutcome;
    use crate::files::{FilesOperation, FilesResult};
    use crate::protocol::{Capabilities, ClientMessage, RequestOperation, ServerMessage};
    use crate::session::decode_server;

    fn config() -> Config {
        Config {
            version: 2,
            endpoint: "wss://example.invalid/dxd".into(),
            thread_id: "thread".into(),
            api_key: "dxd_test-api-key-value".into(),
            workspace_root: "/tmp/work".into(),
            local_runtime: None,
        }
    }

    #[test]
    fn validates_static_config_bounds() {
        assert!(validate(&config()).is_ok());
        let mut bad = config();
        bad.api_key = "dxu_wrong-key-kind".into();
        assert!(validate(&bad).is_err());
        let mut bad = config();
        bad.version = 1;
        assert!(
            validate(&bad).is_err(),
            "v1 configs carry a generation and are rejected"
        );
        let mut bad = config();
        bad.endpoint = "https://example.invalid/dxd".into();
        assert!(validate(&bad).is_err());
        let mut bad = config();
        bad.workspace_root = "relative".into();
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn rejects_v1_config_documents() {
        let v1 = r#"{"version":1,"endpoint":"wss://x/dxd","threadId":"t","generation":"g","apiKey":"dxd_aaaaaaaaaaaaaaaaaaaa","release":"0.7.6","protocolMajor":1,"workspaceRoot":"/w"}"#;
        assert!(serde_json::from_str::<Config>(v1).is_err());
    }

    #[test]
    fn readiness_probe_is_correlated_and_control_bounded() {
        let ping = r#"{"type":"readiness-ping","generation":"gen_1","requestId":"probe_12345678"}"#;
        let ServerMessage::ReadinessPing {
            generation,
            request_id,
        } = decode_server(ping).unwrap()
        else {
            panic!("expected readiness ping")
        };
        assert_eq!(
            serde_json::to_string(&ClientMessage::ReadinessPong {
                generation: &generation,
                request_id: &request_id,
            })
            .unwrap(),
            r#"{"type":"readiness-pong","generation":"gen_1","requestId":"probe_12345678"}"#
        );
        assert!(
            decode_server(&ping.replace(
                "probe_12345678",
                &"x".repeat(session::MAX_CONTROL_FRAME_BYTES)
            ))
            .is_err()
        );
    }

    #[test]
    fn encodes_protocol_messages_exactly() {
        assert_eq!(
            serde_json::to_string(&ClientMessage::Register {
                protocol_major: PROTOCOL_MAJOR,
                release: RELEASE,
                capabilities: Capabilities::current(),
            })
            .unwrap(),
            format!(
                r#"{{"type":"register","protocolMajor":2,"release":"{RELEASE}","capabilities":{{"terminal":{{"version":1}},"workloadIdentity":{{"version":1}},"files":{{"version":1}}}}}}"#
            )
        );
        assert_eq!(
            serde_json::to_string(&ClientMessage::Heartbeat {
                generation: "gen_1",
                terminal: TerminalRuntime::guest(
                    PathBuf::from("/tmp/work"),
                    Path::new("/nonexistent")
                )
                .heartbeat(),
            })
            .unwrap(),
            r#"{"type":"heartbeat","generation":"gen_1","terminal":{"state":"absent","terminalVersion":1,"terminal":"default"}}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientMessage::ChangesDirty).unwrap(),
            r#"{"type":"changes-dirty"}"#
        );
        let registered = decode_server(
            r#"{"type":"registered","generation":"gen_1","heartbeatIntervalMs":2000,"heartbeatLeaseMs":15000}"#,
        )
        .unwrap();
        assert!(matches!(
            decode_server(r#"{"type":"chunk-ack"}"#).unwrap(),
            ServerMessage::ChunkAck {}
        ));
        assert!(decode_server(r#"{"type":"chunk-ack","bytes":1}"#).is_err());
        assert!(
            matches!(registered, ServerMessage::Registered { generation, .. } if generation == "gen_1")
        );
        let refresh: ServerMessage = serde_json::from_str(
            r#"{"type":"changes-refresh","token":"opaque-refresh-token","source":{"baseline":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","defaultBranch":"main"},"expectedFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#,
        )
        .unwrap();
        let ServerMessage::ChangesRefresh {
            token,
            source,
            expected_fingerprint,
        } = refresh
        else {
            panic!("refresh did not decode")
        };
        assert_eq!(token, "opaque-refresh-token");
        assert_eq!(source.default_branch, "main");
        assert_eq!(expected_fingerprint, Some("b".repeat(64)));
        let outcome = CandidateOutcome::Unchanged {
            fingerprint: "b".repeat(64),
        };
        assert_eq!(
            serde_json::to_string(&ClientMessage::ChangesCandidate {
                token: &token,
                outcome: &outcome,
            })
            .unwrap(),
            r#"{"type":"changes-candidate","token":"opaque-refresh-token","outcome":{"kind":"unchanged","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#
        );
        let request = decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_12345678","operation":{"operation":"files.read","path":"src/main.rs"}}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            ServerMessage::Request {
                generation,
                request_id,
                operation: RequestOperation::Files(FilesOperation::Read { path, .. }),
            } if generation == "gen_1" && request_id == "request_12345678" && path == "src/main.rs"
        ));
        let check = decode_server(
            r#"{"type":"request","generation":"gen_1","requestId":"request_1","operation":{"operation":"environment.check","generation":3,"digest":"abc"}}"#,
        )
        .unwrap();
        assert!(matches!(
            check,
            ServerMessage::Request {
                operation: RequestOperation::Environment(crate::protocol::EnvironmentOperation::Check(check)),
                ..
            } if check.generation == 3 && check.digest == "abc"
        ));
        let update = decode_server(
            r#"{"type":"update","generation":"gen_1","url":"https://releases.example/dxd","sha256":"0000000000000000000000000000000000000000000000000000000000000000","release":"0.9.0"}"#,
        )
        .unwrap();
        assert!(matches!(update, ServerMessage::Update { release, .. } if release == "0.9.0"));
        assert!(decode_server(
            r#"{"type":"update","generation":"gen_1","url":"http://insecure/dxd","sha256":"00","release":"0.9.0"}"#,
        )
        .is_err());
        let files_result = serde_json::to_string(&ClientMessage::Response {
            generation: "gen_1",
            request_id: "r",
            result: crate::protocol::OperationResult::Files(FilesResult::Missing),
        })
        .unwrap();
        assert_eq!(
            files_result,
            r#"{"type":"response","generation":"gen_1","requestId":"r","result":{"kind":"missing"}}"#
        );
    }
}
