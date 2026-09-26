import {
  sandboxFromDriver,
  type FileStat,
  type OrphanedExecSettlement,
  type Sandbox,
  type SandboxDriver,
  type SandboxFactory,
  type ShellResult,
} from "@flue/runtime";

const ORPHAN_RESULT = "delayed-signal-deaf-command-result";

interface InstanceState {
  readonly files: Map<string, Uint8Array>;
  initializationCount: number;
  orphanSettled: boolean;
  readonly orphanWaiters: Set<() => void>;
  settleDelayedExec?: () => void;
  sandbox?: Sandbox;
}

const instances = new Map<string, InstanceState>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stateFor = (id: string): InstanceState => {
  const existing = instances.get(id);
  if (existing !== undefined) return existing;
  const created: InstanceState = {
    files: new Map(),
    initializationCount: 0,
    orphanSettled: false,
    orphanWaiters: new Set(),
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

  async readdir(_path: string): Promise<string[]> {
    return [];
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

  async exec(command: string): Promise<ShellResult> {
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

export { ORPHAN_RESULT };
