import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonGeneration,
  DXD_PROTOCOL_MAJOR,
  DXD_RELEASE,
} from "../dxd/protocol.js";
import {
  DXD_DEFAULT_BASH_PROFILE,
  DXD_DEFAULT_BASHRC,
  DXD_PROFILE_HOOK,
  DXD_SYSTEMD_UNIT,
  ensureDaemonInGuest,
} from "./daemon-installer.js";

const releaseBinary = new Uint8Array([1, 2, 3]);
const loadBinary = vi.fn(async () => releaseBinary);
const input = {
  threadId: Schema.decodeUnknownSync(ThreadId)(
    "thr_00000000-0000-4000-8000-000000000292",
  ),
  generation: Schema.decodeUnknownSync(DaemonGeneration)("generation_1"),
  apiKey: Redacted.make("dxd_do-not-observe-this-api-key-value"),
  endpoint: "https://daemon.example.test",
  sha256: "a".repeat(64),
  loadBinary,
};

const health = JSON.stringify({
  release: DXD_RELEASE,
  protocolMajor: DXD_PROTOCOL_MAJOR,
  generation: input.generation,
  connected: true,
});

const guest = (healthOutput = health) => ({
  files: {
    write: vi.fn(
      async (_path: string, _data: string | ArrayBuffer) => undefined,
    ),
  },
  commands: {
    run: vi.fn(async (command: string) => ({
      stdout: command.startsWith("curl ") ? healthOutput : "",
      stderr: "",
      exitCode: 0,
    })),
  },
});

