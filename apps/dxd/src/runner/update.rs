//! The one binary in `~/.dx/runner/bin/dxd`: the supervisor and every
//! Thread's dxd run from it.
//!
//! - The first `dxd runner` start copies itself there.
//! - An update (offered in Core's hello) is taken only when idle, only for a
//!   higher version or a rebuild of this one (a different SHA-256 from the
//!   deployment it is paired with; never a lower version), after its
//!   SHA-256 matches, its Ed25519 signature
//!   verifies when this build has a release key, and it passes a smoke test.
//!   It is written as a new file and renamed into place (macOS caches code
//!   signatures per inode), keeping `previous`. The supervisor then stops
//!   every Thread's dxd and re-executes; the Threads start again from the
//!   new file.

use crate::runner::{Config, Paths, VERSION, log, set_mode};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const RELEASE_KEY: Option<&str> = option_env!("DX_RUNNER_UPDATE_KEY");
const MAX_BINARY: u64 = 96 * 1024 * 1024;
const HANDOFF_ENV: &str = "DX_RUNNER_HANDOFF";

/// `macos-aarch64`, `linux-x86_64`, ... (Core's manifest keys).
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().split('.').map(|p| p.parse::<u64>().ok());
    let out = (it.next()??, it.next()??, it.next()??);
    if it.next().is_some() { None } else { Some(out) }
}

pub fn newer(candidate: &str, than: &str) -> bool {
    matches!((parse_version(candidate), parse_version(than)), (Some(a), Some(b)) if a > b)
}

/// SHA-256 of the running executable.
fn own_sha256() -> Option<String> {
    let bytes = fs::read(std::env::current_exe().ok()?).ok()?;
    Some(sha256_hex(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The installed binary.
pub fn installed(paths: &Paths) -> PathBuf {
    paths.bin.join("dxd")
}

fn installed_version(paths: &Paths) -> String {
    fs::read_to_string(paths.bin.join("version"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// At start: run the newest installed binary instead of this one.
pub fn handoff(paths: &Paths) {
    if std::env::var_os(HANDOFF_ENV).is_some() {
        return;
    }
    let exe = installed(paths);
    if !newer(&installed_version(paths), VERSION) || !exe.exists() {
        return;
    }
    if std::env::current_exe().is_ok_and(|me| same_file(&me, &exe)) {
        return;
    }
    let err = Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .env(HANDOFF_ENV, "1")
        .exec();
    eprintln!(
        "dxd runner: could not start {} ({err}); staying on {VERSION}",
        exe.display()
    );
}

/// Writes `bytes` to `bin/<name>` as a new file renamed into place.
fn install_bytes(paths: &Paths, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(&paths.bin).map_err(|e| e.to_string())?;
    set_mode(&paths.bin, 0o700);
    let staged = paths.bin.join(format!("{name}.new"));
    let _ = fs::remove_file(&staged);
    fs::write(&staged, bytes).map_err(|e| e.to_string())?;
    set_mode(&staged, 0o755);
    let target = paths.bin.join(name);
    fs::rename(&staged, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

/// `bin/dxd` exists and is at least this version: the first start (or a
/// newer binary started by hand) copies itself there.
pub fn ensure_dxd(paths: &Paths, _config: &Config) -> Result<(), String> {
    let exe = installed(paths);
    let current = installed_version(paths);
    if exe.exists() && !current.is_empty() && !newer(VERSION, &current) {
        return Ok(());
    }
    let me = std::env::current_exe().map_err(|e| format!("this binary: {e}"))?;
    if same_file(&me, &exe) {
        fs::write(paths.bin.join("version"), VERSION).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let bytes = fs::read(&me).map_err(|e| format!("{}: {e}", me.display()))?;
    install_bytes(paths, "dxd", &bytes)?;
    fs::write(paths.bin.join("version"), VERSION).map_err(|e| e.to_string())?;
    log(&format!("installed dxd {VERSION} at {}", exe.display()));
    Ok(())
}

fn download(config: &Config, url: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let url = config.same_origin(url)?;
    let mut resp = crate::runner::http()
        .get(&url)
        .call()
        .map_err(|e| format!("download {url}: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("download {url} answered {}", resp.status()));
    }
    let mut bytes = Vec::new();
    resp.body_mut()
        .with_config()
        .limit(MAX_BINARY)
        .reader()
        .take(MAX_BINARY)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let got = sha256_hex(&bytes);
    if got != sha256.to_ascii_lowercase() {
        return Err(format!(
            "download {url}: SHA-256 {got} does not match {sha256}"
        ));
    }
    Ok(bytes)
}

/// Applies an update offered as `{version, assets: {<os>-<arch>: {url, sha256, signature?}}}`.
/// Returns `Ok(true)` when the new binary is in place and the caller should restart.
pub fn stage_update(paths: &Paths, config: &Config, offer: &Value) -> Result<bool, String> {
    let version = offer["version"].as_str().unwrap_or_default();
    let entry = &offer["assets"][platform()];
    // A higher version, or a rebuild of this one (previews and staging
    // rebuild without a version bump): a different SHA-256 from Core's own
    // deployment. A lower version is never taken.
    let rebuild = version == VERSION
        && entry["sha256"]
            .as_str()
            .is_some_and(|sha| own_sha256().is_some_and(|own| !own.eq_ignore_ascii_case(sha)));
    if !newer(version, VERSION) && !rebuild {
        return Ok(false);
    }
    let url = entry["url"]
        .as_str()
        .or_else(|| entry["path"].as_str())
        .ok_or("update has no build for this machine")?;
    let sha = entry["sha256"].as_str().ok_or("update has no SHA-256")?;
    if let Some(key) = RELEASE_KEY {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let message = format!("dxd {version} {} {sha}", platform());
        let key: [u8; 32] = B64
            .decode(key)
            .ok()
            .and_then(|k| k.try_into().ok())
            .ok_or("bad built-in key")?;
        let key = VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?;
        let sig: [u8; 64] = B64
            .decode(entry["signature"].as_str().unwrap_or_default())
            .ok()
            .and_then(|s| s.try_into().ok())
            .ok_or("update has no valid signature")?;
        key.verify(message.as_bytes(), &Signature::from_bytes(&sig))
            .map_err(|_| "update signature does not verify; ignoring it".to_string())?;
    }
    log(&format!("update: downloading dxd {version}"));
    let bytes = download(config, url, sha)?;
    let candidate = install_bytes(paths, "dxd.candidate", &bytes)?;
    let out = Command::new(&candidate)
        .args(["runner", "version"])
        .env(HANDOFF_ENV, "1")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim() != version {
        let _ = fs::remove_file(&candidate);
        return Err("the new dxd failed its smoke test".into());
    }
    let current = installed(paths);
    if current.exists() {
        let _ = fs::rename(&current, paths.bin.join("previous"));
    }
    fs::rename(&candidate, &current).map_err(|e| e.to_string())?;
    fs::write(paths.bin.join("version"), version).map_err(|e| e.to_string())?;
    log(&format!("update: {VERSION} -> {version} staged"));
    Ok(true)
}

/// Replaces this process with the installed binary.
pub fn restart(paths: &Paths) -> String {
    let exe = installed(paths);
    let err = Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .env(HANDOFF_ENV, "1")
        .exec();
    format!("restart into {} failed: {err}", exe.display())
}
