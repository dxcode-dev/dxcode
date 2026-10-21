import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { Sandbox } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCodeProvider } from "./provider.js";
import { ClaudeCodeStream } from "./stream.js";

/**
 * Claude Code mode against a Thread workspace on this machine: guest paths
 * under /home/user map onto a temporary home, as in the local development
 * runtime, and the real launch script and runner run in bash. `claude` is a
 * fake that records how it was started and prints a scripted stream-json
 * run; `#wait <file>` lines hold it until the test creates that file.
 */

const GUEST_HOME = "/home/user";
const STATE = `${GUEST_HOME}/.local/state/dx-claude-code`;

interface GuestOp {
  readonly op: "read" | "write" | "exec";
  readonly path: string;
}

const guests: Array<{ root: string; home: string }> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const { root, home } of guests.splice(0)) {
    const runs = join(home, ".local/state/dx-claude-code/runs");
    for (const name of await readdir(runs).catch(() => [])) {
      const pid = Number(
        (
          await readFile(join(runs, name, "pid"), "utf8").catch(() => "")
        ).trim(),
      );
      if (pid > 0)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

const FAKE_CLAUDE = `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/claude-args"
prompt=""
while [ $# -gt 0 ]; do
  [ "$1" = --append-system-prompt-file ] && prompt="$2"
  shift
done
cat > "$HOME/claude-stdin.jsonl"
[ -n "$prompt" ] && cp "$prompt" "$HOME/claude-prompt.txt"
# Read whole before printing: the test writes the next run's script while
# this one may still be running.
mapfile -t script < "$HOME/claude-script.jsonl"
for line in "\${script[@]}"; do
  case "$line" in
    "#wait "*) while [ ! -e "$HOME/\${line#\\#wait }" ]; do sleep 0.05; done ;;
    *) printf '%s\\n' "$line" ;;
  esac
done
`;

const createGuest = async (options: { readonly claude?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "dx-claude-code-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  guests.push({ root, home });
  await mkdir(join(home, "workspace/repo"), { recursive: true });
  await mkdir(bin);
  const tool = (name: string, body: string) =>
    writeFile(join(bin, name), body, { mode: 0o755 });
  // The runner's mount namespace is for the local runtime only.
  await tool("unshare", "#!/bin/sh\nexit 1\n");
  // The machine's awk, whose version banner arrives in two writes, as it can
  // on a loaded machine: a check that stops reading at the first line has
  // closed the pipe before the second.
  await tool(
    "awk",
    `#!/bin/bash
if [ "$1" = -W ] && [ "$2" = version ]; then
  /usr/bin/awk -W version 2>&1 | head -n 1
  sleep 0.2
  /usr/bin/awk -W version 2>&1 | tail -n +2
  exit
fi
exec /usr/bin/awk "$@"
`,
  );
  // The installer it downloads fails.
  await tool(
    "curl",
    "#!/bin/sh\necho 'echo \"Installation failed: no space left on device\" >&2; exit 1'\n",
  );
  const installClaude = () => tool("claude", FAKE_CLAUDE);
  if (options.claude !== false) await installClaude();
  const base = await local({
    cwd: join(home, "workspace/repo"),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  }).createSandbox({ id: "guest" });
  const map = (value: string) => value.replaceAll(GUEST_HOME, home);
  const ops: GuestOp[] = [];
  /** Runs before each operation; a returned error fails it. */
  let before: (op: GuestOp) => Error | undefined = () => undefined;
  const track = async <A>(
    op: GuestOp["op"],
    path: string,
    run: () => Promise<A>,
  ) => {
    const entry = { op, path };
    ops.push(entry);
    const error = before(entry);
    if (error !== undefined) throw error;
    return run();
  };
  const sandbox: Sandbox = {
    cwd: `${GUEST_HOME}/workspace/repo`,
    resolvePath: (path) => path,
    exec: (command, execOptions) =>
      track("exec", command, () => base.exec(map(command), execOptions)),
    readFile: (path) => track("read", path, () => base.readFile(map(path))),
    readFileBuffer: (path) =>
      track("read", path, () => base.readFileBuffer(map(path))),
    readdir: (path) => track("read", path, () => base.readdir(map(path))),
    stat: (path) => track("read", path, () => base.stat(map(path))),
    exists: (path) => track("read", path, () => base.exists(map(path))),
    writeFile: (path, content) =>
      track("write", path, () => base.writeFile(map(path), content)),
    mkdir: (path, mkdirOptions) =>
      track("write", path, () => base.mkdir(map(path), mkdirOptions)),
    rm: (path, rmOptions) =>
      track("write", path, () => base.rm(map(path), rmOptions)),
  };
  return {
    sandbox,
    ops,
    installClaude,
    set before(hook: (op: GuestOp) => Error | undefined) {
      before = hook;
    },
    /** The fake CLI's next run. */
    script: (lines: ReadonlyArray<string>) =>
      writeFile(join(home, "claude-script.jsonl"), `${lines.join("\n")}\n`),
    release: (name: string) => writeFileSync(join(home, name), ""),
    file: (guestPath: string) =>
      existsSync(map(guestPath))
        ? readFileSync(map(guestPath), "utf8")
        : undefined,
    home: (name: string) => readFileSync(join(home, name), "utf8"),
  };
};

const line = (value: unknown) => JSON.stringify(value);
const event = (value: unknown) =>
  line({ type: "stream_event", event: value, parent_tool_use_id: null });
const init = (session = "session-1") =>
  line({ type: "system", subtype: "init", session_id: session });
const response = (
  id: string,
  blocks: ReadonlyArray<
    | { readonly text: string }
    | { readonly id: string; readonly name: string; readonly input: unknown }
  >,
) => [
  event({
    type: "message_start",
    message: { id, usage: { input_tokens: 3, output_tokens: 1 } },
  }),
  ...blocks.flatMap((block, index) =>
    "text" in block
      ? [
          event({
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
          event({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          }),
          event({ type: "content_block_stop", index }),
        ]
      : [
          event({
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name },
          }),
          event({
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          }),
          event({ type: "content_block_stop", index }),
        ],
  ),
  event({ type: "message_stop" }),
];
const toolResult = (id: string, text: string) =>
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    },
    parent_tool_use_id: null,
  });
const result = (text: string) =>
  line({ type: "result", subtype: "success", is_error: false, result: text });

/** A fresh provider module: what a Durable Object restart leaves. */
const restartedProvider = async () => {
  vi.resetModules();
  return (await import("./provider.js")).createClaudeCodeProvider;
};

const claudeCode = (
  create: typeof createClaudeCodeProvider,
  sandbox: Sandbox,
  threadId = `thr_claude_code_${crypto.randomUUID()}`,
) => {
  const credentials: string[] = [];
  const provider = create({
    invocation: (() => ({
      instanceId: threadId,
      scope: { kind: "prompt", submissionId: `sub-${threadId}` },
    })) as never,
    sandbox: async () => sandbox,
    credential: async (_thread, submissionId) => {
      credentials.push(submissionId);
      return { token: "plan-token", plan: { allowExtraUsage: false } };
    },
    recordUsage: async () => ({ allowExtraUsage: false }),
  });
  const model = provider.getModels()[0];
  if (model === undefined) throw new Error("Expected a Claude Code model.");
  return {
    threadId,
    credentials,
    model,
    /** One Flue model call; resolves with its final event. */
    answer: async (context: Context, signal?: AbortSignal) => {
      const events: AssistantMessageEvent[] = [];
      for await (const next of provider.streamSimple(
        model,
        normalizeContext(context),
        { ...(signal === undefined ? {} : { signal }) },
      ))
        events.push(next);
      const last = events.at(-1);
      if (last === undefined) throw new Error("Expected an event.");
      return last;
    },
  };
};

const user = (
  text: string,
  timestamp: number,
): Context["messages"][number] => ({
  role: "user",
  content: text,
  timestamp,
});

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "claude-code",
  provider: "claude-code",
  model: "claude-opus-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

const bashResult = (id: string): Context["messages"][number] => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: Date.now(),
});

