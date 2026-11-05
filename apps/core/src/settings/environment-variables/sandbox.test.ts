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
  defineTool,
  init,
  type Sandbox,
  type SandboxFactory,
  useModel,
  useSandbox,
  useTool,
  type WorkspaceContextSnapshot,
} from "@flue/runtime";
import { local, start } from "@flue/runtime/node";
import { Redacted, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeStream } from "../../claude-code/stream.js";
import { createFileTools } from "../../plugins/execution/files/tools.js";
import { createShellTools } from "../../plugins/execution/shell/tools.js";
import { executionWorkspaceTools } from "../../plugins/execution/tools.js";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";
import {
  environmentMaskerOf,
  threadEnvironmentMasker,
  withExecutionEnvironment,
  withMaskedToolResults,
} from "./sandbox.js";

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

/**
 * #1663: what masking must survive. Each way a secret could still reach the
 * agent, its tool results, or the Thread's history:
 *
 * 1. Encoded: base64 (either alphabet, at any byte alignment, as in a Basic
 *    auth header) or URL-encoded (upper or lower hex, `+` for a space).
 * 2. Split: a command prints half a secret before one shell read and the rest
 *    before the next, so neither read holds the whole value.
 * 3. Cut: the 50 KB or 2,000-line window of a long read starts inside a
 *    secret, so the read begins with its tail.
 * 4. Unsaved credentials dx itself gives the Thread: GitHub tokens from the
 *    credential helper, the dxd key, and Claude plan tokens.
 * 5. Tools that never touch the Orb (code_exec, plugins, Thread tools)
 *    return a secret in their result or error.
 * 6. Masking breaks work: a command no longer receives the real value, an
 *    ordinary word or test fixture is masked, or a write puts a marker over a
 *    credential.
 * 7. Large outputs: masking a multi-megabyte read takes too long.
 */
