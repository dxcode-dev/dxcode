//! `dx`, the executable of `~/.dx/runner/dx.app` on a Mac runner.
//!
//! macOS grants Screen Recording and Accessibility to a program's code
//! identity, and an ad-hoc signature's identity is its hash. voxl (the
//! Desktop's screen server) changes with every update, so a grant given to
//! voxl itself is lost on each one. This launcher changes only when dx
//! deliberately ships a new one: the supervisor (`dxd runner`) starts it as
//! its own responsible process, and it starts `~/.dx/runner/bin/voxl` as an
//! ordinary child, which macOS treats as covered by the launcher's grants.
//! So the person allows "dx" once, and voxl updates keep working.
//!
//! It runs nothing else: the program is always `<runner>/bin/voxl`, found
//! from the launcher's own path (`<runner>/dx.app/Contents/MacOS/dx`), a
//! folder no Thread can write. Arguments and the environment (voxl's
//! password) pass through; SIGTERM, SIGINT and SIGHUP are forwarded, and the
//! launcher exits as voxl did. It is the seed of a future dx Mac app, which
//! would keep this bundle identifier for the Desktop helper.

use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::atomic::{AtomicI32, Ordering};

static CHILD: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward(signal: libc::c_int) {
    let pid = CHILD.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill is async-signal-safe.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// `<runner>/bin/voxl` for a launcher at `<runner>/dx.app/Contents/MacOS/dx`.
fn voxl() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("cannot find myself: {e}"))?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|b| b.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| format!("{} is not inside an app bundle", exe.display()))?;
    let runner = bundle
        .parent()
        .ok_or_else(|| "the bundle has no parent folder".to_string())?;
    let voxl = runner.join("bin").join("voxl");
    match std::fs::symlink_metadata(&voxl) {
        Ok(m) if m.file_type().is_file() => Ok(voxl),
        Ok(_) => Err(format!("{} is not a regular file", voxl.display())),
        Err(e) => Err(format!("{}: {e}", voxl.display())),
    }
}

fn main() -> ExitCode {
    let voxl = match voxl() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("dx: {e}");
            return ExitCode::from(127);
        }
    };
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installs a handler that only calls kill.
        unsafe {
            libc::signal(
                signal,
                forward as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
    let mut child = match Command::new(&voxl)
        .args(std::env::args_os().skip(1))
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            eprintln!("dx: {}: {e}", voxl.display());
            return ExitCode::from(126);
        }
    };
    CHILD.store(child.id() as i32, Ordering::SeqCst);
    let status = loop {
        match child.wait() {
            Ok(status) => break status,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                eprintln!("dx: waiting for voxl: {e}");
                return ExitCode::from(1);
            }
        }
    };
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => ExitCode::from(code as u8),
        (None, Some(signal)) => ExitCode::from(128u8.wrapping_add(signal as u8)),
        _ => ExitCode::from(1),
    }
}
