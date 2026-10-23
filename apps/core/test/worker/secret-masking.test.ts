import { env } from "cloudflare:test";
import type { Sandbox } from "@flue/runtime";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { ClaudeCodeRun } from "../../src/claude-code/workspace-run.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import { executionWorkspaceTools } from "../../src/plugins/execution/tools.js";
import {
  resolveExecutionEnvironment,
  resolveExecutionEnvironmentRevision,
} from "../../src/settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../../src/settings/environment-variables/sandbox.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Q10 in tasks/platform-quirks-tracker.md: which saved secrets dx hides in
 * what the agent reads, and what it shows in their place. Secrets are saved
 * through the settings API into real D1, then resolved and applied by the
 * real environment decorator, as activation composes it, around an
 * in-memory guest. Claude Code output is read by the real `ClaudeCodeRun`,
 * and writes go through the real dx file tools.
 */

muteSpanLogRecords();

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "secret-masking-floor-000000000000000000",
};
const threadId = "thr_00000000-0000-4000-8000-0000000a1001";
const projectId = "prj_00000000-0000-4000-8000-0000000a1001";
const STATE = "/home/user/.local/state/dx-claude-code";
const REPO = "/home/user/workspace/repo";

/** Three letters, as a workspace may hold one; it occurs in many words. */
const SHORT = "ent";
const WORDS =
  "The client sent the environment entry to the agent: enter it gently.";
/** 24 characters. */
const LONG = "dxs_live_7Hq2Vm9KpX4rT8w";
const MARKER = "[REDACTED:DEPLOY_TOKEN]";

let cookie = "";
let signups = 0;