/** Whether any 6 characters of `secret` decode out of a base64 run. */
const base64Reveals = (output: string, secret: string) => {
  const runs = output
    .split(/\[REDACTED:[A-Z_]+\]/)
    .flatMap((part) => part.match(/[A-Za-z0-9+/_-]{4,}/g) ?? []);
  for (const run of runs)
    for (let offset = 0; offset < 4; offset += 1) {
      const body = run.slice(offset);
      const usable = body.slice(0, body.length - (body.length % 4));
      const decoded = Buffer.from(
        usable.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("latin1");
      for (let start = 0; start + 6 <= secret.length; start += 1)
        if (decoded.includes(secret.slice(start, start + 6))) return true;
    }
  return false;
};

describe("secret masking edge cases (#1663)", () => {
  const SECRET = "dxs_live_7Hq2Vm9KpX4rT8w";
  const URL_SECRET = "p@ss w0rd/key+Value=1&x!(y)";
  // Built at run time so no credential-shaped literal sits in the repository.
  const GITHUB = `gh${"s_"}${"A1b2C3d4".repeat(4)}Z9y8`;
  const GITHUB_PAT = `github${"_pat_"}${"11AbCdEfG".repeat(9)}x`;
  const DXD = `dx${"d_"}${"QwErTyUiOp".repeat(6)}AsDf`;
  const CLAUDE = `sk-${"ant"}-oat01-${"Zx9_Yw8-".repeat(12)}AA`;
  const PEM = [
    "-----BEGIN TEST KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    "q3Lr8sR2nT5vW9xY1zA4bC6dE8fG0hJ2kL4mN6oP8qR0sT2uV4w",
    "-----END TEST KEY-----",
  ].join("\n");

  const secrets = () =>
    snapshot([
      value("DEPLOY_TOKEN", "secret", SECRET),
      value("URL_TOKEN", "secret", URL_SECRET),
      value("PEM_KEY", "secret", PEM),
      value("SHORT_KEY", "secret", "ent"),
      value("BUILD_CHANNEL", "variable", "client-beta"),
    ]);

  /** Whether any 4 characters of `secret` show in `output`. */
  const reveals = (output: string, secret: string) => {
    for (let start = 0; start + 4 <= secret.length; start += 1)
      if (output.includes(secret.slice(start, start + 4))) return true;
    return false;
  };

  const shellIn = (sandbox: Sandbox, home: string) => {
    const tools = createShellTools(
      {
        ...sandbox,
        exec: (command, options) =>
          sandbox.exec(command, {
            ...options,
            env: { HOME: home, ...options?.env },
          }),
      },
      { defaultWorkdir: home },
    );
    return async (index: number, params: Record<string, unknown>) => {
      const result = await tools[index]?.execute("test", params);
      return {
        text: (result?.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
        details: result?.details as { pid: number; running: boolean },
      };
    };
  };

  it("masks base64 and URL-encoded forms of a secret while the command still receives its value", async () => {
    const { sandbox } = await localSandbox(async () => secrets());
    const encoded = await sandbox.exec(
      [
        `for prefix in '' 'x:' 'ab:' 'x-access-token:'; do printf '%s' "$prefix$DEPLOY_TOKEN" | base64 -w0; echo; done`,
        `printf '%s' "ab:$DEPLOY_TOKEN" | base64 -w0 | tr '+/' '-_'; echo`,
        `printf 'Authorization: Basic %s\\n' "$(printf 'u:%s' "$DEPLOY_TOKEN" | base64 -w0)"`,
        `node -e 'const v = process.env.URL_TOKEN; console.log("https://u:" + encodeURIComponent(v) + "@host/"); console.log("q=" + encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase())); console.log("f=" + new URLSearchParams({ v }).toString().slice(2))'`,
        `python3 -c 'import os, urllib.parse as u; v = os.environ["URL_TOKEN"]; print("p=" + u.quote(v)); print("b=" + u.quote_plus(v))'`,
        `[ "$DEPLOY_TOKEN" = '${SECRET}' ] && echo command-sees-value`,
        `printf '%s' 'The client environment entry.' | base64 -w0; echo`,
      ].join("\n"),
    );
    expect(encoded.exitCode).toBe(0);
    const lines = encoded.stdout.trimEnd().split("\n");
    for (const line of lines.slice(0, 6)) {
      expect(line).toContain("[REDACTED:DEPLOY_TOKEN]");
      expect(base64Reveals(line, SECRET)).toBe(false);
    }
    expect(lines.slice(6, 11)).toEqual([
      "https://u:[REDACTED:URL_TOKEN]@host/",
      "q=[REDACTED:URL_TOKEN]",
      "f=[REDACTED:URL_TOKEN]",
      "p=[REDACTED:URL_TOKEN]",
      "b=[REDACTED:URL_TOKEN]",
    ]);
    // Masking is for what is read back: the process gets the real value.
    expect(lines[11]).toBe("command-sees-value");
    // A short secret and ordinary words stay readable, encoded or not.
    expect(lines[12]).toBe(
      Buffer.from("The client environment entry.").toString("base64"),
    );
    expect(encoded.stdout).not.toContain(SECRET);
  });

  it("masks a secret a command prints across two shell reads", async () => {
    const { sandbox, directory } = await localSandbox(async () => secrets());
    const call = shellIn(sandbox, directory);
    const go = join(directory, "go");
    for (const cut of [10, 3, 21]) {
      const started = await call(0, {
        command: `printf 'TOKEN=%s' "\${DEPLOY_TOKEN:0:${cut}}"; while [ ! -f ${go} ]; do sleep 0.02; done; printf '%s done\\n' "\${DEPLOY_TOKEN:${cut}}"`,
        timeout_ms: 500,
      });
      expect(started.details.running).toBe(true);
      await writeFile(go, "");
      const finished = await call(1, {
        pid: started.details.pid,
        timeout_ms: 5_000,
      });
      await rm(go);
      expect(finished.details.running).toBe(false);
      // No character of a split secret shows: the first read holds back
      // the secret's start and the second shows it masked (#1774).
      const both = `${started.text}\n${finished.text}`;
      expect(reveals(both, SECRET)).toBe(false);
      expect(started.text).toContain("<output>TOKEN=</output>");
      expect(finished.text).toContain(
        "<output>[REDACTED:DEPLOY_TOKEN] done\n</output>",
      );
    }
  });

  it("masks the rest of a secret when a long read's window starts inside it", async () => {
    const { sandbox, directory } = await localSandbox(async () => secrets());
    const call = shellIn(sandbox, directory);
    // The read keeps the last 51,200 bytes, starting 10 bytes into the secret.
    const after = 51_200 - (SECRET.length - 10);
    const bytes = await call(0, {
      command: `head -c 60000 /dev/zero | tr '\\0' a; printf '%s' "$DEPLOY_TOKEN"; head -c ${after} /dev/zero | tr '\\0' b`,
      timeout_ms: 10_000,
    });
    expect(bytes.text).toContain("[Output truncated to last 50 KB");
    expect(bytes.text).toContain("\n[REDACTED:DEPLOY_TOKEN]bbbb");
    expect(reveals(bytes.text, SECRET)).toBe(false);

    // The read keeps the last 2,000 lines, starting inside a multi-line key.
    const lines = await call(0, {
      command: `seq 1 500; printf '%s\\n' "$PEM_KEY"; seq 1 1997`,
      timeout_ms: 10_000,
    });
    expect(lines.text).toContain("[Output truncated to last 50 KB");
    expect(lines.text).toContain("[REDACTED:PEM_KEY]");
    for (const line of PEM.split("\n").slice(1))
      expect(lines.text).not.toContain(line);
  });

  it("masks credentials dx gives the Thread without anyone saving them, and leaves look-alikes alone", async () => {
    const { sandbox, directory } = await localSandbox(async () => secrets());
    const credentials = [
      `remote: https://x-access-token:${GITHUB}@github.com/o/r.git`,
      `GH_TOKEN=${GITHUB_PAT}`,
      `{"apiKey":"${DXD}","endpoint":"wss://x/dxd"}`,
      `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE}`,
    ].join("\n");
    const lookAlikes =
      'apiKey: "dxd_test-api-key-value", ghs_short, the ghs_ prefix, sk-ant-, dxd_aaaaaaaaaaaaaaaaaaaa\n';
    await writeFile(join(directory, "creds.txt"), `${credentials}\n`);
    await writeFile(join(directory, "fixtures.txt"), lookAlikes);
    const expected = [
      "remote: https://x-access-token:[REDACTED:GITHUB_TOKEN]@github.com/o/r.git",
      "GH_TOKEN=[REDACTED:GITHUB_TOKEN]",
      '{"apiKey":"[REDACTED:DXD_API_KEY]","endpoint":"wss://x/dxd"}',
      "CLAUDE_CODE_OAUTH_TOKEN=[REDACTED:CLAUDE_TOKEN]",
      "",
    ].join("\n");
    expect((await sandbox.exec("cat creds.txt")).stdout).toBe(expected);
    expect(await sandbox.readFile("creds.txt")).toBe(expected);
    expect(
      new TextDecoder().decode(await sandbox.readFileBuffer("creds.txt")),
    ).toBe(expected);
    expect((await sandbox.exec("cat fixtures.txt")).stdout).toBe(lookAlikes);
    expect(await sandbox.readFile("fixtures.txt")).toBe(lookAlikes);

    // An edit would write the marker over the token, so it is refused.
    const edit = createFileTools(sandbox).find(
      ({ name }) => name === "edit_file",
    );
    await expect(
      edit?.execute("edit", {
        path: join(directory, "creds.txt"),
        old_str: "endpoint",
        new_str: "url",
      }),
    ).rejects.toThrow(
      "holds a credential, which dx shows as [REDACTED:GITHUB_TOKEN]",
    );
    await expect(readFile(join(directory, "creds.txt"), "utf8")).resolves.toBe(
      `${credentials}\n`,
    );
    // A file with only look-alikes edits as before.
    await edit?.execute("edit", {
      path: join(directory, "fixtures.txt"),
      old_str: "ghs_short",
      new_str: "ghs_tiny",
    });
    await expect(
      readFile(join(directory, "fixtures.txt"), "utf8"),
    ).resolves.toBe(lookAlikes.replace("ghs_short", "ghs_tiny"));

    // Claude Code streams model text in fragments that can cut a token.
    const stream = new ClaudeCodeStream();
    stream.masker = await threadEnvironmentMasker("thread");
    const delta = (text: string) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        parent_tool_use_id: null,
      });
    stream.push(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        parent_tool_use_id: null,
      }),
    );
    for (const text of [
      "token ",
      GITHUB.slice(0, 2),
      GITHUB.slice(2, 9),
      `${GITHUB.slice(9)} and key ${DXD.slice(0, 30)}`,
      `${DXD.slice(30)}.`,
    ])
      stream.push(delta(text));
    stream.push(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
      }),
    );
    expect(stream.segments[0]?.blocks[0]).toMatchObject({
      type: "text",
      text: "token [REDACTED:GITHUB_TOKEN] and key [REDACTED:DXD_API_KEY].",
    });
  });

  it("masks a secret in wrapped base64, wherever the line break falls", async () => {
    const { sandbox } = await localSandbox(async () => secrets());
    // GNU base64 wraps at 76 characters; each padding moves the secret
    // across the line break.
    const wrapped = await sandbox.exec(
      `for pad in $(seq 0 75); do printf '%*sSECRET=%s\\n' "$pad" '' "$DEPLOY_TOKEN" | tr ' ' x | base64; echo ---; done`,
    );
    expect(wrapped.exitCode).toBe(0);
    const blocks = wrapped.stdout
      .split("---\n")
      .filter((block) => block !== "");
    expect(blocks).toHaveLength(76);
    for (const block of blocks) {
      expect(block).toContain("[REDACTED:DEPLOY_TOKEN]");
      expect(base64Reveals(block.replaceAll("\n", ""), SECRET)).toBe(false);
    }
  });

  it("masks the middle of a secret printed across three shell reads", async () => {
    const { sandbox, directory } = await localSandbox(async () => secrets());
    const call = shellIn(sandbox, directory);
    const [first, second] = [join(directory, "go1"), join(directory, "go2")];
    const started = await call(0, {
      command: `printf 'TOKEN=%s' "\${DEPLOY_TOKEN:0:6}"; while [ ! -f ${first} ]; do sleep 0.02; done; printf '%s' "\${DEPLOY_TOKEN:6:10}"; while [ ! -f ${second} ]; do sleep 0.02; done; printf '%s done\\n' "\${DEPLOY_TOKEN:16}"`,
      timeout_ms: 500,
    });
    await writeFile(first, "");
    const middle = await call(1, { pid: started.details.pid, timeout_ms: 500 });
    expect(middle.details.running).toBe(true);
    await writeFile(second, "");
    const last = await call(1, { pid: started.details.pid, timeout_ms: 5_000 });
    expect(last.details.running).toBe(false);
    const all = [started.text, middle.text, last.text].join("\n");
    expect(reveals(all, SECRET)).toBe(false);
    // The middle read is all inside the secret, so it holds it all back.
    expect(started.text).toContain("<output>TOKEN=</output>");
    expect(middle.text).not.toContain("<output>");
    expect(last.text).toContain(
      "<output>[REDACTED:DEPLOY_TOKEN] done\n</output>",
    );
  });

  it("never releases a streamed credential or secret before it can be masked", async () => {
    // One saved secret starts with characters the credentials also use.
    const { sandbox } = await localSandbox(async () =>
      snapshot([
        value("PAT_LIKE", "secret", "gSup3rSecretValue!xyz"),
        value("SHORTER", "secret", "abcdefgh12"),
        value("LONGER", "secret", "abcdefgh1234"),
      ]),
    );
    const masker = await environmentMaskerOf(sandbox);
    const stream = (text: string, size: number) => {
      let held = "";
      let shown = "";
      for (let offset = 0; offset < text.length; offset += size) {
        const step = masker.maskFragment(
          held,
          text.slice(offset, offset + size),
        );
        shown += step.released;
        held = step.held;
      }
      return shown + masker.maskFragment(held, "", true).released;
    };
    const claude = `sk-${"ant"}-oat01-${"Zx9_Yw8-".repeat(12)}AA`;
    const pat = `github${"_pat_"}${"11AbCdEfG".repeat(9)}x`;
    for (const size of [1, 3, 4, 5, 8, 13]) {
      expect(stream(`push with ${GITHUB} now`, size)).toBe(
        "push with [REDACTED:GITHUB_TOKEN] now",
      );
      expect(stream(`token ${claude} end`, size)).toBe(
        "token [REDACTED:CLAUDE_TOKEN] end",
      );
      expect(stream(`pat ${pat} end`, size)).toBe(
        "pat [REDACTED:GITHUB_TOKEN] end",
      );
      expect(stream("keys abcdefgh1234 and abcdefgh12.", size)).toBe(
        "keys [REDACTED:LONGER] and [REDACTED:SHORTER].",
      );
      expect(stream("then gSup3rSecretValue!xyz.", size)).toBe(
        "then [REDACTED:PAT_LIKE].",
      );
    }
  });

  it("masks a large output at a bounded cost per megabyte", async () => {
    const { sandbox, directory } = await localSandbox(async () =>
      snapshot(
        Array.from({ length: 20 }, (_, index) =>
          value(`TOKEN_${index}`, "secret", `${SECRET}-${index}-${index}`),
        ),
      ),
    );
    const line = `${"x".repeat(60)} ${"The client environment entry ".repeat(3)}\n`;
    const chunk = line.repeat(Math.ceil(100_000 / line.length));
    const parts: string[] = [];
    for (let index = 0; index < 40; index += 1)
      parts.push(
        chunk,
        `TOKEN=${SECRET}-${index % 20}-${index % 20} `,
        Buffer.from(`u:${SECRET}-${index % 20}-${index % 20}`).toString(
          "base64",
        ),
        ` ${GITHUB}\n`,
      );
    const content = parts.join("");
    const megabytes = Buffer.byteLength(content) / 1_000_000;
    await writeFile(join(directory, "big.log"), content);
    // The first read resolves the environment; time the ones after it.
    await sandbox.readFile("big.log");
    const timings: Record<string, number> = {};
    for (const [name, read] of [
      ["text", () => sandbox.readFile("big.log")],
      [
        "bytes",
        async () =>
          new TextDecoder().decode(await sandbox.readFileBuffer("big.log")),
      ],
    ] as const) {
      const started = performance.now();
      const masked = await read();
      timings[name] = (performance.now() - started) / megabytes;
      expect(masked).not.toContain(SECRET);
      expect(masked).not.toContain(GITHUB);
      expect(masked.match(/\[REDACTED:TOKEN_\d+\]/g)).toHaveLength(80);
      expect(masked.match(/\[REDACTED:GITHUB_TOKEN\]/g)).toHaveLength(40);
    }
    // The same output as a command's shell reads: 50 KB each, with the
    // 4 KiB before it, holding back what could begin a secret (#1774).
    const masker = await environmentMaskerOf(sandbox);
    const bytes = Buffer.from(content);
    const started = performance.now();
    let shown = "";
    for (let offset = 0; offset < bytes.length; offset += 51_200)
      shown += masker.maskRead(
        bytes.subarray(Math.max(0, offset - masker.readContextBytes), offset),
        bytes.subarray(offset, offset + 51_200),
        {
          heldBefore: true,
          final: offset + 51_200 >= bytes.length,
          context: masker.readContextBytes,
        },
      );
    timings.reads = (performance.now() - started) / megabytes;
    expect(shown).toBe(masker.mask(content));
    console.info(
      `secret masking, 20 secrets and their encoded forms over ${megabytes.toFixed(1)} MB: ${timings.text?.toFixed(1)} ms/MB as text, ${timings.bytes?.toFixed(1)} ms/MB as bytes (read and mask), ${timings.reads?.toFixed(1)} ms/MB as 50 KB shell reads`,
    );
    expect(timings.text).toBeLessThan(150);
    expect(timings.bytes).toBeLessThan(150);
    expect(timings.reads).toBeLessThan(150);
  });

  it("keeps every form of a secret out of the agent's tool results and Flue history, including tools outside the Orb", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dx-environment-test-"));
    temporaryDirectories.push(directory);
    const environment = local({ cwd: directory });
    const factory = withExecutionEnvironment(
      {
        createSandbox: (request) => environment.createSandbox(request),
        tools: executionWorkspaceTools,
      },
      async () => secrets(),
    );
    await writeFile(
      join(directory, ".env"),
      `DEPLOY_TOKEN=${SECRET}\nURL_TOKEN=${encodeURIComponent(URL_SECRET)}\nAUTH=${Buffer.from(`u:${SECRET}`).toString("base64")}\nGITHUB=${GITHUB}\n`,
    );
    const lookup = withMaskedToolResults(
      defineTool({
        name: "lookup",
        description: "Looks something up outside the Orb.",
        run: async () => ({
          output: { found: `token ${SECRET}`, nested: [{ key: DXD }] },
        }),
      }),
      () => threadEnvironmentMasker("environment-everywhere"),
    );
    const failing = withMaskedToolResults(
      defineTool({
        name: "failing",
        description: "Fails with a secret in its message.",
        run: async () => {
          throw new Error(`upstream rejected ${GITHUB}`);
        },
      }),
      () => threadEnvironmentMasker("environment-everywhere"),
    );
    const results: string[] = [];
    let history = "";
    const provider = fauxProvider();
    const next =
      (call: ReturnType<typeof fauxToolCall>) =>
      (context: { messages: ReadonlyArray<unknown> }) => {
        results.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage(call, { stopReason: "toolUse" });
      };
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("shell_command", { command: "cat .env; env" }),
        { stopReason: "toolUse" },
      ),
      next(fauxToolCall("shell_command", { command: "grep AUTH .env" })),
      next(fauxToolCall("lookup", {})),
      next(fauxToolCall("failing", {})),
      (context) => {
        results.push(JSON.stringify(context.messages.at(-1)));
        history = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);

    function LocalAgent(_props: AgentProps) {
      useModel("faux/faux-1");
      useSandbox(factory);
      useTool(lookup);
      useTool(failing);
      return "Use the tools.";
    }
    LocalAgent.agentName = "environment-everywhere-test";

    await using _runtime = await start({
      agents: [LocalAgent],
      providers: [provider.provider],
    });
    const handle = init(LocalAgent, { id: "environment-everywhere" });
    const receipt = await handle.dispatch("Show the environment.");
    await expect(handle.read(receipt)).resolves.toMatchObject({ text: "done" });

    expect(results).toHaveLength(4);
    expect(results[0]).toContain("DEPLOY_TOKEN=[REDACTED:DEPLOY_TOKEN]");
    expect(results[0]).toContain("URL_TOKEN=[REDACTED:URL_TOKEN]");
    expect(results[0]).toContain("GITHUB=[REDACTED:GITHUB_TOKEN]");
    expect(results[0]).toContain("BUILD_CHANNEL=client-beta");
    expect(results[1]).toMatch(
      /AUTH=[A-Za-z0-9+/]{0,4}\[REDACTED:DEPLOY_TOKEN\]/,
    );
    expect(results[2]).toContain("token [REDACTED:DEPLOY_TOKEN]");
    expect(results[2]).toContain("[REDACTED:DXD_API_KEY]");
    expect(results[3]).toContain("upstream rejected [REDACTED:GITHUB_TOKEN]");
    for (const plaintext of [SECRET, URL_SECRET, GITHUB, DXD])
      expect(history).not.toContain(plaintext);
    expect(history).not.toContain(encodeURIComponent(URL_SECRET));
    expect(base64Reveals(history, SECRET)).toBe(false);
  });
});

