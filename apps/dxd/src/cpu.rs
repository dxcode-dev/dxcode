//! Orb CPU: how busy the Orb's processors were since the previous heartbeat.
//!
//! Every heartbeat after a session's first carries [`Cpu::sample`], the
//! share of all the CPU time the Orb may use that went to work, 0 to 100.
//! A cgroup v2 hierarchy is measured where it has `cpu.stat`: the cgroup on
//! this process's path with the tightest `cpu.max` quota, else the
//! hierarchy's root (the whole VM, or a container's own cgroup), against
//! wall time × its CPUs. Without one, the aggregate `cpu` line of
//! `/proc/stat` is used.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuUsage {
    /// Rounded to one decimal.
    pub busy_percent: f64,
}

/// One reading of a cumulative CPU counter.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Reading {
    /// A cgroup's `usage_usec`, when it was read, and how many CPUs it may
    /// use (a fractional quota counts as a fraction of a CPU).
    Cgroup {
        usage_usec: u64,
        at: Instant,
        cpus: f64,
    },
    /// `/proc/stat` jiffies: busy (all but idle and iowait) and all.
    Proc { busy: u64, total: u64 },
}

/// The previous reading, kept by the connection loop that sends heartbeats.
#[derive(Default)]
pub struct Cpu {
    previous: Option<Reading>,
}

impl Cpu {
    /// Busy percent since the previous call; `None` on the first call, or
    /// when the counter cannot be read or changed source.
    pub fn sample(&mut self) -> Option<CpuUsage> {
        let current = read(Path::new("/sys/fs/cgroup"), Path::new("/proc"));
        let previous = std::mem::replace(&mut self.previous, current);
        busy_percent(previous?, current?).map(|busy_percent| CpuUsage { busy_percent })
    }
}

fn read(cgroup_root: &Path, proc_root: &Path) -> Option<Reading> {
    std::fs::read_to_string(proc_root.join("self/cgroup"))
        .ok()
        .and_then(|membership| cgroup_reading(cgroup_root, &membership))
        .or_else(|| {
            let (busy, total) =
                proc_stat_counters(&std::fs::read_to_string(proc_root.join("stat")).ok()?)?;
            Some(Reading::Proc { busy, total })
        })
}

fn cgroup_reading(root: &Path, membership: &str) -> Option<Reading> {
    let path = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?
        .trim();
    let mut directory = PathBuf::from(path);
    let mut tightest: Option<(f64, PathBuf)> = None;
    loop {
        let relative = directory.strip_prefix("/").unwrap_or(&directory);
        let candidate = root.join(relative);
        if let Some(cpus) = std::fs::read_to_string(candidate.join("cpu.max"))
            .ok()
            .and_then(|value| quota_cpus(&value))
            && tightest.as_ref().is_none_or(|(best, _)| cpus < *best)
        {
            tightest = Some((cpus, candidate));
        }
        if !directory.pop() {
            break;
        }
    }
    let (quota, directory) = match tightest {
        Some((cpus, directory)) => (Some(cpus), directory),
        None => (None, root.to_path_buf()),
    };
    let usage_usec = usage_usec(&std::fs::read_to_string(directory.join("cpu.stat")).ok()?)?;
    let available = std::fs::read_to_string(directory.join("cpuset.cpus.effective"))
        .ok()
        .and_then(|list| cpu_list_count(&list))
        .unwrap_or_else(online_cpus);
    let cpus = quota.map_or(available as f64, |quota| quota.min(available as f64));
    (cpus > 0.0).then(|| Reading::Cgroup {
        usage_usec,
        at: Instant::now(),
        cpus,
    })
}

fn online_cpus() -> u64 {
    // SAFETY: sysconf has no preconditions.
    let count = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    u64::try_from(count)
        .ok()
        .filter(|count| *count > 0)
        .unwrap_or(1)
}

/// `usage_usec` from a cgroup's `cpu.stat`.
fn usage_usec(stat: &str) -> Option<u64> {
    stat.lines().find_map(|line| {
        line.strip_prefix("usage_usec")?
            .strip_prefix(' ')?
            .trim()
            .parse()
            .ok()
    })
}

/// CPUs a `cpu.max` of `<quota> <period>` allows; `None` for `max`.
fn quota_cpus(cpu_max: &str) -> Option<f64> {
    let mut fields = cpu_max.split_whitespace();
    let quota = fields.next()?.parse::<u64>().ok()?;
    let period = fields.next()?.parse::<u64>().ok().filter(|p| *p > 0)?;
    (quota > 0).then(|| quota as f64 / period as f64)
}

/// CPUs in a list such as `0-3,6,8-9`.
fn cpu_list_count(list: &str) -> Option<u64> {
    let list = list.trim();
    if list.is_empty() {
        return None;
    }
    let mut count = 0u64;
    for range in list.split(',') {
        count += match range.split_once('-') {
            Some((first, last)) => {
                let (first, last) = (first.parse::<u64>().ok()?, last.parse::<u64>().ok()?);
                last.checked_sub(first)? + 1
            }
            None => {
                range.parse::<u64>().ok()?;
                1
            }
        };
    }
    (count > 0).then_some(count)
}

/// Busy and total jiffies from the aggregate `cpu` line: user, nice,
/// system, idle, iowait, irq, softirq, steal (guest time is already in
/// user and nice).
fn proc_stat_counters(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|line| line.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|field| field.parse().ok())
        .collect::<Option<_>>()?;
    if fields.len() < 4 {
        return None;
    }
    let total: u64 = fields.iter().sum();
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

