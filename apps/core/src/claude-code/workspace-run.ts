import type { Sandbox } from "@flue/runtime";
import { BUILT_IN_SKILL_NAMES } from "../agents/built-in-skill-names.js";
import { encodeBase64 } from "../encoding/base64.js";
import { environmentSecretsOf } from "../settings/environment-variables/sandbox.js";
import { CLAUDE_CODE_MCP_SERVER } from "./mcp-server.js";
import { CHUNK_END_LINE, ClaudeCodeStream } from "./stream.js";

/**
 * One attempt at answering one user turn with the Claude Code CLI in the
 * Thread workspace. An attempt is `<turn>.<n>`: it starts at Flue segment
 * `base` of the turn, so a failed, stopped, or lost attempt is followed by
 * the next one resuming Claude's session from that segment. The CLI runs
 * detached, so a Durable Object restart, a Flue retry, or a tool batch never
 * starts an attempt twice; it reads one stream-json user message and exits
 * after its `result`. Its stdout is split into line-aligned chunk files read
 * with `readFile`, which bypasses the per-command activity and Changes
 * wrappers that every `exec` pays.
 */
const STATE_ROOT = "/home/user/.local/state/dx-claude-code";
export const claudeCodeRunsRoot = `${STATE_ROOT}/runs`;

/** Where dx writes a dx tool's result for the \`dx\` MCP server to return. */
export const claudeCodeToolResultPath = (toolCallId: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(toolCallId))
    throw new Error("Invalid Claude Code tool call id.");
  return `${STATE_ROOT}/mcp/results/${toolCallId}.json`;
};
const WORKSPACE = "/home/user/workspace/repo";
const CHUNK_BYTES = 65_536;
const POLL_MS = 250;
/** The runner rewrites its heartbeat every 5 s while the CLI lives. */
const HEARTBEAT_CHECK_MS = 5_000;
const HEARTBEAT_STALE_SECONDS = 90;
const HEARTBEAT_OBSERVED_MS = 15_000;
/**
 * Reads skip the activity wrapper, so a live run writes this often to keep
 * the sandbox from pausing under Claude while it works.
 */
const KEEP_ALIVE_MS = 60_000;
/** Settled run directories kept for tool-call lookups after a restart. */
const KEPT_RUNS = 20;
/**
 * A failed read of a run's status says nothing about the run; this long
 * without one that succeeds fails its reader.
 */
const UNREADABLE_MS = 60_000;
/**
 * A command line is one argument of at most 128 KiB, so a launch whose files
 * are larger writes them as one file first.
 */
const INLINE_LAUNCH_BYTES = 96 * 1024;

export const CLAUDE_CODE_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "NotebookEdit",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "DesignSync",
  "SendMessage",
  "ListAgents",
  "PushNotification",
  "ShareOnboardingGuide",
];

/**
 * Command-line settings outrank a repository's `.claude` settings, whose
 * `env` could otherwise send the plan token to another endpoint, through an
 * intercepting proxy, or to another provider, or run the turn on a token of
 * its own. The plan token is read from descriptor 3 (see the runner).
 */
const CLI_SETTINGS = JSON.stringify({
  env: {
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    ALL_PROXY: "",
    https_proxy: "",
    http_proxy: "",
    all_proxy: "",
    NODE_EXTRA_CA_CERTS: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  },
});

/** Claude Code settings pinned for unattended runs. */
const CLI_ENVIRONMENT = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  // A run ends with its turn, so subagents run in the foreground: the Agent
  // call returns the subagent's report, and its steps stream with the run.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  // Claude Code refuses unattended permissions as root outside a sandbox.
  IS_SANDBOX: "1",
  // A dx tool may run as long as the turn; the dx MCP server bounds the wait.
  MCP_TOOL_TIMEOUT: String(31 * 60_000),
  MCP_TIMEOUT: "30000",
};

