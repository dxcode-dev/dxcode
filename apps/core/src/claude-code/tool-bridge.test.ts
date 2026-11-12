import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_TOOL_BRIDGE } from "./tool-bridge.js";

/**
 * The real dx tool bridge under python3, with this test as Claude Code: it
 * reads what the bridge sends Claude on fd 4, writes Claude's output to the
 * bridge's stdin, and reads what the bridge passes on to dx on stdout.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const lines = (stream: Readable) => {
  const seen: Array<Record<string, unknown>> = [];
  let buffered = "";
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts)
      if (part.trim() !== "") seen.push(JSON.parse(part));
  });
  return seen;
};

const until = async <A>(read: () => A | undefined, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const startBridge = async (options: { readonly gate: boolean }) => {
  const root = await mkdtemp(join(tmpdir(), "dx-bridge-"));
  roots.push(root);
  const run = join(root, "runs/attempt");
  const mcp = join(root, "mcp");
  await mkdir(run, { recursive: true });
  await mkdir(join(mcp, "hooks"), { recursive: true });
  await writeFile(join(run, "dx-bridge.py"), CLAUDE_CODE_TOOL_BRIDGE);
  await writeFile(
    join(run, "dx-tools.json"),
    JSON.stringify([
      { name: "create_thread", description: "dx tool", inputSchema: {} },
    ]),
  );
  if (options.gate) await writeFile(join(run, "dx-hooks.json"), "{}");
  await writeFile(
    join(run, "input.jsonl"),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`,
  );
  const child = spawn(
    "python3",
    [
      "-I",
      join(run, "dx-bridge.py"),
      join(run, "dx-tools.json"),
      mcp,
      join(run, "input.jsonl"),
    ],
    { stdio: ["pipe", "pipe", "inherit", "ignore", "pipe"] },
  );
  const toClaude = lines(child.stdio[4] as Readable);
  const toDx = lines(child.stdout as Readable);
  const claudeSays = (message: unknown) =>
    (child.stdin as Writable).write(`${JSON.stringify(message)}\n`);
  return { child, toClaude, toDx, claudeSays, mcp };
};

const hookRequest = (id: string, toolName: string, input: unknown) => ({
  type: "control_request",
  request_id: `req-${id}`,
  request: {
    subtype: "hook_callback",
    callback_id: "dx-pre-tool-use",
    tool_use_id: id,
    input: {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: input,
      tool_use_id: id,
    },
  },
});

const answerTo = (
  messages: ReadonlyArray<Record<string, unknown>>,
  requestId: string,
) =>
  messages.find(
    (message) =>
      message.type === "control_response" &&
      (message.response as { request_id?: string }).request_id === requestId,
  );

describe("the dx tool bridge's PreToolUse hook", () => {
  it("registers the hook, hands each call to dx, and answers with dx's decision", async () => {
    const bridge = await startBridge({ gate: true });
    try {
      const initialize = await until(() => bridge.toClaude[0]);
      expect(initialize).toMatchObject({
        type: "control_request",
        request: {
          subtype: "initialize",
          sdkMcpServers: ["dx"],
          hooks: {
            PreToolUse: [
              {
                hookCallbackIds: ["dx-pre-tool-use"],
                timeout: 1_890,
                onFailure: "block",
              },
            ],
          },
        },
      });
      bridge.claudeSays({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "dx-initialize",
          response: { hook_on_failure_supported: true, hooks_applied: true },
        },
      });
      await until(() =>
        bridge.toClaude.find((message) => message.type === "user"),
      );

      // Denied: dx reads the request, decides, and Claude gets the reason.
      bridge.claudeSays(
        hookRequest("toolu_force", "Bash", { command: "git push --force" }),
      );
      expect(
        await until(() =>
          bridge.toDx.find((message) => message.type === "dx_hook"),
        ),
      ).toEqual({
        type: "dx_hook",
        tool_use_id: "toolu_force",
        tool_name: "Bash",
        tool_input: { command: "git push --force" },
      });
      await writeFile(
        join(bridge.mcp, "hooks/toolu_force.json"),
        JSON.stringify({
          decision: "deny",
          reason: "Force pushes are blocked.",
        }),
      );
      expect(
        await until(() => answerTo(bridge.toClaude, "req-toolu_force")),
      ).toMatchObject({
        response: {
          subtype: "success",
          response: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Force pushes are blocked.",
            },
          },
        },
      });

      // Allowed with a modified input.
      bridge.claudeSays(hookRequest("toolu_ls", "Bash", { command: "ls" }));
      await until(() =>
        bridge.toDx.find((message) => message.tool_use_id === "toolu_ls"),
      );
      await writeFile(
        join(bridge.mcp, "hooks/toolu_ls.json"),
        JSON.stringify({ decision: "allow", input: { command: "ls -1" } }),
      );
      expect(
        await until(() => answerTo(bridge.toClaude, "req-toolu_ls")),
      ).toMatchObject({
        response: {
          response: {
            hookSpecificOutput: {
              permissionDecision: "allow",
              updatedInput: { command: "ls -1" },
            },
          },
        },
      });

      // dx's own tools pass dx's gate inside dx, so the hook allows them
      // at once and prints nothing for dx.
      bridge.claudeSays(hookRequest("toolu_dx", "create_thread", {}));
      expect(
        await until(() => answerTo(bridge.toClaude, "req-toolu_dx")),
      ).toMatchObject({ response: { response: {} } });
      expect(
        bridge.toDx.some((message) => message.tool_use_id === "toolu_dx"),
      ).toBe(false);

      // A request without an id is denied, never allowed.
      bridge.claudeSays({
        ...hookRequest("x", "Bash", {}),
        request_id: "req-bad",
        request: {
          subtype: "hook_callback",
          callback_id: "dx-pre-tool-use",
          input: { tool_name: "Bash", tool_input: {} },
        },
      });
      expect(
        await until(() => answerTo(bridge.toClaude, "req-bad")),
      ).toMatchObject({
        response: {
          response: { hookSpecificOutput: { permissionDecision: "deny" } },
        },
      });
    } finally {
      bridge.child.kill();
    }
  });

  it("ends the run before Claude does anything when Claude Code cannot block on a failed hook", async () => {
    const bridge = await startBridge({ gate: true });
    try {
      await until(() => bridge.toClaude[0]);
      // A Claude Code that predates onFailure says nothing about it.
      bridge.claudeSays({
        type: "control_response",
        response: { subtype: "success", request_id: "dx-initialize" },
      });
      expect(
        await until(() =>
          bridge.toDx.find((message) => message.type === "result"),
        ),
      ).toMatchObject({ type: "result", is_error: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bridge.toClaude.some((message) => message.type === "user")).toBe(
        false,
      );
    } finally {
      bridge.child.kill();
    }
  });

  it("registers no hook when no installed plugin gates tool calls", async () => {
    const bridge = await startBridge({ gate: false });
    try {
      const initialize = await until(() => bridge.toClaude[0]);
      expect(initialize).toMatchObject({
        request: { subtype: "initialize", sdkMcpServers: ["dx"] },
      });
      expect(
        (initialize.request as Record<string, unknown>).hooks,
      ).toBeUndefined();
    } finally {
      bridge.child.kill();
    }
  });
});
