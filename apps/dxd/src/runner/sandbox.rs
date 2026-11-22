//! The sandbox every Thread command and every per-Thread dxd runs in.
//!
//! macOS: Seatbelt (`/usr/bin/sandbox-exec`) with paths passed as `-D`
//! parameters. Writes only in the Thread folder and temp folders; no reads of
//! the rest of $HOME (toolchain folders and the runner's `bin` excepted); no
//! Keychain, clipboard, AppleEvents, or `open`; and no connection to, or
//! listener on, the Desktop's port (voxl controls the whole Mac outside any
//! sandbox; only the supervisor reaches it).
//!
//! Linux: Landlock, applied by `dxd __runner-sandbox` to itself before it execs
//! the command. A kernel without Landlock runs nothing unless the person paired
//! with `--unsandboxed`.

use crate::runner::Paths;
use crate::runner::exec::{Run, run_in_thread};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Toolchain folders under $HOME commands may read (only those that exist).
pub const HOME_TOOLCHAINS: &[&str] = &[
    ".cargo",
    ".rustup",
    ".nvm",
    ".volta",
    ".bun",
    ".deno",
    ".pyenv",
    ".rbenv",
    ".asdf",
    ".local/share/mise",
    ".local/share/pnpm",
    ".local/bin",
    ".sdkman",
    ".pnpm",
    "Library/pnpm",
    "go",
    ".go",
    ".gem",
    ".npm-global",
    ".linuxbrew",
];

pub fn toolchains(paths: &Paths) -> Vec<PathBuf> {
    HOME_TOOLCHAINS
        .iter()
        .map(|t| paths.home.join(t))
        .filter(|p| p.exists())
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .collect()
}

pub fn kind(unsandboxed: bool) -> &'static str {
    if unsandboxed {
        "none"
    } else if cfg!(target_os = "macos") {
        "seatbelt"
    } else {
        "landlock"
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn seatbelt_profile(tools: usize) -> String {
    let voxl = crate::runner::desktop::VOXL_PORT;
    let tools: String = (0..tools)
        .map(|i| format!(" (subpath (param \"TOOL{i}\"))"))
        .collect();
    format!(
        r#"(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "THREAD"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (literal "/dev/ptmx") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))
(deny file-read-data (subpath (param "REAL_HOME")) (subpath (param "RUNNER")) (subpath "/Volumes"))
(allow file-read-data (subpath (param "THREAD")) (subpath (param "BIN")){tools})
(deny appleevent-send)
(deny mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.security.agent")
  (global-name "com.apple.pasteboard.1")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.tccd")
  (global-name "com.apple.tccd.system"))
(deny network-outbound (remote ip "localhost:{voxl}"))
(deny network-bind (local ip "*:{voxl}"))
(deny network-inbound (local ip "*:{voxl}"))
"#
    )
}

/// A `Command` that runs `argv` confined to `thread_dir`.
pub fn command(
    paths: &Paths,
    thread_dir: &Path,
    argv: &[String],
    unsandboxed: bool,
) -> Result<Command, String> {
    if argv.is_empty() {
        return Err("empty command".into());
    }
    if unsandboxed {
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        return Ok(cmd);
    }
    platform_command(paths, thread_dir, argv)
}

fn canonical(p: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(p).map_err(|e| format!("{}: {e}", p.display()))
}

#[cfg(target_os = "macos")]
fn platform_command(paths: &Paths, thread_dir: &Path, argv: &[String]) -> Result<Command, String> {
    let sandbox = Path::new("/usr/bin/sandbox-exec");
    if !sandbox.exists() {
        return Err("/usr/bin/sandbox-exec is missing; refusing to run unconfined".into());
    }
    std::fs::create_dir_all(&paths.bin).map_err(|e| e.to_string())?;
    let tools = toolchains(paths);
    let mut cmd = Command::new(sandbox);
    cmd.arg("-D")
        .arg(format!("THREAD={}", canonical(thread_dir)?.display()));
    cmd.arg("-D")
        .arg(format!("REAL_HOME={}", canonical(&paths.home)?.display()));
    cmd.arg("-D")
        .arg(format!("RUNNER={}", canonical(&paths.runner)?.display()));
    cmd.arg("-D")
        .arg(format!("BIN={}", canonical(&paths.bin)?.display()));
    for (i, t) in tools.iter().enumerate() {
        cmd.arg("-D").arg(format!("TOOL{i}={}", t.display()));
    }
    cmd.arg("-p").arg(seatbelt_profile(tools.len()));
    cmd.args(argv);
    Ok(cmd)
}

#[cfg(not(target_os = "macos"))]
fn platform_command(paths: &Paths, thread_dir: &Path, argv: &[String]) -> Result<Command, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("__runner-sandbox").arg(canonical(thread_dir)?);
    std::fs::create_dir_all(&paths.bin).map_err(|e| e.to_string())?;
    cmd.arg(canonical(&paths.bin)?);
    for t in toolchains(paths) {
        cmd.arg("--ro").arg(t);
    }
    cmd.arg("--").args(argv);
    Ok(cmd)
}

