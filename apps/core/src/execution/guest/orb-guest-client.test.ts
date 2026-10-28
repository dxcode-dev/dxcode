import { describe, expect, it, vi } from "vitest";
import { classifyRunFailure } from "../../runtime/run-failure.js";
import { type OrbGuestClient, orbGuestSandbox } from "./orb-guest-client.js";

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
  }) satisfies OrbGuestClient;

describe("Orb guest sandbox driver", () => {
  it("returns non-zero exits and rejects only a timeout, like E2B", async () => {
    const orb = client();
    const sandbox = orbGuestSandbox(orb, "/workspace");
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

  it("fails a workspace context read as a retryable platform failure with its reason", async () => {
    const orb = client();
    orb.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "node: cannot open /workspace: Input/output error",
      exitCode: 1,
      timedOut: false,
    });
    const sandbox = orbGuestSandbox(orb, "/workspace");
    const failed = await sandbox.snapshotWorkspaceContext!("/workspace").then(
      () => undefined,
      (error: Error) => classifyRunFailure({ message: error.message }),
    );
    expect(failed).toMatchObject({
      class: "platform",
      code: "WORKSPACE_CONTEXT_UNAVAILABLE",
      retryable: true,
    });
    expect(failed?.message).toContain("exit 1");
    expect(failed?.message).toContain("Input/output error");

    orb.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 124,
      timedOut: true,
    });
    await expect(
      sandbox.snapshotWorkspaceContext!("/workspace").then(
        () => undefined,
        (error: Error) => classifyRunFailure({ message: error.message }),
      ),
    ).resolves.toMatchObject({
      class: "platform",
      code: "WORKSPACE_CONTEXT_UNAVAILABLE",
      retryable: true,
    });
  });
});
