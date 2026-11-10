import {
  type FileStat,
  type OrphanedExecSettlement,
  type Sandbox,
  type SandboxDriver,
  type SandboxFactory,
  type ShellResult,
  sandboxFromDriver,
} from "@flue/runtime";
import { fixtureText } from "./heavy-history.js";

const ORPHAN_RESULT = "delayed-signal-deaf-command-result";

interface InstanceState {
  readonly files: Map<string, Uint8Array>;
  initializationCount: number;
  orphanSettled: boolean;
  holding: boolean;
  readonly orphanWaiters: Set<() => void>;
  settleDelayedExec?: () => void;
  sandbox?: Sandbox;
  /** How often each `fixture-count <name>` command ran. */
  commandRuns: Map<string, number>;
}

const instances = new Map<string, InstanceState>();
const failingActivations = new Set<string>();
const hangingActivations = new Set<string>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stateFor = (id: string): InstanceState => {
  const existing = instances.get(id);
  if (existing !== undefined) return existing;
  const created: InstanceState = {
    files: new Map(),
    initializationCount: 0,
    orphanSettled: false,
    holding: false,
    orphanWaiters: new Set(),
    commandRuns: new Map(),
  };
  instances.set(id, created);
  return created;
};

const waitForOrphan = (state: InstanceState) =>
  state.orphanSettled
    ? Promise.resolve()
    : new Promise<void>((resolve) => state.orphanWaiters.add(resolve));

class FixtureSandboxDriver implements SandboxDriver {
  constructor(private readonly state: InstanceState) {}

  async readFile(path: string): Promise<string> {
    if (path === "/.dx/orphan-state") await waitForOrphan(this.state);
    const content = this.state.files.get(path);
    if (content === undefined) throw new Error("File not found.");
    return decoder.decode(content);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const content = this.state.files.get(path);
    if (content === undefined) throw new Error("File not found.");
    return content;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.state.files.set(
      path,
      typeof content === "string" ? encoder.encode(content) : content,
    );
  }

  async stat(path: string): Promise<FileStat> {
    const content = this.state.files.get(path);
    if (content === undefined) throw new Error("File not found.");
    return { isFile: true, isDirectory: false, size: content.byteLength };
  }

  /** The entries directly under `path`, as a real workspace lists them. */
  async readdir(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const names = new Set<string>();
    for (const file of this.state.files.keys())
      if (file.startsWith(prefix))
        names.add(file.slice(prefix.length).split("/")[0] ?? "");
    names.delete("");
    return [...names].sort();
  }

  async exists(path: string): Promise<boolean> {
    return this.state.files.has(path);
  }

  async mkdir(
    _path: string,
    _options?: { readonly recursive?: boolean },
  ): Promise<void> {}

  async rm(
    path: string,
    _options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void> {
    this.state.files.delete(path);
  }

  async exec(
    command: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ShellResult> {
    if (command === "hold-turn") return this.holdUntilStopped(options?.signal);
    // A command that ignores Stop and never ends, as a wedged Orb's did.
    if (command === "deaf-hold") {
      this.state.holding = true;
      return new Promise<never>(() => undefined);
    }
    const counted = /^fixture-count (\S+)$/.exec(command);
    if (counted?.[1] !== undefined) {
      const runs = this.state.commandRuns;
      runs.set(counted[1], (runs.get(counted[1]) ?? 0) + 1);
      return { stdout: "counted", stderr: "", exitCode: 0 };
    }
    const output = /^fixture-output (\d+) (\d+)$/.exec(command);
    if (output !== null)
      return {
        stdout: fixtureText(Number(output[1]), Number(output[2])),
        stderr: "",
        exitCode: 0,
      };
    if (command !== "delayed-reference-command") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return new Promise((resolve) => {
      this.state.settleDelayedExec = () => {
        this.state.settleDelayedExec = undefined;
        resolve({ stdout: ORPHAN_RESULT, stderr: "", exitCode: 0 });
      };
    });
  }

  /** Keeps the turn running until Stop aborts it. */
  private holdUntilStopped(signal?: AbortSignal): Promise<ShellResult> {
    this.state.holding = true;
    return new Promise((resolve) => {
      const release = () => {
        this.state.holding = false;
        resolve({ stdout: "", stderr: "stopped", exitCode: 130 });
      };
      if (signal?.aborted) release();
      else signal?.addEventListener("abort", release, { once: true });
    });
  }
}

const observeOrphan =
  (state: InstanceState) => (_settlement: OrphanedExecSettlement) => {
    state.orphanSettled = true;
    state.files.set("/.dx/orphan-state", encoder.encode("settled"));
    for (const resolve of state.orphanWaiters) resolve();
    state.orphanWaiters.clear();
  };

export const fixtureSandboxFactory: SandboxFactory = {
  async createSandbox({ id }): Promise<Sandbox> {
    if (failingActivations.delete(id))
      throw new Error("Fixture workspace activation failed.");
    // Signal-deaf, as activation against a wedged Orb was (#1584).
    if (hangingActivations.delete(id))
      return new Promise<never>(() => undefined);
    const state = stateFor(id);
    if (state.sandbox !== undefined) return state.sandbox;
    state.initializationCount += 1;
    state.files.set(
      "/.dx/initialization-count",
      encoder.encode(String(state.initializationCount)),
    );
    state.files.set("/.dx/instance-id", encoder.encode(id));
    state.sandbox = sandboxFromDriver(
      new FixtureSandboxDriver(state),
      "/home/user",
      {
        onOrphanSettled: observeOrphan(state),
      },
    );
    return state.sandbox;
  },
};

export const settleDelayedCommand = (id: string) => {
  stateFor(id).settleDelayedExec?.();
};

export const isHoldingTurn = (id: string) => stateFor(id).holding;

/** How often each `fixture-count <name>` command ran in the instance. */
export const commandRuns = (id: string) =>
  Object.fromEntries(stateFor(id).commandRuns);

/** Fails the instance's next workspace activation, before any model call. */
export const failNextActivation = (id: string) => {
  failingActivations.add(id);
};

/** Hangs the instance's next workspace activation, ignoring Stop. */
export const hangNextActivation = (id: string) => {
  hangingActivations.add(id);
};

export { ORPHAN_RESULT };