type Read = { readonly output: string; readonly running: boolean };

const outputOf = (text: string) =>
  /<output>([\s\S]*)<\/output>/.exec(text)?.[1] ?? "";

/**
 * Runs one command through shell_command and shell_command_status that
 * prints `parts` one at a time, each after the test lets it, so every read
 * ends exactly where a part does. Returns each read's output. `beforeRead`
 * runs before each read after the first, to change what is saved.
 */
const streamed = async (
  sandbox: Sandbox,
  parts: ReadonlyArray<Uint8Array | string>,
  beforeRead?: (index: number) => void,
): Promise<Read[]> => {
  const directory = await mkdtemp(join(tmpdir(), "dx-hold-test-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    parts.map((part, index) =>
      writeFile(join(directory, `part${index}`), part),
    ),
  );
  const tools = createShellTools(
    {
      ...sandbox,
      exec: (command, options) =>
        sandbox.exec(command, {
          ...options,
          env: { HOME: directory, ...options?.env },
        }),
    },
    { defaultWorkdir: directory },
  );
  const call = async (index: number, params: Record<string, unknown>) => {
    const result = await tools[index]?.execute("test", params);
    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const details = result?.details as { pid: number; running: boolean };
    return { text, details };
  };
  const command = parts
    .map(
      (_, index) =>
        `${index === 0 ? "" : `while [ ! -f go${index} ]; do sleep 0.01; done; `}cat part${index}`,
    )
    .join("; ");
  const reads: Read[] = [];
  const started = await call(0, { command, timeout_ms: 300 });
  reads.push({
    output: outputOf(started.text),
    running: started.details.running,
  });
  for (let index = 1; index < parts.length; index += 1) {
    beforeRead?.(index);
    await writeFile(join(directory, `go${index}`), "");
    const last = index === parts.length - 1;
    const read = await call(1, {
      pid: started.details.pid,
      timeout_ms: last ? 10_000 : 300,
    });
    reads.push({
      output: outputOf(read.text),
      running: read.details.running,
    });
  }
  // A read after the command ended and was flushed shows nothing again.
  const after = await call(1, { pid: started.details.pid, timeout_ms: 0 });
  reads.push({
    output: outputOf(after.text),
    running: after.details.running,
  });
  return reads;
};

