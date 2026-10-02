export const DEFAULT_WORKSPACE_INACTIVITY_MS = 300_000;
export const FOREGROUND_POLL_MS = 30_000;

export interface ActivityHost {
  readonly setDeadline: (durationMs: number) => Promise<void>;
  readonly onIdle?: () => void;
}

export interface ActivityLease {
  readonly release: () => void;
}

export interface WorkspaceActivity {
  readonly runCommand: <A>(
    timeoutMs: number,
    execute: () => Promise<A>,
  ) => Promise<A>;
  readonly acquireCommand: (timeoutMs: number) => ActivityLease;
  readonly retain: () => ActivityLease;
  readonly attachTerminal: (
    inspectForeground: () => Promise<boolean>,
  ) => () => void;
  readonly recordTerminalInput: () => void;
  /**
   * The provider's deadline was replaced from outside this coordinator: an
   * E2B connect extends a running sandbox to the connect timeout. Publish the
   * inactivity deadline unless a lease is renewing it.
   */
  readonly deadlineReplaced: () => void;
  readonly isActive: () => Promise<boolean>;
}

interface Clock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const createWorkspaceActivity = (
  host: ActivityHost,
  clock: Clock = systemClock,
  inactivityMs = DEFAULT_WORKSPACE_INACTIVITY_MS,
): WorkspaceActivity => {
  const commands = new Map<symbol, number>();
  const retainers = new Set<symbol>();
  let terminalInputUntil = 0;
  let terminal:
    | { readonly inspectForeground: () => Promise<boolean> }
    | undefined;
  let foreground = false;
  let timer: unknown;
  let wasActive = false;
  let finalDeadlineSet = false;
  const deadlines: number[] = [];
  let publishing = false;

  const publishDeadlines = async () => {
    publishing = true;
    while (deadlines.length > 0) {
      const durationMs = deadlines.shift();
      if (durationMs === undefined) continue;
      try {
        await host.setDeadline(durationMs);
      } catch {
        // Deadline publication is best-effort, but later publications stay ordered.
      }
    }
    publishing = false;
  };
  const setDeadline = () => {
    deadlines.push(inactivityMs);
    if (!publishing) void publishDeadlines();
  };
  const renewing = () => commands.size > 0 || retainers.size > 0 || foreground;
  const retained = () => renewing() || terminalInputUntil > clock.now();
  const publish = () => {
    if (renewing()) {
      wasActive = true;
      finalDeadlineSet = false;
      setDeadline();
    } else if ((wasActive || terminal !== undefined) && !finalDeadlineSet) {
      wasActive = false;
      finalDeadlineSet = true;
      setDeadline();
    }
    if (!retained() && terminal === undefined) host.onIdle?.();
  };
  const schedule = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    const now = clock.now();
    const expiries = [...commands.values(), terminalInputUntil].filter(
      (expiry) => expiry > now,
    );
    const nextExpiry = expiries.length === 0 ? Infinity : Math.min(...expiries);
    const delay = Math.min(
      terminal === undefined && !renewing() ? Infinity : FOREGROUND_POLL_MS,
      nextExpiry - now,
    );
    if (Number.isFinite(delay))
      timer = clock.setTimeout(() => void tick(), Math.max(0, delay));
  };
  const inspectActive = async () => {
    const now = clock.now();
    for (const [id, expiry] of commands) if (expiry <= now) commands.delete(id);
    if (terminalInputUntil <= now) terminalInputUntil = 0;
    const attachment = terminal;
    if (attachment === undefined) {
      foreground = false;
      return retained();
    }
    let inspectedForeground = false;
    try {
      inspectedForeground = await attachment.inspectForeground();
    } catch {
      inspectedForeground = false;
    }
    if (terminal === attachment) foreground = inspectedForeground;
    return retained();
  };
  const tick = async () => {
    timer = undefined;
    const now = clock.now();
    for (const [id, expiry] of commands) if (expiry <= now) commands.delete(id);
    if (terminalInputUntil <= now) terminalInputUntil = 0;
    const attachment = terminal;
    if (attachment !== undefined) {
      let inspectedForeground = false;
      try {
        inspectedForeground = await attachment.inspectForeground();
      } catch {
        inspectedForeground = false;
      }
      if (terminal !== attachment) return;
      foreground = inspectedForeground;
    } else foreground = false;
    publish();
    schedule();
  };

  return {
    async runCommand(timeoutMs, execute) {
      const lease = this.acquireCommand(timeoutMs);
      try {
        return await execute();
      } finally {
        lease.release();
      }
    },
    acquireCommand(timeoutMs) {
      const id = Symbol();
      commands.set(id, clock.now() + Math.max(1, timeoutMs));
      publish();
      schedule();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          commands.delete(id);
          publish();
          schedule();
        },
      };
    },
    retain() {
      const id = Symbol();
      retainers.add(id);
      publish();
      schedule();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          retainers.delete(id);
          publish();
          schedule();
        },
      };
    },
    attachTerminal(inspect) {
      const attachment = { inspectForeground: inspect };
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      terminal = attachment;
      void tick();
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        if (terminal !== attachment) return;
        terminal = undefined;
        foreground = false;
        publish();
        schedule();
      };
    },
    recordTerminalInput() {
      terminalInputUntil = clock.now() + inactivityMs;
      if (!renewing()) {
        wasActive = false;
        finalDeadlineSet = true;
        setDeadline();
      }
      schedule();
    },
    deadlineReplaced() {
      // A renewing lease republishes on release. Otherwise the connect
      // timeout must not outlive the inactivity deadline, even on a fresh
      // coordinator that nothing else would make publish (a Files-only wake).
      if (renewing()) return;
      wasActive = false;
      finalDeadlineSet = true;
      setDeadline();
    },
    isActive: inspectActive,
  };
};
