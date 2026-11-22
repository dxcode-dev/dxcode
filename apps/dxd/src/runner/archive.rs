//! Archive: a Thread folder becomes a small snapshot stored in Core, then the
//! folder is deleted. Restore rebuilds it on any runner.
//!
//! Per git repo (`workspace/repo` and `workspace/repos/*`): origin, branch,
//! HEAD, and a bundle holding one commit with the working tree (tracked and
//! untracked, not ignored). A small repo's bundle carries its whole history so
//! it restores without the network; a large one carries only what origin lacks.
//! The rest of `workspace/` and dx's source state travel as tars. Ignored files
//! (dependencies, build output) are dropped.

use crate::runner::exec::{Run, run_in_thread};
use crate::runner::ops::{Ctx, OpError, OpResult, ThreadPaths, dir_size, plain_relative};
use crate::runner::{log, now_ms};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SNAPSHOT_CAP: u64 = 64 * 1024 * 1024;
const SELF_CONTAINED_REPO: u64 = 24 * 1024 * 1024;
/// dx's own per-Thread state in the guest home, kept across archive.
const HOME_STATE: &str = ".local/state/dx";

fn git_argv(args: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = [
        "git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    argv.extend(args.iter().map(|s| s.to_string()));
    argv
}

/// git inside the sandbox with hooks and fsmonitor off: a repository the
/// agent wrote must not run code through the runner's own git calls.
fn git(
    ctx: &Ctx,
    t: &ThreadPaths,
    cwd: &Path,
    args: &[&str],
    env: &[(String, String)],
) -> Result<Run, String> {
    run_in_thread(
        &ctx.paths,
        &t.root,
        &git_argv(args),
        cwd,
        Duration::from_secs(900),
        env,
        ctx.config.unsandboxed,
    )
}

fn git_ok(
    ctx: &Ctx,
    t: &ThreadPaths,
    cwd: &Path,
    args: &[&str],
    env: &[(String, String)],
) -> Result<String, String> {
    let r = git(ctx, t, cwd, args, env)?;
    if r.ok() {
        Ok(r.stdout.trim().to_string())
    } else {
        Err(format!("git {}: {}", args.join(" "), r.stderr.trim()))
    }
}

fn git_opt(ctx: &Ctx, t: &ThreadPaths, cwd: &Path, args: &[&str]) -> Option<String> {
    git_ok(ctx, t, cwd, args, &[])
        .ok()
        .filter(|s| !s.is_empty())
}

fn workspace_dir(t: &ThreadPaths) -> PathBuf {
    t.home.join("workspace")
}

/// Repos as paths relative to `workspace/`.
fn repos(t: &ThreadPaths) -> Vec<String> {
    let ws = workspace_dir(t);
    let mut out = Vec::new();
    if ws.join("repo/.git").exists() {
        out.push("repo".to_string());
    }
    if let Ok(it) = fs::read_dir(ws.join("repos")) {
        let mut names: Vec<String> = it
            .flatten()
            .filter(|e| e.path().join(".git").exists() && !e.path().is_symlink())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        out.extend(names.into_iter().map(|n| format!("repos/{n}")));
    }
    out
}

fn tar(
    ctx: &Ctx,
    t: &ThreadPaths,
    from: &Path,
    out: &Path,
    entries: &[&str],
    excludes: &[String],
) -> Result<(), String> {
    let mut argv: Vec<String> = vec!["tar".into(), "-czf".into(), out.display().to_string()];
    for x in excludes {
        argv.extend(["--exclude".into(), x.clone()]);
    }
    argv.extend(["-C".into(), from.display().to_string()]);
    argv.extend(entries.iter().map(|s| s.to_string()));
    let r = run_in_thread(
        &ctx.paths,
        &t.root,
        &argv,
        from,
        Duration::from_secs(900),
        &[],
        ctx.config.unsandboxed,
    )?;
    if r.ok() {
        Ok(())
    } else {
        Err(format!("tar: {}", r.stderr.trim()))
    }
}

fn untar(ctx: &Ctx, t: &ThreadPaths, archive: &Path, into: &Path) -> Result<(), String> {
    fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let argv: Vec<String> = vec![
        "tar".into(),
        "-xzf".into(),
        archive.display().to_string(),
        "-C".into(),
        into.display().to_string(),
    ];
    let r = run_in_thread(
        &ctx.paths,
        &t.root,
        &argv,
        into,
        Duration::from_secs(900),
        &[],
        ctx.config.unsandboxed,
    )?;
    if r.ok() {
        Ok(())
    } else {
        Err(format!("tar: {}", r.stderr.trim()))
    }
}

fn b64_file(p: &Path) -> Result<String, String> {
    Ok(B64.encode(fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?))
}

fn packed_bytes(ctx: &Ctx, t: &ThreadPaths, repo: &Path) -> u64 {
    git_opt(ctx, t, repo, &["count-objects", "-v"])
        .map(|s| {
            s.lines()
                .filter_map(|l| {
                    l.strip_prefix("size-pack: ")
                        .or_else(|| l.strip_prefix("size: "))
                })
                .filter_map(|v| v.trim().parse::<u64>().ok())
                .sum::<u64>()
                * 1024
        })
        .unwrap_or(u64::MAX)
}

/// Builds the snapshot of a Thread folder.
pub fn snapshot(ctx: &Ctx, t: &ThreadPaths) -> Result<Value, String> {
    let stage = t.root.join("tmp/archive");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let author: Vec<(String, String)> = [
        ("GIT_AUTHOR_NAME", "dx-runner"),
        ("GIT_AUTHOR_EMAIL", "runner@dx.invalid"),
        ("GIT_COMMITTER_NAME", "dx-runner"),
        ("GIT_COMMITTER_EMAIL", "runner@dx.invalid"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let ws = workspace_dir(t);
    let mut out_repos = Vec::new();
    let mut total: u64 = 0;
    let repo_paths = repos(t);
    for (i, rel) in repo_paths.iter().enumerate() {
        let repo = ws.join(rel);
        let origin = git_opt(ctx, t, &repo, &["remote", "get-url", "origin"]);
        let head = git_opt(ctx, t, &repo, &["rev-parse", "--verify", "-q", "HEAD"]);
        let branch = git_opt(ctx, t, &repo, &["symbolic-ref", "-q", "--short", "HEAD"]);
        let Some(head) = head else {
            let tarball = stage.join(format!("{i}.tgz"));
            tar(ctx, t, &ws, &tarball, &[rel.as_str()], &[])?;
            total += fs::metadata(&tarball).map(|m| m.len()).unwrap_or(0);
            out_repos.push(json!({ "path": rel, "mode": "tar", "tar": b64_file(&tarball)? }));
            continue;
        };
        let index = stage.join(format!("{i}.index"));
        let mut env = author.clone();
        env.push(("GIT_INDEX_FILE".into(), index.display().to_string()));
        git_ok(ctx, t, &repo, &["read-tree", "HEAD"], &env)?;
        git_ok(ctx, t, &repo, &["add", "-A"], &env)?;
        let tree = git_ok(ctx, t, &repo, &["write-tree"], &env)?;
        let wip = git_ok(
            ctx,
            t,
            &repo,
            &["commit-tree", &tree, "-p", &head, "-m", "dx-runner archive"],
            &env,
        )?;
        git_ok(ctx, t, &repo, &["update-ref", "refs/dx/wip", &wip], &[])?;
        let bundle = stage.join(format!("{i}.bundle"));
        let bundle_s = bundle.display().to_string();
        // Test hook: DX_RUNNER_SELF_CONTAINED_BYTES lowers the limit.
        let limit = std::env::var("DX_RUNNER_SELF_CONTAINED_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(SELF_CONTAINED_REPO);
        // A shallow clone's own history stops at its cut, so a bundle of it
        // cannot stand alone: it carries only what origin lacks.
        let shallow = git(
            ctx,
            t,
            &repo,
            &["rev-parse", "--is-shallow-repository"],
            &[],
        )
        .is_ok_and(|r| r.stdout.trim() == "true");
        let full = origin.is_none() || (!shallow && packed_bytes(ctx, t, &repo) <= limit);
        let mut args = vec!["bundle", "create", &bundle_s, "refs/dx/wip", "--branches"];
        if !full {
            args.extend(["--not", "--remotes"]);
        } else {
            args.push("--tags");
        }
        git_ok(ctx, t, &repo, &args, &[])?;
        let _ = git(ctx, t, &repo, &["update-ref", "-d", "refs/dx/wip"], &[]);
        total += fs::metadata(&bundle).map(|m| m.len()).unwrap_or(0);
        let changed = git_opt(ctx, t, &repo, &["diff", "--name-only", &head, &wip])
            .map_or(0, |s| s.lines().count());
        out_repos.push(json!({
            "path": rel, "mode": if full { "bundle-full" } else { "bundle" },
            "origin": origin, "branch": branch, "head": head, "wip": wip,
            "changedFiles": changed, "bundle": b64_file(&bundle)?,
        }));
    }
    let ws_tar = stage.join("workspace.tgz");
    let excludes: Vec<String> = repo_paths.iter().map(|r| format!("./{r}")).collect();
    if ws.is_dir() {
        tar(ctx, t, &ws, &ws_tar, &["."], &excludes)?;
        total += fs::metadata(&ws_tar).map(|m| m.len()).unwrap_or(0);
    }
    let state_tar = stage.join("home-state.tgz");
    let has_state = t.home.join(HOME_STATE).is_dir();
    if has_state {
        tar(ctx, t, &t.home, &state_tar, &[HOME_STATE], &[])?;
        total += fs::metadata(&state_tar).map(|m| m.len()).unwrap_or(0);
    }
    if total > SNAPSHOT_CAP {
        return Err(format!(
            "the snapshot is {total} bytes, over the {SNAPSHOT_CAP}-byte cap; nothing was deleted"
        ));
    }
    let snapshot = json!({
        "version": 2, "thread": t.id, "createdAt": now_ms(),
        "folderBytesBefore": dir_size(&t.root), "snapshotBytes": total,
        "repos": out_repos,
        "workspaceTar": if ws.is_dir() { Value::String(b64_file(&ws_tar)?) } else { Value::Null },
        "homeStateTar": if has_state { Value::String(b64_file(&state_tar)?) } else { Value::Null },
    });
    let _ = fs::remove_dir_all(&stage);
    Ok(snapshot)
}

/// The `archive` operation: snapshot, upload, then delete the folder.
pub fn archive(ctx: &Ctx, t: &ThreadPaths, body: &Value) -> OpResult {
    let url = ctx
        .config
        .same_origin(
            body["uploadUrl"]
                .as_str()
                .ok_or_else(|| OpError::invalid("archive needs uploadUrl"))?,
        )
        .map_err(OpError::invalid)?;
    if !t.root.is_dir() {
        return Err(OpError::new(
            "not-found",
            "the Thread has no folder on this machine",
        ));
    }
    ctx.daemons.stop(t);
    let snap = snapshot(ctx, t)?;
    let text = snap.to_string();
    let resp = crate::runner::http()
        .put(&url)
        .header("Authorization", &format!("Bearer {}", ctx.config.token))
        .header("Content-Type", "application/json")
        .send(text.as_bytes())
        .map_err(|e| OpError::failed(format!("upload: {e}")))?;
    if !resp.status().is_success() {
        return Err(OpError::failed(format!(
            "upload answered {}; nothing was deleted",
            resp.status()
        )));
    }
    fs::remove_dir_all(&t.root)?;
    log(&format!(
        "archive {}: {} bytes on disk -> {} byte snapshot; folder deleted",
        t.id, snap["folderBytesBefore"], snap["snapshotBytes"]
    ));
    let repos: Vec<Value> = snap["repos"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| json!({ "path": r["path"], "mode": r["mode"], "branch": r["branch"], "changedFiles": r["changedFiles"] }))
                .collect()
        })
        .unwrap_or_default();
    Ok(
        json!({ "bytes": text.len(), "folderBytesBefore": snap["folderBytesBefore"], "repos": repos }),
    )
}

/// `ensure` with `restore`: fetch the snapshot and rebuild the folder.
pub fn restore(ctx: &Ctx, t: &ThreadPaths, url: &str, env: &Value) -> Result<(), OpError> {
    let url = ctx.config.same_origin(url).map_err(OpError::invalid)?;
    let mut resp = crate::runner::http()
        .get(&url)
        .header("Authorization", &format!("Bearer {}", ctx.config.token))
        .call()
        .map_err(|e| OpError::failed(format!("restore download: {e}")))?;
    if resp.status() == 404 {
        return Err(OpError::new("not-found", "no snapshot for this Thread"));
    }
    if !resp.status().is_success() {
        return Err(OpError::failed(format!(
            "restore download answered {}",
            resp.status()
        )));
    }
    let mut text = String::new();
    resp.body_mut()
        .with_config()
        .limit(SNAPSHOT_CAP * 2)
        .reader()
        .read_to_string(&mut text)
        .map_err(|e| OpError::failed(e.to_string()))?;
    let snap: Value =
        serde_json::from_str(&text).map_err(|e| OpError::invalid(format!("snapshot: {e}")))?;
    let git_env: Vec<(String, String)> = env
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    v.as_str()
                        .map(|v| (k.clone(), crate::runner::ops::translate(t, v)))
                })
                .collect()
        })
        .unwrap_or_default();
    for dir in [&t.root, &t.home, &workspace_dir(t)] {
        fs::create_dir_all(dir)?;
        crate::runner::set_mode(dir, 0o700);
    }
    let result = restore_into(ctx, t, &snap, &git_env);
    if result.is_err() {
        // Nothing half-restored; the snapshot stays in Core.
        let _ = fs::remove_dir_all(&t.root);
    }
    result.map_err(OpError::failed)
}

