//! One dxd per Thread, started inside the Thread's sandbox with the
//! `localRuntime` configuration `scripts/local-runtime.mjs` writes. The
//! supervisor, not dxd, updates the dxd binary (`selfUpdate: false`).

use crate::runner::ops::{Ctx, OpError, OpResult, ThreadPaths, thread_ids, thread_paths};
use crate::runner::{Config, Paths, exec, log, sandbox, set_mode, update, write_private};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::process::{Child, Stdio};
use std::sync::Mutex;

pub struct Daemons {
    children: Mutex<HashMap<String, Child>>,
}

fn config_path(t: &ThreadPaths) -> std::path::PathBuf {
    t.daemon.join("config.json")
}

fn pid_path(t: &ThreadPaths) -> std::path::PathBuf {
    t.daemon.join("pid")
}

pub fn remove_config(t: &ThreadPaths) {
    let _ = fs::remove_file(config_path(t));
    let _ = fs::remove_file(pid_path(t));
}

/// Endpoints Core may hand a Thread's dxd: its own route over wss, or ws on
/// loopback for local tests.
fn valid_endpoint(endpoint: &str, thread: &str) -> bool {
    let (scheme, rest) = match endpoint.split_once("://") {
        Some(v) => v,
        None => return false,
    };
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return false,
    };
    let loopback = ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| host == *h || host.starts_with(&format!("{h}:")));
    let scheme_ok = scheme == "wss" || (scheme == "ws" && loopback);
    let path_ok =
        path == format!("/v1/threads/{thread}/dxd") || path == format!("/v1/dxd/{thread}");
    scheme_ok && path_ok && !host.is_empty() && !host.contains('@')
}

/// The dxd config `local-runtime.mjs` writes, plus `selfUpdate: false`.
fn daemon_config(t: &ThreadPaths, endpoint: &str, api_key: &str) -> Value {
    let mut local = json!({
        "homeDirectory": t.home.display().to_string(),
        "stateDirectory": t.state.display().to_string(),
    });
    // Test hook: a dxd built before `selfUpdate` existed rejects the field.
    if std::env::var_os("DX_RUNNER_DXD_LEGACY_CONFIG").is_none() {
        local["selfUpdate"] = json!(false);
        local["resumeHooks"] = json!(false);
    }
    json!({
        "version": 2,
        "endpoint": endpoint,
        "threadId": t.id,
        "apiKey": api_key,
        "workspaceRoot": t.workspace.display().to_string(),
        "localRuntime": local,
    })
}

impl Daemons {
    pub fn new() -> Self {
        Daemons {
            children: Mutex::new(HashMap::new()),
        }
    }

