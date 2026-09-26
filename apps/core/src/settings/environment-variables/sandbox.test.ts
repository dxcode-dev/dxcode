import { mkdtemp, rm } from "node:fs/promises";
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
import type { ExecutionEnvironmentSnapshot } from "./execution.js";
import {
  ENVIRONMENT_SECRET_REDACTION,
  withExecutionEnvironment,
} from "./sandbox.js";

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
): ExecutionEnvironmentSnapshot => ({
  revision: {
    personal: { targetId: "user", revision: 0 },
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
      value("OVERLAP", "secret", "secret"),
      value("SHORT_SECRET", "secret", "R"),
    ]);
    const resolve = vi.fn(async () => current);
    const { sandbox } = await localSandbox(resolve);

    const first = await sandbox.exec(
      `printf '%s|%s|%s|%s' "$BUILD_CHANNEL" "$API_SECRET" "$OVERLAP" "$SHORT_SECRET"; printf '%s' "$API_SECRET" >&2`,
    );
    expect(first).toEqual({
      stdout: `before|${ENVIRONMENT_SECRET_REDACTION}|${ENVIRONMENT_SECRET_REDACTION}|${ENVIRONMENT_SECRET_REDACTION}`,
      stderr: ENVIRONMENT_SECRET_REDACTION,
      exitCode: 0,
    });
    expect(first.stdout).not.toContain("synthetic-secret");
    expect(ENVIRONMENT_SECRET_REDACTION).not.toContain("R");
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
      `prefix ${ENVIRONMENT_SECRET_REDACTION} suffix`,
    );
    expect(
      new TextDecoder().decode(await sandbox.readFileBuffer("bytes.bin")),
    ).toBe(`bytes ${ENVIRONMENT_SECRET_REDACTION} suffix`);
    expect(await sandbox.readdir("directory")).toEqual([
      `${ENVIRONMENT_SECRET_REDACTION}.txt`,
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
    ).toBe(`after|${ENVIRONMENT_SECRET_REDACTION}`);
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(7);
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
      `provider exposed ${ENVIRONMENT_SECRET_REDACTION}`,
    );
    writeFile.mockRejectedValueOnce(new Error("provider exposed sensitive"));
    await expect(sandbox.writeFile("file", "contents")).rejects.toThrow(
      `provider exposed ${ENVIRONMENT_SECRET_REDACTION}`,
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
        "AGENTS.md": `${ENVIRONMENT_SECRET_REDACTION} instructions`,
      },
      skillFiles: [
        {
          kind: "file",
          directoryName: `${ENVIRONMENT_SECRET_REDACTION}-skill`,
          content: `${ENVIRONMENT_SECRET_REDACTION} body`,
        },
        {
          kind: "read-error",
          directoryName: "broken",
          errorMessage: `${ENVIRONMENT_SECRET_REDACTION} failure`,
        },
      ],
      directoryListing: [`${ENVIRONMENT_SECRET_REDACTION}.txt`],
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
        expect(serializedResult).toContain(
          JSON.stringify(ENVIRONMENT_SECRET_REDACTION).slice(1, -1),
        );
        expect(serializedResult).not.toContain(secret);
        expect(serializedResult).not.toContain("R");
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
});
