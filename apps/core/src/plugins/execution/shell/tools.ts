import { Type } from "@earendil-works/pi-ai";
import type { Sandbox, SandboxToolFactory } from "@flue/runtime";
import { shellDefinitions } from "./definitions.js";

type AgentTool = ReturnType<SandboxToolFactory>[number];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const shellWaitMs = (value?: number) =>
  value === undefined || !Number.isFinite(value)
    ? 10_000
    : Math.min(60_000, Math.max(0, Math.floor(value)));

// Each read keeps at most the last 51,200 bytes and 2,000 lines. The cursor
// advances past discarded bytes too. Guest log files themselves are retained.
const readScript = (wait: number) => `
deadline=$(( $(date +%s%3N) + ${wait} ))
while [[ ! -f "$state/exit" && $(date +%s%3N) -lt $deadline ]]; do sleep 0.1; done
# Serialize readers so concurrent calls cannot return the same bytes.
while ! mkdir "$state/read-lock" 2>/dev/null; do sleep 0.1; done
trap 'rmdir "$state/read-lock"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cursor=$(cat "$state/cursor")
running=true; code=
if [[ -f "$state/exit" ]]; then running=false; code=$(cat "$state/exit"); fi
size=$(stat -c %s "$state/output")
start=$cursor
(( size - start > 51200 )) && start=$((size - 51200))
dd if="$state/output" bs=1 skip="$start" count="$((size-start))" status=none | tail -n 2000 > "$state/read"
kept=$(stat -c %s "$state/read")
truncated=0
(( kept < size - cursor )) && truncated=1
printf '%s' "$size" > "$state/cursor"
printf '%s\\n%s\\n%s\\n%s\\n' "$pid" "$running" "$code" "$truncated"
cat "$state/read"
`;

const runner = `state="$1"
printf '%s' "$$" > "$state/pid"
finish() { printf '%s' "$1" > "$state/exit.tmp"; mv "$state/exit.tmp" "$state/exit"; }
trap 'finish 143; exit 143' TERM
trap 'finish 129; exit 129' HUP
bash "$state/command" > "$state/output" 2>&1 &
wait $!
finish $?
`;

export const createShellTools = (
  sandbox: Sandbox,
  options?: { defaultWorkdir?: string },
): AgentTool[] =>
  shellDefinitions.map((definition, index) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: Type.Unsafe<{
      command: string;
      workdir?: string;
      timeout_ms?: number;
      pid: number;
    }>(definition.parameters),
    async execute(_toolCallId, input, signal) {
      const params = input as {
        command: string;
        workdir?: string;
        timeout_ms?: number;
        pid: number;
      };
      signal?.throwIfAborted();
      const wait = index === 2 ? 2000 : shellWaitMs(params.timeout_ms);
      const prefix = `umask 077\nroot="$HOME/.local/state/dx-shell"\n`;
      let script: string;
      if (index === 0) {
        const cwd = params.workdir ?? options?.defaultWorkdir ?? sandbox.cwd;
        script = `${prefix}
[[ -d ${quote(cwd)} ]] || { echo 'Working directory does not exist:' ${quote(cwd)} >&2; exit 1; }
cd -- ${quote(cwd)} || exit 1
mkdir -p "$root"
state=$(mktemp -d "$root/start.XXXXXXXXXX")
printf '%s' ${quote(params.command)} > "$state/command"
printf '%s' ${quote(runner)} > "$state/runner"
: > "$state/output"; echo 0 > "$state/cursor"
nohup setsid bash "$state/runner" "$state" </dev/null >/dev/null 2>&1 &
while [[ ! -f "$state/pid" ]]; do sleep 0.01; done
pid=$(cat "$state/pid")
# The runner keeps its initial path; the public pid path is a durable alias.
ln -s "$state" "$root/$pid" || exit 1
${readScript(wait)}`;
      } else {
        if (!Number.isSafeInteger(params.pid) || params.pid <= 0) {
          throw new Error("Unknown shell process pid");
        }
        script = `${prefix}
pid=${params.pid}
state="$root/$pid"
[[ -d "$state" ]] || { echo "Unknown shell process pid: $pid" >&2; exit 1; }
${
  index === 2
    ? `
if [[ ! -f "$state/exit" ]]; then
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 1
  if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  # SIGKILL cannot run the runner's exit trap.
  if [[ ! -f "$state/exit" ]]; then echo 137 > "$state/exit"; fi
fi
`
    : ""
}
${readScript(index === 2 ? 1000 : wait)}`;
      }
      const result = await sandbox.exec(`bash -c ${quote(script)}`, {
        timeoutMs: wait + 5000,
        signal,
      });
      signal?.throwIfAborted();
      if (result.exitCode !== 0)
        throw new Error(
          result.stderr || result.stdout || "Shell process operation failed",
        );
      const [pidText, runningText, codeText, truncated, ...outputLines] =
        result.stdout.split("\n");
      const pid = Number(pidText);
      const running = runningText === "true";
      const exitCode = running ? undefined : Number(codeText);
      // Keep output plaintext so the sandbox's secret-redaction wrapper can
      // redact admitted environment values before they reach the model.
      const output =
        (truncated === "1"
          ? "[Output truncated to last 50 KB / 2,000 lines]\n"
          : "") + outputLines.join("\n");
      const lines: string[] = [];
      if (output || !running) lines.push(`<output>${output}</output>`);
      if (!running) lines.push(`<exitCode>${exitCode}</exitCode>`);
      if (running || index !== 0)
        lines.push(`<running>${running}</running>`, `<pid>${pid}</pid>`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { pid, running, exitCode },
      };
    },
  }));
