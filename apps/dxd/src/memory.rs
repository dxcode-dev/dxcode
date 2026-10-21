//! Orb memory: how much of the guest's memory is in use, the workspace
//! user's largest processes, and stopping one of them on request.
//!
//! Every heartbeat carries [`usage`], so Core sees memory pressure on any
//! provider that runs dxd. Core asks for a [`Memory::snapshot`] only while a
//! person looks at it, and [`Memory::stop`] sends `SIGTERM`, then `SIGKILL`
//! once [`KILL_AFTER`] has passed. dx's own processes (this daemon, the
//! Orb's supervisor and tools under `/opt/dx`, and a Claude Code run's CLI
//! and helpers) are never listed and cannot be stopped. A local runtime
//! lists only processes working inside the Thread's home, never the
//! developer's other programs.

use serde::Serialize;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Running processes listed in a snapshot, largest first.
pub const LISTED_PROCESSES: usize = 5;
/// A process that ignored `SIGTERM` this long gets `SIGKILL`.
pub const KILL_AFTER: Duration = Duration::from_secs(5);
/// A stopped process stays listed (as stopped) this long.
const STOPPED_RETENTION: Duration = Duration::from_secs(60);
/// Stops remembered at once; the oldest is forgotten first.
const MAX_STOPS: usize = 8;
const MAX_COMMAND_BYTES: usize = 240;
const MAX_NAME_BYTES: usize = 64;
const CLAUDE_CODE_RUNS: &str = "/dx-claude-code/runs/";
const CLAUDE_CODE_STATE: &str = "/dx-claude-code/";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUsage {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessState {
    Running,
    Stopping,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    /// `<pid>-<start time>`: names one process, never a later one that
    /// reuses its PID.
    pub id: String,
    pub pid: u32,
    pub name: String,
    pub command: String,
    pub memory_bytes: u64,
    pub state: ProcessState,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MemoryResult {
    Snapshot {
        #[serde(rename = "usedBytes")]
        used_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
        processes: Vec<ProcessEntry>,
    },
    Stop {
        state: ProcessState,
    },
    Unavailable {
        reason: &'static str,
    },
}

/// The guest's memory in use. A cgroup limit tighter than the machine (a
/// container, or E2B's user cgroup) is the one that matters; page cache the
/// kernel can reclaim does not count as used.
pub fn usage() -> Option<MemoryUsage> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let machine = machine_usage(&meminfo)?;
    let cgroup = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|membership| cgroup_usage(Path::new("/sys/fs/cgroup"), &membership));
    Some(match cgroup {
        Some(limited) if limited.total_bytes < machine.total_bytes => limited,
        _ => machine,
    })
}

fn meminfo_bytes(meminfo: &str, key: &str) -> Option<u64> {
    meminfo.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        let kib = rest.trim().strip_suffix("kB")?.trim().parse::<u64>().ok()?;
        kib.checked_mul(1024)
    })
}

fn machine_usage(meminfo: &str) -> Option<MemoryUsage> {
    let total = meminfo_bytes(meminfo, "MemTotal")?;
    let available = meminfo_bytes(meminfo, "MemAvailable")?;
    (total > 0).then(|| MemoryUsage {
        used_bytes: total.saturating_sub(available),
        total_bytes: total,
    })
}