const save = async (name: string, kind: string, value: string) => {
  const response = await app.request(
    "/v1/settings/personal/environment-variables",
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal", name, kind, value }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
};

beforeEach(async () => {
  signups += 1;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signups}`,
      },
      body: JSON.stringify({
        name: "Secret Masking",
        email: "secret-masking@example.com",
        password: "secret-masking-floor-1234",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  // Saved in this order so a shared value's marker cannot follow it.
  await save("PUBLISH_TOKEN", "secret", LONG);
  await save("DEPLOY_TOKEN", "secret", LONG);
  await save("SHORT_KEY", "secret", SHORT);
  await save("BUILD_CHANNEL", "variable", "client-beta");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind("secret-masking@example.com")
    .first<{ id: string }>();
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, user?.id, "Secret masking", at, at),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(threadId, projectId, user?.id, at, at),
  ]);
});

/**
 * A workspace in memory. `run <name>` prints that environment variable as
 * the process received it, `cat <path>` prints a file, and anything else
 * fails with the command in its message.
 */
const memoryGuest = () => {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const write = (path: string, content: string | Uint8Array) =>
    files.set(
      path,
      typeof content === "string" ? encoder.encode(content) : content,
    );
  const read = (path: string) => {
    const file = files.get(path);
    if (file === undefined) throw new Error(`No such file: ${path}`);
    return file;
  };
  const sandbox: Sandbox = {
    cwd: REPO,
    resolvePath: (path) => path,
    exec: async (command, options) => {
      const [verb, argument = ""] = command.split(" ", 2);
      if (verb === "run")
        return {
          stdout: `${options?.env?.[argument] ?? ""}\n`,
          stderr: "",
          exitCode: 0,
        };
      if (verb === "cat")
        return {
          stdout: new TextDecoder().decode(read(argument)),
          stderr: "",
          exitCode: 0,
        };
      throw new Error(`Command failed: ${command}`);
    },
    readFile: async (path) => new TextDecoder().decode(read(path)),
    readFileBuffer: async (path) => read(path),
    readdir: async (path) => {
      const prefix = `${path.replace(/\/$/, "")}/`;
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length).split("/")[0] ?? "");
    },
    stat: async (path) => ({
      isFile: files.has(path),
      isDirectory: !files.has(path),
      isSymbolicLink: false,
      size: files.get(path)?.length ?? 0,
      mtime: new Date(),
    }),
    exists: async (path) => files.has(path),
    writeFile: async (path, content) => {
      write(path, content);
    },
    mkdir: async () => {},
    rm: async (path) => {
      files.delete(path);
    },
  };
  return {
    files,
    write,
    text: (path: string) => new TextDecoder().decode(files.get(path)),
    /** The guest decorated as activation decorates it. */
    decorated: () =>
      withExecutionEnvironment(
        { createSandbox: async () => sandbox },
        (id) => Effect.runPromise(resolveExecutionEnvironment(bindings, id)),
        (id) =>
          Effect.runPromise(resolveExecutionEnvironmentRevision(bindings, id)),
      ).createSandbox({ id: threadId }),
  };
};

const line = (value: unknown) => JSON.stringify(value);
const event = (value: unknown) =>
  line({ type: "stream_event", event: value, parent_tool_use_id: null });
const delta = (index: number, value: Record<string, unknown>) =>
  event({ type: "content_block_delta", index, delta: value });

/**
 * One Claude Code response: thinking, text, and a dx tool call, each
 * streamed in the given fragments, then the call's result.
 */
const claudeResponse = (fragments: {
  readonly thinking: ReadonlyArray<string>;
  readonly text: ReadonlyArray<string>;
  readonly input: ReadonlyArray<string>;
  readonly result: string;
}) => [
  line({ type: "system", subtype: "init", session_id: "session-1" }),
  event({ type: "message_start", message: { id: "m1", usage: {} } }),
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }),
  ...fragments.thinking.map((thinking) =>
    delta(0, { type: "thinking_delta", thinking }),
  ),
  event({ type: "content_block_stop", index: 0 }),
  event({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  }),
  ...fragments.text.map((text) => delta(1, { type: "text_delta", text })),
  event({ type: "content_block_stop", index: 1 }),
  event({
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_q10",
      name: "mcp__dx__create_thread",
      input: {},
    },
  }),
  ...fragments.input.map((partial_json) =>
    delta(2, { type: "input_json_delta", partial_json }),
  ),
  event({ type: "content_block_stop", index: 2 }),
  event({ type: "message_stop" }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_q10",
          content: fragments.result,
        },
      ],
    },
    parent_tool_use_id: null,
  }),
];

/** Polls a finished run of this response through the decorated guest. */
const streamThrough = async (lines: ReadonlyArray<string>) => {
  const guest = memoryGuest();
  const sandbox = await guest.decorated();
  const dir = `${STATE}/runs/t1-q10.0`;
  guest.write(`${dir}/pid`, "4242\n");
  guest.write(`${dir}/alive`, `${Math.floor(Date.now() / 1000)}\n`);
  guest.write(`${dir}/c000000`, `${lines.join("\n")}\n`);
  const run = new ClaudeCodeRun("t1-q10.0", sandbox, 0);
  expect(await run.poll()).toBe(true);
  return {
    blocks: run.stream.segments[0]?.blocks.map((block) =>
      block.type === "toolCall"
        ? { type: block.type, input: block.input }
        : block,
    ),
    result: run.stream.toolResults.get("toolu_q10")?.text,
  };
};

const tools = (sandbox: Sandbox) => {
  const all = executionWorkspaceTools(sandbox);
  return (name: string, params: unknown) => {
    const tool = all.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`No tool ${name}`);
    return tool.execute("call", params);
  };
};

describe("Q10: secret masking floor, in workerd with real D1", () => {
  it("Settings reports which saved secrets dx can hide", async () => {
    const response = await app.request(
      "/v1/settings/personal/environment-variables?scope=personal",
      { headers: { cookie, origin } },
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        items: ReadonlyArray<{ name: string; value: string; hidden: boolean }>;
      };
    };
    const byName = Object.fromEntries(
      body.data.items.map(({ name, value, hidden }) => [
        name,
        { value, hidden },
      ]),
    );
    expect(byName).toEqual({
      BUILD_CHANNEL: { value: "client-beta", hidden: false },
      DEPLOY_TOKEN: { value: "••••••••", hidden: true },
      PUBLISH_TOKEN: { value: "••••••••", hidden: true },
      SHORT_KEY: { value: "••••••••", hidden: false },
    });
    expect(JSON.stringify(body)).not.toContain(LONG);
  });

  it("a 3-letter secret inside ordinary words: command output, file reads, and Claude Code arrive unchanged", async () => {
    const guest = memoryGuest();
    const sandbox = await guest.decorated();
    guest.write(`${REPO}/notes.md`, WORDS);
    // The workspace still receives the short secret.
    expect
      .soft((await sandbox.exec("run SHORT_KEY")).stdout)
      .toBe(`${SHORT}\n`);
    expect
      .soft((await sandbox.exec(`cat ${REPO}/notes.md`)).stdout)
      .toBe(WORDS);
    expect.soft(await sandbox.readFile(`${REPO}/notes.md`)).toBe(WORDS);
    expect
      .soft(
        new TextDecoder().decode(
          await sandbox.readFileBuffer(`${REPO}/notes.md`),
        ),
      )
      .toBe(WORDS);

    const streamed = await streamThrough(
      claudeResponse({
        thinking: ["The client sent the envir", "onment entry."],
        text: ["Your agent is gen", "tly entering it."],
        input: ['{"pro', 'mpt": "Find the client environ', 'ment entry."}'],
        result: WORDS,
      }),
    );
    expect.soft(streamed).toEqual({
      blocks: [
        {
          type: "thinking",
          thinking: "The client sent the environment entry.",
        },
        { type: "text", text: "Your agent is gently entering it." },
        {
          type: "toolCall",
          input: { prompt: "Find the client environment entry." },
        },
      ],
      result: WORDS,
    });
  });

  it("a 24-character secret shows as [REDACTED:NAME] in command output, file reads, listings, failures, and Claude Code", async () => {
    const guest = memoryGuest();
    const sandbox = await guest.decorated();
    guest.write(`${REPO}/deploy.env`, `TOKEN=${LONG}\nREGION=eu\n`);
    guest.write(`${REPO}/keys/${LONG}.pem`, "key");
    const expected = `TOKEN=${MARKER}\nREGION=eu\n`;
    expect
      .soft((await sandbox.exec("run DEPLOY_TOKEN")).stdout)
      .toBe(`${MARKER}\n`);
    expect
      .soft((await sandbox.exec(`cat ${REPO}/deploy.env`)).stdout)
      .toBe(expected);
    expect.soft(await sandbox.readFile(`${REPO}/deploy.env`)).toBe(expected);
    expect
      .soft(
        new TextDecoder().decode(
          await sandbox.readFileBuffer(`${REPO}/deploy.env`),
        ),
      )
      .toBe(expected);
    expect
      .soft(await sandbox.readdir(`${REPO}/keys`))
      .toEqual([`${MARKER}.pem`]);
    await expect
      .soft(sandbox.exec(`deploy ${LONG}`))
      .rejects.toThrow(`Command failed: deploy ${MARKER}`);
    // A variable is not a secret.
    expect
      .soft((await sandbox.exec("run BUILD_CHANNEL")).stdout)
      .toBe("client-beta\n");

    const streamed = await streamThrough(
      claudeResponse({
        thinking: ["The key dxs_live_7Hq2", "Vm9KpX4rT8w is set."],
        text: ["Your token is dxs_live_7Hq2Vm9K", "pX4rT8w, keep it safe."],
        input: [
          '{"prompt": "Deploy with dxs_live_7Hq',
          '2Vm9KpX4rT8w and report."}',
        ],
        result: `TOKEN=${LONG}`,
      }),
    );
    expect.soft(streamed).toEqual({
      blocks: [
        { type: "thinking", thinking: `The key ${MARKER} is set.` },
        { type: "text", text: `Your token is ${MARKER}, keep it safe.` },
        {
          type: "toolCall",
          input: { prompt: `Deploy with ${MARKER} and report.` },
        },
      ],
      result: `TOKEN=${MARKER}`,
    });
    expect.soft(JSON.stringify(streamed)).not.toContain(LONG);
  });

  it("refuses to write the marker of a hidden secret back into a file", async () => {
    const guest = memoryGuest();
    const call = tools(await guest.decorated());
    guest.write(`${REPO}/deploy.env`, `TOKEN=${LONG}\nREGION=eu\n`);

    await expect(
      call("create_file", {
        path: `${REPO}/copy.env`,
        content: `TOKEN=${MARKER}\n`,
      }),
    ).rejects.toThrow(
      `${MARKER} stands for the hidden secret DEPLOY_TOKEN. Do not write it into a file.`,
    );
    expect(guest.files.has(`${REPO}/copy.env`)).toBe(false);

    // The file holds the secret, so any edit would write the marker over it.
    await expect(
      call("edit_file", {
        path: `${REPO}/deploy.env`,
        old_str: "REGION=eu",
        new_str: "REGION=us",
      }),
    ).rejects.toThrow(
      `${REPO}/deploy.env holds the hidden secret DEPLOY_TOKEN, which dx shows as ${MARKER}. Do not write it into a file.`,
    );
    expect(guest.text(`${REPO}/deploy.env`)).toBe(`TOKEN=${LONG}\nREGION=eu\n`);
  });

  it("control: ordinary files, short secrets, and binary files write and edit as before", async () => {
    const guest = memoryGuest();
    const call = tools(await guest.decorated());
    await call("create_file", { path: `${REPO}/notes.md`, content: WORDS });
    expect(guest.text(`${REPO}/notes.md`)).toBe(WORDS);
    const edited = await call("edit_file", {
      path: `${REPO}/notes.md`,
      old_str: "sent",
      new_str: "read",
    });
    expect(edited.details).toMatchObject({ replacements: 1 });
    expect(guest.text(`${REPO}/notes.md`)).toBe(WORDS.replace("sent", "read"));

    // A short secret is not hidden, so its marker never stands for it.
    await call("create_file", {
      path: `${REPO}/doc.md`,
      content: "Shown as [REDACTED:SHORT_KEY].",
    });
    expect(guest.text(`${REPO}/doc.md`)).toBe("Shown as [REDACTED:SHORT_KEY].");

    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0x0a]);
    guest.write(`${REPO}/image.png`, png);
    await expect(
      call("edit_file", {
        path: `${REPO}/image.png`,
        old_str: "PNG",
        new_str: "GIF",
      }),
    ).rejects.toThrow(
      `Cannot edit binary or non-UTF-8 file ${REPO}/image.png.`,
    );
    expect(guest.files.get(`${REPO}/image.png`)).toEqual(png);
  });
});
