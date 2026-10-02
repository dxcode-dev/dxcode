import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DXD_GUEST_BINARY_PATH,
  DXD_GUEST_CONFIG_PATH,
  DXD_PROFILE_STUB,
  DXD_SYSTEMD_UNIT,
  ensureDaemonInGuest,
} from "./daemon-installer.js";

const releaseBinary = new Uint8Array([1, 2, 3]);
const loadBinary = vi.fn(async () => releaseBinary);
const mintCredential = vi.fn(async () => ({
  id: "key_minted",
  key: Redacted.make("dxd_minted-key-value-do-not-observe"),
}));
const input = {
  threadId: Schema.decodeUnknownSync(ThreadId)(
    "thr_00000000-0000-4000-8000-000000000292",
  ),
  endpoint: "wss://daemon.example.test/v1/threads/thr_x/dxd",
  sha256: "a".repeat(64),
  releaseUrl: "https://releases.example.test/dxd-linux-x64",
  loadBinary,
  mintCredential,
};

type Inspection = {
  readonly binarySha?: string;
  readonly config?: boolean;
  /** The guest's daemon is current and configured: the probe nudges it. */
  readonly nudged?: boolean;
  /** What the install script reports. */
  readonly installed?: "installed" | "upgraded";
};

const guest = (inspection: Inspection, curlSucceeds = true) => {
  const target = {
    files: {
      write: vi.fn(
        async (_path: string, _data: string | ArrayBuffer) => undefined,
      ),
    },
    commands: {
      run: vi.fn(async (command: string) => {
        if (command.startsWith("install -d")) {
          return {
            stdout: inspection.nudged
              ? "nudged\n"
              : `${inspection.binarySha ?? "none"}\n${inspection.config ? "config" : "no-config"}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (command.startsWith("lockdir="))
          return {
            stdout: `${inspection.installed ?? "installed"}\n`,
            stderr: "",
            exitCode: 0,
          };
        if (command.startsWith("curl ")) {
          // Like the E2B SDK, a non-zero exit rejects instead of returning.
          if (!curlSucceeds)
            throw new Error("CommandExitError: exit status 22");
          return { stdout: "ok\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    },
  };
  return target;
};

const installScript = (target: ReturnType<typeof guest>) => {
  const script = target.commands.run.mock.calls
    .map(([command]) => command)
    .find((command) => command.startsWith("lockdir="));
  if (script === undefined) throw new Error("Expected an install script.");
  return script;
};

describe("daemon guest bootstrap", () => {
  beforeEach(() => {
    loadBinary.mockClear();
    mintCredential.mockClear();
  });

  it("downloads the pinned release in the guest and installs it user-owned", async () => {
    const target = guest({ config: true });
    await ensureDaemonInGuest(target, input);
    const curl = target.commands.run.mock.calls.find(([command]) =>
      command.startsWith("curl "),
    )?.[0];
    expect(curl).toContain(input.releaseUrl);
    expect(curl).toContain(`'${input.sha256}'`);
    expect(loadBinary).not.toHaveBeenCalled();
    const script = installScript(target);
    expect(script).toContain(`mv -f`);
    expect(script).toContain(DXD_GUEST_BINARY_PATH);
    expect(script).not.toContain("sudo install -o root -g root -m 0755");
    expect(script).toContain("systemctl restart dxd.service");
    expect(script).not.toContain("curl --unix-socket");
    expect(DXD_SYSTEMD_UNIT).toContain(`ExecStart=${DXD_GUEST_BINARY_PATH}`);
  });

  it("only nudges a current, configured daemon: one guest command", async () => {
    const target = guest({ nudged: true });
    await expect(ensureDaemonInGuest(target, input)).resolves.toBe("nudged");
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    expect(target.files.write).not.toHaveBeenCalled();
    const [probe] = target.commands.run.mock.calls[0] as [string];
    // A current protocol, configuration, unit, and login hook are required,
    // and the release is left to the daemon's own update.
    expect(probe).toContain('test "$protocol" = 2');
    // Even a nudge removes an upgrade notice an earlier installer left.
    expect(probe).toContain("sudo rm -f /etc/profile.d/dx-terminal-notice.sh");
    expect(probe).toContain(
      "rm -f /home/user/.local/state/dxd/terminal-notice",
    );
    // Only the daemon started from the current binary path is nudged; the
    // guest user has no systemd bus, so systemctl always goes through sudo.
    expect(probe).toContain(`test "$running" = ${DXD_GUEST_BINARY_PATH}`);
    expect(probe).toContain("sudo systemctl show dxd.service -p MainPID");
    expect(probe).toContain("sudo systemctl kill --signal=SIGHUP");
    expect(probe).not.toContain(input.sha256);
    // The login hook is the static stub, never a release's own hook.
    expect(probe).toContain(
      `sha256sum /etc/profile.d/dx-terminal.sh 2>/dev/null | cut -d' ' -f1)" = ${createHash("sha256").update(DXD_PROFILE_STUB).digest("hex")}`,
    );
    expect(mintCredential).not.toHaveBeenCalled();
  });

  it("never nudges when a new credential must reach the configuration", async () => {
    const target = guest({ binarySha: input.sha256, config: true });
    await ensureDaemonInGuest(target, {
      ...input,
      credential: { id: "key_new", key: Redacted.make("dxd_new-key-value") },
    });
    const [probe] = target.commands.run.mock.calls[0] as [string];
    expect(probe).not.toContain("echo nudged");
  });

  it("replaces a running pre-protocol-2 daemon once, without a Terminal notice", async () => {
    const target = guest({ config: false, installed: "upgraded" });
    await expect(ensureDaemonInGuest(target, input)).resolves.toBe("upgraded");
    const script = installScript(target);
    // The protocol is read before the new binary lands; only an old one
    // forces the restart.
    expect(script.indexOf('case "$running" in')).toBeLessThan(
      script.indexOf(`mv -f`),
    );
    expect(script).toContain(
      `case "$running" in ""|${DXD_GUEST_BINARY_PATH}*) ;; *) restart=1 ;; esac`,
    );
    expect(script).toMatch(
      /elif test "\$restart" = 1; then\n {2}sudo systemctl restart dxd.service; echo upgraded/,
    );
    for (const [command] of target.commands.run.mock.calls.slice(1))
      expect(command).not.toContain("notice");
    expect(
      target.files.write.mock.calls.some(([path]) => path.includes("notice")),
    ).toBe(false);
  });

  it("falls back to a Worker upload when the guest cannot fetch the release", async () => {
    const target = guest({ config: true }, false);
    await ensureDaemonInGuest(target, input);
    expect(loadBinary).toHaveBeenCalledTimes(1);
    expect(
      target.files.write.mock.calls.filter(([path]) =>
        path.includes(".binary-"),
      ),
    ).toHaveLength(1);
  });

  it("keeps a current binary and never re-downloads it", async () => {
    const target = guest({ binarySha: input.sha256, config: true });
    await ensureDaemonInGuest(target, input);
    expect(
      target.commands.run.mock.calls.some(([command]) =>
        command.startsWith("curl "),
      ),
    ).toBe(false);
    expect(loadBinary).not.toHaveBeenCalled();
    const script = installScript(target);
    expect(script).not.toContain(".binary-");
    // Nothing forces a restart: the running daemon reloads on SIGHUP and the
    // Terminal shell it owns survives the repair.
    expect(script).not.toContain("restart=1\n");
    // Unprivileged systemctl cannot reach the bus in the guest and would
    // always report inactive, forcing a restart; liveness comes from sudo.
    expect(script).toContain("sudo systemctl show dxd.service -p MainPID");
    expect(script).not.toMatch(/(^|[^o] )systemctl /m);
    expect(script).toContain(
      "sudo systemctl kill --signal=SIGHUP --kill-whom=main dxd.service",
    );
  });

  it("never restarts a current-protocol daemon for a new binary", async () => {
    const target = guest({ config: true });
    await expect(ensureDaemonInGuest(target, input)).resolves.toBe("installed");
    const script = installScript(target);
    expect(script).toMatch(/mv -f \S+ \S+\/bin\/dxd\n/);
    expect(script).not.toMatch(/restart=1\n/);
    expect(script).not.toContain("systemctl is-active");
  });

  it("writes a static version-2 configuration only when a key is provided or missing", async () => {
    const fresh = guest({ binarySha: input.sha256, config: false });
    await ensureDaemonInGuest(fresh, input);
    expect(mintCredential).toHaveBeenCalledTimes(1);
    const written = fresh.files.write.mock.calls.find(([path]) =>
      path.includes(".config-"),
    );
    if (written === undefined) throw new Error("Expected a configuration.");
    const configuration = JSON.parse(written[1] as string);
    expect(configuration).toEqual({
      version: 2,
      endpoint: input.endpoint,
      threadId: input.threadId,
      apiKey: "dxd_minted-key-value-do-not-observe",
      workspaceRoot: "/home/user/workspace/repo",
    });
    expect(installScript(fresh)).toContain(DXD_GUEST_CONFIG_PATH);

    mintCredential.mockClear();
    const configured = guest({ binarySha: input.sha256, config: true });
    await ensureDaemonInGuest(configured, input);
    expect(mintCredential).not.toHaveBeenCalled();
    expect(
      configured.files.write.mock.calls.some(([path]) =>
        path.includes(".config-"),
      ),
    ).toBe(false);

    const provided = guest({ binarySha: input.sha256, config: true });
    await ensureDaemonInGuest(provided, {
      ...input,
      credential: {
        id: "key_activation",
        key: Redacted.make("dxd_activation-key-value"),
      },
    });
    expect(mintCredential).not.toHaveBeenCalled();
    const replaced = provided.files.write.mock.calls.find(([path]) =>
      path.includes(".config-"),
    );
    expect(JSON.parse(replaced?.[1] as string).apiKey).toBe(
      "dxd_activation-key-value",
    );
  });

  // Runs the real install script under bash with the guest's absolute paths
  // moved into a temporary root and only systemd and /proc stubbed.
  it.each([
    ["a current daemon", DXD_GUEST_BINARY_PATH, "kill --signal=SIGHUP"],
    [
      "a current daemon whose file was replaced",
      `${DXD_GUEST_BINARY_PATH} (deleted)`,
      "kill --signal=SIGHUP",
    ],
    ["a pre-protocol-2 daemon", "/usr/local/bin/dxd (deleted)", "restart"],
    ["a stopped daemon", "", "start"],
  ])(
    "the install script only signals %s (%s)",
    async (_name, exe, expected) => {
      const target = guest({ binarySha: input.sha256, config: false });
      await ensureDaemonInGuest(target, input);
      const root = mkdtempSync(join(tmpdir(), "dxd-guest-"));
      const stubs = join(root, "stubs");
      mkdirSync(stubs);
      const stub = (name: string, body: string) =>
        writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`, {
          mode: 0o755,
        });
      stub(
        "sudo",
        'export DX_TEST_SUDO=1\nif [ "$1" = install ]; then shift 5; exec install "$@"; fi\nexec "$@"',
      );
      stub(
        "systemctl",
        // Like the guest: the unprivileged user has no systemd bus.
        `[ -n "$DX_TEST_SUDO" ] || { echo "Failed to connect to bus" >&2; exit 1; }\necho "$*" >>"${root}/systemctl.log"\nif [ "$1" = show ]; then echo ${exe === "" ? 0 : 4242}; fi`,
      );
      stub(
        "readlink",
        `case "$1" in /proc/*/exe) [ -n "${exe}" ] && echo "${exe.replace("/home/user", `${root}/home/user`)}" ;; *) exec /usr/bin/readlink "$@" ;; esac`,
      );
      const relocate = (command: string) =>
        command
          .replaceAll("/home/user", `${root}/home/user`)
          .replaceAll("/etc/", `${root}/etc/`)
          .replaceAll("/usr/local/bin/dxd", `${root}/usr/local/bin/dxd`);
      for (const directory of [
        "home/user/.local/state/dxd/bin",
        "etc/systemd/system",
        "etc/profile.d",
        "usr/local/bin",
      ])
        mkdirSync(join(root, directory), { recursive: true });
      // A guest installed before the stub holds a release's whole hook.
      writeFileSync(
        join(root, "etc/profile.d/dx-terminal.sh"),
        "# dxd-profile-v3\nexport HOME=/home/user\n",
      );
      // An earlier installer left an upgrade notice for the next shell.
      const legacyNoticeHook = join(
        root,
        "etc/profile.d/dx-terminal-notice.sh",
      );
      const legacyNotice = join(
        root,
        "home/user/.local/state/dxd/terminal-notice",
      );
      writeFileSync(legacyNoticeHook, "# notice hook\n");
      writeFileSync(legacyNotice, "dx: upgraded\n");
      const [inspection] = target.commands.run.mock.calls[0] as [string];
      const inspected = spawnSync("bash", ["-c", relocate(inspection)], {
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(existsSync(legacyNoticeHook)).toBe(false);
      expect(existsSync(legacyNotice)).toBe(false);
      for (const [path, data] of target.files.write.mock.calls)
        writeFileSync(relocate(path), Buffer.from(data as string));
      const install = spawnSync(
        "bash",
        ["-c", relocate(installScript(target))],
        {
          env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      expect(install.status, install.stderr).toBe(0);
      const calls = readFileSync(join(root, "systemctl.log"), "utf8");
      const action = calls
        .split("\n")
        .find((line) => /^(kill|restart|start) /.test(line));
      expect(action?.startsWith(expected)).toBe(true);
      expect(existsSync(legacyNotice)).toBe(false);
      expect(install.stdout.trim()).toBe(
        expected === "restart" ? "upgraded" : "installed",
      );
      expect(
        readFileSync(join(root, "etc/profile.d/dx-terminal.sh"), "utf8"),
      ).toBe(DXD_PROFILE_STUB);
    },
  );

  it("emits syntactically valid shell for every path", async () => {
    for (const inspection of [
      { nudged: true },
      { config: false, installed: "upgraded" as const },
      { binarySha: input.sha256, config: true },
    ]) {
      const target = guest(inspection);
      await ensureDaemonInGuest(target, input);
      for (const [command] of target.commands.run.mock.calls) {
        const checked = spawnSync("bash", ["-n"], { input: command });
        expect(checked.status, String(checked.stderr)).toBe(0);
      }
    }
  });

  it("never places the key or endpoint in a shell command", async () => {
    const target = guest({ config: false });
    await ensureDaemonInGuest(target, input);
    for (const [command] of target.commands.run.mock.calls) {
      expect(command).not.toContain("dxd_minted-key-value-do-not-observe");
      expect(command).not.toContain(input.endpoint);
    }
  });

  it("does not enter the installer after activation is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const target = guest({ config: true });
    await expect(
      ensureDaemonInGuest(target, { ...input, signal: controller.signal }),
    ).rejects.toThrow("Daemon installation aborted.");
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    expect(loadBinary).not.toHaveBeenCalled();
  });

  it("fails when the install script fails", async () => {
    const target = guest({ binarySha: input.sha256, config: true });
    target.commands.run.mockImplementation(async (command: string) => {
      if (command.startsWith("install -d"))
        return { stdout: `${input.sha256}\nconfig\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    await expect(ensureDaemonInGuest(target, input)).rejects.toThrow(
      "Daemon installation failed.",
    );
  });
});