fn decode_to(stage: &Path, name: &str, data: &str) -> Result<PathBuf, String> {
    let p = stage.join(name);
    fs::write(&p, B64.decode(data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(p)
}

fn valid_branch(b: &str) -> bool {
    !b.is_empty()
        && !b.starts_with('-')
        && !b.contains("..")
        && b.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_-.".contains(c))
}

fn restore_into(
    ctx: &Ctx,
    t: &ThreadPaths,
    snap: &Value,
    git_env: &[(String, String)],
) -> Result<(), String> {
    if !matches!(snap["version"].as_u64(), Some(1 | 2)) {
        return Err("unknown snapshot version".into());
    }
    let stage = t.root.join("tmp/restore");
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let ws = workspace_dir(t);
    for (i, r) in snap["repos"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        // Version 1 (the experiment) named repos under workspace/repos.
        let rel = r["path"]
            .as_str()
            .map(str::to_string)
            .or_else(|| r["name"].as_str().map(|n| format!("repos/{n}")))
            .ok_or("snapshot repo has no path")?;
        if !plain_relative(&rel) {
            return Err(format!("unsafe repo path {rel:?}"));
        }
        let repo = ws.join(&rel);
        let parent = repo.parent().unwrap_or(&ws).to_path_buf();
        let name = repo
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("bad repo path")?
            .to_string();
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let mode = r["mode"].as_str().unwrap_or("bundle");
        if mode == "tar" {
            let tarball = decode_to(
                &stage,
                &format!("{i}.tgz"),
                r["tar"].as_str().unwrap_or_default(),
            )?;
            untar(ctx, t, &tarball, &ws)?;
            continue;
        }
        let bundle = decode_to(
            &stage,
            &format!("{i}.bundle"),
            r["bundle"].as_str().unwrap_or_default(),
        )?;
        let bundle_s = bundle.display().to_string();
        let head = r["head"].as_str().ok_or("snapshot repo has no head")?;
        let origin = r["origin"].as_str();
        let fetch_bundle = || {
            git_ok(
                ctx,
                t,
                &repo,
                &[
                    "fetch",
                    "-q",
                    "--update-head-ok",
                    &bundle_s,
                    "+refs/heads/*:refs/heads/*",
                    "+refs/tags/*:refs/tags/*",
                    "+refs/dx/wip:refs/dx/wip",
                ],
                &[],
            )
        };
        let clone = || {
            git_ok(
                ctx,
                t,
                &parent,
                &[
                    "clone",
                    "-q",
                    "--no-checkout",
                    "--",
                    origin.unwrap_or_default(),
                    &name,
                ],
                git_env,
            )
        };
        if mode == "bundle-full" || origin.is_none() {
            git_ok(ctx, t, &parent, &["init", "-q", &name], &[])?;
            if let Some(o) = origin {
                git_ok(ctx, t, &repo, &["remote", "add", "origin", o], &[])?;
            }
            // A whole-history bundle from a shallow clone (made before
            // archive checked for one) lacks what lies past the cut; origin
            // has it.
            if let Err(error) = fetch_bundle() {
                if origin.is_none() {
                    return Err(error);
                }
                fs::remove_dir_all(&repo).map_err(|e| e.to_string())?;
                clone()?;
                fetch_bundle()?;
            }
        } else {
            clone()?;
            fetch_bundle()?;
        }
        match r["branch"].as_str() {
            Some(b) if valid_branch(b) => {
                let full = format!("refs/heads/{b}");
                git_ok(ctx, t, &repo, &["update-ref", &full, head], &[])?;
                git_ok(ctx, t, &repo, &["symbolic-ref", "HEAD", &full], &[])?;
                let upstream = format!("origin/{b}");
                let _ = git(
                    ctx,
                    t,
                    &repo,
                    &["branch", "-q", "--set-upstream-to", &upstream, b],
                    &[],
                );
            }
            Some(b) => return Err(format!("unsupported branch name {b:?}")),
            None => {
                git_ok(
                    ctx,
                    t,
                    &repo,
                    &["update-ref", "--no-deref", "HEAD", head],
                    &[],
                )?;
            }
        }
        // Working tree = the archived tree; index = HEAD. Untracked files come
        // back untracked; deleted files stay deleted.
        git_ok(
            ctx,
            t,
            &repo,
            &["read-tree", "-u", "--reset", "refs/dx/wip"],
            &[],
        )?;
        git_ok(ctx, t, &repo, &["reset", "-q"], &[])?;
        git_ok(ctx, t, &repo, &["update-ref", "-d", "refs/dx/wip"], &[])?;
    }
    if let Some(data) = snap["workspaceTar"].as_str() {
        let tarball = decode_to(&stage, "workspace.tgz", data)?;
        untar(ctx, t, &tarball, &ws)?;
    }
    if let Some(data) = snap["homeStateTar"].as_str() {
        let tarball = decode_to(&stage, "home-state.tgz", data)?;
        untar(ctx, t, &tarball, &t.home)?;
    }
    let _ = fs::remove_dir_all(&stage);
    log(&format!(
        "restore {}: {} repos",
        t.id,
        snap["repos"].as_array().map_or(0, Vec::len)
    ));
    Ok(())
}
