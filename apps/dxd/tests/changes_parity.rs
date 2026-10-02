//! Changes parity: `dxd changes-capture` must produce the same manifest as
//! `main`'s Python capture for every fixture. The oracle is
//! `fixtures/changes_capture_main.py`, byte-identical to
//! `apps/dxd/src/changes_capture.py` at `a7d81624` (dxd v0.1.1), and runs only
//! here: nothing in the guest path uses Python.
//!
//! The fingerprint is excluded: Python hashes untracked content, dxd hashes
//! `git status` plus file metadata, and each is only ever compared with
//! itself.
//!
//! Known, intentional divergences (asserted in `divergences_from_main`):
//! - Glob characters in a tracked path: Python passes the path as a pathspec,
//!   so `star*.txt` also pulls in `star-x.txt`'s patch; dxd uses literal
//!   pathspecs.
//! - Untracked text is split into patch lines on `\n` only, as Git does;
//!   Python's `splitlines` also splits on `\r`, `\f`, `\v`, and a few Unicode
//!   separators, producing patch lines Git never would.

use serde_json::Value;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ORACLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/changes_capture_main.py"
);

/// Git without the developer's global or system configuration.
fn isolated(command: &mut Command) -> &mut Command {
    command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "dx")
        .env("GIT_AUTHOR_EMAIL", "dx@example.com")
        .env("GIT_COMMITTER_NAME", "dx")
        .env("GIT_COMMITTER_EMAIL", "dx@example.com")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = isolated(Command::new("git").arg("-C").arg(root).args(arguments))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn write(root: &Path, path: &str, content: impl AsRef<[u8]>) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn commit_all(root: &Path, message: &str) -> String {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", message]);
    git(root, &["rev-parse", "HEAD"])
}

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("repo");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        Self {
            _directory: directory,
            root,
        }
    }

    fn sibling(&self, name: &str) -> PathBuf {
        self.root.parent().unwrap().join(name)
    }
}

fn run(command: &mut Command, root: &Path, baseline: &str) -> Option<Value> {
    let output = isolated(command)
        .env("DX_CHANGES_ROOT", root)
        .env("DX_CHANGES_BASELINE", baseline)
        .env("DX_CHANGES_DEFAULT_BRANCH", "main")
        .env_remove("DX_CHANGES_EXPECTED_FINGERPRINT")
        .env_remove("DX_CHANGES_PROBE")
        .output()
        .unwrap();
    if !output.status.success() {
        return None;
    }
    let mut value: Value = serde_json::from_slice(&output.stdout).unwrap();
    if let Some(object) = value.as_object_mut() {
        object.remove("fingerprint");
    }
    Some(value)
}

fn captures(root: &Path, baseline: &str) -> (Option<Value>, Option<Value>) {
    let rust = run(
        Command::new(env!("CARGO_BIN_EXE_dxd")).arg("changes-capture"),
        root,
        baseline,
    );
    let python = run(Command::new("python3").arg(ORACLE), root, baseline);
    (rust, python)
}

/// First differing JSON location, for a readable failure.
fn difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys = left.keys().chain(right.keys()).collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                difference(
                    &format!("{path}.{key}"),
                    left.get(key).unwrap_or(&Value::Null),
                    right.get(key).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => left
            .iter()
            .zip(right)
            .enumerate()
            .find_map(|(index, (left, right))| {
                difference(&format!("{path}[{index}]"), left, right)
            }),
        _ if left == right => None,
        _ => Some(format!("{path}:\n  dxd:    {left}\n  python: {right}")),
    }
}

fn assert_parity(root: &Path, baseline: &str) -> Value {
    let (rust, python) = captures(root, baseline);
    let python = python.expect("the Python oracle failed");
    let rust = rust.expect("dxd changes-capture failed");
    if let Some(difference) = difference("$", &rust, &python) {
        panic!("dxd and main differ at {difference}");
    }
    assert_eq!(rust["kind"], "complete");
    rust
}