/// The tightest `memory.max` on this process's cgroup v2 path, and that
/// cgroup's use without its page cache (shared memory stays counted).
fn cgroup_usage(root: &Path, membership: &str) -> Option<MemoryUsage> {
    let path = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?
        .trim();
    let mut directory = PathBuf::from(path);
    let mut tightest: Option<(u64, PathBuf)> = None;
    loop {
        let relative = directory.strip_prefix("/").unwrap_or(&directory);
        let candidate = root.join(relative);
        if let Some(limit) = std::fs::read_to_string(candidate.join("memory.max"))
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            && tightest.as_ref().is_none_or(|(best, _)| limit < *best)
        {
            tightest = Some((limit, candidate));
        }
        if !directory.pop() {
            break;
        }
    }
    let (limit, directory) = tightest?;
    let current = std::fs::read_to_string(directory.join("memory.current"))
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    let stat = std::fs::read_to_string(directory.join("memory.stat")).unwrap_or_default();
    let field = |name: &str| {
        stat.lines()
            .find_map(|line| {
                line.strip_prefix(name)?
                    .strip_prefix(' ')?
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(0)
    };
    (limit > 0).then(|| MemoryUsage {
        used_bytes: current
            .saturating_sub(field("file"))
            .saturating_add(field("shmem"))
            .min(limit),
        total_bytes: limit,
    })
}

/// One process as `/proc` describes it.
#[derive(Clone, Debug)]
struct Process {
    pid: u32,
    parent: u32,
    start: u64,
    zombie: bool,
    uid: u32,
    rss_bytes: u64,
    comm: String,
    arguments: Vec<String>,
}

impl Process {
    fn id(&self) -> String {
        format!("{}-{}", self.pid, self.start)
    }
}

fn page_size() -> u64 {
    // SAFETY: sysconf has no preconditions.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(size)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(4096)
}

/// `/proc/<pid>/stat` fields after the command name: state, parent, start
/// time (field 22), and resident pages (field 24).
fn parse_stat(stat: &str) -> Option<(char, u32, u64, u64, String)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_owned();
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    let state = fields.first()?.chars().next()?;
    let parent = fields.get(1)?.parse().ok()?;
    let start = fields.get(19)?.parse().ok()?;
    let pages = fields.get(21)?.parse().ok()?;
    Some((state, parent, start, pages, comm))
}

fn read_process(proc_root: &Path, pid: u32, page: u64) -> Option<Process> {
    let directory = proc_root.join(pid.to_string());
    let uid = std::fs::metadata(&directory).ok()?.uid();
    let (state, parent, start, pages, comm) =
        parse_stat(&std::fs::read_to_string(directory.join("stat")).ok()?)?;
    let arguments = std::fs::read(directory.join("cmdline"))
        .map(|bytes| {
            bytes
                .split(|byte| *byte == 0)
                .filter(|argument| !argument.is_empty())
                .take(64)
                .map(|argument| String::from_utf8_lossy(argument).into_owned())
                .collect()
        })
        .unwrap_or_default();
    Some(Process {
        pid,
        parent,
        start,
        zombie: matches!(state, 'Z' | 'X'),
        uid,
        rss_bytes: pages.saturating_mul(page),
        comm,
        arguments,
    })
}

fn processes(proc_root: &Path) -> HashMap<u32, Process> {
    let page = page_size();
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return HashMap::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| read_process(proc_root, pid, page).map(|process| (pid, process)))
        .collect()
}

/// A Claude Code run's runner script, or one of its subshells.
fn claude_code_runner(process: &Process) -> bool {
    process
        .arguments
        .iter()
        .any(|argument| argument.contains(CLAUDE_CODE_RUNS) && argument.ends_with("/runner.sh"))
}

/// Who may see and stop processes: this daemon's user, and on a local
/// runtime only processes working inside the Thread's home.
struct Scope {
    uid: u32,
    own_pid: u32,
    proc_root: PathBuf,
    local_home: Option<PathBuf>,
}

impl Scope {
    /// dx's own processes: this daemon (and its subcommands), the Orb's
    /// init (PID 1, such as tini on Cloudflare: stopping it ends the Orb),
    /// its supervisor and tools under `/opt/dx` (tmux, the Desktop), and a
    /// Claude Code run's runner, CLI, and dx MCP server. What Claude runs
    /// for the person is theirs.
    fn dx_owned(&self, process: &Process, all: &HashMap<u32, Process>) -> bool {
        if process.pid == 1
            || process.pid == self.own_pid
            || process.comm == "dxd"
            || process.comm == "dx-orb-init"
        {
            return true;
        }
        let executable =
            std::fs::read_link(self.proc_root.join(process.pid.to_string()).join("exe"))
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
        let executable = executable.trim_end_matches(" (deleted)");
        if executable.starts_with("/opt/dx/")
            || Path::new(executable)
                .file_name()
                .is_some_and(|name| name == "dxd")
        {
            return true;
        }
        claude_code_runner(process)
            || all.get(&process.parent).is_some_and(claude_code_runner)
            || process.arguments.iter().any(|argument| {
                argument.contains(CLAUDE_CODE_STATE) && argument.ends_with("/dx-mcp.py")
            })
    }

