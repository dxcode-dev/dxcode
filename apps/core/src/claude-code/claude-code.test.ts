import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { formatMessageAuthor } from "@dx/api";
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
import { settingsInstructions } from "../agents/dx-agent-prompt.js";
import { classifyRunFailure } from "../runtime/run-failure.js";
import type { ExecutionEnvironmentSnapshot } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import { claudeCodeDxSandboxTool, claudeCodeDxTools } from "./dx-tools.js";
import * as claudeCodeProvider from "./provider.js";
import { createClaudeCodeProvider } from "./provider.js";
import { claudeCodeSandbox } from "./runs.js";
import { ClaudeCodeStream } from "./stream.js";
import { setClaudeCodeToolGate } from "./tool-gate.js";
import { claudeCodeMirrorTools, claudeCodeReadTool } from "./tools.js";
import { createClaudeCodeViewMediaTool } from "./view-media.js";
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
# A fork Claude Code cannot make, as when the message is not in the session:
# it says so and exits before naming a session.
if [ -e "$HOME/refuse-fork" ] && printf '%s\\n' "$@" | grep -qx -- --resume-session-at; then
  cp "$HOME/claude-args" "$HOME/refused-args"
  echo "No message found with message.uuid of: refused" >&2
  printf '%s\\n' '{"type":"result","subtype":"error_during_execution","is_error":true}'
  # Its result lands before it exits, and the runner's exit marker after.
  sleep 1
  exit 1
fi
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
 * A Claude Code that speaks the stream-json control protocol, for runs that
 * go through the dx tool bridge: it answers the bridge's initialize (saving
 * the request to ~/fake-initialize.json), reads the turn's input, then
 * prints ~/claude-script.jsonl. A \`#hook <tool_use id>\` line fires a
 * PreToolUse hook_callback for that call, waits for the bridge's answer
 * (saved to ~/hook-<id>.json), and prints the call's result as Claude Code
 * would: the deny reason as an error, or "ran: <command>" with the input
 * the hook allowed.
 */
const PROTOCOL_CLAUDE = `#!/usr/bin/env python3
import json, os, sys
if len(sys.argv) > 1 and sys.argv[1] == "--version":
    print("2.1.322 (Claude Code)")
    sys.exit(0)
home = os.environ["HOME"]
calls = {}
def out(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
def read():
    line = sys.stdin.readline()
    return json.loads(line) if line else None
initialize = read()
json.dump(initialize, open(os.path.join(home, "fake-initialize.json"), "w"))
out({"type": "control_response", "response": {"subtype": "success", "request_id": initialize["request_id"], "response": {"hook_on_failure_supported": True, "hooks_applied": True}}})
read()
for raw in open(os.path.join(home, "claude-script.jsonl")):
    raw = raw.rstrip("\\n")
    if raw.startswith("#hook "):
        tool_use = raw.split(" ", 1)[1]
        name, tool_input = calls[tool_use]
        out({"type": "control_request", "request_id": "hook-" + tool_use, "request": {"subtype": "hook_callback", "callback_id": initialize["request"]["hooks"]["PreToolUse"][0]["hookCallbackIds"][0], "tool_use_id": tool_use, "input": {"hook_event_name": "PreToolUse", "tool_name": name, "tool_input": tool_input, "tool_use_id": tool_use}}})
        answer = read()
        json.dump(answer, open(os.path.join(home, "hook-" + tool_use + ".json"), "w"))
        output = (answer["response"].get("response") or {}).get("hookSpecificOutput") or {}
        if output.get("permissionDecision") == "deny":
            content, error = output.get("permissionDecisionReason", "denied"), True
        else:
            content, error = "ran: " + str((output.get("updatedInput") or tool_input).get("command")), False
        out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use, "content": content, "is_error": error}]}, "parent_tool_use_id": None})
        continue
    if raw.strip() == "":
        continue
    line = json.loads(raw)
    event = line.get("event") or {}
    block = event.get("content_block") or {}
    if block.get("type") == "tool_use":
        calls[block["id"]] = (block["name"], None)
        pending = block["id"]
    delta = event.get("delta") or {}
    if delta.get("type") == "input_json_delta":
        calls[pending] = (calls[pending][0], json.loads(delta["partial_json"]))
    out(line)
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

