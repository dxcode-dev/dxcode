//! The native tools a plugin's manifest names (`binaries`), installed
//! before its process first starts and put on its PATH:
//!
//! - `apt`: a Debian package, installed with `sudo apt-get` when missing; it
//!   puts its own commands on PATH.
//! - `url` + `sha256`: a download checked against its digest, unpacked when
//!   it is a .zip, .tar.gz, .tgz, or .tar.xz (`path` names the file inside).
//! - `path`: a file in the plugin, copied out so the package stays as it was
//!   reviewed.
//!
//! Each tool is linked as `name` in a folder per process key, which the
//! launch puts first on PATH. A key installs once; a marker file records it.

use super::{Binary, PluginPaths, PluginResult, ProcessSpec, allowed_url, unavailable};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_BINARIES: usize = 16;
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const COMPLETE: &str = ".dx-binaries-complete";

pub(super) fn validate(binaries: &[Binary]) -> Result<(), &'static str> {
    if binaries.len() > MAX_BINARIES {
        return Err("A plugin declares at most 16 binaries.");
    }
    for (index, binary) in binaries.iter().enumerate() {
        let name = binary.name.as_bytes();
        if name.is_empty()
            || name.len() > 64
            || !name[0].is_ascii_alphanumeric()
            || !name
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(b))
            || binaries[..index]
                .iter()
                .any(|other| other.name == binary.name)
        {
            return Err("A binary's name is invalid or repeated.");
        }
        let apt_ok = binary.apt.as_ref().is_none_or(|apt| {
            (2..=64).contains(&apt.len())
                && apt.as_bytes()[0].is_ascii_alphanumeric()
                && apt
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b))
        });
        let sha_ok = binary.sha256.as_deref().is_none_or(super::hex64);
        let path_ok = binary
            .path
            .as_deref()
            .is_none_or(|path| path.len() <= 512 && crate::mcp::safe_relative(path));
        let kind_ok = match (&binary.apt, &binary.url, &binary.path) {
            (Some(_), None, None) => binary.sha256.is_none(),
            (None, Some(url), _) => allowed_url(url) && binary.sha256.is_some(),
            (None, None, Some(_)) => true,
            _ => false,
        };
        if !(apt_ok && sha_ok && path_ok && kind_ok) {
            return Err("A binary needs one of apt, url with sha256, or path.");
        }
    }
    Ok(())
}

/// Installs the spec's binaries and returns the folder to put on PATH.
pub(super) fn install(
    paths: &PluginPaths,
    spec: &ProcessSpec,
    root: &Path,
    deadline: Instant,
) -> Result<PathBuf, PluginResult> {
    let keyed = paths.binaries().join(format!("key-{}", spec.key));
    let bin = keyed.join("bin");
    if keyed.join(COMPLETE).is_file() {
        return Ok(bin);
    }
    let failed = |name: &str, message: String| {
        unavailable(
            "binaries",
            format!("dx could not install the binary {name}: {message}"),
        )
    };
    let _ = fs::remove_dir_all(&bin);
    fs::create_dir_all(&bin).map_err(|error| failed("(folder)", error.to_string()))?;

    let packages: Vec<&str> = spec
        .binaries
        .iter()
        .filter_map(|binary| binary.apt.as_deref())
        .filter(|package| !apt_installed(package))
        .collect();
    if !packages.is_empty() {
        apt_install(&packages, deadline).map_err(|message| failed(&packages.join(" "), message))?;
    }

    for binary in &spec.binaries {
        let target = if let Some(url) = &binary.url {
            let sha256 = binary.sha256.as_deref().unwrap_or_default();
            download(
                paths,
                url,
                sha256,
                binary.path.as_deref(),
                &binary.name,
                deadline,
            )
            .map_err(|message| failed(&binary.name, message))?
        } else if let Some(path) = &binary.path {
            let source = root.join(path);
            if !source.is_file() {
                return Err(failed(
                    &binary.name,
                    format!("{path} is not in the plugin."),
                ));
            }
            let copy = keyed.join(&binary.name);
            fs::copy(&source, &copy).map_err(|error| failed(&binary.name, error.to_string()))?;
            copy
        } else {
            continue;
        };
        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        std::os::unix::fs::symlink(&target, bin.join(&binary.name))
            .map_err(|error| failed(&binary.name, error.to_string()))?;
    }
    File::create(keyed.join(COMPLETE)).map_err(|error| failed("(marker)", error.to_string()))?;
    Ok(bin)
}