/// `dxd __runner-sandbox <thread> <bin> [--ro DIR]... -- argv...`
pub fn helper_main(args: &[String]) -> ! {
    let fail = |msg: String| -> ! {
        eprintln!("dxd runner sandbox: {msg}");
        std::process::exit(126)
    };
    let Some(sep) = args.iter().position(|a| a == "--") else {
        fail("missing --".into())
    };
    let (head, argv) = (&args[..sep], &args[sep + 1..]);
    if head.len() < 2 || argv.is_empty() {
        fail("usage: __runner-sandbox THREAD BIN [--ro DIR]... -- COMMAND".into());
    }
    let thread = PathBuf::from(&head[0]);
    let bin = PathBuf::from(&head[1]);
    let mut ro = vec![bin];
    let mut i = 2;
    while i + 1 < head.len() && head[i] == "--ro" {
        ro.push(PathBuf::from(&head[i + 1]));
        i += 2;
    }
    if let Err(e) = restrict(&thread, &ro) {
        fail(e);
    }
    use std::os::unix::process::CommandExt;
    let err = Command::new(&argv[0]).args(&argv[1..]).exec();
    fail(format!("exec {}: {err}", argv[0]))
}

#[cfg(target_os = "linux")]
fn restrict(thread: &Path, extra_ro: &[PathBuf]) -> Result<(), String> {
    use landlock::{
        ABI, Access, AccessFs, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
        RulesetAttr, RulesetCreatedAttr, RulesetError, RulesetStatus,
    };
    let abi = ABI::V3;
    let read_dirs = [
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib32",
        "/lib64",
        "/libx32",
        "/etc",
        "/opt",
        "/proc",
        "/sys",
        "/dev",
        "/var",
        "/run",
        "/nix",
        "/snap",
        "/home/linuxbrew",
    ];
    let write_dirs = ["/tmp", "/var/tmp", "/dev/shm", "/dev/pts"];
    let write_files = [
        "/dev/null",
        "/dev/zero",
        "/dev/full",
        "/dev/tty",
        "/dev/ptmx",
        "/dev/urandom",
        "/dev/random",
    ];
    let mut rules: Vec<(PathBuf, BitFlags<AccessFs>)> = Vec::new();
    rules.extend(
        read_dirs
            .iter()
            .map(|d| (PathBuf::from(d), AccessFs::from_read(abi))),
    );
    rules.extend(
        extra_ro
            .iter()
            .map(|d| (d.clone(), AccessFs::from_read(abi))),
    );
    rules.extend(
        write_dirs
            .iter()
            .map(|d| (PathBuf::from(d), AccessFs::from_all(abi))),
    );
    rules.extend(
        write_files
            .iter()
            .map(|f| (PathBuf::from(f), AccessFs::from_file(abi))),
    );
    rules.push((thread.to_path_buf(), AccessFs::from_all(abi)));
    let beneath = rules.into_iter().filter_map(|(path, access)| {
        let fd = PathFd::new(&path).ok()?;
        let access = if path.is_dir() {
            access
        } else {
            access & AccessFs::from_file(abi)
        };
        Some(Ok::<_, RulesetError>(PathBeneath::new(fd, access)))
    });
    let status = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(abi))
        .map_err(|e| e.to_string())?
        .create()
        .map_err(|e| e.to_string())?
        .add_rules(beneath)
        .map_err(|e| e.to_string())?
        .restrict_self()
        .map_err(|e| e.to_string())?;
    if status.ruleset == RulesetStatus::NotEnforced {
        return Err(
            "this kernel has no Landlock; pair with --unsandboxed to run without a sandbox".into(),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn restrict(_thread: &Path, _extra_ro: &[PathBuf]) -> Result<(), String> {
    Err("the __sandbox helper is for Linux".into())
}

/// Proves the sandbox: a command runs, writes outside the Thread folder fail,
/// and reads of the runner's own folder fail.
pub fn self_test(paths: &Paths, unsandboxed: bool) -> Result<Value, String> {
    let dir = paths.threads.join(".selftest");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).map_err(|e| e.to_string())?;
    let probe = paths.runner.join("sandbox-probe");
    let secret = paths.runner.join("read-probe");
    let _ = std::fs::remove_file(&probe);
    std::fs::write(
        &secret,
        "if a sandboxed command can print this, the sandbox is broken\n",
    )
    .map_err(|e| e.to_string())?;
    let sh = |script: String| -> Result<Run, String> {
        let argv = vec!["/bin/bash".into(), "-c".into(), script];
        run_in_thread(
            paths,
            &dir,
            &argv,
            &dir.join("home"),
            Duration::from_secs(20),
            &[],
            unsandboxed,
        )
    };
    let echo = sh("echo ok".into())?;
    let inside = sh("echo x > inside.txt && cat inside.txt".into())?;
    let outside = sh(format!("echo x > '{}'", probe.display()))?;
    let read = sh(format!("cat '{}'", secret.display()))?;
    let wrote_outside = probe.exists();
    let desktop = desktop_port_probe(&sh, unsandboxed)?;
    let _ = std::fs::remove_file(&probe);
    let _ = std::fs::remove_dir_all(&dir);
    let checks = json!({
        "runsCommands": echo.ok() && echo.stdout.trim() == "ok",
        "writesInThreadFolder": inside.ok(),
        "blocksWriteOutside": !outside.ok() && !wrote_outside,
        "blocksReadOfRunnerFolder": !read.ok() && !read.stdout.contains("sandbox is broken"),
    });
    let all = checks
        .as_object()
        .unwrap()
        .values()
        .all(|v| v == &json!(true));
    let ok = if unsandboxed {
        checks["runsCommands"] == json!(true)
    } else {
        all
    };
    Ok(json!({
        "ok": ok,
        "sandbox": kind(unsandboxed),
        "checks": checks,
        // Not part of `ok`: without it only the Desktop stays off.
        "desktopConfined": desktop["confined"],
        "desktop": desktop,
        "details": {
            "echo": echo.stderr.trim(),
            "blockedWrite": outside.stderr.trim(),
            "blockedRead": read.stderr.trim(),
        },
    }))
}

/// Whether a Thread command can reach, or take, the Desktop's port. On a Mac
/// the supervisor holds a listener there while a sandboxed command tries to
/// connect, then a sandboxed command tries to listen there itself; both
/// must fail. Elsewhere there is no Desktop to protect (Linux runners have
/// none; the runner E2E's test Desktop runs unconfined).
fn desktop_port_probe(
    sh: &dyn Fn(String) -> Result<Run, String>,
    unsandboxed: bool,
) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Ok(json!({ "confined": true, "checked": false }));
    }
    if unsandboxed {
        return Ok(json!({ "confined": false, "checked": false }));
    }
    let port = crate::runner::desktop::VOXL_PORT;
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).ok();
    let connect = sh(format!(
        "exec 3<>/dev/tcp/127.0.0.1/{port} && echo connected"
    ))?;
    drop(listener);
    let bind = sh(format!(
        "/usr/bin/perl -MIO::Socket::INET -e 'IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => {port}, Listen => 1, ReuseAddr => 1) or exit 3; print \"bound\\n\"'"
    ))?;
    let connected = connect.stdout.contains("connected");
    let bound = bind.stdout.contains("bound");
    Ok(json!({
        "confined": !connected && !bound,
        "checked": true,
        "connect": connect.stderr.trim(),
        "bind": bind.stderr.trim(),
    }))
}

