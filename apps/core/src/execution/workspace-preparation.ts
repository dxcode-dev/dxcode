export interface WorkspaceCommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export interface WorkspacePreparation {
  readonly run: (
    command: string,
    options?: {
      readonly cwd?: string;
      readonly environment?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    },
  ) => Promise<WorkspaceCommandResult>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

interface WorkspacePreparationTarget {
  readonly commands: {
    readonly run: (
      command: string,
      options?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
      },
    ) => Promise<WorkspaceCommandResult>;
  };
  readonly files: {
    readonly write: (path: string, content: string) => Promise<unknown>;
  };
}

export const workspacePreparationFor = (
  target: WorkspacePreparationTarget,
): WorkspacePreparation => ({
  run: (command, options) =>
    target.commands.run(command, {
      cwd: options?.cwd,
      envs:
        options?.environment === undefined
          ? undefined
          : { ...options.environment },
      timeoutMs: options?.timeoutMs,
    }),
  writeFile: async (path, content) => {
    await target.files.write(path, content);
  },
});
