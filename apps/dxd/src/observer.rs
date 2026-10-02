//! Filesystem observation for Changes: a content-free `changes-dirty` hint
//! after coalesced mutations in the checkout and its linked worktrees.
//!
//! Each directory is watched individually with inotify, so Git-ignored trees
//! such as `node_modules` never consume watches. Only mutations are
//! subscribed: opens and reads (every `git status`, every `rg`) never wake
//! the observer.
//!
//! Git's own bookkeeping is not a mutation: `*.lock` files under `.git`, and
//! index rewrites that keep the same number of entries (the stat refresh of
//! any `git status`, or staging already-tracked content). Neither can change a
//! manifest, and treating them as mutations lets any Git reader, including a
//! capture without `GIT_OPTIONAL_LOCKS=0`, schedule the next capture forever.
//!
//! When the watch budget or the kernel's watch limit is exhausted, parts of
//! the tree go unwatched. That fallback compares the Changes fingerprint
//! every few seconds and hints only when it moved.

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::fs;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{Receiver, Sender, channel};

/// A single save arrives as a few events within a millisecond or two; the
/// quiet period only has to cover that. Continuous writes are bounded by
/// `MAX_WAIT`, and Core coalesces hints that arrive during a capture.
const QUIET_PERIOD: Duration = Duration::from_millis(50);
const MAX_WAIT: Duration = Duration::from_secs(1);
/// Fallback cadence: at least this, and at most 5% of the time spent
/// computing the fingerprint.
const FALLBACK_PERIOD: Duration = Duration::from_secs(5);
const FALLBACK_COST_FACTOR: u32 = 20;
/// How often a capped watch set is rebuilt, in case limits changed.
const FALLBACK_REBUILD: Duration = Duration::from_secs(60);
const MAX_WATCHES: usize = 8192;
const GIT_IGNORE_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_GIT_IGNORE_BYTES: usize = 4 * 1024 * 1024;
const WATCH_MASK: u32 = libc::IN_ATTRIB
    | libc::IN_CREATE
    | libc::IN_DELETE
    | libc::IN_CLOSE_WRITE
    | libc::IN_MODIFY
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_DELETE_SELF
    | libc::IN_MOVE_SELF
    | libc::IN_ONLYDIR;

pub struct Observer {
    dirty: Receiver<()>,
}

impl Observer {
    pub fn start(root: &Path) -> Self {
        Self::start_with(root, MAX_WATCHES, FALLBACK_PERIOD)
    }

    fn start_with(root: &Path, budget: usize, fallback_period: Duration) -> Self {
        let root = root.to_owned();
        let (sender, dirty) = channel(1);
        thread::Builder::new()
            .name("dxd-observer".into())
            .spawn(move || observe(root, sender, budget, fallback_period))
            .expect("observer thread");
        Self { dirty }
    }

    /// Resolve when the checkout changed since the last call.
    pub async fn dirty(&mut self) {
        if self.dirty.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
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

    fn ready_at(&self) -> Option<Instant> {
        let first = self.first?;
        let latest = self.latest?;
        Some((first + MAX_WAIT).min(latest + QUIET_PERIOD))
    }

    fn clear(&mut self) {
        self.first = None;
        self.latest = None;
    }
}

/// One inotify instance; non-blocking, read after `poll` reports it ready.
struct Inotify(OwnedFd);

impl Inotify {
    fn new() -> io::Result<Self> {
        // SAFETY: plain syscall; the descriptor is owned below.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a new descriptor nothing else owns.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    fn add(&self, path: &Path) -> io::Result<i32> {
        let path = CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: valid descriptor and NUL-terminated path.
        let wd = unsafe { libc::inotify_add_watch(self.0.as_raw_fd(), path.as_ptr(), WATCH_MASK) };
        if wd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(wd)
        }
    }

