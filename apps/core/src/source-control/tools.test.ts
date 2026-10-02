import type { Sandbox } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  executeSourcePush as executePush,
  SourcePushHeadChanged,
  SourcePushRemoteHeadChanged,
  type SourceToolMutationInput,
} from "./tools.js";

const sha = (value: string) => value.repeat(40);
const sandbox = (exec: Sandbox["exec"]): Sandbox =>
  ({ cwd: "/home/user/workspace/repo", exec }) as Sandbox;

describe("executeSourcePush", () => {
  it("rejects a resumed workspace whose local HEAD changed before push", async () => {
    const execute = vi.fn();
    const performMutation = vi.fn();
    await expect(
      executePush(
        {
          threadId: "thread-117",
          sandbox: sandbox(async () => ({
            stdout: sha("b"),
            stderr: "",
            exitCode: 0,
          })),
          branch: "main",
          expectedHead: sha("a"),
        },
        { execute, performMutation, providerForThread: async () => "github" },
      ),
    ).rejects.toBeInstanceOf(SourcePushHeadChanged);
    expect(execute).not.toHaveBeenCalled();
    expect(performMutation).not.toHaveBeenCalled();
  });

  it("rejects a push when the live leased remote differs from fetched tracking", async () => {
    const execute = vi.fn(async () => ({
      stdout: `${sha("b")}\trefs/heads/main\n`,
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      executePush(
        {
          threadId: "thread-117",
          sandbox: sandbox(async (command) => ({
            stdout: command === "git rev-parse HEAD" ? sha("c") : "",
            stderr: "",
            exitCode: 0,
          })),
          branch: "main",
          expectedRemoteHead: sha("a"),
        },
        { execute, providerForThread: async () => "github" },
      ),
    ).rejects.toBeInstanceOf(SourcePushRemoteHeadChanged);
  });

  it("propagates an admitted caller abort signal through local and provider push commands", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_sandbox, command) => ({
      stdout: command.startsWith("git ls-remote")
        ? `${sha("a")}\trefs/heads/main\n`
        : "",
      stderr: "",
      exitCode: 0,
    }));
    const local = vi.fn(async (command: string) => ({
      stdout: command === "git rev-parse HEAD" ? sha("b") : "",
      stderr: "",
      exitCode: 0,
    }));
    const performMutation = async <A>(input: SourceToolMutationInput<A>) =>
      (await input.execute()).value;

    await executePush(
      {
        threadId: "thread-117",
        sandbox: sandbox(local),
        branch: "main",
        signal: controller.signal,
      },
      { execute, performMutation, providerForThread: async () => "github" },
    );

    expect(local).toHaveBeenCalledWith(
      "git rev-parse HEAD",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(local).toHaveBeenCalledWith(
      expect.stringContaining("git diff --name-only"),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("git ls-remote"),
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("git push --force-with-lease"),
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("preserves an aborted provider push for mutation reconciliation", async () => {
    const controller = new AbortController();
    const abort = new DOMException("The operation was aborted", "AbortError");
    const execute = vi.fn(async (_sandbox, command) => {
      if (command.startsWith("git ls-remote"))
        return {
          stdout: `${sha("a")}\trefs/heads/main\n`,
          stderr: "",
          exitCode: 0,
        };
      throw abort;
    });
    const local = sandbox(async (command) => ({
      stdout: command === "git rev-parse HEAD" ? sha("b") : "",
      stderr: "",
      exitCode: 0,
    }));
    const performMutation = async <A>(input: SourceToolMutationInput<A>) =>
      (await input.execute()).value;

    await expect(
      executePush(
        {
          threadId: "thread-117",
          sandbox: local,
          branch: "main",
          signal: controller.signal,
        },
        { execute, performMutation, providerForThread: async () => "github" },
      ),
    ).rejects.toBe(abort);
    expect(execute).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining("git push --force-with-lease"),
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("reuses one DX-owned idempotency key for an ambiguous shell-push retry", async () => {
    const keys: string[] = [];
    const execute = vi.fn(async () => ({
      stdout: `${sha("a")}\trefs/heads/main\n`,
      stderr: "",
      exitCode: 0,
    }));
    const local = sandbox(async (command) => ({
      stdout: command === "git rev-parse HEAD" ? sha("b") : "",
      stderr: "",
      exitCode: 0,
    }));
    const performMutation = async <A>(input: SourceToolMutationInput<A>) => {
      keys.push(input.idempotencyKey);
      return (await input.execute()).value;
    };
    for (let attempt = 0; attempt < 2; attempt += 1)
      await executePush(
        { threadId: "thread-117", sandbox: local, branch: "main" },
        { execute, performMutation, providerForThread: async () => "github" },
      );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^shell-push:[a-f0-9]{64}$/);
  });

  it("scopes DX-owned shell-push retries to one Thread", async () => {
    const keys: string[] = [];
    const execute = vi.fn(async () => ({
      stdout: `${sha("a")}\trefs/heads/main\n`,
      stderr: "",
      exitCode: 0,
    }));
    const local = sandbox(async (command) => ({
      stdout: command === "git rev-parse HEAD" ? sha("b") : "",
      stderr: "",
      exitCode: 0,
    }));
    const performMutation = async <A>(input: SourceToolMutationInput<A>) => {
      keys.push(input.idempotencyKey);
      return (await input.execute()).value;
    };
    for (const threadId of ["thread-117", "thread-118"])
      await executePush(
        { threadId, sandbox: local, branch: "main" },
        { execute, performMutation, providerForThread: async () => "github" },
      );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("proves workflow writes before acquiring a push mutation lease", async () => {
    const execute = vi.fn(async () => ({
      stdout: `${sha("a")}\trefs/heads/main\n`,
      stderr: "",
      exitCode: 0,
    }));
    const performMutation = vi.fn();
    await expect(
      executePush(
        {
          threadId: "thread-117",
          sandbox: sandbox(async (command) => ({
            stdout: command === "git rev-parse HEAD" ? sha("b") : "",
            stderr: "workflow inspection failed",
            exitCode: command === "git rev-parse HEAD" ? 0 : 1,
          })),
          branch: "main",
        },
        { execute, performMutation, providerForThread: async () => "github" },
      ),
    ).rejects.toThrow("Workflow permission proof failed");
    expect(performMutation).not.toHaveBeenCalled();
  });
});