fn files(capture: &Value, range: usize) -> Vec<(String, String)> {
    capture["ranges"][range]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            (
                file["path"].as_str().unwrap().to_owned(),
                file["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn base_repository() -> (Fixture, String) {
    let fixture = Fixture::new();
    let root = &fixture.root;
    write(
        root,
        "README.md",
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    );
    write(root, "src/lib.rs", "pub fn a() {}\npub fn b() {}\n");
    write(root, "gone.txt", "bye\n");
    write(root, "docs/guide.md", "guide\n");
    write(root, "a", "plain a\n");
    write(root, "a b/c.txt", "nested under a space\n");
    write(root, "script.sh", "#!/bin/sh\necho hi\n");
    symlink("README.md", root.join("link")).unwrap();
    let baseline = commit_all(root, "baseline");
    (fixture, baseline)
}

#[test]
fn dirty_working_tree() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    write(
        root,
        "README.md",
        "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight",
    );
    fs::remove_file(root.join("gone.txt")).unwrap();
    fs::remove_dir_all(root.join("docs")).unwrap();
    write(root, "a", "changed a\n");
    write(root, "a b/c.txt", "changed nested\n");
    fs::set_permissions(root.join("script.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::remove_file(root.join("link")).unwrap();
    symlink("src/lib.rs", root.join("link")).unwrap();
    write(root, "notes.txt", "n1\nn2");
    write(root, "empty.txt", "");
    write(root, "crlf.txt", "c1\r\nc2\r\n");
    write(root, "deep/er/file.md", "deep\n");
    write(root, "ünïcødé name.txt", "ü\n");
    write(root, "latin1.txt", b"caf\xe9\n".as_slice());
    symlink("notes.txt", root.join("new-link")).unwrap();
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["ranges"][0]["summary"]["files"], 14);
    let all = files(&capture, 0);
    assert!(all.contains(&("gone.txt".into(), "deleted".into())));
    assert!(all.contains(&("a b/c.txt".into(), "modified".into())));
    assert!(all.contains(&("new-link".into(), "untracked".into())));
}

#[test]
fn quoted_and_ambiguous_tracked_names() {
    let (fixture, _) = base_repository();
    let root = &fixture.root;
    write(root, "tab\there.txt", "t\n");
    write(root, "quote\"d.txt", "q\n");
    write(root, "new\nline.txt", "n\n");
    write(root, "back b/slash.txt", "b\n");
    let baseline = commit_all(root, "odd names");
    write(root, "tab\there.txt", "t2\n");
    write(root, "quote\"d.txt", "q2\n");
    write(root, "new\nline.txt", "n2\n");
    write(root, "back b/slash.txt", "b2\n");
    write(root, "a", "a2\n");
    write(root, "a b/c.txt", "c2\n");
    let capture = assert_parity(root, &baseline);
    for file in capture["ranges"][0]["files"].as_array().unwrap() {
        let path = file["path"].as_str().unwrap();
        let patch = file["patch"].as_str().unwrap();
        assert_eq!(
            patch.matches("diff --git ").count(),
            1,
            "{path} must own exactly its patch"
        );
    }
}

#[test]
fn staged_changes() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    write(
        root,
        "README.md",
        "one\ntwo\nstaged\nfour\nfive\nsix\nseven\n",
    );
    git(root, &["add", "README.md"]);
    write(
        root,
        "README.md",
        "one\ntwo\nstaged\nfour\nunstaged\nsix\nseven\n",
    );
    write(root, "staged-new.txt", "s\n");
    git(root, &["add", "staged-new.txt"]);
    git(root, &["rm", "-q", "gone.txt"]);
    write(root, "intent.txt", "intent to add\n");
    git(root, &["add", "-N", "intent.txt"]);
    write(root, "src/lib.rs", "pub fn a() {}\n");
    git(root, &["add", "src/lib.rs"]);
    write(root, "src/lib.rs", "pub fn a() {}\npub fn b() {}\n");
    let capture = assert_parity(root, &baseline);
    let all = files(&capture, 0);
    assert!(all.contains(&("staged-new.txt".into(), "added".into())));
    assert!(all.contains(&("intent.txt".into(), "added".into())));
    assert!(!all.iter().any(|(path, _)| path == "src/lib.rs"));
}

#[test]
fn ahead_commits_against_an_upstream() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    let remote = fixture.sibling("remote.git");
    git(
        root.parent().unwrap(),
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(root, &["remote", "add", "origin", remote.to_str().unwrap()]);
    write(root, "pushed.txt", "pushed\n");
    commit_all(root, "pushed commit");
    git(root, &["push", "-q", "-u", "origin", "main"]);
    git(root, &["switch", "-q", "-c", "side"]);
    write(root, "side.txt", "side\n");
    commit_all(root, "side work");
    git(root, &["switch", "-q", "main"]);
    write(
        root,
        "src/lib.rs",
        "pub fn a() {}\npub fn b() {}\npub fn c() {}\n",
    );
    commit_all(root, &format!("ünïcode subject {}", "long ".repeat(120)));
    git(
        root,
        &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
    );
    git(root, &["rm", "-q", "gone.txt"]);
    git(root, &["commit", "-q", "-m", "remove gone"]);
    write(root, "README.md", "dirty after commits\n");
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["upstreamLabel"], "origin/main");
    assert_eq!(capture["ahead"], 4);
    assert_eq!(capture["commits"].as_array().unwrap().len(), 5);
    assert_eq!(capture["ranges"].as_array().unwrap().len(), 7);

    // Without a configured upstream the default branch's remote ref counts.
    git(root, &["branch", "-q", "--unset-upstream"]);
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["upstreamLabel"], "origin/main");

    // Detached HEAD: no branch, still the same ranges.
    git(root, &["switch", "-q", "--detach", "HEAD~1"]);
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["branch"], Value::Null);
}