const waitFor = async (ready: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const runDirectories = (ops: ReadonlyArray<GuestOp>) =>
  new Set(
    ops.flatMap(({ path }) => {
      const match = /dx-claude-code\/runs\/([^/'"\s]+)/.exec(path);
      return match?.[1] === undefined ? [] : [match[1]];
    }),
  );

// Real processes; a stop alone waits a second for SIGTERM.
describe("Claude Code mode in a workspace", { timeout: 30_000 }, () => {
  it("launches an attempt with one guest command and answers from its stream", async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [{ text: "Hello from Claude." }]),
      result("Hello from Claude."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const done = await claude.answer({
      systemPrompt: "Answer briefly.",
      messages: [user("Say hello", 1)],
    });
    expect(done).toMatchObject({
      type: "done",
      reason: "stop",
      message: { content: [{ type: "text", text: "Hello from Claude." }] },
    });
    // The CLI got the prompt, the input, and Claude Code's flags.
    expect(guest.home("claude-prompt.txt")).toBe("Answer briefly.");
    expect(JSON.parse(guest.home("claude-stdin.jsonl"))).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Say hello" }] },
    });
    expect(guest.home("claude-args")).toContain("bypassPermissions");
    // Before the first read of Claude's output: listing earlier attempts and
    // one launch command, which writes every file the run needs.
    const launch = guest.ops.findIndex(({ op }) => op === "exec");
    expect(guest.ops.slice(0, launch + 1).map(({ op }) => op)).toEqual([
      "read",
      "exec",
    ]);
  });

  it("launches with a prompt too large for one command line", async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [{ text: "Read it." }]),
      result("Read it."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const systemPrompt = `${"Long instructions. ".repeat(20_000)}End.`;
    const done = await claude.answer({
      systemPrompt,
      messages: [user("Read the instructions", 2)],
    });
    expect(done).toMatchObject({ type: "done", reason: "stop" });
    expect(guest.home("claude-prompt.txt")).toBe(systemPrompt);
    const launch = guest.ops.findIndex(({ op }) => op === "exec");
    expect(
      guest.ops.slice(0, launch + 1).filter(({ op }) => op !== "read"),
    ).toHaveLength(2);
  });

  it("reports a failed install, and the retry launches again instead of waiting on a run that never started", {
    timeout: 45_000,
  }, async () => {
    const guest = await createGuest({ claude: false });
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const context: Context = { messages: [user("Install and answer", 3)] };
    const failed = await claude.answer(context);
    expect(failed).toMatchObject({
      type: "error",
      error: {
        errorMessage: expect.stringMatching(
          /Claude Code could not be installed\.[\s\S]*no space left on device/,
        ),
      },
    });
    // The network is back: Flue's retry launches the next attempt.
    await guest.installClaude();
    await guest.script([
      init(),
      ...response("m1", [{ text: "Installed." }]),
      result("Installed."),
    ]);
    const started = Date.now();
    const retried = await claude.answer(context);
    expect(retried).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "Installed." }] },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a live run through failed heartbeat reads", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      "#wait finish",
      ...response("m1", [{ text: "Still here." }]),
      result("Still here."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    vi.useFakeTimers({ toFake: ["Date"] });
    let heartbeats = 0;
    guest.before = ({ op, path }) => {
      // Each idle check moves the clock past the next heartbeat check.
      if (op === "read" && path.endsWith("/exit"))
        vi.setSystemTime(Date.now() + 5_100);
      if (op === "read" && path.endsWith("/alive")) {
        heartbeats += 1;
        // Forty seconds of unreadable heartbeats, then the run finishes.
        if (heartbeats === 8) guest.release("finish");
        return new Error("The workspace did not answer.");
      }
      return undefined;
    };
    const done = await claude.answer({
      messages: [user("Take your time", 4)],
    });
    expect(done).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "Still here." }] },
    });
  });

  it("fails the turn after a minute of unreadable run status and stops the CLI", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([init(), "#wait never"]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    vi.useFakeTimers({ toFake: ["Date"] });
    guest.before = ({ op, path }) => {
      if (op === "read" && path.endsWith("/exit")) {
        vi.setSystemTime(Date.now() + 5_100);
        return new Error("The workspace did not answer.");
      }
      return undefined;
    };
    const failed = await claude.answer({
      messages: [user("Wait for me", 5)],
    });
    expect(failed).toMatchObject({
      type: "error",
      error: {
        errorMessage: expect.stringContaining("The workspace did not answer."),
      },
    });
    const [attempt] = runDirectories(guest.ops);
    const dir = `${STATE}/runs/${attempt}`;
    expect(guest.file(`${dir}/stopped`)).toBe("");
    const pid = Number(guest.file(`${dir}/pid`));
    await waitFor(() => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    // It failed after the minute, not at the first failed read.
    expect(
      guest.ops.filter(({ path }) => path.endsWith("/exit")).length,
    ).toBeGreaterThanOrEqual(12);
  });

  it("starts a follow-up without stopping or re-reading a turn that finished cleanly", async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [{ text: "One." }]),
      result("One."),
    ]);
    const first = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const turn = [user("First", 10)];
    expect(await first.answer({ messages: turn })).toMatchObject({
      type: "done",
    });
    const [earlier] = runDirectories(guest.ops);

    // The Durable Object restarted while the Orb was paused.
    await guest.script([
      init("session-2"),
      ...response("m2", [{ text: "Two." }]),
      result("Two."),
    ]);
    guest.ops.length = 0;
    const second = claudeCode(
      await restartedProvider(),
      guest.sandbox,
      first.threadId,
    );
    const done = await second.answer({
      messages: [
        ...turn,
        assistant([{ type: "text", text: "One." }], "stop"),
        user("Second", 11),
      ],
    });
    expect(done).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "Two." }] },
    });
    // Nothing of the first turn is read or stopped again.
    expect(
      guest.ops.filter(({ path }) => path.includes(`runs/${earlier}`)),
    ).toEqual([]);
    expect(guest.ops.filter(({ op }) => op === "exec")[0]?.path).toContain(
      "runner.sh",
    );
  });

  it("names an interrupted turn's unrecorded tool calls, reading from the chunk of its last recorded call", async () => {
    const guest = await createGuest();
    const call = (id: string, command: string) => ({
      id,
      name: "Bash",
      input: { command },
    });
    await guest.script([
      init(),
      // Longer than a chunk, so the later calls land in the next one.
      ...response("m1", [
        { text: "x".repeat(70_000) },
        call("toolu_a", "echo a"),
      ]),
      toolResult("toolu_a", "a"),
      ...response("m2", [call("toolu_b", "echo b")]),
      toolResult("toolu_b", "b"),
      ...response("m3", [call("toolu_c", "echo c")]),
      toolResult("toolu_c", "c"),
      "#wait never",
    ]);
    const first = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const turn = [user("Run three commands", 20)];
    expect(await first.answer({ messages: turn })).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
    const [earlier] = runDirectories(guest.ops);
    const chunk = (index: number) => `${STATE}/runs/${earlier}/c00000${index}`;
    await waitFor(() => guest.file(chunk(1))?.includes("toolu_c") === true);

    // Flue recorded two segments when new input interrupted the turn, and
    // the Durable Object restarted since.
    await guest.script([
      init("session-2"),
      ...response("m4", [{ text: "Next." }]),
      result("Next."),
    ]);
    guest.ops.length = 0;
    const second = claudeCode(
      await restartedProvider(),
      guest.sandbox,
      first.threadId,
    );
    const done = await second.answer({
      messages: [
        ...turn,
        assistant(
          [
            { type: "text", text: "x".repeat(70_000) },
            {
              type: "toolCall",
              id: "toolu_a",
              name: "bash",
              arguments: { command: "echo a" },
            },
          ],
          "toolUse",
        ),
        bashResult("toolu_a"),
        assistant(
          [
            {
              type: "toolCall",
              id: "toolu_b",
              name: "bash",
              arguments: { command: "echo b" },
            },
          ],
          "toolUse",
        ),
        bashResult("toolu_b"),
        user("Something else", 21),
      ],
    });
    expect(done).toMatchObject({
      type: "done",
      message: {
        content: [
          {
            type: "text",
            text: "Before this message, Claude Code also ran: Bash `echo c`.\n\n",
          },
          { type: "text", text: "Next." },
        ],
      },
    });
    expect(guest.ops.some(({ path }) => path === chunk(0))).toBe(false);
  });
});

