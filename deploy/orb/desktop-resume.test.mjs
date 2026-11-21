import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Desktop's resume launcher, run the way ./session runs it: with the
// desktop's directory and the repository root overridable so a fake
// `chromium` records what the Desktop would open.
const launcher = join(
  dirname(fileURLToPath(import.meta.url)),
  "desktop",
  "resume",
);

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-desktop-resume-")));
  const home = join(root, "home");
  const desktop = join(root, "desktop");
  const repo = join(home, "workspace", "repo");
  mkdirSync(join(home, ".local", "state", "dx-desktop"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(desktop);
  // The fake browser records its arguments and the directory it ran in.
  writeFileSync(
    join(desktop, "chromium"),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> "${root}/opened"\n`,
    { mode: 0o755 },
  );
  const projectScript = join(
    home,
    ".local",
    "state",
    "dx",
    "project-scripts",
    "desktop-resume",
  );
  const run = () =>
    spawnSync("/bin/bash", [launcher], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        DX_DESKTOP_DIR: desktop,
      },
    });
  const opened = () =>
    existsSync(join(root, "opened"))
      ? readFileSync(join(root, "opened"), "utf8")
      : "";
  const log = () =>
    readFileSync(
      join(home, ".local", "state", "dx-desktop", "desktop-resume.log"),
      "utf8",
    );
  const writeProjectScript = (body) => {
    mkdirSync(dirname(projectScript), { recursive: true });
    writeFileSync(projectScript, body, { mode: 0o700 });
  };
  const writeRepoScript = (body, mode = 0o755) => {
    mkdirSync(join(repo, ".agents", "desktop"), { recursive: true });
    writeFileSync(join(repo, ".agents", "desktop", "resume"), body, { mode });
    chmodSync(join(repo, ".agents", "desktop", "resume"), mode);
  };
  return {
    root,
    repo,
    desktop,
    projectScript,
    run,
    opened,
    log,
    writeProjectScript,
    writeRepoScript,
  };
};

const opens = (url) => `"$DX_DESKTOP_DIR/chromium" ${url}\n`;

describe("Desktop resume launcher", () => {
  it("opens the default browser when there is no resume script", () => {
    const desktop = fixture();
    expect(desktop.run().status).toBe(0);
    expect(desktop.opened()).toBe(
      `${desktop.root}/home|--foreground about:blank\n`,
    );
  });

  it("runs the project's script from the repository root instead of the default browser", () => {
    const desktop = fixture();
    // No shebang: the script is Bash, as in the settings editor.
    desktop.writeProjectScript(
      `echo "project resume in $PWD"\n${opens("http://localhost:3000")}`,
    );

    expect(desktop.run().status).toBe(0);
    expect(desktop.opened()).toBe(`${desktop.repo}|http://localhost:3000\n`);
    expect(desktop.log()).toContain(`project resume in ${desktop.repo}`);
  });

  it("ignores the repository's .agents/desktop/resume", () => {
    for (const project of [true, false]) {
      const desktop = fixture();
      if (project) desktop.writeProjectScript(opens("http://project.test"));
      desktop.writeRepoScript(`#!/bin/sh\n${opens("http://repository.test")}`);

      expect(desktop.run().status).toBe(0);
      expect(desktop.opened()).toBe(
        project
          ? `${desktop.repo}|http://project.test\n`
          : `${desktop.root}/home|--foreground about:blank\n`,
      );
    }
  });

  it("ignores a project script that is a symlink", () => {
    const desktop = fixture();
    const target = join(desktop.root, "elsewhere");
    writeFileSync(target, opens("http://elsewhere.test"), { mode: 0o755 });
    mkdirSync(dirname(desktop.projectScript), { recursive: true });
    symlinkSync(target, desktop.projectScript);

    expect(desktop.run().status).toBe(0);
    expect(desktop.opened()).toBe(
      `${desktop.root}/home|--foreground about:blank\n`,
    );
  });

  it("logs a failing script and still opens the default browser", () => {
    const desktop = fixture();
    desktop.writeProjectScript('echo "dev server not ready" >&2\nexit 3\n');

    expect(desktop.run().status).toBe(0);
    expect(desktop.opened()).toBe(
      `${desktop.root}/home|--foreground about:blank\n`,
    );
    expect(desktop.log()).toContain("dev server not ready");
    expect(desktop.log()).toContain("exited with status 3");
  });
});
