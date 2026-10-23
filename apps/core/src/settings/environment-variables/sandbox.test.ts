import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configReferenceFor,
  EnvironmentVariableId,
  EnvironmentVariableName,
} from "@dx/domain";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentProps,
  init,
  type Sandbox,
  type SandboxFactory,
  useModel,
  useSandbox,
  type WorkspaceContextSnapshot,
} from "@flue/runtime";
import { local, start } from "@flue/runtime/node";
import { Redacted, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeStream } from "../../claude-code/stream.js";
import { executionWorkspaceTools } from "../../plugins/execution/tools.js";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";
import { withExecutionEnvironment } from "./sandbox.js";

/** What dx shows in place of the secret this variable holds. */
const marker = (name: string) => `[REDACTED:${name}]`;

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const value = (
  rawName: string,
  kind: "secret" | "variable",
  plaintext: string,
) => {
  const name = Schema.decodeUnknownSync(EnvironmentVariableName)(rawName);
  const id = Schema.decodeUnknownSync(EnvironmentVariableId)(
    `env_${rawName.toLowerCase()}`,
  );
  return {
    reference: configReferenceFor(id),
    name,
    kind,
    value: Redacted.make(plaintext),
    source: "personal" as const,
  };
};

const snapshot = (
  values: ExecutionEnvironmentSnapshot["values"],
  personalRevision = 0,
): ExecutionEnvironmentSnapshot => ({
  revision: {
    personal: { targetId: "user", revision: personalRevision },
    project: { targetId: "project", revision: 0 },
    workspace: { targetId: null, revision: 0 },
  },
  values,
});

const localSandbox = async (
  resolve: (id: string) => Promise<ExecutionEnvironmentSnapshot>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "dx-environment-test-"));
  temporaryDirectories.push(directory);
  const factory = withExecutionEnvironment(local({ cwd: directory }), resolve);
  return {
    directory,
    factory,
    sandbox: await factory.createSandbox({ id: "thread" }),
  };
};

