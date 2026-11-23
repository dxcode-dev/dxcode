//! Tools Core's guest scripts use that a runner host may lack, run by the
//! dxd binary itself: `setsid` and `flock` (macOS ships neither), `timeout`
//! (GNU coreutils; not on macOS), and on macOS `nohup`. Core's scripts use
//! `flock -x <lock> node …` around source preparation, `nohup setsid bash …`
//! for background commands, and `timeout 50 claude …` for Claude Code
//! answers. Apple's nohup also detaches from the console, which fails
//! outside a Terminal session (a LaunchAgent), so the command never starts;
//! this one only ignores SIGHUP, as GNU's does.
//!
//! Git and python3 are never replaced: on a machine with no usable one
//! (macOS without the Command Line Tools, whose `/usr/bin` stubs would open
//! Apple's installer dialog, or a Linux without the package), `git` and
//! `python3` here run the person's own if one appears later and otherwise
//! say what to install, instead of a raw stub prompt or "command not found".
//!
//! The runner links `~/.dx/runner/bin/shims/<tool>` to the dxd binary only
//! for a tool the host's PATH does not have, and puts that folder first on
//! every Thread command's PATH. dxd started under one of those names runs the
//! tool instead of the daemon (`dispatch`, before anything else in `main`).

use std::ffi::CString;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const TOOLS: [&str; 3] = ["setsid", "flock", "timeout"];
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
        "timeout" => Some(timeout(&rest)),
        "git" | "python3" => Some(prerequisite(&tool, &rest)),
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
        .chain(crate::runner::tools::missing_prerequisites(path))
        .collect();
    // A link for a tool the host now has (installed since) goes, so the
    // host's own runs again.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let stale = !missing.iter().any(|tool| name == *tool);
            if stale && std::fs::read_link(entry.path()).is_ok() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
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

/// `setsid [-f] [-w] <command> [args…]`: the command runs in a new session.
/// As util-linux's: a process-group leader (or `-f`) forks first and the
/// caller returns at once (with `-w`, once the command exits, with its
/// status); otherwise this process becomes the session and runs the command
/// itself, so `setsid … &` leaves `$!` naming the command's process, which
/// Core's Claude Code launch records and later signals.
fn setsid(args: &[String]) -> i32 {
    let (mut fork, mut wait, mut i) = (false, false, 0);
    while let Some(arg) = args.get(i) {
        match arg.as_str() {
            "-f" | "--fork" => fork = true,
            "-w" | "--wait" => wait = true,
            "-c" | "--ctty" => {}
            "--" => {
                i += 1;
                break;
            }
            _ if arg.starts_with('-') => {
                eprintln!("setsid: unsupported option {arg}");
                return 1;
            }
            _ => break,
        }
        i += 1;
    }
    let command = &args[i.min(args.len())..];
    if command.is_empty() {
        eprintln!("usage: setsid [-f] [-w] <command> [arguments…]");
        return 1;
    }
    // SAFETY: plain libc calls; dxd has started no thread yet.
    if fork || unsafe { libc::getpgrp() == libc::getpid() } {
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return 1;
        }
        if pid > 0 {
            if !wait {
                return 0;
            }
            let mut status = 0;
            unsafe { libc::waitpid(pid, &mut status, 0) };
            return if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                128 + libc::WTERMSIG(status)
            };
        }
    }
    unsafe {
        libc::setsid();
    }
    run(command)
}

/// A GNU duration: a number with an optional `s`, `m`, `h`, or `d`.
fn duration(text: &str) -> Option<std::time::Duration> {
    let (number, unit) = match text.char_indices().last()? {
        (i, c) if c.is_ascii_alphabetic() => (&text[..i], c),
        _ => (text, 's'),
    };
    let value: f64 = number
        .parse()
        .ok()
        .filter(|v: &f64| v.is_finite() && *v >= 0.0)?;
    let seconds = match unit {
        's' => value,
        'm' => value * 60.0,
        'h' => value * 3600.0,
        'd' => value * 86400.0,
        _ => return None,
    };
    Some(std::time::Duration::from_secs_f64(seconds))
}

fn signal_number(name: &str) -> Option<i32> {
    let name = name.trim_start_matches("SIG");
    Some(match name {
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "INT" => libc::SIGINT,
        "HUP" => libc::SIGHUP,
        "QUIT" => libc::SIGQUIT,
        "USR1" => libc::SIGUSR1,
        "USR2" => libc::SIGUSR2,
        _ => name.parse().ok()?,
    })
}

