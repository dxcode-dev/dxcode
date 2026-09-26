use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::fs;
use std::io::{self, Read};
use std::os::fd::RawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const QUIET_PERIOD: Duration = Duration::from_millis(250);
const MAX_WAIT: Duration = Duration::from_secs(1);
const FALLBACK_PERIOD: Duration = Duration::from_secs(5);
const MAX_WATCHES: usize = 8192;
const EVENT_BUFFER_BYTES: usize = 64 * 1024;
const GIT_IGNORE_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_GIT_IGNORE_BYTES: usize = 4 * 1024 * 1024;

#[cfg(test)]
static GIT_IGNORE_INVOCATIONS: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, usize>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

pub struct Observer {
    dirty: Receiver<()>,
}

impl Observer {
    pub fn start(root: &Path) -> Self {
        let root = root.to_owned();
        let (sender, dirty) = mpsc::sync_channel(1);
        thread::spawn(move || observe(root, sender));
        Self { dirty }
    }

    pub fn take_dirty(&self) -> bool {
        let mut dirty = false;
        while self.dirty.try_recv().is_ok() {
            dirty = true;
        }
        dirty
    }
}

#[derive(Default)]
struct Coalescer {
    first: Option<Instant>,
    latest: Option<Instant>,
}

impl Coalescer {
    fn mutation(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.latest = Some(now);
    }

    fn ready(&self, now: Instant) -> bool {
        self.first
            .is_some_and(|first| now.duration_since(first) >= MAX_WAIT)
            || self
                .latest
                .is_some_and(|latest| now.duration_since(latest) >= QUIET_PERIOD)
    }

    fn clear(&mut self) {
        self.first = None;
        self.latest = None;
    }
}