describe("Flue execution environment", () => {
  it("injects and refreshes values in a real local process while redacting every readable surface", async () => {
    let current = snapshot([
      value("BUILD_CHANNEL", "variable", "before"),
      value("API_SECRET", "secret", "synthetic-secret"),
      value("OVERLAP", "secret", "synthetic"),
      value("SHORT_SECRET", "secret", "R"),
    ]);
    const resolve = vi.fn(async () => current);
    const { sandbox } = await localSandbox(resolve);

    const first = await sandbox.exec(
      `printf '%s|%s|%s|%s' "$BUILD_CHANNEL" "$API_SECRET" "$OVERLAP" "$SHORT_SECRET"; printf '%s' "$API_SECRET" >&2`,
    );
    // A secret under 8 characters is too short to hide, and still applied.
    expect(first).toEqual({
      stdout: `before|${marker("API_SECRET")}|${marker("OVERLAP")}|R`,
      stderr: marker("API_SECRET"),
      exitCode: 0,
    });
    expect(first.stdout).not.toContain("synthetic-secret");
    expect(first.stdout).not.toContain("undefined");

    const overridden = await sandbox.exec(`printf '%s' "$BUILD_CHANNEL"`, {
      env: { BUILD_CHANNEL: "caller-wins" },
    });
    expect(overridden.stdout).toBe("caller-wins");

    await sandbox.writeFile("text.txt", "prefix synthetic-secret suffix");
    await sandbox.writeFile(
      "bytes.bin",
      new TextEncoder().encode("bytes synthetic-secret suffix"),
    );
    await sandbox.mkdir("directory");
    await sandbox.writeFile("directory/synthetic-secret.txt", "safe");
    expect(await sandbox.readFile("text.txt")).toBe(
      `prefix ${marker("API_SECRET")} suffix`,
    );
    expect(
      new TextDecoder().decode(await sandbox.readFileBuffer("bytes.bin")),
    ).toBe(`bytes ${marker("API_SECRET")} suffix`);
    expect(await sandbox.readdir("directory")).toEqual([
      `${marker("API_SECRET")}.txt`,
    ]);

    const inFlight = sandbox.exec(`sleep 0.05; printf '%s' "$BUILD_CHANNEL"`);
    current = snapshot([
      value("BUILD_CHANNEL", "variable", "after"),
      value("API_SECRET", "secret", "rotated-secret"),
    ]);
    expect((await inFlight).stdout).toBe("before");
    expect(
      (await sandbox.exec(`printf '%s|%s' "$BUILD_CHANNEL" "$API_SECRET"`))
        .stdout,
    ).toBe(`after|${marker("API_SECRET")}`);
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it("reuses the resolved environment while its revision holds: commands check the revision every time, other operations every 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let current = snapshot([
      value("BUILD_CHANNEL", "variable", "before"),
      value("API_SECRET", "secret", "first-secret"),
    ]);
    const resolve = vi.fn(async () => current);
    const revision = vi.fn(async () => current.revision);
    const directory = await mkdtemp(join(tmpdir(), "dx-environment-test-"));
    temporaryDirectories.push(directory);
    const sandbox = await withExecutionEnvironment(
      local({ cwd: directory }),
      resolve,
      revision,
    ).createSandbox({ id: "thread" });

    // Claude Code polls a run's output several times a second.
    await sandbox.writeFile("out.txt", "first-secret second-secret");
    for (let read = 0; read < 100; read += 1)
      expect(await sandbox.readFile("out.txt")).toBe(
        `${marker("API_SECRET")} second-secret`,
      );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(revision).toHaveBeenCalledTimes(0);

    // A command proves the revision first and reuses the values.
    const channel = `printf '%s' "$BUILD_CHANNEL"`;
    expect((await sandbox.exec(channel)).stdout).toBe("before");
    expect(revision).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);

    // An edit reaches the next command at once.
    current = snapshot(
      [
        value("BUILD_CHANNEL", "variable", "after"),
        value("API_SECRET", "secret", "second-secret"),
      ],
      1,
    );
    expect((await sandbox.exec(channel)).stdout).toBe("after");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(await sandbox.readFile("out.txt")).toBe(
      `first-secret ${marker("API_SECRET")}`,
    );

    // Other operations see an edit within 5 s.
    current = snapshot([value("API_SECRET", "secret", "first-secret")], 2);
    vi.setSystemTime(Date.now() + 4_000);
    expect(await sandbox.readFile("out.txt")).toBe(
      `first-secret ${marker("API_SECRET")}`,
    );
    vi.setSystemTime(Date.now() + 1_000);
    expect(await sandbox.readFile("out.txt")).toBe(
      `${marker("API_SECRET")} second-secret`,
    );
    expect(resolve).toHaveBeenCalledTimes(3);

    // An unchanged revision costs only its check, and a failed check fails
    // closed instead of serving the old values.
    vi.setSystemTime(Date.now() + 5_000);
    await sandbox.readFile("out.txt");
    expect(resolve).toHaveBeenCalledTimes(3);
    revision.mockRejectedValueOnce(new Error("revision unavailable"));
    await expect(sandbox.exec(channel)).rejects.toThrow("revision unavailable");
  });

  it("redacts secrets as JSON escapes them, so Claude Code's stream-json never shows one", async () => {
    const secret = 'pa"ss\\word\nnext\tline';
    const { sandbox } = await localSandbox(async () =>
      snapshot([value("API_SECRET", "secret", secret)]),
    );
    const escaped = JSON.stringify(secret).slice(1, -1);
    const twice = JSON.stringify(escaped).slice(1, -1);
    // A tool result, and a tool input streamed as JSON inside JSON.
    const output = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: `token=${secret}`,
            },
          ],
        },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ command: `curl -u ${secret}` }),
          },
        },
        parent_tool_use_id: null,
      }),
    ].join("\n");
    await sandbox.writeFile("stream.jsonl", output);
    expect(output).toContain(escaped);
    expect(output).toContain(twice);
    const reads = [
      await sandbox.readFile("stream.jsonl"),
      new TextDecoder().decode(await sandbox.readFileBuffer("stream.jsonl")),
      (await sandbox.exec("cat stream.jsonl")).stdout,
    ];
    for (const read of reads) {
      expect(read).not.toContain("word");
      expect(read).not.toContain("pa\\");
    }
    const [first] = reads;
    const stream = new ClaudeCodeStream();
    for (const line of first?.split("\n") ?? []) stream.push(line);
    expect(stream.toolResults.get("toolu_1")?.text).toBe(
      `token=${marker("API_SECRET")}`,
    );
  });

  it("fails closed before an operation, preserves AbortError, sanitizes failures, and preserves custom tools", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const writeFile = vi.fn(async () => {});
    const base: Sandbox = {
      cwd: "/workspace",
      resolvePath: (path) => path,
      exec,
      readFile: vi.fn(),
      readFileBuffer: vi.fn(),
      writeFile,
      stat: vi.fn(),
      readdir: vi.fn(),
      exists: vi.fn(),
      mkdir: vi.fn(),
      rm: vi.fn(),
    };
    const tools = vi.fn(() => []);
    const baseFactory: SandboxFactory = {
      createSandbox: async () => base,
      tools,
    };
    const unavailable = withExecutionEnvironment(baseFactory, async () => {
      throw new Error("resolver unavailable");
    });
    expect(unavailable.tools).toBe(tools);
    await expect(
      (await unavailable.createSandbox({ id: "thread" })).exec("ignored"),
    ).rejects.toThrow("resolver unavailable");
    await expect(
      (await unavailable.createSandbox({ id: "thread" })).writeFile(
        "ignored",
        "ignored",
      ),
    ).rejects.toThrow("resolver unavailable");
    expect(exec).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();

    const abort = new DOMException("The operation was aborted", "AbortError");
    exec.mockRejectedValueOnce(abort);
    const admitted = withExecutionEnvironment(baseFactory, async () =>
      snapshot([value("API_SECRET", "secret", "sensitive")]),
    );
    const sandbox = await admitted.createSandbox({ id: "thread" });
    await expect(sandbox.exec("abort")).rejects.toBe(abort);
    exec.mockRejectedValueOnce(new Error("provider exposed sensitive"));
    await expect(sandbox.exec("fail")).rejects.toThrow(
      `provider exposed ${marker("API_SECRET")}`,
    );
    writeFile.mockRejectedValueOnce(new Error("provider exposed sensitive"));
    await expect(sandbox.writeFile("file", "contents")).rejects.toThrow(
      `provider exposed ${marker("API_SECRET")}`,
    );
  });

  it("preserves bulk workspace discovery while redacting every returned fact", async () => {
    const workspaceSnapshot: WorkspaceContextSnapshot = {
      instructionFiles: { "AGENTS.md": "sensitive instructions" },
      skillFiles: [
        {
          kind: "file",
          directoryName: "sensitive-skill",
          content: "sensitive body",
        },
        {
          kind: "read-error",
          directoryName: "broken",
          errorMessage: "sensitive failure",
        },
      ],
      directoryListing: ["sensitive.txt"],
    };
    const snapshotWorkspaceContext = vi.fn(async () => workspaceSnapshot);
    const base = (await localSandbox(async () => snapshot([]))).sandbox;
    const factory = withExecutionEnvironment(
      {
        createSandbox: async () => ({ ...base, snapshotWorkspaceContext }),
      },
      async () => snapshot([value("API_SECRET", "secret", "sensitive")]),
    );
    const sandbox = await factory.createSandbox({ id: "thread" });

    await expect(
      sandbox.snapshotWorkspaceContext?.(sandbox.cwd),
    ).resolves.toEqual({
      instructionFiles: {
        "AGENTS.md": `${marker("API_SECRET")} instructions`,
      },
      skillFiles: [
        {
          kind: "file",
          directoryName: `${marker("API_SECRET")}-skill`,
          content: `${marker("API_SECRET")} body`,
        },
        {
          kind: "read-error",
          directoryName: "broken",
          errorMessage: `${marker("API_SECRET")} failure`,
        },
      ],
      directoryListing: [`${marker("API_SECRET")}.txt`],
    });
    expect(snapshotWorkspaceContext).toHaveBeenCalledWith(sandbox.cwd);
  });

  it("keeps configured secret plaintext out of Flue conversation history", async () => {
    const secret = "history-sensitive-secret";
    const { factory } = await localSandbox(async () =>
      snapshot([
        value("API_SECRET", "secret", secret),
        value("X", "secret", "R"),
      ]),
    );
    const provider = fauxProvider();
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `printf '%s|%s' "$API_SECRET" "$X"`,
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const toolResult = context.messages.find(
          (message) => message.role === "toolResult",
        );
        const serializedResult = JSON.stringify(toolResult?.content);
        // X is too short to hide.
        expect(serializedResult).toContain(`${marker("API_SECRET")}|R`);
        expect(serializedResult).not.toContain(secret);
        return fauxAssistantMessage("done");
      },
    ]);

    function LocalAgent(_props: AgentProps) {
      useModel("faux/faux-1");
      useSandbox(factory);
      return "Use bash.";
    }
    LocalAgent.agentName = "environment-history-test";

    await using _runtime = await start({
      agents: [LocalAgent],
      providers: [provider.provider],
    });
    const handle = init(LocalAgent, { id: "environment-history" });
    const receipt = await handle.dispatch("Print the configured API secret.");
    await expect(handle.read(receipt)).resolves.toMatchObject({ text: "done" });
  });

  it("keeps a hidden secret out of Flue history and out of the files the agent writes", async () => {
    const secret = "dxs_live_7Hq2Vm9KpX4rT8w";
    const directory = await mkdtemp(join(tmpdir(), "dx-environment-test-"));
    temporaryDirectories.push(directory);
    const environment = local({ cwd: directory });
    const factory = withExecutionEnvironment(
      {
        createSandbox: (request) => environment.createSandbox(request),
        tools: executionWorkspaceTools,
      },
      async () =>
        snapshot([
          value("DEPLOY_TOKEN", "secret", secret),
          value("SHORT_KEY", "secret", "ent"),
        ]),
    );
    await writeFile(
      join(directory, "deploy.env"),
      `TOKEN=${secret}\nREGION=eu\n`,
    );
    const results: Array<{ text: string; isError: boolean }> = [];
    const lastResult = (context: { messages: ReadonlyArray<unknown> }) => {
      const message = context.messages.at(-1) as {
        role: string;
        content: ReadonlyArray<{ text?: string }>;
        isError?: boolean;
      };
      results.push({
        text: message.content.map((part) => part.text ?? "").join(""),
        isError: message.isError === true,
      });
    };
    let history = "";
    const provider = fauxProvider();
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("shell_command", {
          command: "cat deploy.env; echo the client environment",
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        lastResult(context);
        return fauxAssistantMessage(
          fauxToolCall("create_file", {
            path: join(directory, "copy.env"),
            content: "TOKEN=[REDACTED:DEPLOY_TOKEN]\n",
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        lastResult(context);
        return fauxAssistantMessage(
          fauxToolCall("edit_file", {
            path: join(directory, "deploy.env"),
            old_str: "REGION=eu",
            new_str: "REGION=us",
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        lastResult(context);
        return fauxAssistantMessage(
          fauxToolCall("create_file", {
            path: join(directory, "notes.md"),
            content: "The client environment entry.",
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        lastResult(context);
        history = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);

    function LocalAgent(_props: AgentProps) {
      useModel("faux/faux-1");
      useSandbox(factory);
      return "Use the workspace tools.";
    }
    LocalAgent.agentName = "environment-writes-test";

    await using _runtime = await start({
      agents: [LocalAgent],
      providers: [provider.provider],
    });
    const handle = init(LocalAgent, { id: "environment-writes" });
    const receipt = await handle.dispatch("Copy the deploy settings.");
    await expect(handle.read(receipt)).resolves.toMatchObject({ text: "done" });

    expect(results).toEqual([
      {
        text: expect.stringContaining(
          "TOKEN=[REDACTED:DEPLOY_TOKEN]\nREGION=eu\nthe client environment",
        ),
        isError: false,
      },
      {
        text: expect.stringContaining(
          "[REDACTED:DEPLOY_TOKEN] stands for the hidden secret DEPLOY_TOKEN. Do not write it into a file.",
        ),
        isError: true,
      },
      {
        text: expect.stringContaining(
          "holds the hidden secret DEPLOY_TOKEN, which dx shows as [REDACTED:DEPLOY_TOKEN]. Do not write it into a file.",
        ),
        isError: true,
      },
      { text: expect.stringContaining("Successfully created"), isError: false },
    ]);
    expect(history).not.toContain(secret);
    // The secret stays in its file, and no marker reaches the disk.
    await expect(readFile(join(directory, "deploy.env"), "utf8")).resolves.toBe(
      `TOKEN=${secret}\nREGION=eu\n`,
    );
    await expect(readFile(join(directory, "copy.env"), "utf8")).rejects.toThrow(
      "ENOENT",
    );
    await expect(readFile(join(directory, "notes.md"), "utf8")).resolves.toBe(
      "The client environment entry.",
    );
  });
});
