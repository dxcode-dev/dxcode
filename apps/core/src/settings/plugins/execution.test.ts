import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  makePluginIsolation,
  PLUGIN_CPU_TIME_LIMIT_SECONDS,
  PLUGIN_INPUT_LIMIT_BYTES,
  PLUGIN_MEMORY_LIMIT_KIB,
  PLUGIN_OUTPUT_LIMIT_BYTES,
  PLUGIN_PROCESS_LIMIT,
  PLUGIN_WALL_TIME_LIMIT_MS,
  PluginExecutionLimited,
  PluginExecutionUnavailable,
  type PluginIsolationInput,
} from "./execution.js";

const input = (
  overrides: Partial<PluginIsolationInput> = {},
): PluginIsolationInput => ({
  environment: "test",
  pluginId: "plg_00000000-0000-4000-8000-000000000045",
  version: "1.0.0",
  invocationId: "pinv_test",
  entrypoint: "main.mjs",
  sourceFiles: [{ path: "main.mjs", content: "export const tools = {};" }],
  projectFiles: [],
  networkDestinations: [],
  secrets: {},
  invocation: {
    kind: "tool",
    name: "summarize",
    input: { value: "safe" },
    context: {},
  },
  ...overrides,
});

describe("plugin E2B isolation", () => {
  let files: Map<string, string>;
  let create: ReturnType<typeof vi.fn>;
  let run: ReturnType<typeof vi.fn>;
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files = new Map();
    run = vi.fn(async () => {
      files.set("/runtime/status", "0");
      files.set(
        "/runtime/result.json",
        JSON.stringify({ result: { accepted: true }, truncated: false }),
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    kill = vi.fn(async () => true);
    const write = vi.fn(
      async (
        pathOrFiles:
          | string
          | ReadonlyArray<{ readonly path: string; readonly data: unknown }>,
        data?: unknown,
      ) => {
        if (typeof pathOrFiles === "string") {
          files.set(pathOrFiles, String(data));
          return;
        }
        for (const file of pathOrFiles) files.set(file.path, String(file.data));
      },
    );
    create = vi.fn(async () => ({
      files: {
        makeDir: vi.fn(async () => undefined),
        write,
        read: vi.fn(async (path: string) => files.get(path) ?? ""),
      },
      commands: { run },
      kill,
    }));
  });

  it("creates a fresh deny-default sandbox with no ambient credentials and hard limits", async () => {
    const isolation = makePluginIsolation({ create } as never, {
      apiKey: "host-only-e2b-key",
    });
    const output = await Effect.runPromise(isolation.invoke(input()));

    expect(output).toEqual({ result: { accepted: true }, truncated: false });
    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      envs: {},
      allowInternetAccess: false,
      network: { allowOut: [], allowPublicTraffic: false },
    });
    expect(options.network.denyOut({ allTraffic: "0.0.0.0/0" })).toEqual([
      "0.0.0.0/0",
    ]);
    expect(options.apiKey).toBe("host-only-e2b-key");
    expect(JSON.stringify(options.envs)).not.toContain("host-only-e2b-key");
    const [command, commandOptions] = run.mock.calls[0] ?? [];
    expect(command).toContain(`ulimit -t ${PLUGIN_CPU_TIME_LIMIT_SECONDS}`);
    expect(command).toContain(`ulimit -u ${PLUGIN_PROCESS_LIMIT}`);
    expect(command).toContain(`ulimit -v ${PLUGIN_MEMORY_LIMIT_KIB}`);
    expect(command).toContain(
      `timeout --signal=KILL ${PLUGIN_WALL_TIME_LIMIT_MS / 1_000}s`,
    );
    expect(command).toContain("exec env -i");
    expect(command).not.toContain("host-only-e2b-key");
    expect(commandOptions.envs).toEqual({});
    expect(kill).toHaveBeenCalledOnce();
  });

  it("forwards only explicitly supplied destinations and secret names", async () => {
    const isolation = makePluginIsolation({ create } as never, {
      apiKey: "host-only-e2b-key",
    });
    await Effect.runPromise(
      isolation.invoke(
        input({
          networkDestinations: ["api.example.com"],
          secrets: { REVIEW_TOKEN: "granted-value" },
        }),
      ),
    );

    expect(create.mock.calls[0]?.[0].network.allowOut).toEqual([
      "api.example.com",
    ]);
    const [command, commandOptions] = run.mock.calls[0] ?? [];
    expect(command).toContain('REVIEW_TOKEN="$REVIEW_TOKEN"');
    expect(command).not.toContain("granted-value");
    expect(commandOptions.envs).toEqual({ REVIEW_TOKEN: "granted-value" });
  });

  it("rejects oversized input before creation and always kills failed sandboxes", async () => {
    const isolation = makePluginIsolation({ create } as never, {
      apiKey: "host-only-e2b-key",
    });
    await expect(
      Effect.runPromise(
        isolation.invoke(
          input({
            invocation: {
              kind: "tool",
              name: "summarize",
              input: "x".repeat(PLUGIN_INPUT_LIMIT_BYTES + 1),
              context: {},
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PluginExecutionLimited);
    expect(create).not.toHaveBeenCalled();

    const commandFailure = new Error("synthetic command failure");
    run.mockRejectedValueOnce(commandFailure);
    const failure = await Effect.runPromise(
      Effect.flip(isolation.invoke(input())),
    );
    expect(failure).toBeInstanceOf(PluginExecutionUnavailable);
    expect(failure).toMatchObject({ operation: "sandbox.run" });
    expect((failure as PluginExecutionUnavailable).cause).toBe(commandFailure);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rejects oversized serialized output and still destroys the sandbox", async () => {
    run.mockImplementationOnce(async () => {
      files.set("/runtime/status", "0");
      files.set(
        "/runtime/result.json",
        JSON.stringify({
          result: "x".repeat(PLUGIN_OUTPUT_LIMIT_BYTES + 2_000),
          truncated: false,
        }),
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const isolation = makePluginIsolation({ create } as never, {
      apiKey: "host-only-e2b-key",
    });
    await expect(
      Effect.runPromise(isolation.invoke(input())),
    ).rejects.toBeInstanceOf(PluginExecutionLimited);
    expect(kill).toHaveBeenCalledOnce();
  });
});