    fn remove(&self, wd: i32) {
        // SAFETY: valid descriptor; an unknown watch only fails with EINVAL.
        unsafe {
            libc::inotify_rm_watch(self.0.as_raw_fd(), wd);
        }
    }

    /// Every queued event as (watch, mask, name).
    fn read(&self, events: &mut Vec<(i32, u32, PathBuf)>) -> io::Result<()> {
        // Aligned for `inotify_event`; one read returns whole events only.
        let mut buffer = [0_u64; 8192];
        loop {
            // SAFETY: reads at most the buffer's length into it.
            let read = unsafe {
                libc::read(
                    self.0.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    std::mem::size_of_val(&buffer),
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                return match error.kind() {
                    io::ErrorKind::WouldBlock => Ok(()),
                    io::ErrorKind::Interrupted => continue,
                    _ => Err(error),
                };
            }
            let bytes = &buffer_bytes(&buffer)[..read as usize];
            let header = std::mem::size_of::<libc::inotify_event>();
            let mut offset = 0;
            while offset + header <= bytes.len() {
                // SAFETY: the kernel wrote a complete event header here; the
                // unaligned read copies it out.
                let event = unsafe {
                    std::ptr::read_unaligned(bytes[offset..].as_ptr().cast::<libc::inotify_event>())
                };
                let name_start = offset + header;
                let name_end = (name_start + event.len as usize).min(bytes.len());
                let name = &bytes[name_start..name_end];
                let name = &name[..name
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(name.len())];
                events.push((
                    event.wd,
                    event.mask,
                    PathBuf::from(std::ffi::OsStr::from_bytes(name)),
                ));
                offset = name_end;
            }
        }
    }
}

fn buffer_bytes(buffer: &[u64]) -> &[u8] {
    // SAFETY: any initialized u64 buffer is a valid byte buffer.
    unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), std::mem::size_of_val(buffer)) }
}

/// A checkout's filesystem event: the affected path and its inotify mask.
struct Event {
    path: PathBuf,
    mask: u32,
}

struct WatchSet {
    root: PathBuf,
    inotify: Inotify,
    /// Watched directories by path and by watch descriptor.
    watched: HashMap<PathBuf, i32>,
    directories: HashMap<i32, PathBuf>,
    capped: bool,
    ignored: Option<IgnoredPaths>,
    /// Last seen entry count of each Git index under this root.
    index_entries: HashMap<PathBuf, Option<u32>>,
}

impl WatchSet {
    fn build(root: PathBuf, budget: usize) -> io::Result<Self> {
        let mut set = Self {
            root,
            inotify: Inotify::new()?,
            watched: HashMap::new(),
            directories: HashMap::new(),
            capped: false,
            ignored: None,
            index_entries: HashMap::new(),
        };
        let git_directory = set.root.join(".git");
        let worktree_indexes = fs::read_dir(git_directory.join("worktrees"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path().join("index"));
        for index in std::iter::once(git_directory.join("index")).chain(worktree_indexes) {
            let entries = index_entries(&index);
            set.index_entries.insert(index, entries);
        }
        set.ignored = IgnoredPaths::load(&set.root).ok();
        if set.ignored.is_none() {
            eprintln!("dxd observer: ignore discovery unavailable; using legacy traversal");
        }
        set.add_tree(&set.root.clone(), budget);
        Ok(set)
    }

    /// Watch `directory` and every non-ignored directory beneath it.
    fn add_tree(&mut self, directory: &Path, budget: usize) {
        let mut pending = vec![directory.to_owned()];
        while let Some(directory) = pending.pop() {
            if self.watched.len() >= budget {
                self.capped = true;
                return;
            }
            if self.watched.contains_key(&directory) {
                continue;
            }
            let Ok(wd) = self.inotify.add(&directory) else {
                self.capped = true;
                continue;
            };
            self.watched.insert(directory.clone(), wd);
            self.directories.insert(wd, directory.clone());
            let Ok(entries) = fs::read_dir(&directory) else {
                self.capped = true;
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if self.excludes_from_traversal(&path) {
                    continue;
                }
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    pending.push(path);
                }
            }
        }
    }

