import { describe, expect, it, vi } from "vitest";
import {
  cloudflareGuest,
  cloudflareSandbox,
  type OrbContainerClient,
} from "./driver.js";

const client = () =>
  ({
    exec: vi.fn(async () => ({
      stdout: "out",
      stderr: "err",
      exitCode: 2,
      timedOut: false,
    })),
    readFile: vi.fn(async () => new TextEncoder().encode("text")),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    })),
    readdir: vi.fn(async () => ["a"]),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  }) satisfies OrbContainerClient;

describe("Cloudflare Orb sandbox driver", () => {
  it("returns non-zero exits and rejects only a timeout, like E2B", async () => {
    const orb = client();
    const sandbox = cloudflareSandbox(orb, "/workspace");
    await expect(
      sandbox.exec("make", { env: { A: "b" }, timeoutMs: 5_000 }),
    ).resolves.toEqual({ stdout: "out", stderr: "err", exitCode: 2 });
    expect(orb.exec).toHaveBeenCalledWith("make", {
      cwd: "/workspace",
      env: { A: "b" },
      timeoutMs: 5_000,
    });
    orb.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 124,
      timedOut: true,
    });
    await expect(sandbox.exec("sleep 9", { timeoutMs: 1_000 })).rejects.toThrow(
      "Command timed out after 1000 ms.",
    );
  });

  it("maps files relative to the source directory", async () => {
    const orb = client();
    const sandbox = cloudflareSandbox(orb, "/workspace");
    await expect(sandbox.readFile("notes.md")).resolves.toBe("text");
    expect(orb.readFile).toHaveBeenCalledWith("/workspace/notes.md");
    await sandbox.writeFile("/tmp/a", "hello");
    expect(orb.writeFile).toHaveBeenCalledWith(
      "/tmp/a",
      new TextEncoder().encode("hello"),
    );
    await sandbox.rm("dir", { recursive: true });
    expect(orb.rm).toHaveBeenCalledWith("/workspace/dir", { recursive: true });
  });

  it("gives Core's pipeline a raw guest with E2B's command options", async () => {
    const orb = client();
    const guest = cloudflareGuest(orb);
    await guest.commands.run("git status", {
      cwd: "/workspace",
      envs: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 30_000,
    });
    expect(orb.exec).toHaveBeenCalledWith("git status", {
      cwd: "/workspace",
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 30_000,
    });
    await guest.files.write("/bin/x", new Uint8Array([1, 2]).buffer);
    expect(orb.writeFile).toHaveBeenCalledWith(
      "/bin/x",
      new Uint8Array([1, 2]),
    );
  });
});