/**
 * The oldest Claude Code dx runs: the first release that accepts every flag
 * dx passes (`--effort` arrived in 2.1.38). It also reads the plan token from
 * a descriptor, which Claude Code has done since 1.0.109.
 */
const CLAUDE_CODE_MIN_VERSION = "2.1.38";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export type ClaudeCodeInputBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

/** A dx tool as the \`dx\` MCP server lists it. */
export interface ClaudeCodeDxTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ClaudeCodeLaunch {
  readonly model: string;
  readonly effort: string;
  readonly systemPrompt: string;
  readonly input: ReadonlyArray<ClaudeCodeInputBlock>;
  readonly token: string;
  /** dx's own tools, served to Claude by the \`dx\` MCP server. */
  readonly tools: ReadonlyArray<ClaudeCodeDxTool>;
}

export const claudeCodeRunKey = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

export const claudeCodeAttemptKey = (turn: string, attempt: number) =>
  `${turn}.${attempt}`;

/** `<turn>.<n>` → n, for directory names of the given turn. */
export const claudeCodeAttemptNumber = (turn: string, name: string) => {
  if (!name.startsWith(`${turn}.`)) return undefined;
  const value = name.slice(turn.length + 1);
  return /^\d{1,4}$/.test(value) ? Number(value) : undefined;
};

const chunkName = (index: number) => `c${String(index).padStart(6, "0")}`;

/**
 * Shell that writes each file into the attempt directory `$D`; base64, so
 * no content is ever read as shell or rewritten by the local runtime's
 * command-text path mapping.
 */
const launchFiles = (files: Readonly<Record<string, string>>) =>
  Object.entries(files)
    .map(
      ([name, content]) =>
        `base64 -d > "$D/${name}" <<'DX_FILE'\n${(
          encodeBase64(new TextEncoder().encode(content)).match(/.{1,76}/g) ??
            []
        ).join("\n")}\nDX_FILE`,
    )
    .join("\n");

const LAUNCH_FILES = "launch-files.sh";