fn apt_installed(package: &str) -> bool {
    Command::new("dpkg-query")
        .args(["-W", "-f=${Status}", package])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout).contains("install ok installed")
        })
}

fn apt_install(packages: &[&str], deadline: Instant) -> Result<(), String> {
    let install = |deadline| {
        let mut command = Command::new("sudo");
        command
            .args([
                "-n",
                "env",
                "DEBIAN_FRONTEND=noninteractive",
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
            ])
            .args(packages);
        run(command, deadline)
    };
    if install(deadline).is_ok() {
        return Ok(());
    }
    // A fresh image may have no package lists yet.
    let mut update = Command::new("sudo");
    update.args(["-n", "apt-get", "update"]);
    run(update, deadline)?;
    install(deadline)
}

/// Runs a command until it exits or the deadline passes; the error carries
/// the end of its output.
fn run(mut command: Command, deadline: Instant) -> Result<(), String> {
    let output = tempfile_path();
    let file = File::create(&output).map_err(|error| error.to_string())?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(file.try_clone().map_err(|error| error.to_string())?)
        .stderr(file)
        .spawn()
        .map_err(|error| error.to_string())?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = fs::read(&output).unwrap_or_default();
    let _ = fs::remove_file(&output);
    let start = text.len().saturating_sub(2048);
    let tail = String::from_utf8_lossy(&text[start..]).trim().to_owned();
    match status {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(format!("{status}. {tail}")),
        None => Err(format!("it did not finish in time. {tail}")),
    }
}

fn tempfile_path() -> PathBuf {
    std::env::temp_dir().join(format!("dxd-plugin-{}.log", rand::random::<u64>()))
}

/// The downloaded (and, for an archive, unpacked) executable.
fn download(
    paths: &PluginPaths,
    url: &str,
    sha256: &str,
    inner: Option<&str>,
    name: &str,
    deadline: Instant,
) -> Result<PathBuf, String> {
    let folder = paths.binaries().join(sha256);
    let file = folder.join("download");
    let complete = folder.join(".complete");
    let archive = archive_kind(url);
    if !complete.is_file() {
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(
                DOWNLOAD_TIMEOUT.min(deadline.saturating_duration_since(Instant::now())),
            ))
            .http_status_as_error(false)
            .build()
            .new_agent();
        let mut response = agent.get(url).call().map_err(|error| error.to_string())?;
        if response.status().as_u16() != 200 {
            return Err(format!(
                "the download answered HTTP {}.",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .with_config()
            .limit(MAX_DOWNLOAD_BYTES + 1)
            .reader()
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("the download is larger than 200 MiB.".into());
        }
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if digest != sha256 {
            return Err(format!(
                "the download's sha256 is {digest}, not the reviewed {sha256}."
            ));
        }
        fs::write(&file, &bytes).map_err(|error| error.to_string())?;
        if let Some(kind) = archive {
            let unpacked = folder.join("unpacked");
            fs::create_dir_all(&unpacked).map_err(|error| error.to_string())?;
            let mut command = match kind {
                Archive::Zip => {
                    let mut command = Command::new("unzip");
                    command.arg("-q").arg(&file).arg("-d").arg(&unpacked);
                    command
                }
                Archive::Tar => {
                    let mut command = Command::new("tar");
                    command.arg("-xf").arg(&file).arg("-C").arg(&unpacked);
                    command
                }
            };
            command.current_dir(&folder);
            run(command, deadline).map_err(|message| format!("unpacking failed: {message}"))?;
        }
        File::create(&complete).map_err(|error| error.to_string())?;
    }
    let target = match (archive, inner) {
        (None, None) => file,
        (None, Some(_)) => {
            return Err("path names a file inside an archive, and the url is not one.".into());
        }
        (Some(_), inner) => folder.join("unpacked").join(inner.unwrap_or(name)),
    };
    // Unpacked archives may hold symlinks; the target must stay inside.
    let inside = target
        .canonicalize()
        .ok()
        .zip(folder.canonicalize().ok())
        .is_some_and(|(target, folder)| target.starts_with(folder) && target.is_file());
    if inside {
        Ok(target)
    } else {
        Err(format!("{} is not in the download.", inner.unwrap_or(name)))
    }
}

#[derive(Clone, Copy)]
enum Archive {
    Zip,
    Tar,
}

fn archive_kind(url: &str) -> Option<Archive> {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.ends_with(".zip") {
        Some(Archive::Zip)
    } else if [".tar.gz", ".tgz", ".tar.xz"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        Some(Archive::Tar)
    } else {
        None
    }
}
