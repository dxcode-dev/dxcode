//! Which of a set of local ports have an open (ESTABLISHED) TCP connection,
//! from `/proc/net/tcp` and `/proc/net/tcp6`. A pane that frames a plugin's
//! Portal keeps a connection open to its port, which keeps the process up.

use std::collections::HashSet;

/// The ports in `ports` with at least one established connection whose
/// local end is that port (the plugin's server side).
pub(super) fn established(ports: &[u16]) -> HashSet<u16> {
    if ports.is_empty() {
        return HashSet::new();
    }
    let mut found = HashSet::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(table) {
            found.extend(parse(&text, ports));
        }
    }
    found
}

fn parse(text: &str, ports: &[u16]) -> Vec<u16> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let local = fields.nth(1)?;
            let state = fields.nth(1)?;
            if state != "01" {
                return None;
            }
            let port = u16::from_str_radix(local.rsplit(':').next()?, 16).ok()?;
            ports.contains(&port).then_some(port)
        })
        .collect()
}