const launchScript = (
  dir: string,
  launch: ClaudeCodeLaunch,
  /** The files' shell, or undefined when it was written to LAUNCH_FILES. */
  files: string | undefined,
) => {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    launch.model,
    "--effort",
    launch.effort,
    "--permission-mode",
    "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--setting-sources",
    "user,project,local",
    "--disallowedTools",
    CLAUDE_CODE_DISALLOWED_TOOLS.join(","),
    "--settings",
    CLI_SETTINGS,
  ]
    .map(quote)
    .join(" ");
  return `# The plan token arrives in this command's environment, which every process
# of the workspace user can read through /proc while the process lives, and
# which children inherit. It moves into a pipe on descriptor 3 and this
# script restarts without it; the CLI alone reads the pipe, once.
if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN-}" ]; then
  exec 3< <(printf '%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN")
  unset CLAUDE_CODE_OAUTH_TOKEN
  exec bash -c "$BASH_EXECUTION_STRING"
fi
set -eu
D=${quote(dir)}
S=${quote(STATE_ROOT)}
mkdir -p "$D"
if [ -e "$D/pid" ]; then echo running; exit 0; fi
# Stopped before it started: never start it.
if [ -e "$D/exit" ]; then echo stopped; exit 0; fi
# A launch that fails before the CLI starts records its exit code, so the
# next call starts another attempt instead of waiting on this one.
launched=""
finish() {
  code=$?
  if [ -z "$launched" ] && [ "$code" -ne 0 ] && [ ! -e "$D/exit" ]; then echo "$code" > "$D/exit"; fi
}
trap finish EXIT
${files ?? `. "$D/${LAUNCH_FILES}"`}
# A recorded PID is killed only while it is still that run's runner: after a
# container restart the number can belong to any process.
ours() { tr '\\0' ' ' < "/proc/$2/cmdline" 2>/dev/null | grep -qF "$1/runner.sh"; }
# One Claude run per Thread: a new turn or attempt ends any other live run,
# including one a restarted Durable Object no longer knows about.
for other in "$S"/runs/*/; do
  o="\${other%/}"
  [ "$o" = "$D" ] && continue
  if [ -f "$o/pid" ] && [ ! -f "$o/exit" ]; then
    : > "$o/stopped"
    p="$(cat "$o/pid")"
    if ours "$o" "$p"; then kill -TERM -- "-$p" 2>/dev/null || true; fi
    [ -f "$o/exit" ] || echo 143 > "$o/exit"
  fi
done
# Keep the newest settled runs; older ones only cost disk and lookups.
ls -1t "$S/runs" 2>/dev/null | tail -n +${KEPT_RUNS + 1} | while read -r n; do
  [ -f "$S/runs/$n/exit" ] && rm -rf "$S/runs/$n"
done
# A workspace image or a repository's setup can carry an older Claude Code;
# one older than ${CLAUDE_CODE_MIN_VERSION} is replaced as a missing one is installed.
version() { "$1" --version 2>/dev/null < /dev/null 3<&- | sed -n '1s/^\\([0-9][0-9.]*\\).*/\\1/p'; }
current() {
  v="$(version "$1")"
  [ -n "$v" ] && [ "$(printf '%s\\n%s\\n' ${CLAUDE_CODE_MIN_VERSION} "$v" | sort -V | head -n 1)" = ${CLAUDE_CODE_MIN_VERSION} ]
}
CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ]; then CLAUDE="$HOME/.local/bin/claude"; fi
OUTDATED=""
if [ -n "$CLAUDE" ] && ! current "$CLAUDE"; then
  OUTDATED="$(version "$CLAUDE")"
  OUTDATED="Claude Code \${OUTDATED:-of an unknown version} is older than ${CLAUDE_CODE_MIN_VERSION}, the oldest dx can run, and could not be updated. Run \\\`claude update\\\` in the workspace's terminal, then retry."
  CLAUDE=""
  if current "$HOME/.local/bin/claude"; then CLAUDE="$HOME/.local/bin/claude"; fi
fi
if [ -z "$CLAUDE" ]; then
  CLAUDE="$HOME/.local/bin/claude"
  if ! (set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash) > "$D/install.log" 2>&1 3<&- || ! current "$CLAUDE"; then
    { echo "\${OUTDATED:-Claude Code could not be installed.}"; tail -n 20 "$D/install.log"; } | tee "$D/stderr.log" >&2
    exit 3
  fi
fi
RESUME=""
if [ -s "$S/session" ]; then RESUME="--resume $(cat "$S/session")"; : > "$D/resumed"; fi
# Claude Code reads skills from ~/.claude/skills, not the repository's .agents.
# dx's built-in skills come first; a repository skill with a built-in name is
# skipped, as for the dx agent. Links are relative, so they resolve inside the
# local runtime's namespace too.
mkdir -p "$HOME/.claude/skills"
find "$HOME/.claude/skills" -maxdepth 1 -xtype l -delete
for skill in "$HOME/.local/share/dx/skills"/*/; do
  name=$(basename "$skill")
  [ -f "$skill/SKILL.md" ] && ln -sfn "../../.local/share/dx/skills/$name" "$HOME/.claude/skills/$name"
done
if [ -d ${quote(`${WORKSPACE}/.agents/skills`)} ]; then
  for skill in ${quote(`${WORKSPACE}/.agents/skills`)}/*/; do
    name=$(basename "$skill")
    case " ${[...BUILT_IN_SKILL_NAMES].join(" ")} " in *" $name "*) continue ;; esac
    [ -f "$skill/SKILL.md" ] && ln -sfn "../../workspace/repo/.agents/skills/$name" "$HOME/.claude/skills/$name"
  done
fi
# The plan token is the only credential Claude Code may use. Workspace
# variables could otherwise switch it to an API key or another provider, or
# send the token to another endpoint.
for name in $(env | sed -n 's/^\\(ANTHROPIC_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(CLAUDE_CODE_USE_[A-Za-z0-9_]*\\)=.*/\\1/p'); do
  unset "$name"
done
unset NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS CLAUDE_CONFIG_DIR
cd ${quote(WORKSPACE)}
setsid nohup bash "$D/runner.sh" "$CLAUDE" ${args} $RESUME > /dev/null 2>&1 < /dev/null &
echo $! > "$D/pid"
launched=1
echo started`;
};