/// Busy share between two readings, clamped to 0–100 and rounded to one
/// decimal. Counters that went backwards or a changed source give `None`.
fn busy_percent(previous: Reading, current: Reading) -> Option<f64> {
    let ratio = match (previous, current) {
        (
            Reading::Cgroup {
                usage_usec: before,
                at: then,
                ..
            },
            Reading::Cgroup {
                usage_usec: after,
                at: now,
                cpus,
            },
        ) => {
            let capacity = now.checked_duration_since(then)?.as_micros() as f64 * cpus;
            if capacity <= 0.0 {
                return None;
            }
            after.checked_sub(before)? as f64 / capacity
        }
        (
            Reading::Proc {
                busy: busy_before,
                total: total_before,
            },
            Reading::Proc { busy, total },
        ) => {
            let total = total.checked_sub(total_before)?;
            if total == 0 {
                return None;
            }
            busy.checked_sub(busy_before)? as f64 / total as f64
        }
        _ => return None,
    };
    let percent = (ratio * 100.0).clamp(0.0, 100.0);
    percent.is_finite().then(|| (percent * 10.0).round() / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PROC_STAT: &str = "cpu  22859 46 16612 314962 2287 0 2699 4021 0 0\n\
                             cpu0 5559 11 4073 79009 525 0 1125 997 0 0\n\
                             intr 1 2 3\n";

    #[test]
    fn parses_counters() {
        assert_eq!(
            usage_usec("usage_usec 420038701\nuser_usec 228457623\n"),
            Some(420_038_701)
        );
        assert_eq!(usage_usec("user_usec 5\n"), None);
        assert_eq!(quota_cpus("max 100000\n"), None);
        assert_eq!(quota_cpus("150000 100000\n"), Some(1.5));
        assert_eq!(quota_cpus("150000 0"), None);
        assert_eq!(cpu_list_count("0-3\n"), Some(4));
        assert_eq!(cpu_list_count("0-1,4,6-7"), Some(5));
        assert_eq!(cpu_list_count("\n"), None);
        assert_eq!(cpu_list_count("3-1"), None);
        let total = 22859 + 46 + 16612 + 314962 + 2287 + 2699 + 4021;
        assert_eq!(
            proc_stat_counters(PROC_STAT),
            Some((total - 314962 - 2287, total))
        );
        assert_eq!(proc_stat_counters("cpu0 1 2 3 4\n"), None);
        assert_eq!(proc_stat_counters("cpu  1 x 3 4\n"), None);
    }

    #[test]
    fn proc_stat_percent() {
        let before = Reading::Proc {
            busy: 1000,
            total: 4000,
        };
        let after = Reading::Proc {
            busy: 1250,
            total: 4800,
        };
        assert_eq!(busy_percent(before, after), Some(31.3));
        assert_eq!(busy_percent(before, before), None);
        assert_eq!(busy_percent(after, before), None);
    }

    #[test]
    fn cgroup_percent_against_its_cpus() {
        let then = Instant::now();
        let now = then + Duration::from_secs(2);
        let reading = |usage_usec, at, cpus| Reading::Cgroup {
            usage_usec,
            at,
            cpus,
        };
        // 1 CPU-second of work in 2 s on 4 CPUs.
        assert_eq!(
            busy_percent(reading(0, then, 4.0), reading(1_000_000, now, 4.0)),
            Some(12.5)
        );
        // The same work under a half-CPU quota saturates it.
        assert_eq!(
            busy_percent(reading(0, then, 0.5), reading(1_000_000, now, 0.5)),
            Some(100.0)
        );
        assert_eq!(
            busy_percent(reading(5, then, 4.0), reading(4, now, 4.0)),
            None
        );
        assert_eq!(
            busy_percent(reading(0, then, 4.0), reading(0, then, 4.0)),
            None
        );
        assert_eq!(
            busy_percent(reading(0, then, 4.0), Reading::Proc { busy: 1, total: 2 }),
            None
        );
    }

    #[test]
    fn reads_the_tightest_quota_else_the_root() {
        let root = tempfile::tempdir().unwrap();
        let orb = root.path().join("orb");
        let leaf = orb.join("leaf");
        std::fs::create_dir_all(&leaf).unwrap();
        std::fs::write(root.path().join("cpu.stat"), "usage_usec 900\n").unwrap();
        std::fs::write(root.path().join("cpuset.cpus.effective"), "0-7\n").unwrap();
        std::fs::write(leaf.join("cpu.stat"), "usage_usec 5\n").unwrap();
        let read = |membership: &str| match cgroup_reading(root.path(), membership) {
            Some(Reading::Cgroup {
                usage_usec, cpus, ..
            }) => Some((usage_usec, cpus)),
            _ => None,
        };
        // No quota anywhere: the whole hierarchy, not dxd's own leaf.
        assert_eq!(read("0::/orb/leaf\n"), Some((900, 8.0)));
        std::fs::write(orb.join("cpu.max"), "200000 100000\n").unwrap();
        std::fs::write(orb.join("cpu.stat"), "usage_usec 70\n").unwrap();
        std::fs::write(orb.join("cpuset.cpus.effective"), "0-7\n").unwrap();
        std::fs::write(leaf.join("cpu.max"), "max 100000\n").unwrap();
        assert_eq!(read("0::/orb/leaf\n"), Some((70, 2.0)));
        // cgroup v1 only: the caller falls back to /proc/stat.
        assert_eq!(read("4:cpu,cpuacct:/orb\n"), None);
    }
}
