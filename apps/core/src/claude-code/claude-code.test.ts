import { spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import {
  configReferenceFor,
  EnvironmentVariableId,
  EnvironmentVariableName,
} from "@dx/domain";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { Sandbox } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { Redacted, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { classifyRunFailure } from "../runtime/run-failure.js";
import type { ExecutionEnvironmentSnapshot } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import * as claudeCodeProvider from "./provider.js";
import { createClaudeCodeProvider } from "./provider.js";
import { claudeCodeSandbox } from "./runs.js";
import { ClaudeCodeStream } from "./stream.js";
import { claudeCodeMirrorTools } from "./tools.js";
import { claudeCodeAnswer } from "./workspace-run.js";

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
if [ "$1" = --version ]; then echo "2.1.310 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > "$HOME/claude-args"
# The plan token as Claude Code reads it: from CLAUDE_CODE_OAUTH_TOKEN, or
# once from the descriptor CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR names.
if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR-}" ]; then
  token=$(cat "/proc/self/fd/$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
else
  token="\${CLAUDE_CODE_OAUTH_TOKEN-}"
fi
printf '%s' "$token" > "$HOME/claude-token"
# Every process this user can read, the runner, its heartbeat, the chunk
# writer, and this CLI among them, whose environment or command line holds
# the token: what any command Claude runs could read.
: > "$HOME/claude-token-readers"
if [ -n "$token" ]; then
  for p in /proc/[0-9]*; do
    for f in environ cmdline; do
      if grep -qaF -- "$token" "$p/$f" 2>/dev/null; then
        printf '%s %s: %s\\n' "\${p#/proc/}" "$f" "$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-100)" >> "$HOME/claude-token-readers"
      fi
    done
  done
fi
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

/**
 * A Claude Code release older than dx can run: it fails on a flag dx passes,
 * as a real one does, before it reads any token.
 */
const OLD_CLAUDE = (version: string) => `#!/bin/bash
if [ "$1" = --version ]; then echo "${version} (Claude Code)"; exit 0; fi
: > "$HOME/old-claude-ran"
echo "error: unknown option '--effort'" >&2
exit 1
`;

const createGuest = async (
  options: {
    readonly claude?: boolean;
    /** A Claude Code of this version instead of the current one. */
    readonly oldClaude?: string;
    /** The downloaded installer installs the current Claude Code. */
    readonly installerWorks?: boolean;
  } = {},
) => {
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
  // The installer it downloads fails, or installs the current Claude Code
  // at ~/.local/bin/claude.
  await writeFile(join(root, "claude-latest"), FAKE_CLAUDE, { mode: 0o755 });
  await tool(
    "curl",
    options.installerWorks === true
      ? `#!/bin/sh\necho 'mkdir -p "$HOME/.local/bin" && cp ${join(root, "claude-latest")} "$HOME/.local/bin/claude"'\n`
      : "#!/bin/sh\necho 'echo \"Installation failed: checksum mismatch\" >&2; exit 1'\n",
  );
  // dx runs Claude Code from where its installer puts it, never from PATH.
  const claudeAt = (body: string) =>
    mkdir(join(home, ".local/bin"), { recursive: true }).then(() =>
      writeFile(join(home, ".local/bin/claude"), body, { mode: 0o755 }),
    );
  const installClaude = () => claudeAt(FAKE_CLAUDE);
  if (options.oldClaude !== undefined)
    await claudeAt(OLD_CLAUDE(options.oldClaude));
  else if (options.claude !== false) await installClaude();
  const base = await local({
    cwd: join(home, "workspace/repo"),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  }).createSandbox({ id: "guest" });
  const map = (value: string) => value.replaceAll(GUEST_HOME, home);
  const ops: GuestOp[] = [];
  /**
   * What each command carried to the provider: a provider runs it under
   * \`bash -l\`, whose profile sees its text and environment.
   */
  const commands: Array<{
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
  }> = [];
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
    exec: (command, execOptions) => {
      commands.push({ command, env: execOptions?.env ?? {} });
      return track("exec", command, () => base.exec(map(command), execOptions));
    },
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
  /** Files under the guest's home, other than the fake CLI's, that hold it. */
  const filesHolding = async (value: string) => {
    const found: string[] = [];
    for (const name of await readdir(home, { recursive: true })) {
      if (name === "claude-token") continue;
      const contents = await readFile(join(home, name), "latin1").catch(
        () => undefined,
      );
      if (contents?.includes(value) === true) found.push(name);
    }
    return found;
  };
  return {
    sandbox,
    ops,
    commands,
    filesHolding,
    installClaude,
    /** Put a command on the guest's PATH ahead of the machine's. */
    tool,
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
    write: (guestPath: string, content: string) =>
      writeFileSync(map(guestPath), content),
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
  /** The workspace for each model call; `sandbox` when omitted. */
  workspace?: (threadId: string) => Promise<Sandbox>,
) => {
  const credentials: string[] = [];
  // Unique, so a scan for it finds only this run's processes.
  const token = `plan-token-${crypto.randomUUID()}`;
  const provider = create({
    invocation: (() => ({
      instanceId: threadId,
      scope: { kind: "prompt", submissionId: `sub-${threadId}` },
    })) as never,
    sandbox: workspace ?? (async () => sandbox),
    credential: async (_thread, submissionId) => {
      credentials.push(submissionId);
      return { token, plan: { allowExtraUsage: false } };
    },
    recordUsage: async () => ({ allowExtraUsage: false }),
  });
  const model = provider.getModels()[0];
  if (model === undefined) throw new Error("Expected a Claude Code model.");
  /** One Flue model call; resolves with every event it streamed. */
  const events = async (context: Context, signal?: AbortSignal) => {
    const streamed: AssistantMessageEvent[] = [];
    for await (const next of provider.streamSimple(
      model,
      normalizeContext(context),
      { ...(signal === undefined ? {} : { signal }) },
    ))
      streamed.push(next);
    return streamed;
  };
  return {
    threadId,
    credentials,
    token,
    model,
    events,
    /** One Flue model call; resolves with its final event. */
    answer: async (context: Context, signal?: AbortSignal) => {
      const last = (await events(context, signal)).at(-1);
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
      // A launch's disk guard names the runs directory with a glob.
      const match = /dx-claude-code\/runs\/([^/'"\s*]+)/.exec(path);
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

  it("gives Claude Code dx's own prompt, not Flue's composition, and the person's instructions as its user-level CLAUDE.md", async () => {
    const guest = await createGuest();
    guest.write(
      `${GUEST_HOME}/workspace/repo/AGENTS.md`,
      "Run the tests before committing.\n",
    );
    // What Flue composes around the agent's prompt for its own loop.
    const flue = [
      "dx's Claude Code prompt.",
      "Run the tests before committing.",
      "## Available Agents\n\nNone. No subagents are currently declared, so the `task` tool has no valid `agent` value.",
      "Date: Sat, Oct 24, 2026\nWorking directory: /home/user/workspace/repo",
    ].join("\n\n");
    const userInstructions = `${GUEST_HOME}/.claude/CLAUDE.md`;
    const turn = async (
      text: string,
      timestamp: number,
      personalInstructions: string,
    ) => {
      await guest.script([
        init(),
        ...response(`m${timestamp}`, [{ text: "Hi." }]),
        result("Hi."),
      ]);
      const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
      claudeCodeProvider.rememberClaudeCodePrompt(
        claude.threadId,
        "dx's Claude Code prompt.",
        personalInstructions,
      );
      await claude.answer({
        systemPrompt: flue,
        messages: [user(text, timestamp)],
      });
    };
    await turn("Hi", 80, "Reply in French.");
    // Claude Code reads the repository's AGENTS.md itself.
    expect(guest.home("claude-prompt.txt")).toBe("dx's Claude Code prompt.");
    expect(await guest.sandbox.readFile(userInstructions)).toBe(
      "Reply in French.",
    );
    // Instructions cleared in Settings leave no stale file behind.
    await turn("Hi again", 81, "");
    expect(await guest.sandbox.exists(userInstructions)).toBe(false);
  });

  it("hands the plan token to the CLI alone, never to a process environment, a command, or a file left behind", async () => {
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
    expect(done).toMatchObject({ type: "done", reason: "stop" });
    expect(guest.home("claude-token")).toBe(claude.token);
    expect(guest.home("claude-token-readers")).toBe("");
    expect(guest.commands.length).toBeGreaterThan(0);
    expect(
      guest.commands.filter(
        ({ command, env }) =>
          command.includes(claude.token) ||
          Object.values(env).some((value) => value.includes(claude.token)),
      ),
    ).toEqual([]);
    expect(await guest.filesHolding(claude.token)).toEqual([]);
  });

  it("answers a title on the plan token without giving it to a command or leaving it in a file", async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [{ text: "Greeting" }]),
      result("Greeting"),
    ]);
    const token = `plan-token-${crypto.randomUUID()}`;
    const answer = await claudeCodeAnswer(guest.sandbox, {
      model: "claude-haiku-5-5",
      token,
      input: "Title this: say hello",
    });
    expect(answer.text).toBe("Greeting");
    expect(guest.home("claude-token")).toBe(token);
    expect(guest.home("claude-token-readers")).toBe("");
    expect(guest.home("claude-stdin.jsonl")).toBe("Title this: say hello");
    expect(
      guest.commands.filter(
        ({ command, env }) =>
          command.includes(token) ||
          Object.values(env).some((value) => value.includes(token)),
      ),
    ).toEqual([]);
    expect(await guest.filesHolding(token)).toEqual([]);
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
          /Claude Code could not be installed\.[\s\S]*checksum mismatch/,
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

  it("updates a Claude Code too old for dx before the turn, and the turn runs on the new one", async () => {
    const guest = await createGuest({
      oldClaude: "2.1.309",
      installerWorks: true,
    });
    await guest.script([
      init(),
      ...response("m1", [{ text: "Hello from Claude." }]),
      result("Hello from Claude."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const done = await claude.answer({ messages: [user("Say hello", 1)] });
    expect(done).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "Hello from Claude." }] },
    });
    expect(guest.home("claude-token")).toBe(claude.token);
    expect(guest.file(`${GUEST_HOME}/old-claude-ran`)).toBeUndefined();
  });

  it("stops with an error naming the version when a too-old Claude Code cannot be updated", async () => {
    const guest = await createGuest({ oldClaude: "1.0.108" });
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const failed = await claude.answer({ messages: [user("Say hello", 1)] });
    expect(failed).toMatchObject({
      type: "error",
      error: {
        errorMessage: expect.stringMatching(
          /Claude Code 1\.0\.108 is older than 2\.1\.310[\s\S]*claude update[\s\S]*checksum mismatch/,
        ),
      },
    });
    expect(guest.file(`${GUEST_HOME}/old-claude-ran`)).toBeUndefined();
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

  it("relaunches on retry when the run it rejoins was lost with a cold-booted workspace", {
    timeout: 45_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([init(), "#wait never"]);
    const first = claudeCode(createClaudeCodeProvider, guest.sandbox);
    vi.useFakeTimers({ toFake: ["Date"] });
    guest.before = ({ op, path }) => {
      if (op === "read" && path.endsWith("/exit"))
        vi.setSystemTime(Date.now() + 5_100);
      return undefined;
    };
    const context: Context = { messages: [user("Keep working", 6)] };
    const lost = first.answer(context);
    let dir = "";
    await waitFor(() => {
      const [attempt] = runDirectories(guest.ops);
      dir = attempt === undefined ? "" : `${STATE}/runs/${attempt}`;
      // The runner's first heartbeat: it is running in its own group.
      return dir !== "" && guest.file(`${dir}/alive`) !== undefined;
    });
    // A cold boot keeps the run's files but not its processes: no exit
    // marker is ever written, and the heartbeat stops at its last value.
    process.kill(-Number(guest.file(`${dir}/pid`)), "SIGKILL");
    guest.write(`${dir}/alive`, "1");
    const failed = await lost;
    expect(failed).toMatchObject({
      type: "error",
      error: {
        errorMessage: expect.stringContaining(
          "Claude Code stopped responding.",
        ),
      },
    });
    // A process lost with its workspace is a platform failure Flue retries.
    expect(
      failed.type === "error" &&
        classifyRunFailure({ message: failed.error.errorMessage ?? "" }).class,
    ).toBe("platform");

    // Flue's retry, from a restarted Durable Object, rejoins that attempt.
    await guest.script([
      init(),
      ...response("m1", [{ text: "Recovered." }]),
      result("Recovered."),
    ]);
    const retry = claudeCode(
      await restartedProvider(),
      guest.sandbox,
      first.threadId,
    );
    expect(await retry.answer(context)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "Recovered." }] },
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

  it("starts the next submission fresh after a minute of unreadable status and a replaced sandbox", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([init(), "#wait never"]);
    // The handle from before the Orb's container was reset: once storage
    // fails, every operation through it fails, and it never recovers.
    let outage = false;
    const STORAGE =
      "Durable Object storage operation exceeded timeout which caused object to be reset.";
    const stale = Object.fromEntries(
      Object.entries(guest.sandbox).map(([name, value]) => [
        name,
        typeof value === "function"
          ? (...args: unknown[]) => {
              if (!outage) return value(...args);
              vi.setSystemTime(Date.now() + 5_100);
              return Promise.reject(new Error(STORAGE));
            }
          : value,
      ]),
    ) as unknown as Sandbox;
    let current = stale;
    const threadId = `thr_claude_code_${crypto.randomUUID()}`;
    const claude = claudeCode(
      createClaudeCodeProvider,
      guest.sandbox,
      threadId,
      (thread) => claudeCodeSandbox(thread, async () => current),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = claude.answer({ messages: [user("Wait for me", 40)] });
    await waitFor(() => {
      const [attempt] = runDirectories(guest.ops);
      return (
        attempt !== undefined &&
        guest.file(`${STATE}/runs/${attempt}/alive`) !== undefined
      );
    });
    outage = true;
    const failed = await first;
    expect(failed).toMatchObject({
      type: "error",
      error: { errorMessage: expect.stringContaining(STORAGE) },
    });
    if (failed.type !== "error") throw new Error("Expected an error.");
    expect(
      classifyRunFailure({ message: failed.error.errorMessage ?? "" }).class,
    ).toBe("platform");

    // The container came back on a new handle; the next message is a new
    // submission, whose start resets the Thread's runtime state.
    current = guest.sandbox;
    (
      claudeCodeProvider as {
        resetClaudeCodeThreadState?: (threadId: string) => void;
      }
    ).resetClaudeCodeThreadState?.(threadId);
    await guest.script([
      init("session-2"),
      ...response("m1", [{ text: "Back." }]),
      result("Back."),
    ]);
    const started = performance.now();
    const next = await claude.answer({
      messages: [user("Wait for me", 40), user("Are you there?", 41)],
    });
    expect({
      next,
      failedWithinASecond:
        next.type === "error" && performance.now() - started < 1_000,
    }).toMatchObject({
      next: {
        type: "done",
        message: { content: [{ type: "text", text: "Back." }] },
      },
      failedWithinASecond: false,
    });
  });

  it("replays a retried turn's own user input, with no retry note, in the resumed session and in a new one", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([
      init("session-1"),
      ...response("m1", [
        { id: "toolu_a", name: "Bash", input: { command: "echo a" } },
      ]),
      toolResult("toolu_a", "a"),
      "#wait fail",
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "API Error: 500 Internal server error",
      }),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const turn = [user("Fix the parser", 50), user("and add a test", 51)];
    expect(await claude.answer({ messages: turn })).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
    const context: Context = {
      messages: [
        ...turn,
        assistant(
          [
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
      ],
    };
    // Claude fails only once this call has found its run live.
    const mark = guest.ops.length;
    const failing = claude.answer(context);
    await waitFor(() =>
      guest.ops
        .slice(mark)
        .some(({ op, path }) => op === "exec" && path.includes("echo lost")),
    );
    guest.release("fail");
    expect(await failing).toMatchObject({ type: "error" });

    // Flue retries the turn. Claude's recorded session is gone, so the
    // resumed CLI exits without naming one, and the adapter starts a new
    // session.
    guest.write(`${STATE}/session`, "session-gone");
    await guest.script([]);
    await claude.answer(context);
    const inputs = [...runDirectories(guest.ops)]
      .sort()
      .slice(1)
      .map((name) => guest.file(`${STATE}/runs/${name}/input.jsonl`) ?? "");
    const content = (input: string) =>
      (JSON.parse(input) as { message: { content: unknown } }).message.content;
    expect(inputs).toHaveLength(2);
    // Resuming the session: the turn's own input, exactly.
    expect(content(inputs[0] ?? "{}")).toEqual([
      { type: "text", text: "Fix the parser" },
      { type: "text", text: "and add a test" },
    ]);
    // A new session: the turn's anchoring message.
    expect(content(inputs[1] ?? "{}")).toEqual([
      { type: "text", text: "and add a test" },
    ]);
    for (const input of inputs) expect(input).not.toMatch(/retry/i);
  });

  it("settles a run that wrote a successful result after tool use as done when Flue resumes past a failed message", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [
        { id: "toolu_a", name: "Bash", input: { command: "echo a" } },
      ]),
      toolResult("toolu_a", "a"),
      "#wait go",
      ...response("m2", [{ text: "All done." }]),
      result("All done."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const turn = [user("Do the work", 60)];
    expect(await claude.answer({ messages: turn })).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
    // The next model call failed while Claude kept working. An explicit
    // resume keeps that failed message in context, rewritten as a stop
    // (Flue's `resumeFailedAssistant`); it is not one of Claude's segments.
    const resumed = claude.answer({
      messages: [
        ...turn,
        assistant(
          [
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
        assistant([], "stop"),
      ],
    });
    guest.release("go");
    expect(await resumed).toMatchObject({
      type: "done",
      reason: "stop",
      message: { content: [{ type: "text", text: "All done." }] },
    });
  });

  it("keeps a run that finishes while dx checks whether it was lost, and does not run the turn again", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [
        { id: "toolu_a", name: "Bash", input: { command: "echo a" } },
      ]),
      toolResult("toolu_a", "a"),
      "#wait go",
      ...response("m2", [{ text: "All done." }]),
      result("All done."),
    ]);
    // Reading a process's command line is how the check sees the runner.
    // Once armed, it waits until the run has finished, so Claude ends
    // between the check's reads, as it can on a loaded machine.
    await guest.tool(
      "tr",
      `#!/bin/bash
if [ -e "$HOME/hold-tr" ]; then
  rm -f "$HOME/hold-tr"
  for _ in $(seq 200); do
    gone=no
    for d in "$HOME"/.local/state/dx-claude-code/runs/*/; do
      pid=$(cat "$d/pid" 2>/dev/null)
      [ -f "$d/exit" ] && [ -n "$pid" ] && [ -z "$(/usr/bin/tr -d '\\0' < "/proc/$pid/cmdline" 2>/dev/null)" ] && gone=yes
    done
    [ "$gone" = yes ] && break
    sleep 0.05
  done
fi
exec /usr/bin/tr "$@"
`,
    );
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const turn = [user("Do the work", 60)];
    expect(await claude.answer({ messages: turn })).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
    guest.before = (op) => {
      if (op.op === "exec" && op.path.includes("echo lost")) {
        guest.release("hold-tr");
        guest.release("go");
      }
      return undefined;
    };
    expect(
      await claude.answer({
        messages: [
          ...turn,
          assistant(
            [
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
        ],
      }),
    ).toMatchObject({
      type: "done",
      reason: "stop",
      message: { content: [{ type: "text", text: "All done." }] },
    });
    // The check ran, the run kept its own exit code, and no second attempt
    // replayed the turn.
    expect(
      guest.ops.some(
        ({ op, path }) => op === "exec" && path.includes("echo lost"),
      ),
    ).toBe(true);
    const runs = [...runDirectories(guest.ops)];
    expect(runs).toHaveLength(1);
    expect(guest.file(`${STATE}/runs/${runs[0]}/exit`)?.trim()).toBe("0");
  });

  it("answers a dx call Flue will not run as its segment closes, so Claude's next tool and the batch finish", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    // Claude runs its calls in order: the dx call's server answers first,
    // only then does Bash run.
    await guest.script([
      init(),
      ...response("m1", [
        { id: "toolu_gone", name: "mcp__dx__gone", input: {} },
        { id: "toolu_b", name: "Bash", input: { command: "echo b" } },
      ]),
      "#wait .local/state/dx-claude-code/mcp/results/toolu_gone.json",
      toolResult("toolu_gone", "answered"),
      toolResult("toolu_b", "b"),
      ...response("m2", [{ text: "Done." }]),
      result("Done."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    // The model call offers the mirrors but no dx tool named gone, so Flue
    // answers that call itself without running anything.
    const tools = claudeCodeMirrorTools(claude.threadId);
    expect(
      await claude.answer({
        messages: [user("Use both tools", 70)],
        tools: tools.map(({ name, description }) => ({
          name,
          description,
          parameters: { type: "object" } as never,
        })),
      }),
    ).toMatchObject({ type: "done", reason: "toolUse" });
    const bash = tools.find(({ name }) => name === "Bash");
    const output = await bash?.run({
      toolCallId: "toolu_b",
      signal: AbortSignal.timeout(10_000),
      harness: { sandbox: guest.sandbox },
      log: console,
    } as never);
    expect(output).toBe("b");
    expect(
      JSON.parse(guest.file(`${STATE}/mcp/results/toolu_gone.json`) ?? "null"),
    ).toEqual({
      content: [{ type: "text", text: "Tool mcp__dx__gone not found" }],
      isError: true,
    });
  });

  it("re-runs a read-only dx call a restart interrupted, so Flue records and Claude receives its real result", {
    // Flue's Node runtime recovers a lost attempt after its 30-second lease.
    timeout: 120_000,
  }, async () => {
    // A Durable Object restart ends the attempt while Claude waits on
    // wait_for_threads: here the process running it is killed mid-call, and
    // a new one over the same storage recovers the submission.
    const root = await mkdtemp(join(tmpdir(), "dx-claude-code-restart-"));
    guests.push({ root, home: join(root, "home") });
    await mkdir(join(root, "home"));
    const fixture = (mode: string, ...rest: string[]) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "restart-fixture.ts"),
          mode,
          join(root, "db.sqlite"),
          join(root, "home"),
          ...rest,
        ],
        {
          cwd: join(import.meta.dirname, "../.."),
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
    const lines = (child: ReturnType<typeof spawn>) => {
      const seen: Record<string, unknown>[] = [];
      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        for (const line of parts)
          if (line.startsWith("{")) seen.push(JSON.parse(line));
      });
      return seen;
    };
    const first = fixture("start");
    const started = lines(first);
    await vi.waitFor(
      () => {
        expect(started).toContainEqual({ calling: true });
        expect(started.some((line) => "submissionId" in line)).toBe(true);
      },
      { timeout: 30_000, interval: 100 },
    );
    const exited = new Promise((resolve) => first.on("exit", resolve));
    first.kill("SIGKILL");
    await exited;
    const submissionId = String(
      started.find((line) => "submissionId" in line)?.submissionId,
    );
    const second = fixture("resume", submissionId);
    const resumed = lines(second);
    await new Promise((resolve) => second.on("exit", resolve));
    const report = JSON.stringify({
      settled: true,
      lastMessage: "REPORT\nEND-OF-REPORT",
    });
    // The model's next call sees the tool's result, not "interrupted".
    expect(resumed).toEqual([{ reply: report }]);
    // And Claude, still waiting on the same call, receives it.
    expect(
      JSON.parse(
        await readFile(
          join(
            root,
            "home/.local/state/dx-claude-code/mcp/results/toolu_wait.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual({ content: [{ type: "text", text: report }], isError: false });
  });

  it("stamps each failure with the class Flue's retry policy reads", {
    timeout: 60_000,
  }, async () => {
    const cases = [
      {
        result:
          'API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
        class: "account",
      },
      {
        result:
          'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
        class: "account",
      },
      {
        result:
          'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        class: "transient",
      },
      { result: "API Error: Connection lost mid-response", class: "transient" },
    ];
    const seen: Array<{ class: string; stamped: boolean }> = [];
    for (const [index, { result: text }] of cases.entries()) {
      const guest = await createGuest();
      await guest.script([
        init(),
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: text,
        }),
      ]);
      const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
      const failed = await claude.answer({
        messages: [user("Go", 70 + index)],
      });
      const message = failed.type === "error" ? failed.error.errorMessage : "";
      seen.push({
        class: classifyRunFailure({ message: message ?? "" }).class,
        stamped: /\(dx_failure:/.test(message ?? ""),
      });
    }
    expect(seen).toEqual(
      cases.map((entry) => ({ class: entry.class, stamped: true })),
    );
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

/**
 * Q9 and Q1 in tasks/platform-quirks-tracker.md, through the real launch
 * script, runner, and environment decorator: Claude Code streams text and
 * tool input as fragments, one stream-json line each, and a workspace read
 * redacts each line on its own. What Flue records and forwards is the
 * provider's messages and deltas, so neither may hold a secret however the
 * fragments split it.
 */
describe("Claude Code stream through secret redaction", {
  timeout: 30_000,
}, () => {
  const SECRET = "sk-live-4f9a2c7e";
  /** A secret too short to hide, as a workspace may hold one; it occurs in "exactly". */
  const SHORT = "act";
  /** What dx shows in place of SECRET, the first variable. */
  const MARK = "[REDACTED:Q9_0]";
  const recorded: Record<string, unknown> = {};

  // DX_STREAM_REDACTION_ARTIFACT=<file> keeps what each case recorded.
  afterAll(async () => {
    const path = process.env.DX_STREAM_REDACTION_ARTIFACT;
    if (path === undefined || path === "") return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(recorded, null, 2)}\n`);
  });

  const environment = (
    secrets: ReadonlyArray<string>,
  ): ExecutionEnvironmentSnapshot => ({
    revision: {
      personal: { targetId: "user", revision: 0 },
      project: { targetId: "project", revision: 0 },
      workspace: { targetId: null, revision: 0 },
    },
    values: secrets.map((plaintext, index) => ({
      reference: configReferenceFor(
        Schema.decodeUnknownSync(EnvironmentVariableId)(`env_q9_${index}`),
      ),
      name: Schema.decodeUnknownSync(EnvironmentVariableName)(`Q9_${index}`),
      kind: "secret" as const,
      value: Redacted.make(plaintext),
      source: "workspace" as const,
    })),
  });

  const delta = (index: number, value: Record<string, unknown>) =>
    event({ type: "content_block_delta", index, delta: value });

  /** One response whose blocks arrive in the given fragments. */
  const fragmented = (
    blocks: ReadonlyArray<
      | { readonly text: ReadonlyArray<string> }
      | { readonly thinking: ReadonlyArray<string> }
      | {
          readonly id: string;
          readonly name: string;
          readonly json: ReadonlyArray<string>;
        }
    >,
  ) => [
    init(),
    event({
      type: "message_start",
      message: { id: "m1", usage: { input_tokens: 3, output_tokens: 1 } },
    }),
    ...blocks.flatMap((block, index) => [
      event({
        type: "content_block_start",
        index,
        content_block:
          "text" in block
            ? { type: "text", text: "" }
            : "thinking" in block
              ? { type: "thinking", thinking: "" }
              : { type: "tool_use", id: block.id, name: block.name, input: {} },
      }),
      ...("text" in block
        ? block.text.map((text) => delta(index, { type: "text_delta", text }))
        : "thinking" in block
          ? block.thinking.map((thinking) =>
              delta(index, { type: "thinking_delta", thinking }),
            )
          : block.json.map((partial_json) =>
              delta(index, { type: "input_json_delta", partial_json }),
            )),
      event({ type: "content_block_stop", index }),
    ]),
    event({ type: "message_delta", usage: { output_tokens: 9 } }),
    event({ type: "message_stop" }),
    result("Done."),
  ];

  /**
   * Runs the response through a workspace holding these secrets and
   * returns what Flue records (the final message) and what it forwards
   * (every delta, joined per block).
   */
  const record = async (
    name: string,
    lines: ReadonlyArray<string>,
    secrets: ReadonlyArray<string>,
  ) => {
    const guest = await createGuest();
    await guest.script(lines);
    const sandbox = await withExecutionEnvironment(
      { createSandbox: async () => guest.sandbox },
      async () => environment(secrets),
    ).createSandbox({ id: "guest" });
    const claude = claudeCode(createClaudeCodeProvider, sandbox);
    const events = await claude.events({
      systemPrompt: "Answer briefly.",
      messages: [user("Go", 1)],
    });
    const last = events.at(-1);
    if (last?.type !== "done")
      throw new Error(`Expected done: ${JSON.stringify(last)}`);
    const forwarded: string[] = [];
    for (const next of events)
      if (
        next.type === "text_delta" ||
        next.type === "thinking_delta" ||
        next.type === "toolcall_delta"
      )
        forwarded[next.contentIndex] =
          (forwarded[next.contentIndex] ?? "") + next.delta;
    const content = last.message.content;
    recorded[name] = { secrets, content, forwarded };
    return { content, forwarded, events: JSON.stringify(events) };
  };

  it("never records or forwards a secret split across two text deltas, or two thinking deltas", async () => {
    const { content, forwarded, events } = await record(
      "text split across deltas",
      fragmented([
        { thinking: ["The key sk-live-", "4f9a2c7e is set."] },
        { text: ["Your token is sk-live-4f9", "a2c7e, keep it safe."] },
      ]),
      [SECRET],
    );
    expect(content).toEqual([
      { type: "thinking", thinking: `The key ${MARK} is set.` },
      { type: "text", text: `Your token is ${MARK}, keep it safe.` },
    ]);
    expect(forwarded).toEqual([
      `The key ${MARK} is set.`,
      `Your token is ${MARK}, keep it safe.`,
    ]);
    expect(events).not.toContain(SECRET);
  });

  it("never records or forwards a secret split across two partial_json deltas", async () => {
    const { content, forwarded, events } = await record(
      "tool input split across deltas",
      fragmented([
        {
          id: "toolu_bash",
          name: "Bash",
          json: [
            '{"command": "curl -H \'Authorization: sk-live-4f',
            "9a2c7e' https://api.example.com\"}",
          ],
        },
      ]),
      [SECRET],
    );
    expect(content).toEqual([
      {
        type: "toolCall",
        id: "toolu_bash",
        name: "Bash",
        arguments: {
          command: `curl -H 'Authorization: ${MARK}' https://api.example.com`,
        },
      },
    ]);
    expect(forwarded.join("")).not.toContain(SECRET);
    expect(events).not.toContain(SECRET);
  });

  it("leaves a dx tool input unchanged when a secret too short to hide occurs inside its words", async () => {
    const { content, events } = await record(
      "short secret inside words",
      fragmented([
        {
          id: "toolu_dx",
          name: "mcp__dx__create_thread",
          json: [
            '{"pro',
            'mpt": "Find exactly',
            ' where the input loses its keys."}',
          ],
        },
      ]),
      [SHORT],
    );
    expect(content).toEqual([
      {
        type: "toolCall",
        id: "toolu_dx",
        name: "mcp__dx__create_thread",
        arguments: { prompt: "Find exactly where the input loses its keys." },
      },
    ]);
    expect(events).toContain("exactly");
  });

  it("control: without secrets, and near a secret's prefix, the stream arrives as Claude sent it", async () => {
    const response = fragmented([
      { text: ["Nearly sk-live-4f9", "b, and ends with sk-live"] },
      {
        id: "toolu_dx",
        name: "mcp__dx__create_thread",
        json: ['{"pro', 'mpt": "Find exactly', ' where."}'],
      },
    ]);
    const expected = [
      { type: "text", text: "Nearly sk-live-4f9b, and ends with sk-live" },
      {
        type: "toolCall",
        id: "toolu_dx",
        name: "mcp__dx__create_thread",
        arguments: { prompt: "Find exactly where." },
      },
    ];
    const without = await record("control without secrets", response, []);
    expect(without.content).toEqual(expected);
    const near = await record("control near a secret", response, [SECRET]);
    expect(near.content).toEqual(expected);
    expect(near.forwarded).toEqual(without.forwarded);
  });
});