fn observe(root: PathBuf, sender: SyncSender<()>) {
    let mut setup = build_watch_sets(&root).ok();
    let mut fallback = setup
        .as_ref()
        .is_none_or(|sets| sets.iter().any(|(_, set)| set.capped));
    let mut next_fallback = Instant::now() + FALLBACK_PERIOD;
    let mut coalescer = Coalescer::default();
    let mut buffer = vec![0_u8; EVENT_BUFFER_BYTES];

    loop {
        let now = Instant::now();
        let mut reconcile = false;
        let mut failed = false;
        if let Some(sets) = setup.as_mut() {
            for (checkout, watches) in sets {
                loop {
                    let read = unsafe {
                        libc::read(
                            watches.fd,
                            buffer.as_mut_ptr().cast(),
                            buffer.len() as libc::size_t,
                        )
                    };
                    if read < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::WouldBlock {
                            failed = true;
                        }
                        break;
                    }
                    if read == 0 {
                        break;
                    }
                    let mut offset = 0;
                    while offset + size_of::<libc::inotify_event>() <= read as usize {
                        let event = unsafe {
                            std::ptr::read_unaligned(
                                buffer.as_ptr().add(offset).cast::<libc::inotify_event>(),
                            )
                        };
                        let event_size = size_of::<libc::inotify_event>() + event.len as usize;
                        if offset + event_size > read as usize {
                            reconcile = true;
                            break;
                        }
                        let path = watches.event_path(
                            event.wd,
                            &buffer[offset + size_of::<libc::inotify_event>()..offset + event_size],
                        );
                        offset += event_size;
                        if event.mask & libc::IN_Q_OVERFLOW != 0 {
                            reconcile = true;
                            coalescer.mutation(now);
                        }
                        if event.mask & mutation_mask() != 0 {
                            let ignore_definition = path
                                .as_ref()
                                .is_some_and(|path| is_ignore_definition(checkout, path));
                            if ignore_definition {
                                reconcile = true;
                            }
                            if ignore_definition
                                || !path.as_ref().is_some_and(|path| {
                                    watches.ignores_event(checkout, path, event.mask)
                                })
                            {
                                coalescer.mutation(now);
                            }
                        }
                        if event.mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 {
                            reconcile = true;
                        }
                        if event.mask & libc::IN_ISDIR != 0
                            && event.mask
                                & (libc::IN_CREATE
                                    | libc::IN_MOVED_TO
                                    | libc::IN_MOVED_FROM
                                    | libc::IN_DELETE)
                                != 0
                        {
                            reconcile = true;
                        }
                    }
                }
            }
        }
        if failed {
            setup = None;
            fallback = true;
        }
        if reconcile {
            setup = build_watch_sets(&root).ok();
            fallback = setup
                .as_ref()
                .is_none_or(|sets| sets.iter().any(|(_, set)| set.capped));
            if fallback {
                next_fallback = now + FALLBACK_PERIOD;
            }
        }
        if fallback && now >= next_fallback {
            coalescer.mutation(now);
            next_fallback = now + FALLBACK_PERIOD;
            // Limits can change while dxd remains resident.
            setup = build_watch_sets(&root).ok();
            fallback = setup
                .as_ref()
                .is_none_or(|sets| sets.iter().any(|(_, set)| set.capped));
        }
        if coalescer.ready(now) {
            let _ = sender.try_send(());
            coalescer.clear();
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn build_watch_sets(primary: &Path) -> io::Result<Vec<(PathBuf, WatchSet)>> {
    let roots = crate::worktrees::selected(primary).unwrap_or_else(|_| vec![primary.to_owned()]);
    let mut remaining = MAX_WATCHES;
    let mut sets = Vec::with_capacity(roots.len());
    for root in roots {
        let set = WatchSet::build_with_limit(&root, remaining)?;
        remaining = remaining.saturating_sub(set.count);
        sets.push((root, set));
    }
    Ok(sets)
}

struct WatchSet {
    fd: RawFd,
    capped: bool,
    count: usize,
    paths: HashMap<i32, PathBuf>,
    ignored: Option<IgnoredPaths>,
}

impl WatchSet {
    fn build(root: &Path) -> io::Result<Self> {
        Self::build_with_limit(root, MAX_WATCHES)
    }

    fn build_with_limit(root: &Path, limit: usize) -> io::Result<Self> {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut result = Self {
            fd,
            capped: false,
            count: 0,
            paths: HashMap::new(),
            // If Git is absent, slow, or returns too much output, retain the
            // legacy traversal rather than risking missed Changes hints.
            ignored: IgnoredPaths::load(root).ok(),
        };
        if result.ignored.is_none() {
            // This contains no workspace path or file content. It is useful
            // when diagnosing why a checkout retained legacy traversal.
            eprintln!("dxd observer: ignore discovery unavailable; using legacy traversal");
        }
        let mut pending = vec![root.to_owned()];
        while let Some(directory) = pending.pop() {
            if result.count == limit {
                result.capped = true;
                break;
            }
            let path = CString::new(directory.as_os_str().as_bytes())
                .map_err(|_| io::ErrorKind::InvalidInput)?;
            let watch = unsafe { libc::inotify_add_watch(fd, path.as_ptr(), mutation_mask()) };
            if watch < 0 {
                result.capped = true;
                continue;
            }
            result.count += 1;
            result.paths.insert(watch, directory.clone());
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    result.capped = true;
                    continue;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if result.excludes_from_traversal(root, &path) {
                    continue;
                }
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    pending.push(path);
                }
            }
        }
        Ok(result)
    }

    fn event_path(&self, watch: i32, name: &[u8]) -> Option<PathBuf> {
        let directory = self.paths.get(&watch)?;
        let name = name.split(|byte| *byte == 0).next().unwrap_or_default();
        if name.is_empty() {
            Some(directory.clone())
        } else {
            Some(directory.join(std::ffi::OsString::from_vec(name.to_vec())))
        }
    }

    fn excludes_from_traversal(&self, root: &Path, path: &Path) -> bool {
        self.ignored
            .as_ref()
            .is_some_and(|ignored| ignored.contains(root, path))
            || legacy_excluded(root, path)
    }

    fn ignores_event(&mut self, root: &Path, path: &Path, mask: u32) -> bool {
        if self.excludes_from_traversal(root, path) {
            return true;
        }
        if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) == 0 {
            return false;
        }
        self.ignored
            .as_mut()
            .is_some_and(|ignored| ignored.classify_created(root, path, mask).unwrap_or(false))
    }
}