describe("Claude Code stream", () => {
  const complete = (id: string, content: unknown[], stopReason: string) =>
    line({
      type: "assistant",
      message: { id, role: "assistant", content, stop_reason: stopReason },
      parent_tool_use_id: null,
    });

  it("closes a non-streamed response's segment at its tool call, so a dx tool's result can follow", () => {
    const stream = new ClaudeCodeStream();
    stream.push(init());
    // Claude Code sends a non-streamed response one content block per
    // message; the dx MCP server answers only after Flue runs the call.
    stream.push(
      complete("m1", [{ type: "text", text: "Looking." }], "tool_use"),
    );
    expect(stream.segments[0]?.stopReason).toBeUndefined();
    stream.push(
      complete(
        "m1",
        [
          {
            type: "tool_use",
            id: "toolu_dx",
            name: "mcp__dx__read_thread",
            input: { thread: "thr_1" },
          },
        ],
        "tool_use",
      ),
    );
    expect(stream.segments[0]).toMatchObject({
      stopReason: "toolUse",
      blocks: [
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "toolu_dx", name: "mcp__dx__read_thread" },
      ],
    });
    // Its result and the next response fill the next segment.
    stream.push(toolResult("toolu_dx", "thread text"));
    stream.push(complete("m2", [{ type: "text", text: "Done." }], "end_turn"));
    stream.push(result("Done."));
    expect(stream.segments).toHaveLength(2);
    expect(stream.segments[1]).toMatchObject({
      stopReason: "stop",
      blocks: [{ type: "text", text: "Done." }],
    });
    expect(stream.toolResults.get("toolu_dx")?.text).toBe("thread text");
  });
});
