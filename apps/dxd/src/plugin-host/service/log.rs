//! One install's service log: every line its setup, run, and listeners
//! print, each prefixed with where it came from, in
//! `<log dir>/services/<installId>.log` (1 MiB, one rotation).

use super::super::lock;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(super) const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// The longest line kept, in the log or sent to a listener's endpoint.
pub(super) const MAX_LINE_BYTES: usize = 64 * 1024;
/// The most a `service.logs` answer carries.
const MAX_TAIL_BYTES: usize = 512 * 1024;
pub(super) const TRUNCATED: &str = "…[truncated]";

pub(super) struct ServiceLog {
    path: PathBuf,
    file: Mutex<Option<(File, u64)>>,
}

impl ServiceLog {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: Mutex::new(None),
        }
    }

    /// Appends `prefix line\n`, rotating first when the file would pass
    /// the limit. A log that cannot be written loses the line, never the
    /// service.
    pub(super) fn line(&self, prefix: &str, line: &[u8]) {
        let mut text = Vec::with_capacity(prefix.len() + line.len() + 2);
        text.extend_from_slice(prefix.as_bytes());
        text.push(b' ');
        text.extend_from_slice(line);
        text.push(b'\n');
        let mut file = lock(&self.file);
        if file
            .as_ref()
            .is_some_and(|(_, size)| size + text.len() as u64 > MAX_LOG_BYTES)
        {
            *file = None;
            let _ = fs::rename(&self.path, rotated(&self.path));
        }
        if file.is_none() {
            *file = self.open().ok();
        }
        if let Some((handle, size)) = file.as_mut()
            && handle.write_all(&text).is_ok()
        {
            *size += text.len() as u64;
        }
    }

    fn open(&self) -> io::Result<(File, u64)> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut handle = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)?;
        let mut size = handle.seek(SeekFrom::End(0))?;
        if size > MAX_LOG_BYTES {
            drop(handle);
            let _ = fs::rename(&self.path, rotated(&self.path));
            handle = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&self.path)?;
            size = 0;
        }
        Ok((handle, size))
    }
}

fn rotated(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// The last `lines` lines of the log and its rotation, at most 512 KiB.
pub(super) fn tail(path: &Path, lines: usize) -> String {
    let mut bytes = Vec::new();
    for file in [rotated(path), path.to_owned()] {
        let Ok(mut handle) = File::open(&file) else {
            continue;
        };
        let size = handle.metadata().map_or(0, |metadata| metadata.len());
        let start = size.saturating_sub(MAX_TAIL_BYTES as u64);
        if handle.seek(SeekFrom::Start(start)).is_ok() {
            let _ = handle.take(MAX_TAIL_BYTES as u64).read_to_end(&mut bytes);
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    let mut kept = all[all.len().saturating_sub(lines)..].join("\n");
    if kept.len() > MAX_TAIL_BYTES {
        let mut cut = kept.len() - MAX_TAIL_BYTES;
        while !kept.is_char_boundary(cut) {
            cut += 1;
        }
        kept = kept[cut..].to_owned();
    }
    kept
}

/// Reads one line of at most `maximum` bytes into `line` (without its
/// newline or carriage return), discarding the rest of a longer one.
/// `None` at the end of the stream; otherwise whether it was cut.
pub(super) fn read_line(
    reader: &mut impl BufRead,
    maximum: usize,
    line: &mut Vec<u8>,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut truncated = false;
    let mut any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(any.then_some(truncated));
        }
        any = true;
        let (chunk, newline) = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => (&available[..index], Some(index)),
            None => (available, None),
        };
        let room = maximum.saturating_sub(line.len());
        if chunk.len() > room {
            truncated = true;
        }
        line.extend_from_slice(&chunk[..chunk.len().min(room)]);
        let used = newline.map_or(available.len(), |index| index + 1);
        reader.consume(used);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(truncated));
        }
    }
}

/// `2026-11-25T08:15:30.123Z` for milliseconds since the epoch.
pub(super) fn rfc3339(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        milliseconds % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(1_795_598_130_123), "2026-11-25T09:15:30.123Z");
    }

    // Ways it could fail: a long line held whole in memory, its remainder
    // read as the next line, a carriage return kept, or the last line
    // without a newline lost.
    #[test]
    fn lines_are_bounded_and_split_exactly() {
        let input = format!("short\r\n{}\nnext\nlast", "x".repeat(100));
        let mut reader = io::BufReader::with_capacity(16, input.as_bytes());
        let mut line = Vec::new();
        let mut seen = Vec::new();
        while let Some(truncated) = read_line(&mut reader, 10, &mut line).unwrap() {
            seen.push((String::from_utf8(line.clone()).unwrap(), truncated));
        }
        assert_eq!(
            seen,
            [
                ("short".into(), false),
                ("x".repeat(10), true),
                ("next".into(), false),
                ("last".into(), false),
            ]
        );
    }

    #[test]
    fn the_log_rotates_once_and_tails_across_the_rotation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("services/plg_a.log");
        let log = ServiceLog::new(path.clone());
        let line = "y".repeat(1000);
        for _ in 0..2_200 {
            log.line("[run]", line.as_bytes());
        }
        log.line("[setup]", b"the end");
        assert!(fs::metadata(&path).unwrap().len() <= MAX_LOG_BYTES);
        assert!(fs::metadata(rotated(&path)).unwrap().len() <= MAX_LOG_BYTES);
        let tail = tail(&path, 2);
        assert!(tail.ends_with("[setup] the end"), "{tail:.80}");
        assert_eq!(tail.lines().count(), 2);
    }
}