    fn remove_tree(&mut self, directory: &Path) {
        let removed = self
            .watched
            .keys()
            .filter(|watched| watched.starts_with(directory))
            .cloned()
            .collect::<Vec<_>>();
        for path in removed {
            if let Some(wd) = self.watched.remove(&path) {
                self.inotify.remove(wd);
                self.directories.remove(&wd);
            }
        }
    }

    /// Drain the kernel queue into checkout events.
    fn events(&mut self) -> io::Result<Vec<Event>> {
        let mut raw = Vec::new();
        self.inotify.read(&mut raw)?;
        let mut events = Vec::with_capacity(raw.len());
        for (wd, mask, name) in raw {
            if mask & libc::IN_Q_OVERFLOW != 0 {
                events.push(Event {
                    path: self.root.clone(),
                    mask,
                });
                continue;
            }
            if mask & libc::IN_IGNORED != 0 {
                // The kernel dropped this watch (directory gone or unwatched).
                if let Some(path) = self.directories.remove(&wd) {
                    self.watched.remove(&path);
                }
                continue;
            }
            let Some(directory) = self.directories.get(&wd) else {
                continue;
            };
            let path = if name.as_os_str().is_empty() {
                directory.clone()
            } else {
                directory.join(name)
            };
            events.push(Event { path, mask });
        }
        Ok(events)
    }

    fn excludes_from_traversal(&self, path: &Path) -> bool {
        self.ignored
            .as_ref()
            .is_some_and(|ignored| ignored.contains(&self.root, path))
            || legacy_excluded(&self.root, path)
    }

    /// Git bookkeeping that cannot change a manifest (see the module docs).
    fn git_bookkeeping(&mut self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return false;
        };
        if !in_git_directory(relative) {
            return false;
        }
        if path
            .extension()
            .is_some_and(|extension| extension == "lock")
        {
            return true;
        }
        if !is_index(relative) {
            return false;
        }
        let entries = index_entries(path);
        self.index_entries.insert(path.to_owned(), entries) == Some(entries)
    }

    fn ignores_event(&mut self, path: &Path, created: bool, directory: bool) -> bool {
        if self.excludes_from_traversal(path) {
            return true;
        }
        // Ignore rules never apply inside `.git`; skip the `check-ignore`.
        if !created || path.strip_prefix(&self.root).is_ok_and(in_git_directory) {
            return false;
        }
        self.ignored.as_mut().is_some_and(|ignored| {
            ignored
                .classify_created(&self.root, path, directory)
                .unwrap_or(false)
        })
    }
}

enum Outcome {
    Mutation,
    Reconcile,
}

fn classify(set: &mut WatchSet, event: &Event, budget: usize) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    if event.mask & libc::IN_Q_OVERFLOW != 0 {
        outcomes.push(Outcome::Reconcile);
        outcomes.push(Outcome::Mutation);
        return outcomes;
    }
    let path = &event.path;
    let arrived = event.mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0;
    let renamed = event.mask & (libc::IN_MOVED_FROM | libc::IN_MOVED_TO) != 0;
    let removed = event.mask
        & (libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_DELETE_SELF | libc::IN_MOVE_SELF)
        != 0;
    let is_directory = event.mask & libc::IN_ISDIR != 0;
    if set.git_bookkeeping(path) {
        return outcomes;
    }
    if is_ignore_definition(&set.root, path) {
        outcomes.push(Outcome::Reconcile);
        outcomes.push(Outcome::Mutation);
        return outcomes;
    }
    if removed {
        set.remove_tree(path);
        if *path == set.root {
            // The checkout itself moved or vanished: start over.
            outcomes.push(Outcome::Reconcile);
        }
    }
    if arrived && is_directory && !set.excludes_from_traversal(path) {
        set.add_tree(path, budget);
    }
    if !set.ignores_event(path, arrived || renamed, is_directory) {
        outcomes.push(Outcome::Mutation);
    }
    outcomes
}