    fn running(&self, thread: &str) -> bool {
        let mut children = self.children.lock().unwrap();
        match children.get_mut(thread) {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    children.remove(thread);
                    false
                }
            },
            None => false,
        }
    }

    /// The `daemon` operation.
    pub fn ensure(&self, ctx: &Ctx, t: &ThreadPaths, body: &Value) -> OpResult {
        let endpoint = body["endpoint"].as_str().unwrap_or_default();
        if !valid_endpoint(endpoint, &t.id) {
            return Err(OpError::invalid("dxd endpoint is not this Thread's"));
        }
        fs::create_dir_all(&t.daemon)?;
        set_mode(&t.daemon, 0o700);
        fs::create_dir_all(&t.workspace)?;
        let existing: Option<Value> = fs::read_to_string(config_path(t))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let usable = existing.as_ref().is_some_and(|c| {
            c["version"] == json!(2)
                && c["threadId"] == json!(t.id)
                && c["endpoint"] == json!(endpoint)
                && c["workspaceRoot"] == json!(t.workspace.display().to_string())
        });
        let api_key = body["apiKey"].as_str();
        if api_key.is_none() && !usable {
            // The config holds the Thread's one key; Core mints one first.
            return Ok(json!({ "status": "credential-required" }));
        }
        if let Some(key) = api_key {
            write_private(
                &config_path(t),
                &daemon_config(t, endpoint, key).to_string(),
            )?;
        }
        update::ensure_dxd(&ctx.paths, &ctx.config)?;
        let changed = api_key.is_some() && !usable;
        if !self.running(&t.id) || changed {
            self.stop(t);
            self.launch(&ctx.paths, &ctx.config, t)?;
        }
        Ok(json!({ "status": "running" }))
    }

    pub fn launch(&self, paths: &Paths, config: &Config, t: &ThreadPaths) -> Result<(), OpError> {
        let dxd = update::installed(paths);
        if !dxd.exists() {
            return Err(OpError::failed("dxd is not installed yet"));
        }
        fs::create_dir_all(&t.state)?;
        set_mode(&t.state, 0o700);
        let argv = vec![
            dxd.display().to_string(),
            "--config".to_string(),
            config_path(t).display().to_string(),
        ];
        let mut cmd = sandbox::command(paths, &t.root, &argv, config.unsandboxed)?;
        let log_file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(t.daemon.join("dxd.log"))?;
        use std::os::unix::process::CommandExt;
        // The runner's shims, then the person's own PATH, then dx's tools.
        let host_path = exec::command_path(paths);
        cmd.env_clear()
            .env("PATH", exec::with_tools_last(paths, &host_path))
            .env("HOME", &t.home)
            .env("TMPDIR", t.root.join("tmp"))
            .env("LANG", exec::lang())
            .env("DXD_TMUX", "")
            .env("DXD_RUNNER", "1")
            // Services and Portals in this Thread find the machine's own tools.
            .env("DXD_HOST_PATH", &host_path)
            // dx's tools, which the Thread's PATH and Terminal put last.
            .env("DXD_TOOLS_PATH", exec::tools_path(paths))
            .env("DX_WORKLOAD_IDENTITY_SOCKET", t.state.join("wi.sock"))
            .current_dir(&t.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_file))
            .process_group(0);
        if let Ok(user) = std::env::var("USER") {
            cmd.env("USER", user);
        }
        if config.unsandboxed {
            cmd.envs(exec::full_access_env(paths))
                .env("DXD_RUNNER_OWN_HOME", &paths.home);
        }
        let child = cmd
            .spawn()
            .map_err(|e| OpError::failed(format!("start dxd: {e}")))?;
        let _ = fs::write(pid_path(t), format!("{}\n", child.id()));
        log(&format!("dxd started for {} (pid {})", t.id, child.id()));
        self.children.lock().unwrap().insert(t.id.clone(), child);
        Ok(())
    }

    pub fn stop(&self, t: &ThreadPaths) {
        if let Some(mut child) = self.children.lock().unwrap().remove(&t.id) {
            let pgid = child.id() as i32;
            exec::kill_group(pgid, libc::SIGTERM);
            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            exec::kill_group(pgid, libc::SIGKILL);
            let _ = child.wait();
            log(&format!("dxd stopped for {}", t.id));
        } else {
            stop_recorded(t);
        }
        let _ = fs::remove_file(pid_path(t));
    }

    pub fn stop_all(&self, paths: &Paths) {
        let ids: Vec<String> = self.children.lock().unwrap().keys().cloned().collect();
        for id in ids {
            if let Ok(t) = thread_paths(paths, &id) {
                self.stop(&t);
            }
        }
    }

    /// At start: a dxd left by an earlier runner process is ended, and every
    /// Thread with a valid dxd config gets its dxd again.
    pub fn adopt_all(&self, paths: &Paths, config: &Config) {
        for id in thread_ids(paths) {
            let Ok(t) = thread_paths(paths, &id) else {
                continue;
            };
            stop_recorded(&t);
            let Some(c) = fs::read_to_string(config_path(&t))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            else {
                continue;
            };
            let valid = c["version"] == json!(2)
                && c["threadId"] == json!(id)
                && c["workspaceRoot"] == json!(t.workspace.display().to_string())
                && c["endpoint"]
                    .as_str()
                    .is_some_and(|e| valid_endpoint(e, &id));
            if !valid || !t.workspace.is_dir() {
                continue;
            }
            if let Err(e) = update::ensure_dxd(paths, config)
                .map_err(OpError::failed)
                .and_then(|_| self.launch(paths, config, &t))
            {
                log(&format!("dxd for {id} not restarted: {}", e.message));
            }
        }
    }
}

/// Ends the dxd a previous runner process recorded, only if that pid still
/// runs this Thread's dxd (never an unrelated process that reused the pid).
fn stop_recorded(t: &ThreadPaths) {
    let Some(pid) = fs::read_to_string(pid_path(t))
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
    else {
        return;
    };
    if pid <= 1 {
        return;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output();
    let command = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if command.contains("dxd") && command.contains(&config_path(t).display().to_string()) {
        exec::kill_group(pid, libc::SIGTERM);
        std::thread::sleep(std::time::Duration::from_millis(300));
        exec::kill_group(pid, libc::SIGKILL);
        log(&format!("ended a leftover dxd for {} (pid {pid})", t.id));
    }
    let _ = fs::remove_file(pid_path(t));
}

/// `dxd runner uninstall`: end every recorded dxd.
pub fn stop_all_recorded(paths: &Paths) {
    for id in thread_ids(paths) {
        if let Ok(t) = thread_paths(paths, &id) {
            stop_recorded(&t);
        }
    }
}