impl Drop for WatchSet {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

fn mutation_mask() -> u32 {
    libc::IN_MODIFY
        | libc::IN_ATTRIB
        | libc::IN_CLOSE_WRITE
        | libc::IN_CREATE
        | libc::IN_DELETE
        | libc::IN_MOVED_FROM
        | libc::IN_MOVED_TO
        | libc::IN_DELETE_SELF
        | libc::IN_MOVE_SELF
}

fn legacy_excluded(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    let mut components = relative.components();
    if components
        .next()
        .is_none_or(|part| part.as_os_str() != ".git")
    {
        return false;
    }
    components.next().is_some_and(|part| {
        let name = part.as_os_str();
        name == "objects" || name == "logs"
    })
}

struct IgnoredPaths {
    directories: HashSet<PathBuf>,
    files: HashSet<PathBuf>,
}

impl IgnoredPaths {
    fn load(root: &Path) -> io::Result<Self> {
        let output = git_ignore_output(
            root,
            [
                "-c",
                "core.excludesFile=/dev/null",
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
            &[],
            false,
        )?;
        let mut directories = HashSet::new();
        let mut files = HashSet::new();
        for path in output
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let directory = path.last() == Some(&b'/');
            let path = if directory {
                &path[..path.len() - 1]
            } else {
                path
            };
            let path = PathBuf::from(std::ffi::OsString::from_vec(path.to_vec()));
            if !is_checkout_relative(&path) {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if directory {
                directories.insert(path);
            } else {
                files.insert(path);
            }
        }
        Ok(Self { directories, files })
    }

    fn classify_created(&mut self, root: &Path, path: &Path, mask: u32) -> io::Result<bool> {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::ErrorKind::InvalidInput)?;
        if !is_checkout_relative(relative) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut input = relative.as_os_str().as_bytes().to_vec();
        input.push(0);
        let output = git_ignore_output(
            root,
            [
                "-c",
                "core.excludesFile=/dev/null",
                "check-ignore",
                "--no-index",
                "--stdin",
                "-z",
            ],
            &input,
            true,
        )?;
        if output.is_empty() {
            return Ok(false);
        }
        if output != input {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if mask & libc::IN_ISDIR != 0 {
            self.directories.insert(relative.to_owned());
        } else {
            self.files.insert(relative.to_owned());
        }
        Ok(true)
    }

    fn contains(&self, root: &Path, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        self.files.contains(relative)
            || relative
                .ancestors()
                .any(|ancestor| self.directories.contains(ancestor))
    }
}

fn is_checkout_relative(path: &Path) -> bool {
    !path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

fn git_ignore_output<const N: usize>(
    root: &Path,
    arguments: [&str; N],
    input: &[u8],
    no_match_is_ok: bool,
) -> io::Result<Vec<u8>> {
    #[cfg(test)]
    {
        *GIT_IGNORE_INVOCATIONS
            .lock()
            .unwrap()
            .entry(root.to_owned())
            .or_default() += 1;
    }
    let mut command = Command::new("git");
    command
        .args(arguments)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: this child only creates a process group before exec so timeout
    // cleanup also closes output inherited by Git helpers.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        if let Err(error) = stdin.write_all(input) {
            stop_git(&mut child);
            return Err(error);
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("git stdout was not piped"))?;
    let reader = thread::spawn(move || read_git_ignore_output(stdout));
    let deadline = Instant::now() + GIT_IGNORE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                stop_git(&mut child);
                break Err(io::ErrorKind::TimedOut.into());
            }
            Err(error) => {
                stop_git(&mut child);
                break Err(error);
            }
        }
    };
    let output = reader
        .join()
        .map_err(|_| io::Error::other("git output reader panicked"))??;
    let status = status?;
    if !status.success() && !(no_match_is_ok && status.code() == Some(1)) {
        return Err(io::ErrorKind::Other.into());
    }
    Ok(output)
}