/** Each way to cut `whole` in two, with the first part ending at byte `cut`. */
const everyCut = (whole: string) => {
  const bytes = Buffer.from(whole);
  return Array.from({ length: bytes.length + 1 }, (_, cut) => [
    bytes.subarray(0, cut),
    bytes.subarray(cut),
  ]);
};

/** Runs `count` jobs, a few at a time. */
const inBatches = async <A>(
  count: number,
  job: (index: number) => Promise<A>,
) => {
  const results: A[] = [];
  for (let start = 0; start < count; start += 8)
    results.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(8, count - start) }, (_, offset) =>
          job(start + offset),
        ),
      )),
    );
  return results;
};

describe("shell reads hold back what could begin a secret (#1774)", () => {
  const QA_PREFIX = "second-half-QA7x9Lm2Pq";
  const DEPLOY = "dxs_live_7Hq2Vm9KpX4rT8w";
  const UNICODE = "clé-sëcret-wörd-42✓";
  const SHORTER = "abcdefgh12";
  const LONGER = "abcdefgh1234";
  const OVERLAP_A = "alpha-bravo-1x";
  const OVERLAP_B = "bravo-1x-charlie";
  const DATABASE_URL = "postgres://app:pw-9f3k2@db.internal:5432/app";
  const API_BASE_URL = "https://api.internal.example/v1";
  const GITHUB = `gh${"s_"}${"A1b2C3d4".repeat(4)}Z9y8`;

  const saved = () =>
    snapshot([
      value("QA_PREFIX", "secret", QA_PREFIX),
      value("DEPLOY_TOKEN", "secret", DEPLOY),
      value("UNICODE_TOKEN", "secret", UNICODE),
      value("SHORTER", "secret", SHORTER),
      value("LONGER", "secret", LONGER),
      value("OVERLAP_A", "secret", OVERLAP_A),
      value("OVERLAP_B", "secret", OVERLAP_B),
      value("DATABASE_URL", "secret", DATABASE_URL),
      value("API_BASE_URL", "secret", API_BASE_URL),
    ]);

  it("returns QA's streamed output byte for byte, never a marker for a secret that was not printed", async () => {
    const { sandbox, directory } = await localSandbox(async () => saved());
    const tools = createShellTools(
      {
        ...sandbox,
        exec: (command, options) =>
          sandbox.exec(command, {
            ...options,
            env: { HOME: directory, ...options?.env },
          }),
      },
      { defaultWorkdir: directory },
    );
    const run = async (index: number, params: Record<string, unknown>) => {
      const result = await tools[index]?.execute("qa", params);
      return {
        text: (result?.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
        details: result?.details as { pid: number; running: boolean },
      };
    };
    // The command from #1774, as QA ran it on staging.
    const reads = [
      await run(0, {
        command: `printf 'first-half second'; sleep 8; printf '%s\\n' '-half done'`,
        timeout_ms: 3000,
      }),
    ];
    expect(reads[0]?.details.running).toBe(true);
    while (reads.at(-1)?.details.running === true)
      reads.push(
        await run(1, { pid: reads[0]?.details.pid, timeout_ms: 10_000 }),
      );
    reads.push(await run(1, { pid: reads[0]?.details.pid, timeout_ms: 0 }));
    const outputs = reads.map(({ text }) => outputOf(text));
    for (const output of outputs) expect(output).not.toContain("[REDACTED");
    expect(outputs.join("")).toBe("first-half second-half done\n");
    // The first read held back only what could begin the secret.
    expect(outputs[0]).toBe("first-half ");
    expect(outputs.at(-1)).toBe("");
  }, 30_000);

  it("shows ordinary text unchanged wherever a read cuts it, including inside a multi-byte character", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const ordinary =
      "first-half second-half done; see https://example.com and postgres:// docs, abcdefgh1 naïve café ✓ 日本 alpha-bravo-1 clé-s\n";
    const cuts = everyCut(ordinary);
    const results = await inBatches(cuts.length, (index) =>
      streamed(sandbox, cuts[index] ?? []),
    );
    for (const [index, reads] of results.entries()) {
      expect(
        reads.map(({ output }) => output).join(""),
        `cut at byte ${index}`,
      ).toBe(ordinary);
      expect(reads.at(-1)?.output).toBe("");
    }
  }, 120_000);

  it("masks a secret split between two reads at every byte position, ASCII, non-ASCII, and credential-shaped", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    for (const [secret, marker] of [
      [DEPLOY, "[REDACTED:DEPLOY_TOKEN]"],
      [UNICODE, "[REDACTED:UNICODE_TOKEN]"],
      [GITHUB, "[REDACTED:GITHUB_TOKEN]"],
      [encodeURIComponent(UNICODE), "[REDACTED:UNICODE_TOKEN]"],
    ] as const) {
      const whole = `TOKEN=${secret} done\n`;
      const cuts = everyCut(whole);
      const results = await inBatches(cuts.length, (index) =>
        streamed(sandbox, cuts[index] ?? []),
      );
      for (const [index, reads] of results.entries())
        expect(
          reads.map(({ output }) => output).join(""),
          `${marker} cut at byte ${index}`,
        ).toBe(`TOKEN=${marker} done\n`);
    }
  }, 240_000);

  it("masks a secret split across three reads, with the middle read inside it", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const bytes = Buffer.from(`TOKEN=${UNICODE} done\n`);
    const start = "TOKEN=".length;
    const end = start + Buffer.byteLength(UNICODE);
    const pairs: Array<[number, number]> = [];
    for (let first = start; first < end; first += 1)
      for (const width of [1, 3, 7])
        if (first + width < end) pairs.push([first, first + width]);
    const results = await inBatches(pairs.length, (index) => {
      const [first, second] = pairs[index] ?? [0, 0];
      return streamed(sandbox, [
        bytes.subarray(0, first),
        bytes.subarray(first, second),
        bytes.subarray(second),
      ]);
    });
    for (const [index, reads] of results.entries()) {
      expect(reads[1]?.output, `cut at ${pairs[index]}`).toBe("");
      expect(reads[1]?.running).toBe(true);
      expect(
        reads.map(({ output }) => output).join(""),
        `cut at ${pairs[index]}`,
      ).toBe("TOKEN=[REDACTED:UNICODE_TOKEN] done\n");
    }
  }, 240_000);

  it("masks a secret that begins another, and overlapping secrets, wherever a read cuts them", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    for (const [whole, expected] of [
      [`key ${LONGER} end\n`, "key [REDACTED:LONGER] end\n"],
      [`key ${SHORTER} end\n`, "key [REDACTED:SHORTER] end\n"],
      [
        `key ${SHORTER}${LONGER}.\n`,
        "key [REDACTED:SHORTER][REDACTED:LONGER].\n",
      ],
      [
        "key alpha-bravo-1x-charlie end\n",
        "key [REDACTED:OVERLAP_A][REDACTED:OVERLAP_B] end\n",
      ],
    ] as const) {
      const cuts = everyCut(whole);
      const results = await inBatches(cuts.length, (index) =>
        streamed(sandbox, cuts[index] ?? []),
      );
      for (const [index, reads] of results.entries())
        expect(
          reads.map(({ output }) => output).join(""),
          `${whole.trim()} cut at byte ${index}`,
        ).toBe(expected);
    }
  }, 240_000);

  it("returns raw bytes as printed, even where their hex spells a saved hex secret", async () => {
    const { sandbox } = await localSandbox(async () =>
      snapshot([
        value("HEX_EVEN", "secret", "deadbeefcafebabe0011"),
        value("HEX_ODD", "secret", "1234567890abcdef1234"),
      ]),
    );
    // Core gets each read as hex; the sandbox masks what it returns, so a
    // saved hex secret must not match the hex of other bytes, at either
    // nibble alignment.
    const printed = Buffer.concat([
      Buffer.from("even "),
      Buffer.from("deadbeefcafebabe0011", "hex"),
      Buffer.from(" odd "),
      Buffer.from("01234567890abcdef12340", "hex"),
      Buffer.from(" end\n"),
    ]);
    const reads = await streamed(sandbox, [printed]);
    expect(reads.map(({ output }) => output).join("")).toBe(
      new TextDecoder().decode(printed),
    );
  }, 30_000);

  it("holds a secret's start while the command runs, and shows it as printed once the command ends without finishing it", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const partial = DEPLOY.slice(0, 12);
    const reads = await streamed(sandbox, [`key=${partial}`, ""]);
    expect(reads[0]).toEqual({ output: "key=", running: true });
    // Only part of the secret was ever printed, so it is not the secret.
    expect(reads[1]).toEqual({ output: partial, running: false });
    expect(reads[2]?.output).toBe("");
  }, 30_000);
});