#[cfg(test)]
mod tests {
    // Ways the Seatbelt profile could let a Thread reach the Mac's Desktop
    // (voxl, unsandboxed, on 127.0.0.1:VOXL_PORT), each checked below:
    // - a Thread command connects to the port (it would still need the
    //   password, but the password is not a secret against same-user `ps -E`);
    // - a Thread command binds the port before voxl does and receives the
    //   supervisor's password and the owner's input;
    // - a later `allow` network rule overrides the deny (last match wins);
    // - the profile names another port than the one voxl listens on.
    // Whether macOS accepts the text is proven only on a Mac (`dxd runner
    // doctor`); this checks the text the runner hands to sandbox-exec.
    use super::seatbelt_profile;
    use crate::runner::desktop::VOXL_PORT;

    #[test]
    fn seatbelt_denies_the_desktop_port() {
        let profile = seatbelt_profile(2);
        let port = VOXL_PORT.to_string();
        for rule in [
            format!("(deny network-outbound (remote ip \"localhost:{port}\"))"),
            format!("(deny network-bind (local ip \"*:{port}\"))"),
            format!("(deny network-inbound (local ip \"*:{port}\"))"),
        ] {
            assert!(profile.contains(&rule), "missing {rule} in\n{profile}");
        }
        let first_deny = profile.find("(deny network-").unwrap();
        assert!(profile.find("(allow default)").unwrap() < first_deny);
        assert!(
            !profile[first_deny..].contains("(allow network"),
            "a later allow would override the deny:\n{profile}"
        );
    }
}