/// `timeout [-s SIG] [-k DURATION] [--preserve-status] [--foreground]
/// DURATION <command> [args…]`, as GNU coreutils' (exit 124 on a timeout,
/// 125 for its own errors, 126/127 when the command cannot run).
fn timeout(args: &[String]) -> i32 {
    let (mut signal, mut kill_after, mut preserve, mut i) = (libc::SIGTERM, None, false, 0);
    let mut foreground = false;
    while let Some(arg) = args.get(i) {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = || {
            inline.clone().or_else(|| {
                i += 1;
                args.get(i).cloned()
            })
        };
        match flag {
            "-s" | "--signal" => match value().as_deref().and_then(signal_number) {
                Some(s) => signal = s,
                None => {
                    eprintln!("timeout: invalid signal");
                    return 125;
                }
            },
            "-k" | "--kill-after" => match value().as_deref().and_then(duration) {
                Some(d) => kill_after = Some(d),
                None => {
                    eprintln!("timeout: invalid duration");
                    return 125;
                }
            },
            "--preserve-status" => preserve = true,
            "--foreground" => foreground = true,
            "-v" | "--verbose" => {}
            "--" => {
                i += 1;
                break;
            }
            _ if arg.starts_with('-')
                && arg.len() > 1
                && !arg[1..].starts_with(|c: char| c.is_ascii_digit()) =>
            {
                eprintln!("timeout: unsupported option {arg}");
                return 125;
            }
            _ => break,
        }
        i += 1;
    }
    let Some(limit) = args.get(i).and_then(|d| duration(d)) else {
        eprintln!("usage: timeout [-s SIGNAL] [-k DURATION] DURATION <command> [arguments…]");
        return 125;
    };
    let command = &args[i + 1..];
    if command.is_empty() {
        eprintln!("timeout: missing command");
        return 125;
    }
    // SAFETY: dxd has started no thread yet; the child only execs.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return 125;
    }
    if pid == 0 {
        // As GNU's: the command leads its own process group, so the limit
        // ends everything it started, not only the command itself.
        if !foreground {
            unsafe { libc::setpgid(0, 0) };
        }
        std::process::exit(run(command));
    }
    // Both sides set it, so a signal sent before the child runs still finds
    // the group.
    let target = if foreground {
        pid
    } else {
        unsafe { libc::setpgid(pid, pid) };
        -pid
    };
    // A signal that stops this process reaches the command's group too.
    for forwarded in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe { libc::signal(forwarded, forward_signal as libc::sighandler_t) };
    }
    let started = std::time::Instant::now();
    let mut status = 0;
    let mut timed_out = false;
    let mut killed_at: Option<std::time::Instant> = None;
    loop {
        let done = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if done == pid {
            break;
        }
        if done < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return 125;
        }
        let received = RECEIVED.swap(0, std::sync::atomic::Ordering::SeqCst);
        if received != 0 {
            unsafe { libc::kill(target, received) };
        }
        if !timed_out && !limit.is_zero() && started.elapsed() >= limit {
            timed_out = true;
            unsafe { libc::kill(target, signal) };
            killed_at = Some(std::time::Instant::now());
        }
        if let (Some(at), Some(after)) = (killed_at, kill_after)
            && at.elapsed() >= after
        {
            unsafe { libc::kill(target, libc::SIGKILL) };
            killed_at = None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    };
    if timed_out && !preserve {
        if libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL {
            137
        } else {
            124
        }
    } else {
        code
    }
}

/// The last SIGTERM, SIGINT, or SIGHUP the `timeout` shim received, for its
/// loop to pass on to the command's group.
static RECEIVED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

extern "C" fn forward_signal(signal: libc::c_int) {
    RECEIVED.store(signal, std::sync::atomic::Ordering::SeqCst);
}

/// `git` or `python3` on a machine without a usable one when the runner
/// started: the person's own if one is there now (the Command Line Tools
/// finished installing), else what to install, with exit 127.
fn prerequisite(tool: &str, args: &[String]) -> i32 {
    use crate::runner::tools;
    let me = std::env::current_exe().and_then(std::fs::canonicalize).ok();
    let path = std::env::var("PATH").unwrap_or_default();
    let shim = |p: &Path| std::fs::canonicalize(p).ok() == me;
    if let Some(found) = tools::find_prerequisite(&path, tool, tools::command_line_tools(), &shim) {
        let error = Command::new(&found).args(args).exec();
        eprintln!("{tool}: {error}");
        return 126;
    }
    eprintln!("dx runner: {}", tools::prerequisite_advice(tool));
    127
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