/**
 * #1780: what a shell read could still show of a secret split between reads
 * after #1776, written down before the fix.
 *
 * Wrapped base64:
 * 1. A read that stops inside a base64 form wrapped at 76 columns (GNU
 *    base64) or 64 (openssl) shows the part before the cut, since its line
 *    break hides it from the hold.
 * 2. The same at any other width, down to one character a line.
 * 3. The same with CRLF line ends, and with the cut between `\r` and `\n`,
 *    right before a break, or right after one.
 * 4. The same at each of base64's three byte alignments.
 * 5. Ordinary text and wrapped base64 that holds no secret come back
 *    changed: a marker, a byte dropped or shown twice, or a split character.
 * Secrets over 4 KiB:
 * 6. A read that stops more than 4 KiB into a secret shows its start; the
 *    next read, given only 4 KiB of context, shows its end.
 * 7. The same at 5 KiB (a PEM key, with newlines, `+`, `/`, `=`), 6 KiB of
 *    non-ASCII text cut inside a character, 32 KiB (the most a variable
 *    holds), and 64 KiB.
 * 8. A secret longer than a whole read (64 KiB against a read's 50 KB).
 * 9. Three reads with the middle one inside a long secret.
 * 10. A long secret URL-encoded (three times as long) or in wrapped base64.
 * 11. Several secrets, short and long, in one output.
 * 12. Saving a long secret makes masking fail or crawl: building and
 *     running one regular expression with a long secret's forms.
 * 13. Speed: ordinary secrets lose the ~8 ms/MB #1776 measured.
 */
