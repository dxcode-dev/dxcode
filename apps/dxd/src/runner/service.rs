//! Start at login: a per-user LaunchAgent on macOS, a `systemd --user` unit
//! on Linux. No sudo; nothing outside the person's own account.

use crate::runner::{Config, Paths};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "dev.dx.runner";

fn exe(paths: &Paths) -> PathBuf {
    let installed = crate::runner::update::installed(paths);
    if installed.exists() {
        installed
    } else {
        std::env::current_exe().unwrap_or(installed)
    }
}

fn root_args(paths: &Paths) -> Vec<String> {
    if paths.root == paths.home.join(".dx") {
        vec![]
    } else {
        vec!["--root".into(), paths.root.display().to_string()]
    }
}

fn captured_path(paths: &Paths) -> String {
    Config::load(paths)
        .ok()
        .and_then(|c| c.path)
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into())
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn plist_path(paths: &Paths) -> PathBuf {
    paths
        .home
        .join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

fn unit_path(paths: &Paths) -> PathBuf {
    paths.home.join(".config/systemd/user/dx-runner.service")
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

fn systemd_user() -> bool {
    run(Command::new("systemctl").args(["--user", "show-environment"])).is_ok()
}

pub fn install(paths: &Paths) -> Result<(), String> {
    Config::load(paths)?;
    let mut args = vec![exe(paths).display().to_string()];
    args.push("runner".into());
    args.extend(root_args(paths));
    args.push("run".into());
    if cfg!(target_os = "macos") {
        let plist = plist_path(paths);
        fs::create_dir_all(plist.parent().unwrap()).map_err(|e| e.to_string())?;
        let program: String = args
            .iter()
            .map(|a| format!("    <string>{}</string>\n", xml(a)))
            .collect();
        let text = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{program}  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
            path = xml(&captured_path(paths)),
            log = xml(&paths.runner.join("service.log").display().to_string()),
        );
        fs::write(&plist, text).map_err(|e| e.to_string())?;
        crate::runner::set_mode(&plist, 0o644);
        let domain = format!("gui/{}", uid());
        let service = format!("{domain}/{LABEL}");
        let _ = run(Command::new("launchctl").args(["bootout", &service]));
        // bootout returns before the old runner has stopped; bootstrapping
        // over it fails with "Bootstrap failed: 5". Wait until it is gone.
        for _ in 0..50 {
            if run(Command::new("launchctl").args(["print", &service])).is_err() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let plist_path = plist.display().to_string();
        let mut attempt = 0;
        loop {
            match run(Command::new("launchctl").args(["bootstrap", &domain, &plist_path])) {
                Ok(_) => break,
                Err(e) if attempt < 5 => {
                    attempt += 1;
                    let _ = e;
                    std::thread::sleep(std::time::Duration::from_millis(500 * attempt));
                }
                Err(e) => return Err(e),
            }
        }
        println!(
            "installed LaunchAgent {} (starts at login; stop with `dxd runner uninstall-service`)",
            plist.display()
        );
        Ok(())
    } else if systemd_user() {
        let unit = unit_path(paths);
        fs::create_dir_all(unit.parent().unwrap()).map_err(|e| e.to_string())?;
        let quoted: Vec<String> = args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
            .collect();
        let text = format!(
            "[Unit]\nDescription=dx runner (dxd runner run)\nAfter=network-online.target\n\n[Service]\nExecStart={}\nEnvironment=\"PATH={}\"\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
            quoted.join(" "),
            captured_path(paths).replace('"', ""),
        );
        fs::write(&unit, text).map_err(|e| e.to_string())?;
        run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
        run(Command::new("systemctl").args(["--user", "enable", "--now", "dx-runner.service"]))?;
        println!(
            "installed systemd user unit {} (enabled and started)",
            unit.display()
        );
        println!("to keep it running after you log out: loginctl enable-linger $USER");
        Ok(())
    } else {
        Err(format!(
            "no systemd user session here; run it in the background yourself:\n  nohup {} run >> {} 2>&1 &",
            args[..args.len() - 1].join(" "),
            paths.runner.join("service.log").display()
        ))
    }
}

pub fn uninstall(paths: &Paths) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let plist = plist_path(paths);
        let _ = run(Command::new("launchctl").args(["bootout", &format!("gui/{}/{LABEL}", uid())]));
        if plist.exists() {
            fs::remove_file(&plist).map_err(|e| e.to_string())?;
            println!("removed LaunchAgent {}", plist.display());
        }
        // The Desktop's privacy grants, for its bundle only.
        let bundle = crate::runner::desktop::BUNDLE_ID;
        for service in ["ScreenCapture", "Accessibility"] {
            let _ = run(Command::new("/usr/bin/tccutil").args(["reset", service, bundle]));
        }
    } else {
        let unit = unit_path(paths);
        if unit.exists() {
            let _ = run(Command::new("systemctl").args([
                "--user",
                "disable",
                "--now",
                "dx-runner.service",
            ]));
            fs::remove_file(&unit).map_err(|e| e.to_string())?;
            let _ = run(Command::new("systemctl").args(["--user", "daemon-reload"]));
            println!("removed systemd user unit {}", unit.display());
        }
    }
    Ok(())
}

pub fn describe(paths: &Paths) -> String {
    if cfg!(target_os = "macos") {
        if plist_path(paths).exists() {
            format!("LaunchAgent {LABEL}")
        } else {
            "not installed".into()
        }
    } else if unit_path(paths).exists() {
        "systemd user unit dx-runner.service".into()
    } else {
        "not installed".into()
    }
}