#[test]
fn linked_worktrees() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    write(root, "primary-dirty.txt", "p\n");
    let feature = fixture.sibling("feature");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            feature.to_str().unwrap(),
        ],
    );
    write(&feature, "src/lib.rs", "pub fn feature() {}\n");
    commit_all(&feature, "feature commit");
    write(&feature, "feature-untracked.txt", "f\n");
    write(&feature, "README.md", "feature dirty\n");
    let detached = fixture.sibling("detached");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            detached.to_str().unwrap(),
            &baseline,
        ],
    );
    write(&detached, "docs/guide.md", "detached edit\n");
    let unrelated = fixture.sibling("orphan");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "--orphan",
            "-b",
            "orphan",
            unrelated.to_str().unwrap(),
        ],
    );
    write(&unrelated, "fresh.txt", "unborn worktree\n");
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["worktrees"].as_array().unwrap().len(), 4);
    assert_eq!(capture["ranges"][0]["truncated"], false);

    // A pruned (deleted) worktree disappears; more than four linked
    // worktrees truncate the set.
    fs::remove_dir_all(&detached).unwrap();
    for index in 0..4 {
        let path = fixture.sibling(&format!("extra-{index}"));
        git(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                path.to_str().unwrap(),
                &baseline,
            ],
        );
        write(&path, "extra.txt", format!("extra {index}\n"));
    }
    let capture = assert_parity(root, &baseline);
    assert_eq!(capture["worktrees"].as_array().unwrap().len(), 5);
    assert_eq!(capture["ranges"][0]["truncated"], true);
}

#[test]
fn unborn_branch_with_the_empty_tree_baseline() {
    let fixture = Fixture::new();
    let root = &fixture.root;
    write(root, "a.txt", "a\n");
    write(root, "staged.txt", "staged\n");
    git(root, &["add", "staged.txt"]);
    write(root, "bin.dat", [0_u8, 1, 2, 3].as_slice());
    let capture = assert_parity(root, EMPTY_TREE);
    assert_eq!(capture["head"], EMPTY_TREE);
    assert_eq!(capture["branch"], "main");
    assert_eq!(capture["ahead"], 0);
    assert!(files(&capture, 0).contains(&("staged.txt".into(), "added".into())));
}

#[test]
fn projectless_commits_against_the_empty_tree() {
    let fixture = Fixture::new();
    let root = &fixture.root;
    write(root, "first.txt", "first\n");
    commit_all(root, "first");
    write(root, "second.txt", "second\n");
    write(root, "first.txt", "first\nmore\n");
    commit_all(root, "second");
    write(root, "third.txt", "uncommitted\n");
    let capture = assert_parity(root, EMPTY_TREE);
    assert_eq!(capture["ahead"], 2);
    assert_eq!(capture["commits"].as_array().unwrap().len(), 2);
    assert_eq!(
        files(&capture, 3),
        [("first.txt".to_owned(), "added".to_owned())]
    );
}

#[test]
fn binary_files() {
    let (fixture, _) = base_repository();
    let root = &fixture.root;
    write(
        root,
        "image.png",
        [0x89_u8, b'P', b'N', b'G', 0, 0, 1].as_slice(),
    );
    let baseline = commit_all(root, "binary");
    write(
        root,
        "image.png",
        [0x89_u8, b'P', b'N', b'G', 0, 0, 2].as_slice(),
    );
    write(root, "blob.bin", [1_u8, 0, 2].as_slice());
    let mut large = vec![b'x'; 300 * 1024];
    large[10] = 0;
    write(root, "large.bin", &large);
    write(root, "committed.bin", [0_u8; 16].as_slice());
    commit_all(root, "commit a binary");
    write(root, "large.bin", &large);
    let capture = assert_parity(root, &baseline);
    let image = &capture["ranges"][0]["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "image.png")
        .unwrap()
        .clone();
    assert_eq!(image["binary"], true);
    assert_eq!(image["patch"], "");
}

#[test]
fn renames_are_a_deletion_and_an_addition() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    git(root, &["mv", "README.md", "README.renamed.md"]);
    fs::rename(root.join("src/lib.rs"), root.join("src/moved.rs")).unwrap();
    git(root, &["mv", "docs/guide.md", "docs/guide2.md"]);
    write(root, "docs/guide2.md", "guide\nplus a line\n");
    let capture = assert_parity(root, &baseline);
    let all = files(&capture, 0);
    assert!(all.contains(&("README.md".into(), "deleted".into())));
    assert!(all.contains(&("README.renamed.md".into(), "added".into())));
    assert!(all.contains(&("src/lib.rs".into(), "deleted".into())));
    assert!(all.contains(&("src/moved.rs".into(), "untracked".into())));
}