describe("shell reads mask wrapped base64 and long secrets split across reads (#1780)", () => {
  const WRAP_TOKEN = "dxs_live_7Hq2Vm9KpX4rT8w-wrap";
  const DEPLOY = "dxs_live_7Hq2Vm9KpX4rT8w";

  /** The same bytes on every run, so a failure names its exact cut. */
  const randomBytes = (size: number, seed: number) => {
    const bytes = new Uint8Array(size);
    let state = seed;
    for (let index = 0; index < size; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state >>> 24;
    }
    return bytes;
  };
  const randomText = (size: number, alphabet: string, seed: number) =>
    [...randomBytes(size, seed)]
      .map((byte) => alphabet[byte % alphabet.length])
      .join("");
  const ALPHANUMERIC =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  /** Text as `base64` prints it: `width` characters a line, each ended. */
  const wrap = (text: string, width: number, end: string) =>
    (text.match(new RegExp(`.{1,${width}}`, "g")) ?? [])
      .map((line) => line + end)
      .join("");

  const PEM_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    wrap(Buffer.from(randomBytes(3_800, 1)).toString("base64"), 64, "\n"),
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const UNICODE_KEY = randomText(3_800, "abcdef0123éü✓日本語", 2);
  const BIG_KEY = randomText(32_768, ALPHANUMERIC, 3);
  const HUGE_KEY = randomText(65_536, ALPHANUMERIC, 4);

  const saved = () =>
    snapshot([
      value("WRAP_TOKEN", "secret", WRAP_TOKEN),
      value("DEPLOY_TOKEN", "secret", DEPLOY),
      value("PEM_KEY", "secret", PEM_KEY),
      value("UNICODE_KEY", "secret", UNICODE_KEY),
      value("BIG_KEY", "secret", BIG_KEY),
      value("HUGE_KEY", "secret", HUGE_KEY),
    ]);

  /** The whole of each read, as the agent sees it, without truncation notes. */
  const joined = (reads: ReadonlyArray<Read>) =>
    reads
      .map(({ output }) => output)
      .join("")
      .replaceAll("[Output truncated to last 50 KB / 2,000 lines]\n", "");

  /** Every cut of `whole` in two at the given byte positions. */
  const cutsAt = (whole: Uint8Array, positions: Iterable<number>) =>
    [...new Set(positions)]
      .filter((cut) => cut >= 0 && cut <= whole.length)
      .sort((left, right) => left - right)
      .map(
        (cut) => [cut, [whole.subarray(0, cut), whole.subarray(cut)]] as const,
      );

  /** Runs each cut through real shell reads and checks it against `expected`. */
  const expectEveryCut = async (
    sandbox: Sandbox,
    label: string,
    cuts: ReadonlyArray<readonly [number, ReadonlyArray<Uint8Array>]>,
    check: (shown: string, cut: number) => void,
  ) => {
    const results = await inBatches(cuts.length, (index) =>
      streamed(sandbox, cuts[index]?.[1] ?? []),
    );
    for (const [index, reads] of results.entries()) {
      const cut = cuts[index]?.[0] ?? -1;
      check(joined(reads), cut);
      expect(reads.at(-1)?.output, `${label} cut at byte ${cut}`).toBe("");
    }
  };

  /** A base64 form of WRAP_TOKEN whose line break falls inside the token. */
  const wrappedToken = (width: number, end: string, shift: number) => {
    // Put the token's base64 across the first line's end; `shift` moves it
    // through base64's three byte alignments.
    const pad = Math.max(0, Math.floor((3 * width) / 4) - 19) + shift;
    const payload = `${"x".repeat(pad)}SECRET=${WRAP_TOKEN}\n`;
    return `KEY=\n${wrap(Buffer.from(payload).toString("base64"), width, end)}done\n`;
  };

  const expectWrappedMasked = async (
    sandbox: Sandbox,
    variants: ReadonlyArray<readonly [number, string, number]>,
  ) => {
    const masker = await environmentMaskerOf(sandbox);
    for (const [width, end, shift] of variants) {
      const whole = wrappedToken(width, end, shift);
      const label = `width ${width} ${JSON.stringify(end)} shift ${shift}`;
      const expected = masker.mask(whole);
      // Read whole, the token's base64 is masked and only the padding's
      // characters show.
      expect(expected, label).toContain("[REDACTED:WRAP_TOKEN]");
      expect(
        base64Reveals(expected.replace(/\r?\n/g, ""), WRAP_TOKEN),
        label,
      ).toBe(false);
      const bytes = Buffer.from(whole);
      await expectEveryCut(
        sandbox,
        label,
        cutsAt(
          bytes,
          Array.from({ length: bytes.length + 1 }, (_, cut) => cut),
        ),
        (shown, cut) =>
          expect(shown, `${label} cut at byte ${cut}`).toBe(expected),
      );
    }
  };

  it("masks wrapped base64 split between two reads at every byte, at 76 and 64 columns, LF and CRLF, at every alignment", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    await expectWrappedMasked(sandbox, [
      [76, "\n", 0],
      [76, "\n", 1],
      [76, "\n", 2],
      [64, "\n", 0],
      [76, "\r\n", 1],
      [64, "\r\n", 2],
    ]);
  }, 400_000);

  it("masks wrapped base64 at any line width, including a read that stops between \\r and \\n", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    await expectWrappedMasked(sandbox, [
      [1, "\r\n", 0],
      [5, "\n", 1],
      [17, "\r\n", 2],
      [33, "\n", 0],
    ]);
  }, 400_000);

  it("shows ordinary text and wrapped base64 that holds no secret unchanged wherever a read cuts it, with long secrets saved", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const ordinary = [
      "naïve café ✓ 日本 build ok",
      wrap(Buffer.from(randomBytes(90, 9)).toString("base64"), 76, "\n"),
      wrap(Buffer.from(randomBytes(40, 10)).toString("base64"), 20, "\r\n"),
      // Begins like the saved PEM key, then differs.
      "-----BEGIN PRIVATE KEY-----\nnot the key\n",
      `${UNICODE_KEY.slice(0, 40)} and ${BIG_KEY.slice(0, 30)}…\n`,
    ].join("\n");
    const bytes = Buffer.from(ordinary);
    await expectEveryCut(
      sandbox,
      "ordinary",
      cutsAt(
        bytes,
        Array.from({ length: bytes.length + 1 }, (_, cut) => cut),
      ),
      (shown, cut) => expect(shown, `cut at byte ${cut}`).toBe(ordinary),
    );
  }, 400_000);

  /** Cuts at the edges of the secret, of each 4 KiB, and of a 50 KB read. */
  const longCuts = (whole: Uint8Array, start: number, end: number) => {
    const positions = [start - 1, start, end, end + 1, (start + end) >> 1];
    for (let offset = 1; offset <= 6; offset += 1)
      positions.push(start + offset, end - offset);
    for (let at = 4_096; at < whole.length; at += 4_096)
      positions.push(at - 1, at, at + 1, start + at - 1, start + at);
    positions.push(51_199, 51_200, 51_201, whole.length - 51_200);
    // Inside a multi-byte character, where there is one.
    let inside = 0;
    for (let at = start; at < end && inside < 8; at += 1)
      if ((whole[at] ?? 0) >= 0x80 && (whole[at] ?? 0) < 0xc0 && at % 7 === 0) {
        positions.push(at);
        inside += 1;
      }
    return cutsAt(whole, positions);
  };

  it("masks a secret over 4 KiB split between two reads wherever the cut falls: 5 KiB PEM, 6 KiB non-ASCII, 32 KiB, 64 KiB", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    for (const [name, secret] of [
      ["PEM_KEY", PEM_KEY],
      ["UNICODE_KEY", UNICODE_KEY],
      ["BIG_KEY", BIG_KEY],
      ["HUGE_KEY", HUGE_KEY],
    ] as const) {
      const whole = Buffer.from(`KEY=${secret} done\n`);
      const expected = `KEY=[REDACTED:${name}] done\n`;
      await expectEveryCut(
        sandbox,
        name,
        longCuts(whole, 4, 4 + Buffer.byteLength(secret)),
        (shown, cut) => {
          // A read keeps at most 50 KB, so where a read around a 64 KiB
          // secret skips output, part of `KEY=` may go with it.
          if (Buffer.byteLength(secret) < 51_200)
            expect(shown, `${name} cut at byte ${cut}`).toBe(expected);
          const [before = "", after] = shown.split(`[REDACTED:${name}]`);
          expect("KEY=".includes(before), `${name} cut at byte ${cut}`).toBe(
            true,
          );
          expect(after, `${name} cut at byte ${cut}`).toBe(" done\n");
        },
      );
    }
  }, 400_000);

  it("masks a long secret split between reads when a longer secret is saved or deleted between them", async () => {
    // A read sends and holds as much as the longest saved secret spans, so
    // saving or deleting the longest one changes it between two reads.
    let values = saved().values;
    const { sandbox } = await localSandbox(async () => snapshot(values));
    const all = values;
    const without = all.filter(
      ({ name }) => name !== "HUGE_KEY" && name !== "BIG_KEY",
    );
    const whole = Buffer.from(`KEY=${PEM_KEY} done\n`);
    for (const [label, first, then] of [
      ["deleted", all, without],
      ["saved", without, all],
    ] as const)
      for (const cut of [5, 100, 2_048, 4_096, 5_000, whole.length - 8]) {
        values = first;
        const reads = await streamed(
          sandbox,
          [whole.subarray(0, cut), whole.subarray(cut)],
          () => {
            values = then;
          },
        );
        expect(
          joined(reads),
          `${label} between reads, cut at byte ${cut}`,
        ).toBe("KEY=[REDACTED:PEM_KEY] done\n");
      }
  }, 120_000);

  it("masks a long secret split across three reads, the middle read inside it, and several secrets in one output", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const start = "KEY=".length;
    for (const [name, secret, pairs] of [
      [
        "BIG_KEY",
        BIG_KEY,
        [
          [10, 20_000],
          [4_095, 8_193],
          [1, 32_767],
        ],
      ],
      [
        "PEM_KEY",
        PEM_KEY,
        [
          [100, 5_000],
          [3, 4_100],
        ],
      ],
    ] as const) {
      const whole = Buffer.from(`KEY=${secret} done\n`);
      const results = await Promise.all(
        pairs.map(([first, second]) =>
          streamed(sandbox, [
            whole.subarray(0, start + first),
            whole.subarray(start + first, start + second),
            whole.subarray(start + second),
          ]),
        ),
      );
      for (const [index, reads] of results.entries()) {
        const label = `${name} cut at ${pairs[index]}`;
        expect(reads[1], label).toEqual({ output: "", running: true });
        expect(joined(reads), label).toBe(`KEY=[REDACTED:${name}] done\n`);
      }
    }
    const several = Buffer.from(
      `A=${DEPLOY} B=${BIG_KEY} C=${UNICODE_KEY} D=${PEM_KEY}\n`,
    );
    const expected =
      "A=[REDACTED:DEPLOY_TOKEN] B=[REDACTED:BIG_KEY] C=[REDACTED:UNICODE_KEY] D=[REDACTED:PEM_KEY]\n";
    await expectEveryCut(
      sandbox,
      "several",
      cutsAt(several, [
        10,
        20_000,
        2 + DEPLOY.length + 3 + 32_768 + 3 + 50,
        several.length - 2_000,
        several.length - 10,
      ]),
      (shown, cut) =>
        expect(shown, `several cut at byte ${cut}`).toBe(expected),
    );
  }, 400_000);

  it("masks a long secret URL-encoded or in wrapped base64, split between reads", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const masker = await environmentMaskerOf(sandbox);
    for (const [label, whole, name, secret] of [
      [
        "URL-encoded PEM",
        `KEY=${encodeURIComponent(PEM_KEY)} done\n`,
        "PEM_KEY",
        PEM_KEY,
      ],
      [
        "wrapped base64 PEM",
        `KEY=\n${wrap(Buffer.from(`k:${PEM_KEY}`).toString("base64"), 76, "\n")}done\n`,
        "PEM_KEY",
        PEM_KEY,
      ],
      [
        "wrapped base64 non-ASCII, CRLF",
        `KEY=\n${wrap(Buffer.from(`ab:${UNICODE_KEY}`).toString("base64"), 64, "\r\n")}done\n`,
        "UNICODE_KEY",
        UNICODE_KEY,
      ],
    ] as const) {
      const expected = masker.mask(whole);
      expect(expected, label).toContain(`[REDACTED:${name}]`);
      expect(
        base64Reveals(expected.replace(/\r?\n/g, ""), secret.slice(0, 600)),
        label,
      ).toBe(false);
      if (label.startsWith("URL"))
        expect(expected).toBe(`KEY=[REDACTED:${name}] done\n`);
      const bytes = Buffer.from(whole);
      await expectEveryCut(
        sandbox,
        label,
        longCuts(bytes, 5, bytes.length - 6),
        (shown, cut) =>
          expect(shown, `${label} cut at byte ${cut}`).toBe(expected),
      );
    }
  }, 400_000);

  it("masks a 32 KiB secret's base64 with \\r\\n after every character, the longest form a read's context covers, split between reads", async () => {
    const { sandbox } = await localSandbox(async () => saved());
    const masker = await environmentMaskerOf(sandbox);
    const whole = `KEY=\n${wrap(Buffer.from(BIG_KEY).toString("base64"), 1, "\r\n")}done\n`;
    const expected = masker.mask(whole);
    // Only the last group's characters, which padding also decides, show.
    expect(expected).toMatch(
      /^KEY=\n\[REDACTED:BIG_KEY\](?:\r\n[A-Za-z0-9+/=]){0,3}\r\ndone\n$/,
    );
    const tail = expected.slice(expected.indexOf("[REDACTED:BIG_KEY]"));
    const bytes = Buffer.from(whole);
    await expectEveryCut(
      sandbox,
      "width 1, CRLF",
      cutsAt(bytes, [
        10,
        51_199,
        70_000,
        bytes.length - 40_000,
        bytes.length - 20,
      ]),
      (shown, cut) => {
        // A read keeps at most 50 KB, so one may skip part of the start.
        expect(shown.endsWith(tail), `cut at byte ${cut}`).toBe(true);
        expect(
          base64Reveals(shown.replace(/\r?\n/g, ""), BIG_KEY.slice(0, 600)),
          `cut at byte ${cut}`,
        ).toBe(false);
      },
    );
  }, 120_000);

  it("masks long secrets at a bounded cost: building the masker, and per megabyte of output", async () => {
    const values = [
      ...Array.from({ length: 20 }, (_, index) =>
        value(`TOKEN_${index}`, "secret", `${DEPLOY}-${index}-${index}`),
      ),
      value("PEM_KEY", "secret", PEM_KEY),
      value("BIG_KEY", "secret", BIG_KEY),
    ];
    const { sandbox } = await localSandbox(async () => snapshot(values));
    const built = performance.now();
    const masker = await environmentMaskerOf(sandbox);
    const line = `${"x".repeat(60)} ${"The client environment entry ".repeat(3)}\n`;
    const chunk = line.repeat(Math.ceil(100_000 / line.length));
    const parts: string[] = [];
    for (let index = 0; index < 20; index += 1)
      parts.push(
        chunk,
        `TOKEN=${DEPLOY}-${index}-${index} `,
        index % 5 === 0 ? `BIG=${BIG_KEY} ` : "",
        index % 5 === 1
          ? wrap(Buffer.from(`k:${PEM_KEY}`).toString("base64"), 76, "\n")
          : "",
        "\n",
      );
    const content = parts.join("");
    const first = masker.mask(content);
    const building = performance.now() - built;
    const megabytes = Buffer.byteLength(content) / 1_000_000;
    let started = performance.now();
    expect(masker.mask(content)).toBe(first);
    const text = (performance.now() - started) / megabytes;
    expect(first).not.toContain(BIG_KEY.slice(0, 64));
    expect(first.match(/\[REDACTED:BIG_KEY\]/g)).toHaveLength(4);
    expect(first.match(/\[REDACTED:PEM_KEY\]/g)).toHaveLength(4);
    expect(first.match(/\[REDACTED:TOKEN_\d+\]/g)).toHaveLength(20);
    const bytes = Buffer.from(content);
    started = performance.now();
    let shown = "";
    for (let offset = 0; offset < bytes.length; offset += 51_200)
      shown += masker.maskRead(
        bytes.subarray(Math.max(0, offset - masker.readContextBytes), offset),
        bytes.subarray(offset, offset + 51_200),
        {
          heldBefore: true,
          final: offset + 51_200 >= bytes.length,
          context: masker.readContextBytes,
        },
      );
    const reads = (performance.now() - started) / megabytes;
    expect(shown).toBe(first);
    console.info(
      `secret masking with a 32 KiB and a 5 KiB secret among 22 over ${megabytes.toFixed(1)} MB: building and first mask ${building.toFixed(0)} ms, ${text.toFixed(1)} ms/MB as text, ${reads.toFixed(1)} ms/MB as 50 KB shell reads with ${masker.readContextBytes} bytes of context`,
    );
    expect(building).toBeLessThan(2_000);
    expect(text).toBeLessThan(150);
    expect(reads).toBeLessThan(150);
  }, 120_000);
});