    fn visible(&self, process: &Process, all: &HashMap<u32, Process>) -> bool {
        process.uid == self.uid
            && !process.zombie
            && process.rss_bytes > 0
            && !self.dx_owned(process, all)
            && self.local_home.as_ref().is_none_or(|home| {
                std::fs::read_link(self.proc_root.join(process.pid.to_string()).join("cwd"))
                    .is_ok_and(|cwd| cwd.starts_with(home))
            })
    }
}

fn truncated(value: &str, bytes: usize) -> String {
    if value.len() <= bytes {
        return value.to_owned();
    }
    let mut end = bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn presentation(process: &Process) -> (String, String) {
    let command = if process.arguments.is_empty() {
        process.comm.clone()
    } else {
        process.arguments.join(" ")
    };
    // A process that rewrote its title (Chrome, nginx, Perl's `$0`) holds a
    // whole phrase in its first argument: its program is the first word.
    let name = process
        .arguments
        .first()
        .and_then(|first| first.split_whitespace().next())
        .and_then(|program| Path::new(program).file_name())
        .map(|name| name.to_string_lossy().trim_end_matches(':').to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| process.comm.clone());
    (
        truncated(&name, MAX_NAME_BYTES),
        truncated(&command, MAX_COMMAND_BYTES),
    )
}

#[derive(Clone, Debug)]
struct Stop {
    entry: ProcessEntry,
    pid: u32,
    start: u64,
    requested_at: Instant,
    killed: bool,
    exited_at: Option<Instant>,
}

/// Processes a person asked to stop, shared by every session of this
/// daemon. Snapshots and stops run on blocking workers.
#[derive(Clone)]
pub struct Memory {
    stops: Arc<Mutex<Vec<Stop>>>,
    scope: Arc<Scope>,
}

impl Memory {
    pub fn new(local_home: Option<PathBuf>) -> Self {
        Self::with_proc_root(PathBuf::from("/proc"), local_home)
    }

    fn with_proc_root(proc_root: PathBuf, local_home: Option<PathBuf>) -> Self {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        Self {
            stops: Arc::default(),
            scope: Arc::new(Scope {
                uid,
                own_pid: std::process::id(),
                proc_root,
                local_home,
            }),
        }
    }

    fn alive(&self, pid: u32, start: u64) -> bool {
        read_process(&self.scope.proc_root, pid, 1)
            .is_some_and(|process| process.start == start && !process.zombie)
    }

    /// Usage, the largest running processes, and every stop still
    /// remembered, largest first.
    pub fn snapshot(&self) -> MemoryResult {
        let Some(usage) = usage() else {
            return MemoryResult::Unavailable {
                reason: "unreadable",
            };
        };
        let all = processes(&self.scope.proc_root);
        let now = Instant::now();
        let mut stops = self.stops.lock().unwrap_or_else(PoisonError::into_inner);
        for stop in stops.iter_mut() {
            match all.get(&stop.pid) {
                // A stop keeps the memory it was asked to free, so its row
                // stays in place while the process exits.
                Some(process) if process.start == stop.start && !process.zombie => {
                    stop.entry.state = ProcessState::Stopping;
                }
                _ => {
                    stop.entry.state = ProcessState::Stopped;
                    stop.exited_at.get_or_insert(now);
                }
            }
        }
        stops.retain(|stop| {
            stop.exited_at
                .is_none_or(|exited| now.duration_since(exited) < STOPPED_RETENTION)
        });
        let mut running: Vec<&Process> = all
            .values()
            .filter(|process| {
                self.scope.visible(process, &all)
                    && !stops
                        .iter()
                        .any(|stop| stop.pid == process.pid && stop.start == process.start)
            })
            .collect();
        running.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes).then(a.pid.cmp(&b.pid)));
        let mut listed: Vec<ProcessEntry> = running
            .into_iter()
            .take(LISTED_PROCESSES)
            .map(|process| {
                let (name, command) = presentation(process);
                ProcessEntry {
                    id: process.id(),
                    pid: process.pid,
                    name,
                    command,
                    memory_bytes: process.rss_bytes,
                    state: ProcessState::Running,
                }
            })
            .collect();
        listed.extend(stops.iter().map(|stop| stop.entry.clone()));
        listed.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes).then(a.pid.cmp(&b.pid)));
        MemoryResult::Snapshot {
            used_bytes: usage.used_bytes,
            total_bytes: usage.total_bytes,
            processes: listed,
        }
    }

    /// Ask the process `id` names to stop. Only a process a snapshot could
    /// list is signalled; asking again while it stops changes nothing.
    pub fn stop(&self, id: &str) -> MemoryResult {
        let Some((pid, start)) = parse_id(id) else {
            return MemoryResult::Unavailable { reason: "invalid" };
        };
        let mut stops = self.stops.lock().unwrap_or_else(PoisonError::into_inner);
        if stops
            .iter()
            .any(|stop| stop.pid == pid && stop.start == start)
        {
            return MemoryResult::Stop {
                state: if self.alive(pid, start) {
                    ProcessState::Stopping
                } else {
                    ProcessState::Stopped
                },
            };
        }
        let all = processes(&self.scope.proc_root);
        let Some(process) = all
            .get(&pid)
            .filter(|process| process.start == start && !process.zombie)
        else {
            return MemoryResult::Unavailable {
                reason: "not-found",
            };
        };
        if !self.scope.visible(process, &all) {
            return MemoryResult::Unavailable {
                reason: "protected",
            };
        }
        let Ok(raw_pid) = libc::pid_t::try_from(pid) else {
            return MemoryResult::Unavailable { reason: "invalid" };
        };
        // SAFETY: kill has no memory-safety preconditions; the PID and start
        // time were checked just above.
        let signalled = unsafe { libc::kill(raw_pid, libc::SIGTERM) } == 0;
        if !signalled {
            return MemoryResult::Unavailable {
                reason: "not-found",
            };
        }
        let (name, command) = presentation(process);
        if stops.len() >= MAX_STOPS {
            stops.remove(0);
        }
        stops.push(Stop {
            entry: ProcessEntry {
                id: process.id(),
                pid,
                name,
                command,
                memory_bytes: process.rss_bytes,
                state: ProcessState::Stopping,
            },
            pid,
            start,
            requested_at: Instant::now(),
            killed: false,
            exited_at: None,
        });
        MemoryResult::Stop {
            state: ProcessState::Stopping,
        }
    }

    /// `SIGKILL` every stopping process that outlived [`KILL_AFTER`]. Called
    /// on each heartbeat, so it needs no timer of its own.
    pub fn enforce_stops(&self) {
        let mut stops = self.stops.lock().unwrap_or_else(PoisonError::into_inner);
        for stop in stops.iter_mut() {
            if stop.killed || stop.exited_at.is_some() || stop.requested_at.elapsed() < KILL_AFTER {
                continue;
            }
            stop.killed = true;
            if self.alive(stop.pid, stop.start)
                && let Ok(pid) = libc::pid_t::try_from(stop.pid)
            {
                // SAFETY: as in `stop`, the start time was just rechecked.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}

fn parse_id(id: &str) -> Option<(u32, u64)> {
    let (pid, start) = id.split_once('-')?;
    let canonical = |value: &str| {
        !value.is_empty()
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && (value == "0" || !value.starts_with('0'))
    };
    if !canonical(pid) || !canonical(start) {
        return None;
    }
    let pid = pid.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    Some((pid, start.parse().ok()?))
}