/**
 * Runs the CLI, keeps a heartbeat while it lives, and splits its stdout into
 * chunks; every full chunk ends with a marker line. It is written as a file,
 * so the local development runtime's command-text path mapping never
 * rewrites it. That runtime maps the guest home onto a directory of the
 * checkout; there the CLI runs in a private mount namespace with the
 * Thread's home bound at /home/user, so Claude sees and touches exactly the
 * paths it would on a guest.
 */
const RUNNER = `#!/bin/bash
set -o pipefail
D="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$1"
shift
# Descriptor 3 holds the plan token for the CLI; nothing else keeps it.
( while :; do date +%s > "$D/alive.tmp" && mv "$D/alive.tmp" "$D/alive"; sleep 5; done ) 3<&- &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null' EXIT
GUEST=/home/user
# Paths as Claude sees them: inside the local runtime's namespace the
# Thread's home is /home/user.
SEEN="$D"
if [ "$HOME" != "$GUEST" ] && unshare --user --map-root-user --mount true 2>/dev/null; then
  if [ ! -d "$GUEST" ]; then
    echo "Local Claude Code mode needs a $GUEST directory on this machine to mount the Thread's home." > "$D/stderr.log"
    echo 1 > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"
    exit 1
  fi
  SEEN="$GUEST\${D#"$HOME"}"
fi
# dx's own tools, through the dx MCP server. Inside the local runtime's
# namespace the developer's home is hidden, so its Python is skipped.
MCP=()
PYTHON=""
for candidate in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 || true)"; do
  [ -n "$candidate" ] || continue
  if [ "$SEEN" != "$D" ]; then case "$candidate" in "$GUEST"/*) continue ;; esac; fi
  if [ -x "$candidate" ]; then PYTHON="$candidate"; break; fi
done
if [ -s "$D/dx-tools.json" ] && [ -n "$PYTHON" ]; then
  STATE="\${SEEN%/runs/*}"
  printf '{"mcpServers":{"dx":{"type":"stdio","command":"%s","args":["-I","%s/dx-mcp.py","%s/dx-tools.json","%s/mcp"],"alwaysLoad":true}}}' \\
    "$PYTHON" "$SEEN" "$SEEN" "$STATE" > "$D/mcp.json"
  MCP=(--mcp-config "$SEEN/mcp.json")
fi
if [ "$SEEN" != "$D" ]; then
  PROMPT="$SEEN/prompt.txt"
  run() {
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 unshare --user --map-root-user --mount bash -c '
      bin="$HOME/.local/state/dx-claude-code/bin" &&
        mkdir -p "$bin" &&
        { [ -f "$bin/claude" ] || : > "$bin/claude"; } &&
        mount --bind "$0" "$bin/claude" &&
        mount --rbind "$HOME" /home/user &&
        export HOME=/home/user &&
        cd /home/user/workspace/repo &&
        exec /home/user/.local/state/dx-claude-code/bin/claude "$@"
    ' "$(readlink -f "$CLAUDE")" "$@" --append-system-prompt-file "$PROMPT"
  }
else
  run() { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 "$CLAUDE" "$@" --append-system-prompt-file "$D/prompt.txt"; }
fi
# mawk, the sandbox image's awk, reads a pipe in large blocks unless
# interactive; Claude's output would then arrive only when the run exits.
# The banner is read whole: under pipefail, \`grep -q\` stopping at its first
# line can fail the version command with SIGPIPE and miss mawk.
AWK=(awk)
case "$(awk -W version 2>&1)" in *mawk*) AWK=(awk -W interactive) ;; esac
run "$@" "\${MCP[@]}" < "$D/input.jsonl" 2> "$D/stderr.log" |
  "\${AWK[@]}" -v dir="$D" -v end='${CHUNK_END_LINE}' 'BEGIN { n = 0; size = 0; f = sprintf("%s/c%06d", dir, n) }
    { print > f; fflush(f); size += length($0) + 1
      if (size >= ${CHUNK_BYTES}) { print end > f; close(f); n++; size = 0; f = sprintf("%s/c%06d", dir, n) } }' 3<&-
echo $? > "$D/exit.tmp"
mv "$D/exit.tmp" "$D/exit"
`;

