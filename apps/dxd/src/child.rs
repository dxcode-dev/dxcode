//! Bounded child processes for Git: output is read up to a byte limit, the
//! whole run is bounded by a deadline, and a child that exceeds either is
//! killed with its process group. `poll` wakes the caller the moment output
//! or EOF arrives, so a short command costs neither a polling delay nor a
//! reader thread.

use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Run `command` with `input` on stdin (keep it well under a pipe buffer),
/// stdout captured and stderr discarded. Fails with `TimedOut` after
/// `timeout` and with `FileTooLarge` beyond `limit` output bytes.
pub fn run(
    command: &mut Command,
    input: &[u8],
    limit: usize,
    timeout: Duration,
) -> io::Result<(ExitStatus, Vec<u8>)> {
    command
        .stdin(if input.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn()?;
    let result = finish(&mut child, input, limit, Instant::now() + timeout);
    if result.is_err() {
        // SAFETY: the child leads its own process group (see above) and has
        // not been reaped, so the group id still names it.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn finish(
    child: &mut Child,
    input: &[u8],
    limit: usize,
    deadline: Instant,
) -> io::Result<(ExitStatus, Vec<u8>)> {
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input)?;
    }
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut output = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        wait_readable(&stdout, deadline)?;
        let read = match stdout.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if read == 0 {
            break;
        }
        if output.len() + read > limit {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    // EOF means the child closed stdout, which it does as it exits.
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status, output));
        }
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn wait_readable(fd: &impl AsFd, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let mut poll = libc::pollfd {
            fd: fd.as_fd().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let milliseconds = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd for the duration of the call.
        match unsafe { libc::poll(&mut poll, 1, milliseconds) } {
            0 => continue,
            -1 => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            _ => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_output_as_soon_as_the_child_exits() {
        let started = Instant::now();
        let (status, output) = run(
            Command::new("/bin/sh").args(["-c", "cat; echo done"]),
            b"input\n",
            1024,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(status.success());
        assert_eq!(output, b"input\ndone\n");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn bounds_time_and_output_and_kills_the_process_group() {
        let started = Instant::now();
        // The background sleep holds stdout open after the shell exits.
        let error = run(
            Command::new("/bin/sh").args(["-c", "sleep 30 & echo $!"]),
            b"",
            1024,
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        let error = run(
            Command::new("/bin/sh").args(["-c", "head -c 4096 /dev/zero"]),
            b"",
            1024,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
    }
}