fn build_watch_sets(primary: &Path, budget: usize) -> io::Result<Vec<WatchSet>> {
    let roots = crate::worktrees::selected(primary).unwrap_or_else(|_| vec![primary.to_owned()]);
    let mut remaining = budget;
    let mut sets = Vec::with_capacity(roots.len());
    for root in roots {
        let set = WatchSet::build(root, remaining)?;
        remaining = remaining.saturating_sub(set.watched.len());
        sets.push(set);
    }
    Ok(sets)
}

fn capped(sets: &Option<Vec<WatchSet>>) -> bool {
    sets.as_ref()
        .is_none_or(|sets| sets.iter().any(|set| set.capped))
}

/// Wait until one of `sets` has events or `wait` passes; returns the indexes
/// of the ready sets.
fn poll_sets(sets: &[WatchSet], wait: Duration) -> io::Result<Vec<usize>> {
    let mut polls = sets
        .iter()
        .map(|set| libc::pollfd {
            fd: set.inotify.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect::<Vec<_>>();
    let milliseconds = wait.as_millis().min(i32::MAX as u128) as i32;
    // SAFETY: `polls` is a valid array of `polls.len()` entries. With no sets
    // this is a plain sleep.
    let ready = unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as _, milliseconds) };
    if ready < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(Vec::new())
        } else {
            Err(error)
        };
    }
    Ok(polls
        .iter()
        .enumerate()
        .filter(|(_, poll)| poll.revents != 0)
        .map(|(index, _)| index)
        .collect())
}

/// Fallback probe: the Changes fingerprint, and how long it took. `HEAD` as
/// the default branch makes `origin/HEAD` the upstream candidate, which is
/// the remote's default branch; the value is only compared with itself.
fn fallback_fingerprint(root: &Path) -> (Option<String>, Duration) {
    let started = Instant::now();
    let fingerprint = crate::changes::fingerprint_only(root, "HEAD");
    (fingerprint, started.elapsed())
}