export class ClaudeCodeRun {
  readonly stream = new ClaudeCodeStream();
  readonly dir: string;
  #base: number | undefined;
  #chunk = 0;
  /** Complete lines of the current chunk already consumed. */
  #lines = 0;
  #exited = false;
  #dead = false;
  #sessionRecorded = false;
  #polling: Promise<boolean> | undefined;
  #beat: string | undefined;
  #beatChangedAt = Date.now();
  #beatCheckedAt = 0;
  #keptAliveAt = 0;
  /** When the current run of failed status reads began. */
  #unreadableSince: number | undefined;

  constructor(
    readonly key: string,
    private readonly sandbox: Sandbox,
    base?: number,
  ) {
    this.dir = `${claudeCodeRunsRoot}/${key}`;
    this.#base = base;
  }

  /** Nothing of this run has been read yet. */
  get unread() {
    return this.#chunk === 0 && this.#lines === 0;
  }

  /**
   * A separate reader of this run that starts at chunk `index`, for a
   * lookup that needs only what Claude wrote from there on.
   */
  readerFrom(index: number) {
    const reader = new ClaudeCodeRun(this.key, this.sandbox, this.#base);
    reader.#chunk = index;
    return reader;
  }

  /** The turn's Flue segment this attempt's first segment answers. */
  async base() {
    if (this.#base === undefined) {
      const recorded = Number(
        await this.sandbox.readFile(`${this.dir}/base`).catch(() => "0"),
      );
      this.#base = Number.isInteger(recorded) && recorded >= 0 ? recorded : 0;
    }
    return this.#base;
  }

  /** The process is gone: it wrote its exit marker or stopped beating. */
  get exited() {
    return this.#exited;
  }

  get dead() {
    return this.#dead;
  }

  /**
   * Writes the attempt's files and starts the CLI in one command; an attempt
   * an earlier call already launched is left alone.
   */
  async launch(launch: ClaudeCodeLaunch, signal?: AbortSignal) {
    let files: string | undefined = launchFiles({
      base: String(this.#base ?? 0),
      "prompt.txt": launch.systemPrompt,
      "runner.sh": RUNNER,
      ...(launch.tools.length > 0
        ? {
            "dx-tools.json": JSON.stringify(launch.tools),
            "dx-mcp.py": CLAUDE_CODE_MCP_SERVER,
          }
        : {}),
      "input.jsonl": `${JSON.stringify({
        type: "user",
        message: { role: "user", content: launch.input },
        parent_tool_use_id: null,
        session_id: "",
      })}\n`,
    });
    if (files.length > INLINE_LAUNCH_BYTES) {
      await this.sandbox.writeFile(`${this.dir}/${LAUNCH_FILES}`, files);
      files = undefined;
    }
    const result = await this.sandbox.exec(
      `bash -c ${quote(launchScript(this.dir, launch, files))}`,
      {
        env: { ...CLI_ENVIRONMENT, CLAUDE_CODE_OAUTH_TOKEN: launch.token },
        timeoutMs: 180_000,
        signal,
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Claude Code could not start.",
      );
  }

  async #read(path: string) {
    try {
      return await this.sandbox.readFileBuffer(path);
    } catch {
      return undefined;
    }
  }

  /**
   * Reads newly written output; true when anything was consumed. The model
   * stream and every waiting tool share one reader, so reads never overlap.
   */
  poll(): Promise<boolean> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  async #poll(): Promise<boolean> {
    let progressed = false;
    for (;;) {
      const bytes = await this.#read(`${this.dir}/${chunkName(this.#chunk)}`);
      if (bytes === undefined) break;
      this.stream.secrets = await environmentSecretsOf(this.sandbox);
      // Reads are redacted: a secret becomes one byte, so positions are
      // counted in lines, which redaction never adds or removes.
      const lines = new TextDecoder().decode(bytes).split("\n");
      const complete = lines.slice(0, -1);
      let ended = false;
      for (const line of complete.slice(this.#lines)) {
        this.#lines += 1;
        progressed = true;
        if (line === CHUNK_END_LINE) {
          ended = true;
          break;
        }
        this.stream.push(line);
      }
      if (!ended) break;
      this.#chunk += 1;
      this.#lines = 0;
    }
    if (progressed) this.#unreadableSince = undefined;
    if (!progressed && !this.#exited && !this.stream.finished) {
      const exited = await this.#status(() =>
        this.sandbox.exists(`${this.dir}/exit`),
      );
      if (exited !== undefined) this.#exited = exited;
      if (exited === false) await this.#checkHeartbeat();
    }
    if (
      !this.#exited &&
      !this.stream.finished &&
      Date.now() - this.#keptAliveAt >= KEEP_ALIVE_MS
    ) {
      this.#keptAliveAt = Date.now();
      await this.sandbox
        .writeFile(`${this.dir}/seen`, String(this.#keptAliveAt))
        .catch(() => {});
    }
    if (!this.#sessionRecorded && this.stream.sessionId !== undefined) {
      this.#sessionRecorded = true;
      await this.sandbox
        .writeFile(`${STATE_ROOT}/session`, this.stream.sessionId)
        .catch(() => {
          this.#sessionRecorded = false;
        });
    }
    return progressed;
  }

  /**
   * Reads part of the run's status. A failed read is no answer, never a
   * stale or missing one; failures that last UNREADABLE_MS fail the reader.
   */
  async #status<A>(read: () => Promise<A>): Promise<A | undefined> {
    try {
      const value = await read();
      this.#unreadableSince = undefined;
      return value;
    } catch (error) {
      const now = Date.now();
      this.#unreadableSince ??= now;
      if (now - this.#unreadableSince >= UNREADABLE_MS)
        throw new Error(
          `Claude Code's run could not be read for a minute: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      return undefined;
    }
  }

  /**
   * A process lost with its sandbox (a container restart keeps only files)
   * never writes its exit marker; a heartbeat that stays old marks it dead.
   */
  async #checkHeartbeat() {
    const now = Date.now();
    if (now - this.#beatCheckedAt < HEARTBEAT_CHECK_MS) return;
    this.#beatCheckedAt = now;
    const path = `${this.dir}/alive`;
    const beat = await this.#status(async () => {
      try {
        return (await this.sandbox.readFile(path)).trim();
      } catch (error) {
        // Only a heartbeat known to be missing reads as none.
        if (await this.sandbox.exists(path)) throw error;
        return "";
      }
    });
    if (beat === undefined) return;
    if (beat !== this.#beat) {
      this.#beat = beat;
      this.#beatChangedAt = now;
      return;
    }
    const seconds = Number(beat);
    const stale =
      !Number.isFinite(seconds) ||
      now / 1000 - seconds > HEARTBEAT_STALE_SECONDS;
    if (stale && now - this.#beatChangedAt >= HEARTBEAT_OBSERVED_MS) {
      this.#dead = true;
      this.#exited = true;
    }
  }

  /**
   * Reads everything written so far and whether the process is gone, for a
   * decision that must not mistake a stopped attempt for a running one.
   */
  async settle() {
    while (await this.poll()) {}
    if (!this.#exited && !this.stream.finished)
      this.#exited =
        (await this.#status(() => this.sandbox.exists(`${this.dir}/exit`))) ??
        false;
    // The last lines can land just before the exit marker that ended the
    // loop above; one more read keeps a finished run from looking lost.
    if (this.#exited) while (await this.poll()) {}
  }

  /** Polls until `ready` holds, the run ends, or the signal aborts. */
  async waitFor(ready: () => boolean, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      const progressed = await this.poll();
      if (ready()) return;
      if (this.stream.finished) return;
      // The exit marker lands after the last chunk is flushed; one more read
      // drains it.
      if (this.#exited) {
        await this.poll();
        return;
      }
      if (!progressed) await sleep(POLL_MS, signal);
    }
  }

  /** Whether this attempt resumed a recorded Claude session. */
  resumed() {
    return this.sandbox.exists(`${this.dir}/resumed`);
  }

  /**
   * dx stopped this attempt. Claude Code may still answer a SIGTERM with a
   * successful result, so that result does not finish the turn.
   */
  stopped() {
    return this.sandbox.exists(`${this.dir}/stopped`);
  }

  /**
   * Whether the run's process is gone without writing its exit marker, as
   * when its workspace cold-boots and only files survive. A lost run is
   * recorded as killed (137), so its Claude session is resumed. A failed
   * check says nothing and counts as live.
   */
  async lost() {
    if (this.#exited || this.stream.finished) return false;
    const result = await this.sandbox
      .exec(
        `bash -c ${quote(`D=${quote(this.dir)}
pid=$(cat "$D/pid" 2>/dev/null || true)
if [ -f "$D/exit" ] || [ -z "$pid" ] || tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$D/runner.sh"; then echo live; exit 0; fi
echo 137 > "$D/exit"
echo lost`)}`,
        { timeoutMs: 15_000 },
      )
      .catch(() => undefined);
    if (result?.stdout.trim() !== "lost") return false;
    this.#dead = true;
    this.#exited = true;
    return true;
  }

  /** It wrote an exit code other than a stop's SIGTERM or SIGKILL. */
  async exitedOnItsOwn() {
    if (await this.stopped()) return false;
    const code = (
      await this.sandbox.readFile(`${this.dir}/exit`).catch(() => "")
    ).trim();
    return code !== "" && code !== "143" && code !== "137";
  }

  /** Forget a session Claude could not resume, so the next attempt starts one. */
  async forgetSession() {
    await this.sandbox.writeFile(`${STATE_ROOT}/session`, "").catch(() => {});
  }

  /** The CLI's stderr tail, for a run that ended without a result. */
  async stderrTail() {
    try {
      return (await this.sandbox.readFile(`${this.dir}/stderr.log`))
        .trim()
        .split("\n")
        .slice(-20)
        .join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Stops the run unless it already exited. Given a tool call id, also
   * answers with the first chunk that names it.
   */
  async stop(locate?: string) {
    const find =
      locate !== undefined && /^[A-Za-z0-9_-]+$/.test(locate)
        ? `\ngrep -l -F -- ${quote(locate)} "$D"/c[0-9]* 2>/dev/null | head -n 1`
        : "";
    const result = await this.sandbox
      .exec(
        `bash -c ${quote(`D=${quote(this.dir)}
if [ ! -f "$D/exit" ]; then
  : > "$D/stopped"
  pid=$(cat "$D/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$D/runner.sh"; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  [ -f "$D/exit" ] || echo 143 > "$D/exit"
fi${find}`)}`,
        { timeoutMs: 15_000 },
      )
      .catch(() => undefined);
    this.#exited = true;
    const chunk = /\/c(\d{6})\s*$/.exec(result?.stdout ?? "")?.[1];
    return chunk === undefined ? undefined : Number(chunk);
  }

  /**
   * One cheap command through the workspace wrappers so the Changes
   * coordinator captures what Claude's own tools wrote.
   */
  async syncChanges() {
    await this.sandbox.exec("true", { timeoutMs: 30_000 }).catch(() => {});
  }
}
