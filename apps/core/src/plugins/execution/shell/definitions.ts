export const shellDefinitions = [
  {
    name: "shell_command",
    description: `Runs a shell command.
- Always set the \`workdir\` param when using the shell_command function. Do not use \`cd\` unless absolutely necessary. For manual file edits, use your file editing tool instead of Python or JavaScript scripts
- \`workdir\` must already exist before the command starts and must remain present for the whole command. Create it in a prior shell_command from an existing parent directory; do not delete it during the command.
- This tool can run long-lived/background processes such as dev servers, watchers, test runs, log tails, and scripts that may take a while.
- \`timeout_ms\` controls how long this tool waits for the command before returning. It never stops the command. The default is 10000 milliseconds (10 seconds); valid values are 0 through 60000 milliseconds.
- Keep the default timeout for quick commands. When waiting on a slower command's result, set \`timeout_ms\` to its expected duration, up to 60000. This tool returns as soon as the process exits; use short waits only when you will do other work before checking again. Apply the same rule to shell_command_status.
- If the command is still running after \`timeout_ms\`, this tool returns with \`running: true\` and a \`pid\`. This is normal for slow commands, not an error. The process continues in the background while you inspect files, edit code, or run other tools.
- To check a background process, call shell_command_status with the returned \`pid\`. Do not rerun the original command just to get more output.
- Avoid \`pkill -f\`: its pattern can match this tool's own shell and terminate the tool. Stop tracked background commands with shell_command_kill; for other processes, use the target service's stop command or a pidfile.
- Do not run \`kill <pid>\` through this tool. If a background process looks hung (no new output across repeated shell_command_status checks and it is not expected to be long-running), stop it with shell_command_kill.`,
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        workdir: {
          type: "string",
          description:
            "Optional working directory to run the command in; defaults to the turn cwd.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Milliseconds to wait for command completion before returning, from 0 to 60000. Defaults to 10000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shell_command_status",
    description: `Waits for and gets new output from a background process started by shell_command.
- Use this tool after shell_command returned \`running: true\` and a \`pid\`.
- Pass the PID returned by shell_command. This follows the existing process; it does not start or restart the command.
- It returns output produced since the last shell_command/shell_command_status read for that process, plus whether it is still running.
- \`timeout_ms\` controls how long to wait for new output or process completion. The default is 10000 milliseconds (10 seconds); valid values are 0 through 60000 milliseconds. While waiting, this tool streams new process output as progress.
- Returning with \`running: true\` again is normal for slow or long-lived commands. Keep checking. Only if repeated checks show no new output and the process is not expected to be long-running, stop it with shell_command_kill.`,
    parameters: {
      type: "object",
      required: ["pid"],
      properties: {
        pid: { type: "number", description: "PID returned by shell_command." },
        timeout_ms: {
          type: "number",
          description:
            "Milliseconds to wait for process completion while streaming new output as progress, from 0 to 60000. Defaults to 10000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shell_command_kill",
    description: `Stops a hung background process started by shell_command.
- Only use this when the process appears hung: repeated shell_command_status checks returned \`running: true\` with no new output, and the command is not one you expect to run long (test suites, builds, installs, dev servers, watchers, and log tails should be left running).
- Never use this as a routine step just because shell_command or shell_command_status returned after \`timeout_ms\`. That only means the wait ended, not that the process is stuck.
- Use this instead of running \`kill <pid>\` through this tool. It signals the process directly without starting a new shell, so it works even when the machine is overloaded and new commands are slow to start.
- Pass the PID returned by shell_command. The process and its children receive SIGTERM, then SIGKILL if still running about one second later. This tool waits up to two seconds for the process to exit and then returns its unread output and final status, like shell_command_status.
- If \`running\` is still true afterwards, check again with shell_command_status; do not rerun the command.`,
    parameters: {
      type: "object",
      required: ["pid"],
      properties: {
        pid: { type: "number", description: "PID returned by shell_command." },
      },
      additionalProperties: false,
    },
  },
] as const;