describe("daemon guest installer", () => {
  beforeEach(() => {
    loadBinary.mockClear();
  });

  it.each([true, false])(
    "reuses the guest binary only on an exact checksum match (%s)",
    async (matches) => {
      const target = guest();
      target.commands.run.mockResolvedValueOnce({
        stdout: `${matches ? input.sha256 : "b".repeat(64)}  /usr/local/bin/dxd\n`,
        stderr: "",
        exitCode: 0,
      });
      await expect(ensureDaemonInGuest(target, input)).resolves.toEqual(
        JSON.parse(health),
      );
      expect(
        target.files.write.mock.calls.filter(([path]) =>
          path.includes(".binary-"),
        ),
      ).toHaveLength(matches ? 0 : 1);
      expect(loadBinary).toHaveBeenCalledTimes(matches ? 0 : 1);
      if (matches) {
        const install = target.commands.run.mock.calls[1]?.[0];
        expect(install).toContain(
          `'${input.sha256}' '/usr/local/bin/dxd' | sha256sum -c -`,
        );
        expect(install).not.toContain(".binary-");
      }
    },
  );

  it("removes the uploaded binary when shell checksum validation fails", async () => {
    const target = guest();
    await ensureDaemonInGuest(target, input);
    const binaryTemp = target.files.write.mock.calls.find(([path]) =>
      path.includes(".binary-"),
    )?.[0];
    const script = target.commands.run.mock.calls[1]?.[0];
    if (binaryTemp === undefined || script === undefined)
      throw new Error("Expected binary upload and installation script.");
    const directory = mkdtempSync(join(tmpdir(), "dxd-checksum-"));
    const binary = join(directory, "binary");
    try {
      writeFileSync(binary, releaseBinary);
      // Execute the real validation prefix, stopping before any privileged install.
      const validation = script.slice(
        script.indexOf("trap 'rm -f"),
        script.indexOf("\nif ! test -f /usr/local/bin/dxd"),
      );
      expect(validation).toContain("sha256sum -c -");
      const result = spawnSync(
        "sh",
        [
          "-c",
          `set -eu\nlockdir=${directory}/install.lock.d\n${validation.replaceAll(binaryTemp, binary)}`,
        ],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checksum did NOT match");
      expect(existsSync(binary)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not enter the installer after activation is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const target = guest();

    await expect(
      ensureDaemonInGuest(target, { ...input, signal: controller.signal }),
    ).rejects.toThrow("Daemon installation aborted.");
    expect(target.commands.run).toHaveBeenCalledTimes(1);
    expect(loadBinary).not.toHaveBeenCalled();
  });

  it("does not write guest files when loading a missing binary fails", async () => {
    const target = guest();
    const failure = new Error("release unavailable");

    await expect(
      ensureDaemonInGuest(target, {
        ...input,
        loadBinary: vi.fn(async () => Promise.reject(failure)),
      }),
    ).rejects.toBe(failure);

    expect(target.files.write).not.toHaveBeenCalled();
    expect(target.commands.run).toHaveBeenCalledTimes(1);
  });

  it("writes private config and static unit, then atomically installs and checks health", async () => {
    const target = guest();
    await expect(ensureDaemonInGuest(target, input)).resolves.toEqual(
      JSON.parse(health),
    );
    const writes = target.files.write.mock.calls;
    const config = writes.find(([path]) => String(path).includes(".config-"));
    const unit = writes.find(([path]) => String(path).includes(".unit-"));
    const profileHook = writes.find(([path]) =>
      String(path).includes(".profile-hook-"),
    );
    expect(String(config?.[1])).toContain(Redacted.value(input.apiKey));
    expect(String(unit?.[1])).toBe(DXD_SYSTEMD_UNIT);
    expect(String(profileHook?.[1])).toBe(DXD_PROFILE_HOOK);
    expect(DXD_SYSTEMD_UNIT).not.toMatch(
      /Environment|generation|apiKey|endpoint/,
    );
    expect(
      `${DXD_PROFILE_HOOK}${DXD_DEFAULT_BASH_PROFILE}${DXD_DEFAULT_BASHRC}`,
    ).not.toMatch(
      /thr_|generation|apiKey|endpoint|provider|callback|credential|dxd_/,
    );
    expect(DXD_PROFILE_HOOK).toContain("HISTFILESIZE=1000");
    expect(DXD_PROFILE_HOOK).toContain("history -w");
    const commands = target.commands.run.mock.calls.map(([command]) => command);
    expect(commands.join("\n")).not.toContain(Redacted.value(input.apiKey));
    expect(commands.join("\n")).toContain("chmod 0600");
    expect(commands.join("\n")).toContain("cmp -s");
    expect(commands.join("\n")).toContain("mv -f");
    expect(commands.join("\n")).toContain("0700");
    expect(commands.join("\n")).toContain(
      `! test -e /home/user/.bash_profile && ! test -L /home/user/.bash_profile`,
    );
    expect(commands.join("\n")).toContain(
      `! test -e /home/user/.bashrc && ! test -L /home/user/.bashrc`,
    );
    expect(commands.join("\n")).toContain(
      'if test "$binary_changed$config_changed$unit_changed$profile_changed" != 0000',
    );
  });

  it("accepts a daemon that is serving but has not registered yet", async () => {
    const target = guest(
      JSON.stringify({ ...JSON.parse(health), connected: false }),
    );

    await expect(ensureDaemonInGuest(target, input)).resolves.toEqual({
      ...JSON.parse(health),
      connected: false,
    });
    const probe = target.commands.run.mock.calls
      .map(([command]) => command)
      .find((command) => command.startsWith("curl "));
    expect(probe).not.toContain("--fail");
  });

  it("waits through a stale pre-restart health generation", async () => {
    const target = guest();
    let healthChecks = 0;
    target.commands.run.mockImplementation(async (command: string) => ({
      stdout: command.startsWith("curl ")
        ? ++healthChecks === 1
          ? JSON.stringify({ ...JSON.parse(health), generation: "previous" })
          : health
        : "",
      stderr: "",
      exitCode: 0,
    }));

    await expect(ensureDaemonInGuest(target, input)).resolves.toEqual(
      JSON.parse(health),
    );
    expect(healthChecks).toBe(2);
  });

  it("accepts an exact healthy generation after a transient install command failure", async () => {
    const target = guest();
    target.commands.run
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(new Error("systemd transient"));

    await expect(ensureDaemonInGuest(target, input)).resolves.toEqual(
      JSON.parse(health),
    );
  });

  it("rejects mismatched or non-strict health without exposing config", async () => {
    await expect(
      ensureDaemonInGuest(
        guest(JSON.stringify({ ...JSON.parse(health), generation: "other" })),
        input,
      ),
    ).rejects.toThrow("requested generation");
    await expect(
      ensureDaemonInGuest(
        guest(JSON.stringify({ ...JSON.parse(health), extra: true })),
        input,
      ),
    ).rejects.toThrow("invalid result");
  });
});