fn stop_git(child: &mut std::process::Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn read_git_ignore_output(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if output.len() + read > MAX_GIT_IGNORE_BYTES {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(output)
}

fn is_ignore_definition(root: &Path, path: &Path) -> bool {
    if path.file_name().is_some_and(|name| name == ".gitignore") {
        return true;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative == Path::new(".git/info/exclude")
        || relative == Path::new(".git/config")
        || relative == Path::new(".git/index")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Command;

    fn git_ignore_invocations(root: &Path) -> usize {
        GIT_IGNORE_INVOCATIONS
            .lock()
            .unwrap()
            .get(root)
            .copied()
            .unwrap_or_default()
    }

    fn wait_dirty(observer: &Observer) {
        let _ = wait_dirty_after(observer, Instant::now());
    }

    fn wait_dirty_after(observer: &Observer, started_at: Instant) -> Duration {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if observer.take_dirty() {
                return started_at.elapsed();
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("observer did not report mutation");
    }

    fn initialize_git(checkout: &Path) {
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(checkout)
                .status()
                .unwrap()
                .success()
        );
    }

    fn git(checkout: &Path, arguments: &[&str]) {
        assert!(
            Command::new("git")
                .args(["-c", "commit.gpgsign=false"])
                .args(arguments)
                .current_dir(checkout)
                .status()
                .unwrap()
                .success()
        );
    }

    fn stage(checkout: &Path, path: &str) {
        assert!(
            Command::new("git")
                .args(["add", "--force", path])
                .current_dir(checkout)
                .status()
                .unwrap()
                .success()
        );
    }

    fn assert_no_dirty(observer: &Observer) {
        thread::sleep(QUIET_PERIOD + Duration::from_millis(150));
        assert!(
            !observer.take_dirty(),
            "ignored-only mutation emitted a Changes hint"
        );
    }

    fn summarize_millis(samples: &[Duration]) -> (u128, u128, u128, u128) {
        let mut values = samples.iter().map(Duration::as_millis).collect::<Vec<_>>();
        values.sort_unstable();
        (
            values[0],
            values[(values.len() / 2) - 1],
            values[(values.len() * 95).div_ceil(100) - 1],
            values[values.len() - 1],
        )
    }

    #[test]
    fn observes_checkout_mutations_but_not_reads() {
        let checkout = tempfile::tempdir().unwrap();
        fs::create_dir(checkout.path().join(".git")).unwrap();
        let watches = WatchSet::build(checkout.path()).unwrap();
        assert!(
            watches.ignored.is_none(),
            "non-Git checkouts must retain legacy watch traversal"
        );
        drop(watches);
        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));

        fs::write(checkout.path().join("untracked"), b"one").unwrap();
        wait_dirty(&observer);
        fs::write(checkout.path().join("replacement.tmp"), b"two").unwrap();
        fs::rename(
            checkout.path().join("replacement.tmp"),
            checkout.path().join("untracked"),
        )
        .unwrap();
        wait_dirty(&observer);
        fs::create_dir(checkout.path().join("nested")).unwrap();
        fs::create_dir(checkout.path().join("nested/deeper")).unwrap();
        fs::write(checkout.path().join("nested/deeper/file"), b"three").unwrap();
        wait_dirty(&observer);
        fs::remove_dir_all(checkout.path().join("nested")).unwrap();
        wait_dirty(&observer);

        let mut contents = Vec::new();
        fs::File::open(checkout.path().join("untracked"))
            .unwrap()
            .read_to_end(&mut contents)
            .unwrap();
        thread::sleep(QUIET_PERIOD + Duration::from_millis(100));
        assert!(!observer.take_dirty(), "file reads must not produce hints");
    }

    #[test]
    fn observes_linked_worktrees_added_before_and_after_start() {
        let checkout = tempfile::tempdir().unwrap();
        let linked_parent = tempfile::tempdir().unwrap();
        initialize_git(checkout.path());
        git(checkout.path(), &["config", "user.name", "dx test"]);
        git(
            checkout.path(),
            &["config", "user.email", "dx-test@example.test"],
        );
        fs::write(checkout.path().join("tracked"), b"base").unwrap();
        git(checkout.path(), &["add", "tracked"]);
        git(checkout.path(), &["commit", "-m", "baseline"]);
        let first = linked_parent.path().join("first");
        git(
            checkout.path(),
            &["worktree", "add", "-b", "first", first.to_str().unwrap()],
        );
        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));

        fs::write(first.join("first-change"), b"one").unwrap();
        wait_dirty(&observer);

        let second = linked_parent.path().join("second");
        git(
            checkout.path(),
            &["worktree", "add", "-b", "second", second.to_str().unwrap()],
        );
        wait_dirty(&observer);
        thread::sleep(QUIET_PERIOD + Duration::from_millis(100));
        while observer.take_dirty() {}
        fs::write(second.join("second-change"), b"two").unwrap();
        wait_dirty(&observer);
    }

    #[test]
    fn ongoing_writes_are_bounded_by_max_wait() {
        let start = Instant::now();
        let mut coalescer = Coalescer::default();
        for step in 0..=10 {
            coalescer.mutation(start + Duration::from_millis(step * 100));
            if step < 10 {
                assert!(!coalescer.ready(start + Duration::from_millis(step * 100)));
            }
        }
        assert!(coalescer.ready(start + MAX_WAIT));
    }

    #[test]
    fn skips_wholly_ignored_directories_without_losing_negated_or_tracked_changes() {
        const IGNORED_DIRECTORIES: usize = 9_001;
        const EDIT_SAMPLES: usize = 20;
        const WRITES_PER_SAMPLE: usize = 500;

        let checkout = tempfile::tempdir().unwrap();
        initialize_git(checkout.path());
        fs::create_dir_all(checkout.path().join("ignored/negated")).unwrap();
        fs::create_dir_all(checkout.path().join("ignored/tracked")).unwrap();
        for index in 0..IGNORED_DIRECTORIES {
            fs::create_dir(
                checkout
                    .path()
                    .join(format!("ignored/directory-{index:05}")),
            )
            .unwrap();
        }
        fs::write(
            checkout.path().join(".gitignore"),
            b"ignored/*\n!ignored/negated/\n!ignored/negated/**\n",
        )
        .unwrap();
        fs::write(checkout.path().join("ignored/negated/visible"), b"one").unwrap();
        fs::write(checkout.path().join("ignored/tracked/visible"), b"one").unwrap();
        stage(checkout.path(), ".gitignore");
        stage(checkout.path(), "ignored/tracked/visible");

        let build_started_at = Instant::now();
        let watches = WatchSet::build(checkout.path()).unwrap();
        let build_duration = build_started_at.elapsed();
        let watch_count = watches.count;
        assert!(watches.ignored.is_some(), "Git ignores were not loaded");
        assert!(!watches.capped, "ignored directories exhausted watches");
        assert!(
            watches.count < 64,
            "watch count included ignored directories: {}",
            watches.count
        );
        assert!(
            build_duration < Duration::from_millis(500),
            "watch build exceeded the px0 target: {build_duration:?}"
        );
        assert!(
            build_duration < Duration::from_secs(2),
            "watch build exceeded the rejection ceiling: {build_duration:?}"
        );
        assert!(watches.excludes_from_traversal(
            checkout.path(),
            &checkout.path().join("ignored/directory-00000")
        ));
        assert!(
            !watches
                .excludes_from_traversal(checkout.path(), &checkout.path().join("ignored/negated"))
        );
        assert!(
            !watches
                .excludes_from_traversal(checkout.path(), &checkout.path().join("ignored/tracked"))
        );
        drop(watches);

        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));
        fs::write(
            checkout.path().join("ignored/directory-00000/only-ignored"),
            b"one",
        )
        .unwrap();
        assert_no_dirty(&observer);

        let git_after_build = git_ignore_invocations(checkout.path());
        let mut latencies = Vec::with_capacity(EDIT_SAMPLES);
        for sample in 0..EDIT_SAMPLES {
            let started_at = Instant::now();
            for write in 0..WRITES_PER_SAMPLE {
                fs::write(
                    checkout.path().join("ignored/negated/visible"),
                    format!("{sample}:{write}"),
                )
                .unwrap();
            }
            latencies.push(wait_dirty_after(&observer, started_at));
        }
        assert_eq!(
            git_ignore_invocations(checkout.path()),
            git_after_build,
            "normal writes after WatchSet construction must not run Git"
        );
        let (minimum, p50, p95, maximum) = summarize_millis(&latencies);
        println!(
            "px0 observer: ignored_directories={IGNORED_DIRECTORIES} watches={} build_ms={} edit_hint_n={EDIT_SAMPLES} edit_hint_ms=min:{minimum},p50:{p50},p95:{p95},max:{maximum}",
            watch_count,
            build_duration.as_millis(),
        );
        assert!(
            p95 <= 1_500,
            "non-ignored edit-to-hint p95 exceeded 1.5 seconds: {p95} ms"
        );

        fs::write(checkout.path().join("ignored/tracked/visible"), b"two").unwrap();
        wait_dirty(&observer);

        fs::create_dir(checkout.path().join("dynamic")).unwrap();
        wait_dirty(&observer);
        fs::write(
            checkout.path().join(".gitignore"),
            b"ignored/*\n!ignored/negated/\n!ignored/negated/**\ndynamic/\n",
        )
        .unwrap();
        wait_dirty(&observer);
        // The definition notification is observable before its replacement
        // watch set is installed. Give the observer one reconciliation turn
        // before verifying the newly ignored directory.
        thread::sleep(Duration::from_millis(100));
        let rebuilt = WatchSet::build(checkout.path()).unwrap();
        assert!(
            rebuilt.excludes_from_traversal(checkout.path(), &checkout.path().join("dynamic")),
            "reconciliation did not discover the new ignored directory"
        );
        drop(rebuilt);
        fs::write(checkout.path().join("dynamic/only-ignored"), b"one").unwrap();
        assert_no_dirty(&observer);
    }

    #[test]
    fn newly_created_ignored_files_stay_quiet() {
        let checkout = tempfile::tempdir().unwrap();
        initialize_git(checkout.path());
        fs::write(checkout.path().join(".gitignore"), b"*.log\n").unwrap();
        stage(checkout.path(), ".gitignore");
        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));

        fs::write(checkout.path().join("generated.log"), b"one").unwrap();
        assert_no_dirty(&observer);
        fs::write(checkout.path().join("generated.log"), b"two").unwrap();
        assert_no_dirty(&observer);
    }

    #[test]
    fn force_added_ignored_file_becomes_observable() {
        let checkout = tempfile::tempdir().unwrap();
        initialize_git(checkout.path());
        fs::write(checkout.path().join(".gitignore"), b"*.log\n").unwrap();
        stage(checkout.path(), ".gitignore");
        fs::write(checkout.path().join("generated.log"), b"one").unwrap();
        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));

        stage(checkout.path(), "generated.log");
        wait_dirty(&observer);
        // The index notification is observable before its replacement watch
        // set is installed. Give the observer one reconciliation turn.
        thread::sleep(Duration::from_millis(100));
        fs::write(checkout.path().join("generated.log"), b"two").unwrap();
        wait_dirty(&observer);
    }

    #[test]
    fn global_excludes_never_remove_checkout_watches() {
        let checkout = tempfile::tempdir().unwrap();
        let global = tempfile::NamedTempFile::new().unwrap();
        fs::write(global.path(), b"generated/\n").unwrap();
        initialize_git(checkout.path());
        fs::create_dir(checkout.path().join("generated")).unwrap();
        assert!(
            Command::new("git")
                .args(["config", "core.excludesFile"])
                .arg(global.path())
                .current_dir(checkout.path())
                .status()
                .unwrap()
                .success()
        );

        let watches = WatchSet::build(checkout.path()).unwrap();

        assert!(
            !watches.excludes_from_traversal(checkout.path(), &checkout.path().join("generated"))
        );
    }

    #[test]
    #[ignore = "px0 records an exact 120-second idle observation window"]
    fn ignored_checkout_stays_quiet_for_120_seconds() {
        let checkout = tempfile::tempdir().unwrap();
        initialize_git(checkout.path());
        fs::create_dir(checkout.path().join("ignored")).unwrap();
        fs::write(checkout.path().join("ignored/only-ignored"), b"one").unwrap();
        fs::write(checkout.path().join(".gitignore"), b"ignored/\n").unwrap();
        stage(checkout.path(), ".gitignore");

        let observer = Observer::start(checkout.path());
        thread::sleep(Duration::from_millis(100));
        assert!(
            !observer.take_dirty(),
            "observer was not idle before sampling"
        );
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut events = 0;
        while Instant::now() < deadline {
            events += usize::from(observer.take_dirty());
            thread::sleep(Duration::from_millis(20));
        }
        events += usize::from(observer.take_dirty());
        println!("px0 observer: idle_window_ms=120000 idle_changes_events={events}");
        assert!(
            events <= 1,
            "idle Changes hints exceeded one per 120 seconds"
        );
    }

    #[test]
    fn rejects_oversized_git_ignore_output() {
        let bytes = vec![b'x'; MAX_GIT_IGNORE_BYTES + 1];
        assert_eq!(
            read_git_ignore_output(std::io::Cursor::new(bytes))
                .unwrap_err()
                .kind(),
            io::ErrorKind::FileTooLarge
        );
    }
}