/**
 * A Claude Code that discovers skills as the real CLI does, from
 * ~/.claude/skills/<name>/SKILL.md, following links. It reads the turn's
 * input, writes what it found to ~/skills-seen.json (each skill's name and
 * the last line of its SKILL.md, read through the link), and answers with
 * the names.
 */
const SKILLS_CLAUDE = `#!/usr/bin/env python3
import glob, json, os, sys
if sys.argv[1:2] == ["--version"]:
    print("2.1.310 (Claude Code)")
    sys.exit(0)
sys.stdin.read()
home = os.environ["HOME"]
seen = {}
for path in sorted(glob.glob(home + "/.claude/skills/*/SKILL.md")):
    name = os.path.basename(os.path.dirname(path))
    seen[name] = open(path).read().strip().splitlines()[-1]
with open(home + "/skills-seen.json", "w") as out:
    json.dump(seen, out)
text = "skills: " + ",".join(seen)
def emit(value):
    print(json.dumps(value), flush=True)
def event(value):
    emit({"type": "stream_event", "event": value, "parent_tool_use_id": None})
emit({"type": "system", "subtype": "init", "session_id": "skills-1", "skills": list(seen)})
event({"type": "message_start", "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 1}}})
event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}})
event({"type": "content_block_stop", "index": 0})
event({"type": "message_stop"})
emit({"type": "result", "subtype": "success", "is_error": False, "result": text})
`;