fn observe(root: PathBuf, sender: Sender<()>, budget: usize, fallback_period: Duration) {
    let mut sets = build_watch_sets(&root, budget).ok();
    let mut fallback = capped(&sets);
    let mut next_fallback = Instant::now() + fallback_period;
    let mut next_rebuild = Instant::now() + FALLBACK_REBUILD;
    let mut fingerprint: Option<String> = None;
    let mut coalescer = Coalescer::default();

    loop {
        let now = Instant::now();
        let mut deadline = coalescer.ready_at();
        if fallback {
            deadline = Some(deadline.map_or(next_fallback, |ready| ready.min(next_fallback)));
        }
        let wait = deadline.map_or(Duration::from_secs(3600), |deadline| {
            deadline.saturating_duration_since(now)
        });
        let mut reconcile = false;
        let ready = poll_sets(sets.as_deref().unwrap_or_default(), wait);
        let now = Instant::now();
        match ready {
            Ok(ready) => {
                for index in ready {
                    let set = &mut sets.as_mut().expect("ready sets exist")[index];
                    match set.events() {
                        Ok(events) => {
                            for event in events {
                                // Worktrees can nest; each set classifies its own paths.
                                for set in sets.as_mut().expect("ready sets exist").iter_mut() {
                                    if !event.path.starts_with(&set.root) {
                                        continue;
                                    }
                                    for outcome in classify(set, &event, budget) {
                                        match outcome {
                                            Outcome::Mutation => coalescer.mutation(now),
                                            Outcome::Reconcile => reconcile = true,
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            reconcile = true;
                            coalescer.mutation(now);
                        }
                    }
                }
            }
            Err(_) => {
                reconcile = true;
                coalescer.mutation(now);
                thread::sleep(QUIET_PERIOD);
            }
        }
        if reconcile {
            sets = build_watch_sets(&root, budget).ok();
            fallback = capped(&sets);
            next_rebuild = now + FALLBACK_REBUILD;
        }
        if fallback && now >= next_fallback {
            // Limits can change while dxd remains resident.
            if now >= next_rebuild {
                sets = build_watch_sets(&root, budget).ok();
                fallback = capped(&sets);
                next_rebuild = now + FALLBACK_REBUILD;
            }
            let (current, cost) = fallback_fingerprint(&root);
            if fingerprint.is_some() && current != fingerprint {
                coalescer.mutation(now);
            }
            fingerprint = current;
            next_fallback = Instant::now() + fallback_period.max(cost * FALLBACK_COST_FACTOR);
        }
        if coalescer.ready_at().is_some_and(|ready| now >= ready) {
            if sender.try_send(()).is_err() && sender.is_closed() {
                return;
            }
            coalescer.clear();
        }
    }
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
            &[
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
            let path = PathBuf::from(String::from_utf8_lossy(path).into_owned());
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

    fn classify_created(&mut self, root: &Path, path: &Path, directory: bool) -> io::Result<bool> {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::ErrorKind::InvalidInput)?;
        if !is_checkout_relative(relative) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut input = relative.to_string_lossy().into_owned().into_bytes();
        input.push(0);
        let output = git_ignore_output(
            root,
            &[
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
        if directory {
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

fn git_ignore_output(
    root: &Path,
    arguments: &[&str],
    input: &[u8],
    no_match_is_ok: bool,
) -> io::Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .args(arguments)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0");
    let (status, output) = crate::child::run(
        &mut command,
        input,
        MAX_GIT_IGNORE_BYTES,
        GIT_IGNORE_TIMEOUT,
    )?;
    if !status.success() && !(no_match_is_ok && status.code() == Some(1)) {
        return Err(io::ErrorKind::Other.into());
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
        || is_index(relative)
}

fn in_git_directory(relative: &Path) -> bool {
    relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == ".git")
}

/// `.git/index`, or a linked worktree's `.git/worktrees/<name>/index`.
fn is_index(relative: &Path) -> bool {
    let parts = relative.components().collect::<Vec<_>>();
    let name = |index: usize| parts[index].as_os_str();
    match parts.len() {
        2 => name(0) == ".git" && name(1) == "index",
        4 => name(0) == ".git" && name(1) == "worktrees" && name(3) == "index",
        _ => false,
    }
}

/// Entry count from an index header (`DIRC`, version, count), or `None` when
/// the file is missing or not an index.
fn index_entries(path: &Path) -> Option<u32> {
    let mut header = [0_u8; 12];
    fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    (header[..4] == *b"DIRC")
        .then(|| u32::from_be_bytes([header[8], header[9], header[10], header[11]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, arguments: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(arguments)
                .output()
                .unwrap()
                .status
                .success()
        );
    }

    async fn wait_dirty(observer: &mut Observer) -> bool {
        tokio::time::timeout(Duration::from_secs(4), observer.dirty())
            .await
            .is_ok()
    }

    async fn expect_quiet(observer: &mut Observer) {
        assert!(
            tokio::time::timeout(Duration::from_millis(1500), observer.dirty())
                .await
                .is_err(),
            "observer reported an ignored mutation"
        );
    }

    #[test]
    fn coalescer_waits_for_quiet_but_never_beyond_max_wait() {
        let mut coalescer = Coalescer::default();
        let start = Instant::now();
        assert!(coalescer.ready_at().is_none());
        coalescer.mutation(start);
        assert_eq!(coalescer.ready_at(), Some(start + QUIET_PERIOD));
        coalescer.mutation(start + MAX_WAIT - QUIET_PERIOD / 2);
        assert_eq!(coalescer.ready_at(), Some(start + MAX_WAIT));
        coalescer.clear();
        assert!(coalescer.ready_at().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reports_checkout_mutations_and_skips_ignored_and_git_object_writes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        git(&root, &["init", "-q"]);
        fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let mut observer = Observer::start(&root);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = tokio::time::timeout(Duration::from_millis(1200), observer.dirty()).await;

        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        assert!(
            wait_dirty(&mut observer).await,
            "tracked-tree write was not observed"
        );

        fs::write(root.join("ignored/cache.bin"), "x").unwrap();
        fs::write(root.join("build.log"), "x").unwrap();
        fs::create_dir_all(root.join(".git/objects/aa")).unwrap();
        fs::write(root.join(".git/objects/aa/bb"), "x").unwrap();
        expect_quiet(&mut observer).await;

        fs::create_dir_all(root.join("src/nested")).unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = tokio::time::timeout(Duration::from_millis(1200), observer.dirty()).await;
        fs::write(root.join("src/nested/deep.rs"), "deep").unwrap();
        assert!(
            wait_dirty(&mut observer).await,
            "new directory was not watched incrementally"
        );
    }

    /// Beyond the watch budget, unwatched directories are covered by the
    /// fingerprint fallback: a hint when the tree moved, silence when not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capped_watches_hint_only_when_the_fingerprint_moves() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/file.txt"), "one\n").unwrap();
        // Only the root is watched.
        let mut observer = Observer::start_with(&root, 1, Duration::from_millis(200));
        tokio::time::sleep(Duration::from_millis(300)).await;
        expect_quiet(&mut observer).await;

        fs::write(root.join("a/b/file.txt"), "two\n").unwrap();
        assert!(
            wait_dirty(&mut observer).await,
            "a write in an unwatched directory was not observed"
        );
        expect_quiet(&mut observer).await;
    }

    /// Regression for the capture loop: a capture, or any Git reader that
    /// rewrites the index, must not schedule the next capture.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn git_bookkeeping_is_quiet_but_tracking_changes_are_not() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "a@b.c"]);
        git(&root, &["config", "user.name", "a"]);
        fs::write(root.join("tracked.txt"), "tracked\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let baseline = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        fs::write(root.join("dirty.txt"), "untracked\n").unwrap();
        // Stale stat data: the next `git status` that may take the index lock
        // rewrites the index with the same entries.
        let stale = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        fs::File::options()
            .write(true)
            .open(root.join("tracked.txt"))
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let index = root.join(".git/index");
        let before = fs::metadata(&index).unwrap().modified().unwrap();

        let mut observer = Observer::start(&root);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = tokio::time::timeout(Duration::from_millis(1200), observer.dirty()).await;

        let request = crate::changes::RefreshRequest {
            token: "token-0123456789abcdef".into(),
            source: crate::changes::SourceContext {
                baseline,
                default_branch: "main".into(),
            },
            expected_fingerprint: None,
        };
        let cache = crate::changes::CaptureCache::default();
        for _ in 0..3 {
            assert!(matches!(
                crate::changes::capture(&root, &request, &cache),
                crate::changes::CandidateOutcome::Complete { .. }
            ));
            // A shell prompt or editor running Git with optional locks on.
            git(&root, &["status", "--porcelain"]);
        }
        fs::write(root.join(".git/HEAD.lock"), "").unwrap();
        fs::remove_file(root.join(".git/HEAD.lock")).unwrap();
        assert_ne!(
            fs::metadata(&index).unwrap().modified().unwrap(),
            before,
            "git status did not rewrite the index; the test proves nothing"
        );
        expect_quiet(&mut observer).await;

        // Tracking a new file changes the index entry count.
        git(&root, &["add", "dirty.txt"]);
        assert!(wait_dirty(&mut observer).await, "git add was not observed");
        let _ = tokio::time::timeout(Duration::from_millis(500), observer.dirty()).await;
        git(&root, &["commit", "-q", "-m", "second"]);
        assert!(
            wait_dirty(&mut observer).await,
            "git commit was not observed"
        );
    }
}
