//! `setsid` and `flock` for runner hosts that lack them (macOS ships
//! neither), and on macOS `nohup`. Core's guest scripts use all three:
//! `flock -x <lock> node …` around source preparation and
//! `nohup setsid bash …` for background commands. Apple's nohup also
//! detaches from the console, which fails outside a Terminal session (a
//! LaunchAgent), so the command never starts; this one only ignores SIGHUP,
//! as GNU's does.
//!
//! The runner links `~/.dx/runner/bin/shims/<tool>` to the dxd binary only
//! for a tool the host's PATH does not have, and puts that folder first on
//! every Thread command's PATH. dxd started under one of those names runs the
//! tool instead of the daemon (`dispatch`, before anything else in `main`).

use std::ffi::CString;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const TOOLS: [&str; 2] = ["setsid", "flock"];
/// Linked even where the host has its own.
const REPLACED: &[&str] = if cfg!(target_os = "macos") {
    &["nohup"]
} else {
    &[]
};

/// Runs `setsid` or `flock` when dxd was started under that name.
pub fn dispatch() -> Option<i32> {
    let mut args = std::env::args();
    let name = args.next()?;
    let tool = Path::new(&name).file_name()?.to_str()?.to_string();
    let rest: Vec<String> = args.collect();
    match tool.as_str() {
        "setsid" => Some(setsid(&rest)),
        "flock" => Some(flock(&rest)),
        "nohup" => Some(nohup(&rest)),
        _ => None,
    }
}

/// The shims folder, with a link for each tool missing from `path`.
pub fn install(bin: &Path, path: &str) -> Option<PathBuf> {
    let dir = bin.join("shims");
    let exe = bin.join("dxd");
    let missing: Vec<&str> = TOOLS
        .into_iter()
        .filter(|tool| {
            !path
                .split(':')
                .any(|d| !d.is_empty() && Path::new(d).join(tool).is_file())
        })
        .chain(REPLACED.iter().copied())
        .collect();
    if missing.is_empty() || !exe.is_file() {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    for tool in missing {
        let link = dir.join(tool);
        if std::fs::read_link(&link).ok().as_deref() != Some(exe.as_path()) {
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&exe, &link).ok()?;
        }
    }
    Some(dir)
}

fn run(command: &[String]) -> i32 {
    let error = Command::new(&command[0]).args(&command[1..]).exec();
    eprintln!("{}: {error}", command[0]);
    if error.kind() == std::io::ErrorKind::NotFound {
        127
    } else {
        126
    }
}

/// `setsid <command> [args…]`: the command runs in a new session, detached
/// from the caller, which returns at once (as util-linux does from a
/// process-group leader).
fn setsid(args: &[String]) -> i32 {
    if args.is_empty() || args[0].starts_with('-') {
        eprintln!("usage: setsid <command> [arguments…]");
        return 1;
    }
    // SAFETY: called before dxd starts any thread; the child only calls
    // async-signal-safe setsid before exec.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return 1;
    }
    if pid > 0 {
        return 0;
    }
    unsafe {
        libc::setsid();
    }
    run(args)
}

/// `nohup <command> [args…]`: the command ignores SIGHUP; output bound for a
/// terminal goes to `nohup.out` instead, as GNU nohup does.
fn nohup(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("usage: nohup <command> [arguments…]");
        return 125;
    }
    // SAFETY: plain libc calls on this process's own descriptors before exec.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        if libc::isatty(1) == 1 {
            let name = CString::new("nohup.out").unwrap();
            let fd = libc::open(
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
                0o600,
            );
            if fd >= 0 {
                libc::dup2(fd, 1);
                libc::close(fd);
            }
        }
        if libc::isatty(2) == 1 {
            libc::dup2(1, 2);
        }
    }
    run(args)
}

/// `flock [-x|-s] [-n] <file> <command> [args…]` or `flock … <file> -c <cmd>`:
/// holds the lock on `file` while the command runs.
fn flock(args: &[String]) -> i32 {
    let mut operation = libc::LOCK_EX;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        match arg.as_str() {
            "-x" | "-e" | "--exclusive" => operation = (operation & libc::LOCK_NB) | libc::LOCK_EX,
            "-s" | "--shared" => operation = (operation & libc::LOCK_NB) | libc::LOCK_SH,
            "-n" | "--nb" | "--nonblock" => operation |= libc::LOCK_NB,
            "-o" | "--close" => {}
            _ if arg.starts_with('-') => {
                eprintln!("flock: unsupported option {arg}");
                return 64;
            }
            _ => break,
        }
        i += 1;
    }
    let Some(file) = args.get(i) else {
        eprintln!("usage: flock [-x|-s] [-n] <file> <command> [arguments…]");
        return 64;
    };
    let command: Vec<String> = match args.get(i + 1).map(String::as_str) {
        Some("-c") => match args.get(i + 2) {
            Some(script) => vec!["/bin/sh".into(), "-c".into(), script.clone()],
            None => return 64,
        },
        Some(_) => args[i + 1..].to_vec(),
        None => return 64,
    };
    let Ok(c_path) = CString::new(file.as_str()) else {
        return 64;
    };
    // No O_CLOEXEC: the command inherits the descriptor, so the lock lasts
    // until it exits.
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_CREAT | libc::O_NOCTTY,
            0o600,
        )
    };
    if fd < 0 {
        eprintln!(
            "flock: cannot open {file}: {}",
            std::io::Error::last_os_error()
        );
        return 66;
    }
    loop {
        if unsafe { libc::flock(fd, operation) } == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return 1;
    }
    run(&command)
}