const createGuest = async (
  options: {
    readonly claude?: boolean;
    /** A Claude Code of this version instead of the current one. */
    readonly oldClaude?: string;
    /** The downloaded installer installs the current Claude Code. */
    readonly installerWorks?: boolean;
    /** This program as the installed Claude Code instead of the fake. */
    readonly claudeProgram?: string;
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
  else if (options.claudeProgram !== undefined)
    await claudeAt(options.claudeProgram);
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
    write: (guestPath: string, content: string) => {
      mkdirSync(dirname(map(guestPath)), { recursive: true });
      writeFileSync(map(guestPath), content);
    },
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
/**
 * The complete message Claude Code prints after streaming one, carrying the
 * uuid of its entry in the session's transcript.
 */
const complete = (id: string, uuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    message: { id, role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  });
/** Where Claude Code keeps a session of the Thread's repository. */
const sessionTranscript = (session: string) =>
  `${GUEST_HOME}/.claude/projects/-home-user-workspace-repo/${session}.jsonl`;

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

  // #1303: Claude Code must not credit itself in a commit or a pull request.
  // Its attribution defaults add a Co-Authored-By: Claude trailer and a
  // "Generated with Claude Code" line; the settings dx passes on the command
  // line rank above the user, project, and local files a repository controls.
  it("starts Claude Code with its commit and pull request attribution turned off", async () => {
    const guest = await createGuest();
    await guest.script([
      init(),
      ...response("m1", [{ text: "Committed." }]),
      result("Committed."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    await claude.answer({
      systemPrompt: "Commit the change.",
      messages: [user("Commit it", 1)],
    });
    const args = guest.home("claude-args").split("\n");
    const sources = args[args.indexOf("--setting-sources") + 1];
    expect(sources).toBe("user,project,local");
    const settings = args.indexOf("--settings");
    expect(settings).toBeGreaterThan(-1);
    expect(args.lastIndexOf("--settings")).toBe(settings);
    const passed = JSON.parse(args[settings + 1] ?? "") as Record<
      string,
      unknown
    >;
    expect(passed.attribution).toEqual({ commit: "", pr: "" });
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
    // The workspace's instructions, then the person's, as dx-agent.ts
    // composes them for CLAUDE.md.
    await turn(
      "Hi",
      80,
      settingsInstructions("Run the linter first.", "Reply in French."),
    );
    // Claude Code reads the repository's AGENTS.md itself.
    expect(guest.home("claude-prompt.txt")).toBe("dx's Claude Code prompt.");
    expect(await guest.sandbox.readFile(userInstructions)).toBe(
      "<workspace_instructions>\nRun the linter first.\n</workspace_instructions>\n\n<personal_instructions>\nReply in French.\n</personal_instructions>",
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

  it("serves view_media to Claude: the image as an MCP block, and an objective through a claude -p subagent", async () => {
    const guest = await createGuest();
    const pixels = new Uint8Array(2400 * 1200 * 3).fill(90);
    const { encode } = await import("fast-png");
    await guest.sandbox.writeFile(
      `${GUEST_HOME}/workspace/repo/shot.png`,
      encode({ width: 2400, height: 1200, channels: 3, data: pixels }),
    );
    const token = `plan-token-${crypto.randomUUID()}`;
    const [tool] = claudeCodeDxTools("thr_view_media", [
      createClaudeCodeViewMediaTool({
        deps: { githubToken: async () => undefined },
        token: async () => token,
      }),
    ]);
    if (tool === undefined) throw new Error("no tool");
    const run = (toolCallId: string, data: unknown) =>
      tool.run({
        toolCallId,
        data,
        signal: AbortSignal.timeout(20_000),
        harness: { sandbox: guest.sandbox },
        log: console,
      } as never);

    // Without an objective Claude sees the image; Flue records only text.
    const shown = await run("toolu_see", { path: "shot.png" });
    expect(shown).toBe(
      `${GUEST_HOME}/workspace/repo/shot.png: PNG, 2000×1000, downsized from 2400×1200.`,
    );
    const mcpResult = JSON.parse(
      guest.file(`${STATE}/mcp/results/toolu_see.json`) ?? "null",
    );
    expect(mcpResult).toMatchObject({
      isError: false,
      content: [
        { type: "text", text: shown },
        { type: "image", mimeType: "image/png", data: expect.any(String) },
      ],
    });

    // With one, a claude -p subagent answers from the image.
    await guest.script([init(), result("Gray, no text.")]);
    const answered = await run("toolu_ask", {
      path: "shot.png",
      objective: "What color is it?",
    });
    expect(answered).toBe("Gray, no text.");
    const args = guest.home("claude-args").split("\n");
    expect(args).toEqual(
      expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--append-system-prompt",
        "--tools",
      ]),
    );
    const stdin = JSON.parse(guest.home("claude-stdin.jsonl"));
    expect(stdin.message.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: expect.any(String),
        },
      },
      { type: "text", text: "What color is it?" },
    ]);
    expect(await guest.filesHolding(token)).toEqual([]);
  });

  it("records the image Claude's Read returned, so the transcript can show it, and a text file's lines as text", async () => {
    const guest = await createGuest();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64").toString(
      "base64",
    );
    await guest.script([
      init(),
      ...response("m1", [
        {
          id: "toolu_png",
          name: "Read",
          input: { file_path: `${GUEST_HOME}/workspace/repo/shot.png` },
        },
        {
          id: "toolu_txt",
          name: "Read",
          input: { file_path: `${GUEST_HOME}/workspace/repo/notes.txt` },
        },
      ]),
      // Claude Code hands an image file to the model as an image block.
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_png",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: png,
                  },
                },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
      }),
      toolResult("toolu_txt", "     1\tfirst line"),
      ...response("m2", [{ text: "Seen." }]),
      result("Seen."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const read = claudeCodeReadTool(claude.threadId, guest.sandbox);
    expect(
      claudeCodeMirrorTools(claude.threadId).map(({ name }) => name),
    ).not.toContain("Read");
    expect(
      await claude.answer({
        messages: [user("Look at both files", 80)],
        tools: [
          ...claudeCodeMirrorTools(claude.threadId),
          { name: read.name, description: read.description },
        ].map(({ name, description }) => ({
          name,
          description: description ?? "",
          parameters: { type: "object" } as never,
        })),
      }),
    ).toMatchObject({ type: "done", reason: "toolUse" });
    const signal = AbortSignal.timeout(10_000);
    // Flue stores an image block as an attachment of the conversation.
    expect((await read.execute("toolu_png", {}, signal)).content).toEqual([
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    // A text file stays one text block, which Flue records as a string.
    expect((await read.execute("toolu_txt", {}, signal)).content).toEqual([
      { type: "text", text: "     1\tfirst line" },
    ]);
  });

  it("records the image view_media showed Claude beside its text, and still answers Claude with both", async () => {
    const guest = await createGuest();
    const { encode } = await import("fast-png");
    await guest.sandbox.writeFile(
      `${GUEST_HOME}/workspace/repo/small.png`,
      encode({
        width: 40,
        height: 20,
        channels: 3,
        data: new Uint8Array(40 * 20 * 3).fill(200),
      }),
    );
    const viewMedia = createClaudeCodeViewMediaTool({
      deps: { githubToken: async () => undefined },
      token: async () => "plan-token",
    });
    claudeCodeDxTools("thr_view_media_record", [viewMedia]);
    const tool = claudeCodeDxSandboxTool(
      "thr_view_media_record",
      viewMedia,
      guest.sandbox,
    );
    expect(tool.name).toBe("view_media");
    const { content } = await tool.execute(
      "toolu_small",
      { path: "small.png" },
      AbortSignal.timeout(20_000),
    );
    const text = `${GUEST_HOME}/workspace/repo/small.png: PNG, 40×20.`;
    expect(content).toEqual([
      { type: "text", text },
      { type: "image", mimeType: "image/png", data: expect.any(String) },
    ]);
    expect(
      JSON.parse(guest.file(`${STATE}/mcp/results/toolu_small.json`) ?? "null"),
    ).toEqual({ isError: false, content });
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

  // Editing an earlier message rewinds Flue's history, but Claude's session
  // still holds the removed turns. Ways it could fail: the edited message
  // resumes that session; the new session starts with no idea of what came
  // before the edited message; a follow-up stops resuming its session.
  it("starts a new session for an edited message, given the conversation before it, and resumes it after", async () => {
    const guest = await createGuest();
    await guest.script([
      init("session-1"),
      ...response("m1", [{ text: "Parser fixed." }]),
      result("Parser fixed."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const first = user("Fix the parser", 70);
    const firstAnswer = assistant(
      [{ type: "text", text: "Parser fixed." }],
      "stop",
    );
    await claude.answer({ messages: [first] });
    expect(guest.file(`${STATE}/session`)).toBe("session-1");

    // A later turn ran in session-1, then the person edited it away: Flue's
    // history is the first turn and the edited message.
    const edited = user(
      `${formatMessageAuthor({
        author: { role: "owner", userId: "usr_owner", name: "Ada" },
        edited: true,
      })}Add a test instead`,
      80,
    );
    await guest.script([
      init("session-2"),
      ...response("m2", [{ text: "Test added." }]),
      result("Test added."),
    ]);
    const marked = guest.ops.length;
    await claude.answer({ messages: [first, firstAnswer, edited] });
    expect(guest.home("claude-args")).not.toContain("--resume");
    const input = JSON.parse(guest.home("claude-stdin.jsonl")) as {
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(input.message.content).toHaveLength(2);
    expect(input.message.content[0]?.text).toContain("<earlier_conversation>");
    expect(input.message.content[0]?.text).toContain("User: Fix the parser");
    expect(input.message.content[0]?.text).toContain(
      "Assistant: Parser fixed.",
    );
    expect(input.message.content[1]?.text).toContain("Add a test instead");
    const editRun = [...runDirectories(guest.ops.slice(marked))][0];
    expect(guest.file(`${STATE}/runs/${editRun}/resumed`)).toBeUndefined();
    expect(guest.file(`${STATE}/session`)).toBe("session-2");

    // The next message resumes the new session with only its own input.
    await guest.script([
      init("session-2"),
      ...response("m3", [{ text: "Done." }]),
      result("Done."),
    ]);
    await claude.answer({
      messages: [
        first,
        firstAnswer,
        edited,
        assistant([{ type: "text", text: "Test added." }], "stop"),
        user("Run it", 90),
      ],
    });
    const args = guest.home("claude-args").split("\n");
    expect(args[args.indexOf("--resume") + 1]).toBe("session-2");
    expect(
      (
        JSON.parse(guest.home("claude-stdin.jsonl")) as {
          message: { content: unknown };
        }
      ).message.content,
    ).toEqual([{ type: "text", text: "Run it" }]);
  });

  // An edit keeps the conversation before the edited message in Claude's own
  // session, byte for byte, so its prompt cache still holds. Ways it could
  // fail: the edit resumes the whole old session; it forks at a message of a
  // removed turn; it sends the earlier turns again as text; the next message
  // resumes the old session instead of the fork; a second edit cannot reach
  // a turn the first fork copied.
  it("forks Claude's session at the last message an edit keeps, and resumes the fork after", async () => {
    const guest = await createGuest();
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const argsOf = () => guest.home("claude-args").split("\n");
    const inputOf = () =>
      (
        JSON.parse(guest.home("claude-stdin.jsonl")) as {
          message: { content: Array<{ type: string; text: string }> };
        }
      ).message.content;
    await guest.script([
      init("session-1"),
      ...response("m1", [{ text: "APPLE kept." }]),
      complete("m1", "uuid-apple", "APPLE kept."),
      result("APPLE kept."),
    ]);
    const first = user("Remember APPLE", 70);
    const firstAnswer = assistant(
      [{ type: "text", text: "APPLE kept." }],
      "stop",
    );
    await claude.answer({ messages: [first] });
    guest.write(sessionTranscript("session-1"), "{}\n");
    await guest.script([
      init("session-1"),
      ...response("m2", [{ text: "BANANA kept." }]),
      complete("m2", "uuid-banana", "BANANA kept."),
      result("BANANA kept."),
    ]);
    const second = user("Remember BANANA", 80);
    await claude.answer({ messages: [first, firstAnswer, second] });
    expect(argsOf()[argsOf().indexOf("--resume") + 1]).toBe("session-1");

    // The person edits the second message: Flue's history is the first turn
    // and the edited message.
    const edited = user(
      `${formatMessageAuthor({
        author: { role: "owner", userId: "usr_owner", name: "Ada" },
        edited: true,
      })}List the code words`,
      90,
    );
    await guest.script([
      init("session-2"),
      ...response("m3", [{ text: "APPLE." }]),
      complete("m3", "uuid-list", "APPLE."),
      result("APPLE."),
    ]);
    const marked = guest.ops.length;
    await claude.answer({ messages: [first, firstAnswer, edited] });
    const forked = argsOf();
    expect(forked[forked.indexOf("--resume") + 1]).toBe("session-1");
    expect(forked[forked.indexOf("--resume-session-at") + 1]).toBe(
      "uuid-apple",
    );
    expect(forked).toContain("--fork-session");
    // Only the edited message is new input: the turn before it is Claude's.
    expect(inputOf()).toHaveLength(1);
    expect(inputOf()[0]?.text).toContain("List the code words");
    expect(inputOf()[0]?.text).not.toContain("earlier_conversation");
    const editRun = [...runDirectories(guest.ops.slice(marked))][0];
    expect(guest.file(`${STATE}/runs/${editRun}/resumed`)).toBeDefined();
    expect(guest.file(`${STATE}/session`)).toBe("session-2");

    // The next message resumes the fork, with only its own input.
    guest.write(sessionTranscript("session-2"), "{}\n");
    const listed = assistant([{ type: "text", text: "APPLE." }], "stop");
    await guest.script([
      init("session-2"),
      ...response("m4", [{ text: "CHERRY kept." }]),
      complete("m4", "uuid-cherry", "CHERRY kept."),
      result("CHERRY kept."),
    ]);
    const third = user("Remember CHERRY", 100);
    await claude.answer({
      messages: [first, firstAnswer, edited, listed, third],
    });
    expect(argsOf()[argsOf().indexOf("--resume") + 1]).toBe("session-2");
    expect(argsOf()).not.toContain("--resume-session-at");
    expect(argsOf()).not.toContain("--fork-session");
    expect(inputOf()).toEqual([{ type: "text", text: "Remember CHERRY" }]);

    // Editing that message forks the fork at the edited turn's answer.
    const editedAgain = user(
      `${formatMessageAuthor({
        author: { role: "owner", userId: "usr_owner", name: "Ada" },
        edited: true,
      })}Forget nothing`,
      110,
    );
    await guest.script([
      init("session-3"),
      ...response("m5", [{ text: "Done." }]),
      result("Done."),
    ]);
    await claude.answer({
      messages: [first, firstAnswer, edited, listed, editedAgain],
    });
    expect(argsOf()[argsOf().indexOf("--resume") + 1]).toBe("session-2");
    expect(argsOf()[argsOf().indexOf("--resume-session-at") + 1]).toBe(
      "uuid-list",
    );
    expect(guest.file(`${STATE}/session`)).toBe("session-3");
  });

  // The fork is the fast path; a new session that is told the conversation
  // is the fallback. Ways it could fail: the edit resumes the whole old
  // session; the CLI's refusal fails the turn; the fallback starts with no
  // idea of the conversation before the edited message.
  it.each([
    ["Claude's session file is gone", "gone"],
    ["Claude Code refuses the fork", "refused"],
  ] as const)(
    "starts a new session told the conversation before an edit when %s",
    async (_case, failure) => {
      const guest = await createGuest();
      const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
      await guest.script([
        init("session-1"),
        ...response("m1", [{ text: "APPLE kept." }]),
        complete("m1", "uuid-apple", "APPLE kept."),
        result("APPLE kept."),
      ]);
      const first = user("Remember APPLE", 70);
      const firstAnswer = assistant(
        [{ type: "text", text: "APPLE kept." }],
        "stop",
      );
      await claude.answer({ messages: [first] });
      if (failure === "refused") {
        guest.write(sessionTranscript("session-1"), "{}\n");
        guest.release("refuse-fork");
      }
      const edited = user(
        `${formatMessageAuthor({
          author: { role: "owner", userId: "usr_owner", name: "Ada" },
          edited: true,
        })}List the code words`,
        90,
      );
      await guest.script([
        init("session-2"),
        ...response("m2", [{ text: "APPLE." }]),
        result("APPLE."),
      ]);
      const answered = await claude.answer({
        messages: [first, firstAnswer, edited],
      });
      expect(answered.type).toBe("done");
      if (failure === "refused")
        expect(guest.home("refused-args")).toContain("--resume-session-at");
      expect(guest.home("claude-args")).not.toContain("--resume");
      const input = (
        JSON.parse(guest.home("claude-stdin.jsonl")) as {
          message: { content: Array<{ type: string; text: string }> };
        }
      ).message.content;
      expect(input[0]?.text).toContain("<earlier_conversation>");
      expect(input[0]?.text).toContain("User: Remember APPLE");
      expect(input[1]?.text).toContain("List the code words");
      expect(guest.file(`${STATE}/session`)).toBe("session-2");
    },
  );

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

  it("decides each of Claude's own tool calls the bridge asks about with the Thread's plugin gate", {
    timeout: 30_000,
  }, async () => {
    const guest = await createGuest();
    // The bridge prints a dx_hook line per PreToolUse request and waits for
    // dx's decision file; here the CLI prints them as the bridge would.
    const hook = (id: string, command: string) =>
      line({
        type: "dx_hook",
        tool_use_id: id,
        tool_name: "Bash",
        tool_input: { command },
      });
    await guest.script([
      init(),
      ...response("m1", [
        {
          id: "toolu_force",
          name: "Bash",
          input: { command: "git push --force" },
        },
        { id: "toolu_ls", name: "Bash", input: { command: "ls" } },
      ]),
      "#wait gate-set",
      hook("toolu_force", "git push --force"),
      "#wait .local/state/dx-claude-code/mcp/hooks/toolu_force.json",
      toolResult("toolu_force", "Force pushes are blocked."),
      hook("toolu_ls", "ls"),
      "#wait .local/state/dx-claude-code/mcp/hooks/toolu_ls.json",
      toolResult("toolu_ls", "README.md"),
      ...response("m2", [{ text: "Done." }]),
      result("Done."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const tools = claudeCodeMirrorTools(claude.threadId);
    expect(
      await claude.answer({
        messages: [user("Push, then list", 80)],
        tools: tools.map(({ name, description }) => ({
          name,
          description,
          parameters: { type: "object" } as never,
        })),
      }),
    ).toMatchObject({ type: "done", reason: "toolUse" });
    const asked: Array<string> = [];
    setClaudeCodeToolGate(claude.threadId, async (request) => {
      asked.push(`${request.toolName}:${String(request.input.command)}`);
      return String(request.input.command).includes("--force")
        ? { decision: "deny", reason: "Force pushes are blocked." }
        : { decision: "allow", input: { command: "ls -1" } };
    });
    guest.release("gate-set");
    try {
      const bash = tools.find(({ name }) => name === "Bash");
      const run = (toolCallId: string) =>
        bash?.run({
          toolCallId,
          signal: AbortSignal.timeout(15_000),
          harness: { sandbox: guest.sandbox },
          log: console,
        } as never);
      // A denied call reaches the mirror as Claude's error result.
      await expect(run("toolu_force")).resolves.toBe(
        "Force pushes are blocked.",
      );
      await expect(run("toolu_ls")).resolves.toBe("README.md");
    } finally {
      setClaudeCodeToolGate(claude.threadId, undefined);
    }
    expect(asked).toEqual(["Bash:git push --force", "Bash:ls"]);
    expect(
      JSON.parse(guest.file(`${STATE}/mcp/hooks/toolu_force.json`) ?? "null"),
    ).toEqual({ decision: "deny", reason: "Force pushes are blocked." });
    expect(
      JSON.parse(guest.file(`${STATE}/mcp/hooks/toolu_ls.json`) ?? "null"),
    ).toEqual({ decision: "allow", input: { command: "ls -1" } });
  });

  it("gates Claude's own tools end to end: the bridge registers the hook, dx decides each call, Claude Code acts on the answer", {
    timeout: 60_000,
  }, async () => {
    const guest = await createGuest({ claudeProgram: PROTOCOL_CLAUDE });
    await guest.script([
      init(),
      ...response("m1", [
        {
          id: "toolu_push",
          name: "Bash",
          input: { command: "git push --force origin main" },
        },
        { id: "toolu_ls", name: "Bash", input: { command: "ls" } },
      ]),
      "#hook toolu_push",
      "#hook toolu_ls",
      ...response("m2", [{ text: "Done." }]),
      result("Done."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    const asked: Array<string> = [];
    // The Thread's plugins: force pushes are rejected, ls is rewritten.
    setClaudeCodeToolGate(claude.threadId, async (request) => {
      asked.push(`${request.toolName}:${String(request.input.command)}`);
      return String(request.input.command).includes("--force")
        ? {
            decision: "deny",
            reason: "Blocked by Push Guard: no force pushes.",
          }
        : { decision: "allow", input: { command: "ls -1" } };
    });
    try {
      const tools = claudeCodeMirrorTools(claude.threadId);
      expect(
        await claude.answer({
          messages: [user("Push, then list", 90)],
          tools: tools.map(({ name, description }) => ({
            name,
            description,
            parameters: { type: "object" } as never,
          })),
        }),
      ).toMatchObject({ type: "done", reason: "toolUse" });
      const bash = tools.find(({ name }) => name === "Bash");
      const run = (toolCallId: string) =>
        bash?.run({
          toolCallId,
          signal: AbortSignal.timeout(30_000),
          harness: { sandbox: guest.sandbox },
          log: console,
        } as never);
      // Claude Code never ran the push: its result is the plugin's reason.
      await expect(run("toolu_push")).rejects.toThrow(
        "Blocked by Push Guard: no force pushes.",
      );
      // It ran ls with the input the plugin's modify gave.
      await expect(run("toolu_ls")).resolves.toBe("ran: ls -1");
    } finally {
      setClaudeCodeToolGate(claude.threadId, undefined);
    }
    expect(asked).toEqual(["Bash:git push --force origin main", "Bash:ls"]);
    // The bridge asked Claude Code for the hook, set to block on failure.
    expect(JSON.parse(guest.home("fake-initialize.json"))).toMatchObject({
      request: {
        subtype: "initialize",
        hooks: {
          PreToolUse: [
            { hookCallbackIds: ["dx-pre-tool-use"], onFailure: "block" },
          ],
        },
      },
    });
    expect(JSON.parse(guest.home("hook-toolu_push.json"))).toMatchObject({
      response: {
        response: {
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "Blocked by Push Guard: no force pushes.",
          },
        },
      },
    });
  });

  it("links the repository plugins' skills for Claude Code, as the dx agent mounts them, and drops them when a later turn has none", {
    timeout: 60_000,
  }, async () => {
    const guest = await createGuest({ claudeProgram: SKILLS_CLAUDE });
    const repo = `${GUEST_HOME}/workspace/repo`;
    const skill = (name: string, word: string) =>
      `---\nname: ${name}\ndescription: Use ${name}.\n---\n\nSay ${word}.\n`;
    // A committed plugin with two skills, one named like the repository's
    // own skill, which keeps its place.
    guest.write(
      `${repo}/.agents/plugins/release/skills/release-notes/SKILL.md`,
      skill("release-notes", "RELEASE-WORD"),
    );
    guest.write(
      `${repo}/.agents/plugins/release/skills/own/SKILL.md`,
      skill("own", "PLUGIN-OWN"),
    );
    guest.write(
      `${repo}/.agents/skills/own/SKILL.md`,
      skill("own", "REPO-OWN"),
    );
    const turn = async (
      timestamp: number,
      repositorySkills: ReadonlyArray<{ name: string; directory: string }>,
    ) => {
      const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
      claudeCodeProvider.rememberClaudeCodePrompt(
        claude.threadId,
        "dx's Claude Code prompt.",
        "",
        repositorySkills,
      );
      const done = await claude.answer({
        messages: [user("Which skills?", timestamp)],
      });
      expect(done).toMatchObject({ type: "done" });
      return JSON.parse(guest.home("skills-seen.json")) as Record<
        string,
        string
      >;
    };
    const plugin = `${repo}/.agents/plugins/release/skills`;
    const seen = await turn(95, [
      { name: "own", directory: `${plugin}/own` },
      // Neither may become a link: a path out of the checkout, and a name
      // the shell could misread.
      { name: "escape", directory: `${repo}/../../etc` },
      { name: "bad name", directory: `${plugin}/release-notes` },
      // Last, where an unterminated line would be dropped.
      { name: "release-notes", directory: `${plugin}/release-notes` },
    ]);
    expect(seen["release-notes"]).toBe("Say RELEASE-WORD.");
    expect(seen.own).toBe("Say REPO-OWN.");
    expect(Object.keys(seen)).not.toContain("escape");
    expect(Object.keys(seen)).not.toContain("bad name");
    // The link is relative, so it resolves in the local runtime's namespace.
    expect(
      await guest.sandbox.exec(
        `readlink ${GUEST_HOME}/.claude/skills/release-notes`,
      ),
    ).toMatchObject({
      stdout:
        "../../workspace/repo/.agents/plugins/release/skills/release-notes\n",
    });

    // The next submission loads no repository plugin (it was removed from
    // the repository, or the workspace turned them off): its skill goes,
    // though the folder is still on disk, and the repository's own stays.
    const after = await turn(96, []);
    expect(Object.keys(after)).not.toContain("release-notes");
    expect(after.own).toBe("Say REPO-OWN.");
  });

  it("starts Claude Code without the bridge's hook for a Thread whose plugins do not gate tool calls", async () => {
    const guest = await createGuest({ claudeProgram: PROTOCOL_CLAUDE });
    await guest.script([
      init(),
      ...response("m1", [{ text: "Hi." }]),
      result("Hi."),
    ]);
    const claude = claudeCode(createClaudeCodeProvider, guest.sandbox);
    // No gate, and no dx tools: the CLI runs without the bridge at all.
    await claude.answer({ messages: [user("Hi", 91)] }).catch(() => undefined);
    expect(guest.ops.some(({ path }) => path.includes("dx-hooks.json"))).toBe(
      false,
    );
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
    prefix = "Q9_",
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
      name: Schema.decodeUnknownSync(EnvironmentVariableName)(
        `${prefix}${index}`,
      ),
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
    prefix?: string,
  ) => {
    const guest = await createGuest();
    await guest.script(lines);
    const sandbox = await withExecutionEnvironment(
      { createSandbox: async () => guest.sandbox },
      async () => environment(secrets, prefix),
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

  it("reads a tool input where a lowercase-named secret matched outside a JSON string (#1165)", async () => {
    // A numeric secret also matches a bare JSON number in a tool input; its
    // marker must become `null` there whatever the case of the secret's name.
    const NUMBER = "31415926";
    const { content, events } = await record(
      "lowercase-named secret outside a string",
      fragmented([
        {
          id: "toolu_pin",
          name: "Bash",
          json: [`{"command": "true", "pin": ${NUMBER}}`],
        },
      ]),
      [NUMBER],
      "pin_",
    );
    expect(content).toEqual([
      {
        type: "toolCall",
        id: "toolu_pin",
        name: "Bash",
        arguments: { command: "true", pin: null },
      },
    ]);
    expect(events).not.toContain(NUMBER);
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
