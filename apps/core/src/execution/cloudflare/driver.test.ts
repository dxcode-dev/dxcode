import { describe, expect, it, vi } from "vitest";
import { cloudflareSandbox, type OrbContainerClient } from "./driver.js";

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
});