#[test]
fn truncation_bounds() {
    let (fixture, _) = base_repository();
    let root = &fixture.root;
    let lines = (0..12_000)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    write(root, "big-lines.txt", &lines);
    write(root, "big-wide.txt", "short\n");
    let baseline = commit_all(root, "bounds baseline");
    // Over 10,000 patch lines, and over 256 KiB of patch bytes (with a
    // multibyte character straddling the byte bound).
    write(root, "big-lines.txt", lines.replace("line", "LINE"));
    write(root, "big-wide.txt", "é".repeat(200 * 1024));
    write(root, "big-untracked-lines.txt", &lines);
    write(
        root,
        "big-untracked-wide.txt",
        format!("{}\n", "ü".repeat(140 * 1024)),
    );
    // More than 200 files in one range.
    for index in 0..205 {
        write(
            root,
            &format!("bulk/file-{index:03}.txt"),
            format!("{index}\n"),
        );
    }
    let capture = assert_parity(root, &baseline);
    let all = &capture["ranges"][0];
    assert_eq!(all["truncated"], true);
    assert_eq!(all["files"].as_array().unwrap().len(), 200);
    assert_eq!(all["summary"]["files"], 209);
    let truncated = all["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|file| file["truncated"] == true)
        .count();
    assert_eq!(truncated, 4);
}

#[test]
fn oversized_manifests_are_pruned_largest_patch_first() {
    let (fixture, baseline) = base_repository();
    let root = &fixture.root;
    // 40 untracked 250 KiB text files appear in both the all and the
    // uncommitted range: ~20 MiB of patches against the 8 MiB object bound.
    for index in 0..40 {
        let line = format!("{index:02}{}\n", "p".repeat(97));
        write(
            root,
            &format!("big/{index:02}.txt"),
            line.repeat(250 * 1024 / 100 + index),
        );
    }
    let capture = assert_parity(root, &baseline);
    let emptied = capture["ranges"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|range| range["files"].as_array().unwrap())
        .filter(|file| file["patch"] == "" && file["truncated"] == true)
        .count();
    assert!(emptied > 0);
}

#[test]
fn unsafe_tracked_paths_fail_on_both() {
    let (fixture, _) = base_repository();
    let root = &fixture.root;
    write(root, "back\\slash.txt", "b\n");
    let baseline = commit_all(root, "backslash");
    write(root, "back\\slash.txt", "b2\n");
    assert_eq!(captures(root, &baseline), (None, None));
}

#[test]
fn divergences_from_main() {
    let (fixture, _) = base_repository();
    let root = &fixture.root;
    write(root, "star*.txt", "glob\n");
    write(root, "star-x.txt", "x\n");
    let baseline = commit_all(root, "glob names");
    write(root, "star*.txt", "glob2\n");
    write(root, "star-x.txt", "x2\n");
    write(root, "form-feed.txt", "a\x0cb\rc\n");
    let (rust, python) = captures(root, &baseline);
    let (rust, python) = (rust.unwrap(), python.unwrap());
    let patch = |capture: &Value, path: &str| {
        capture["ranges"][0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["path"] == path)
            .unwrap()["patch"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(patch(&rust, "star*.txt").matches("diff --git ").count(), 1);
    assert_eq!(
        patch(&python, "star*.txt").matches("diff --git ").count(),
        2
    );
    assert_eq!(
        patch(&rust, "form-feed.txt"),
        "--- /dev/null\n+++ b/form-feed.txt\n@@ -0,0 +1 @@\n+a\x0cb\rc\n"
    );
    assert_eq!(
        patch(&python, "form-feed.txt"),
        "--- /dev/null\n+++ b/form-feed.txt\n@@ -0,0 +1,3 @@\n+a\x0c+b\r+c\n"
    );
}
