import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configReferenceFor,
  EnvironmentVariableId,
  EnvironmentVariableName,
} from "@dx/domain";
import type { Sandbox, ToolDefinition } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { Redacted, Schema } from "effect";
import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionEnvironmentSnapshot } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import { claudeCodeDxTools } from "./dx-tools.js";
import { ClaudeCodeStream } from "./stream.js";

/**
 * Q1 in tasks/platform-quirks-tracker.md: a dx tool call from Claude Code
 * reaches the tool with no arguments. Claude Code streams a tool's input as
 * `input_json_delta` fragments: JSON inside a JSON string. A workspace
 * secret whose value occurs in ordinary text became NUL on the redacted
 * read, then an escaped NUL in the outer string, so the reassembled input
 * held a raw control character, `JSON.parse` threw, and the stream handed
 * Flue `{}`.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A secret that occurs inside the prompt's ordinary words. */
const SECRET = "input loses";
const PROMPT = "Find exactly where the input loses its keys.";

const environment = (
  secrets: ReadonlyArray<string>,
): ExecutionEnvironmentSnapshot => ({
  revision: {
    personal: { targetId: "user", revision: 0 },
    project: { targetId: "project", revision: 0 },
    workspace: { targetId: null, revision: 0 },
  },
  values: secrets.map((plaintext, index) => ({
    reference: configReferenceFor(
      Schema.decodeUnknownSync(EnvironmentVariableId)(`env_q1_${index}`),
    ),
    name: Schema.decodeUnknownSync(EnvironmentVariableName)(`Q1_${index}`),
    kind: "secret" as const,
    value: Redacted.make(plaintext),
    source: "workspace" as const,
  })),
});

const event = (body: Record<string, unknown>) =>
  JSON.stringify({
    type: "stream_event",
    event: body,
    session_id: "session-1",
    parent_tool_use_id: null,
  });

/** Fragments split where Claude's do: mid-key, mid-string. */
const PROMPT_FRAGMENTS = [
  '{"pro',
  'mpt": "Find exactly',
  ' where the input loses its keys."}',
];

/** What the CLI prints for one `mcp__dx__create_thread` call. */
const toolCallChunk = (fragments: ReadonlyArray<string>) =>
  [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-1",
    }),
    event({
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    event({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_q1",
        name: "mcp__dx__create_thread",
        input: {},
      },
    }),
    ...fragments.map((partial_json) =>
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      }),
    ),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", usage: { output_tokens: 20 } }),
    event({ type: "message_stop" }),
    "",
  ].join("\n");

/**
 * Reads the chunk the way `ClaudeCodeRun.poll` does, through the secret
 * redaction decorator, and runs the call through the dx tool bridge.
 */
const callCreateThread = async (
  secrets: ReadonlyArray<string>,
  fragments: ReadonlyArray<string> = PROMPT_FRAGMENTS,
) => {
  const directory = await mkdtemp(join(tmpdir(), "dx-q1-"));
  directories.push(directory);
  const sandbox = await withExecutionEnvironment(
    local({ cwd: directory }),
    async () => environment(secrets),
  ).createSandbox({ id: "thread" });
  await sandbox.writeFile("c000000", toolCallChunk(fragments));

  const stream = new ClaudeCodeStream();
  const bytes = await sandbox.readFileBuffer("c000000");
  for (const line of new TextDecoder().decode(bytes).split("\n").slice(0, -1))
    stream.push(line);
  const block = stream.segments[0]?.blocks[0];
  if (block?.type !== "toolCall") throw new Error("No tool call streamed.");

  const createThread = {
    name: "create_thread",
    description: "Starts a child Thread.",
    input: v.object({ prompt: v.string() }),
    run: async ({ data }: { data: { prompt: string } }) => data,
  } as unknown as ToolDefinition;
  const [bridged] = claudeCodeDxTools("thr_q1", [createThread]);
  // The bridge writes the answer the guest's MCP server hands Claude.
  const answers: string[] = [];
  const harness = {
    sandbox: {
      writeFile: async (_path: string, content: string) => {
        answers.push(content);
      },
    } as unknown as Sandbox,
  };
  const run = (
    bridged as unknown as {
      run: (context: unknown) => Promise<unknown>;
    }
  ).run({
    data: block.input,
    toolCallId: block.id,
    log: console,
    harness,
  });
  return { input: block.input, run, answers };
};

describe("Q1: dx tool input through secret redaction", () => {
  it("control: without a matching secret, create_thread receives its prompt", async () => {
    const { input, run } = await callCreateThread([]);
    expect(input).toEqual({ prompt: PROMPT });
    await expect(run).resolves.toEqual({ prompt: PROMPT });
  });

  it("repro: a secret occurring inside the streamed prompt must not empty the tool input", async () => {
    const { input, run } = await callCreateThread([SECRET]);
    // Fails today with: Invalid arguments for create_thread:
    // × Invalid key: Expected "prompt" but received undefined
    await expect(run).resolves.toEqual({
      prompt: "Find exactly where the [REDACTED:Q1_0] its keys.",
    });
    expect(Object.keys(input ?? {})).toEqual(["prompt"]);
    expect(JSON.stringify(input)).not.toContain(SECRET);
  });

  it("answers a call whose input cannot be read with an error that says so", async () => {
    // A response cut off mid-input, as when it hits its token limit.
    const { run, answers } = await callCreateThread(
      [],
      ['{"prompt": "Find exa'],
    );
    await expect(run).rejects.toThrow(
      "dx could not read the input of this create_thread call",
    );
    // Claude is told, rather than handed a schema error about a key it sent.
    expect(answers.map((answer) => JSON.parse(answer))).toEqual([
      {
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              "dx could not read the input of this create_thread call",
            ),
          },
        ],
        isError: true,
      },
    ]);
  });
});
