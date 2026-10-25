/**
 * `find_thread` and `read_thread` as the agent calls them, with real D1 and
 * real per-owner search indexes. Flue's agent objects do not run here, so
 * the history read is injected and the reader's model is scripted.
 *
 * Ways it could fail, each covered below:
 *  1. find_thread reaches another member's private Thread, or (from a shared
 *     calling Thread) the owner's private Threads outside its family.
 *  2. An invalid filter value fails without saying which filter.
 *  3. read_thread reads a Thread outside the caller's reach.
 *  4. read_messages numbers messages off by one, reads past the end, or
 *     returns tool output too large for the reader's context.
 *  5. search_messages matches tool output or text between tool calls,
 *     misses stems, or returns oldest first.
 *  6. The reader keeps calling tools forever.
 *  7. context "current" sends the oldest messages instead of the newest.
 */
import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import type { SubagentDefinition, ToolDefinition } from "@flue/runtime";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import {
  createThreadSearchTools,
  type ReaderMode,
} from "../../src/thread-search/agent-tools.js";
import type {
  HistoryMessage,
  HistoryRead,
} from "../../src/thread-search/history.js";
import { ownerSearchIndex } from "../../src/thread-search/index-client.js";
import { READER_MAX_TOOL_CALLS } from "../../src/thread-search/reader.js";
import { THREAD_READER_SYSTEM_PROMPT } from "../../src/thread-search/reader-prompt.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "tools-owner" as UserId;
const member = "tools-member" as UserId;
const workspaceId = "tools-workspace";
const ownerProject = "prj_00000000-0000-4000-8000-0000000000a1" as ProjectId;
const memberProject = "prj_00000000-0000-4000-8000-0000000000a2" as ProjectId;

const bindings: Bindings = {
  DB: env.DB,
  THREAD_SEARCH_INDEX: env.THREAD_SEARCH_INDEX,
};

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const seed = async (
  ownerUserId: UserId,
  projectId: ProjectId,
  title: string,
  text: string,
) => {
  const id = `thr_${crypto.randomUUID()}`;
  await runRepositories(
    Effect.gen(function* () {
      const threads = yield* ThreadRepository;
      yield* threads.insert(thread(id, projectId, ownerUserId));
    }),
  );
  await env.DB.prepare("UPDATE threads SET title = ? WHERE id = ?")
    .bind(title, id)
    .run();
  await ownerSearchIndex(bindings, ownerUserId)?.indexMessages(id, title, [
    { messageId: `${id}-m`, role: "user", text },
  ]);
  return id;
};

/** A long Thread: a plan, many steps with tool output, then a revision. */
const longHistory = (): HistoryMessage[] => {
  const messages: HistoryMessage[] = [
    {
      id: "m1",
      role: "user",
      purpose: "user",
      submissionId: "s1",
      parts: [{ type: "text", text: "Plan the ledger migration to Postgres" }],
    },
  ];
  for (let index = 0; index < 60; index++)
    messages.push({
      id: `step${index}`,
      role: "assistant",
      purpose: "assistant",
      submissionId: "s1",
      parts: [
        { type: "text", text: "Checking the schema between steps" },
        {
          type: "dynamic-tool",
          toolName: "shell_command",
          state: "output-available",
          input: { command: `psql -c "select ${index}"` },
          output: `${"x".repeat(9_000)} ledger-in-tool-output`,
        },
        {
          type: "text",
          text: `Step ${index} finished deploying shard ${index}`,
        },
      ],
    });
  messages.push({
    id: "m-last",
    role: "user",
    purpose: "user",
    submissionId: "s2",
    parts: [
      { type: "text", text: "Revert the migration, keep the ledger in D1" },
    ],
  });
  return messages;
};

const history =
  (messages: HistoryMessage[]) => async (): Promise<HistoryRead> => ({
    kind: "page",
    page: {
      messages,
      settled: new Map([
        ["s1", "completed"],
        ["s2", "completed"],
      ]),
      hasOlder: false,
    },
  });

const run = (
  tool: ToolDefinition | undefined,
  data: unknown,
  harness?: unknown,
) =>
  (tool as ToolDefinition).run({
    data,
    toolCallId: "call",
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...(harness === undefined ? {} : { harness }),
  } as never);

const tools = (
  callingThreadId: string,
  messages = longHistory(),
  readerMode: ReaderMode = "isolated",
) => {
  const [findThread, readThread] = createThreadSearchTools(
    callingThreadId,
    () => ({ db: env.DB, bindings }),
    { loadHistory: history(messages), readerMode },
  );
  return { findThread, readThread };
};

interface ReaderCall {
  readonly via: "task" | "prompt";
  readonly text: string;
  readonly options: {
    readonly tools?: ToolDefinition[];
    readonly thinkingLevel?: string;
    readonly agent?: SubagentDefinition;
  };
}

/** A tool harness whose model is `script`, whichever entry point runs it. */
const scripted = (script: (call: ReaderCall) => Promise<{ text: string }>) => ({
  task: (text: string, options: ReaderCall["options"]) =>
    script({ via: "task", text, options }),
  prompt: (text: string, options: ReaderCall["options"]) =>
    script({ via: "prompt", text, options }),
});

beforeEach(async () => {
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(workspaceId, "Tools Team", "tools-team"),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('t-owner', ?1, ?2, 'owner', 1), ('t-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(project(ownerProject, owner, "Owner"));
      yield* projects.insert(project(memberProject, member, "Member"));
    }),
  );
});

describe("find_thread and read_thread", () => {
  it("find_thread searches the owner's and workspace-shared Threads", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "osprey call");
    const privateOther = await seed(
      owner,
      ownerProject,
      "Other",
      "osprey private",
    );
    const shared = await seed(member, memberProject, "Shared", "osprey shared");
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    )
      .bind(workspaceId, shared)
      .run();
    const memberPrivate = await seed(
      member,
      memberProject,
      "Hidden",
      "osprey hidden",
    );

    const result = (await run(tools(calling).findThread, {
      query: "osprey",
    })) as {
      output: { threads: Array<{ threadId: string; ownedByYou: boolean }> };
    };
    const found = result.output.threads.map(({ threadId }) => threadId);
    expect(new Set(found)).toEqual(new Set([calling, privateOther, shared]));
    expect(found).not.toContain(memberPrivate);
    expect(
      result.output.threads.find(({ threadId }) => threadId === shared)
        ?.ownedByYou,
    ).toBe(false);

    // A shared calling Thread reaches only its family of the owner's Threads.
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'contribute', shared_workspace_id = ? WHERE id = ?",
    )
      .bind(workspaceId, calling)
      .run();
    const fromShared = (await run(tools(calling).findThread, {
      query: "osprey",
    })) as { output: { threads: Array<{ threadId: string }> } };
    expect(
      new Set(fromShared.output.threads.map(({ threadId }) => threadId)),
    ).toEqual(new Set([calling, shared]));

    await expect(
      run(tools(calling).findThread, { query: "osprey after:yesterday" }),
    ).rejects.toThrow(/after: takes a date/);
  });

  it("read_thread refuses Threads outside the caller's reach", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "falcon");
    const hidden = await seed(member, memberProject, "Hidden", "falcon");
    const harness = {
      prompt: async () => ({ text: "should not run" }),
    };
    await expect(
      run(
        tools(calling).readThread,
        { threadID: hidden, question: "What happened?", context: "full" },
        harness,
      ),
    ).rejects.toThrow(/not found among the Threads/);
  });

  it.each(["isolated", "shared"] as const)(
    "read_thread gives the %s reader normalized messages and stemmed search",
    async (mode) => {
      const calling = await seed(owner, ownerProject, "Caller", "ledger");
      const target = await seed(owner, ownerProject, "Ledger move", "ledger");
      interface Message {
        index: number;
        role: string;
        origin?: string;
        sender?: Record<string, string>;
        blocks: Array<Record<string, unknown>>;
      }
      interface Page {
        messageCount: number;
        hits?: Array<{ index: number; message?: Message }>;
        messages?: Message[];
        nextCursor?: string;
      }
      const harness = scripted(async ({ via, text, options }) => {
        if (mode === "isolated") {
          // A fresh subagent: the reader prompt is its system prompt, and it
          // has no sandbox and only the two reader tools.
          expect(via).toBe("task");
          expect(options.agent?.environment).toBe("none");
          expect(options.agent?.thinkingLevel).toBe("low");
          expect(options.agent?.agent({} as never)).toBe(
            THREAD_READER_SYSTEM_PROMPT,
          );
          expect(text).toMatch(/^Target thread: Ledger move/);
          expect(text).not.toContain("You are Thread Reader");
        } else {
          expect(via).toBe("prompt");
          expect(options.thinkingLevel).toBe("low");
          expect(text).toMatch(/^You are Thread Reader\./);
        }
        expect(text).toContain("182 messages");
        expect(options.tools?.map(({ name }) => name)).toEqual([
          "search_messages",
          "read_messages",
        ]);
        const [search, read] = options.tools ?? [];
        const call = async (tool: ToolDefinition | undefined, data: unknown) =>
          ((await run(tool, data)) as { output: Page }).output;
        const ledger = await call(search, { query: "ledger" });
        const deploy = await call(search, { query: "deploys", limit: 3 });
        const older = await call(search, {
          query: "deploys",
          limit: 3,
          cursor: deploy.nextCursor,
        });
        const between = await call(search, { query: "schema" });
        const firstSteps = await call(read, { start: 1, end: 3 });
        const past = await call(read, { start: 500 });
        return {
          text: JSON.stringify({
            ledger,
            deploy,
            older,
            between,
            firstSteps,
            past,
          }),
        };
      });
      const result = (await run(
        tools(calling, longHistory(), mode).readThread,
        {
          threadID: `https://dx.example/threads/${target}`,
          question: "Where did the ledger go?",
          context: "full",
        },
        harness,
      )) as { output: { answer: string; readerToolCalls: number } };
      const seen = JSON.parse(result.output.answer) as Record<string, Page>;
      const indexes = (page: Page | undefined) =>
        (page?.hits ?? []).map(({ index }) => index);
      // Each response turns into a step with its tool calls, a tool_result
      // message, and the final reply: 1 + 60 × 3 + 1 messages.
      expect(seen.ledger?.messageCount).toBe(182);
      // Newest first; the revision before the plan; tool output never matches.
      expect(indexes(seen.ledger)).toEqual([182, 1]);
      // "deploys" finds "deploying" in final replies only, newest first, paged.
      expect(indexes(seen.deploy)).toEqual([181, 178, 175]);
      expect(indexes(seen.older)).toEqual([172, 169, 166]);
      // Text written before a tool call in the same step is not searchable.
      expect(indexes(seen.between)).toEqual([]);
      const [first, step, results] = seen.firstSteps?.messages ?? [];
      expect(first).toMatchObject({ index: 1, role: "user" });
      expect(step).toMatchObject({
        index: 2,
        role: "assistant",
        blocks: [
          { type: "text", text: "Checking the schema between steps" },
          { type: "tool_call", name: "shell_command", status: "done" },
        ],
      });
      expect(results).toMatchObject({
        index: 3,
        role: "user",
        origin: "tool_result",
        blocks: [
          {
            type: "tool_result",
            toolName: "shell_command",
            status: "done",
          },
        ],
      });
      expect(results?.blocks[0]?.toolUseId).toBe(step?.blocks[1]?.toolUseId);
      expect(seen.past).toEqual({ messageCount: 182, messages: [] });
      expect(result.output.readerToolCalls).toBe(6);
    },
  );

  it("read_messages returns an oversized message in ordered chunks", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "ibis");
    const huge = "y".repeat(100_000);
    const messages: HistoryMessage[] = [
      {
        id: "u",
        role: "user",
        purpose: "user",
        submissionId: "s1",
        parts: [
          {
            type: "text",
            text: '<dx_message_author role="contributor" user_id="u2" identifier="Ben"/>\nDump the log',
          },
        ],
      },
      {
        id: "a",
        role: "assistant",
        purpose: "assistant",
        submissionId: "s1",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "shell_command",
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "cat big.log" },
            output: { output: huge, exitCode: 0 },
          },
          { type: "text", text: "Done." },
        ],
      },
      {
        id: "from-thread",
        role: "user",
        purpose: "user",
        submissionId: "s2",
        parts: [
          {
            type: "text",
            text: '<dx_message_author role="owner" user_id="u1" identifier="Ada" source_thread="thr_parent" />\nPlease also rotate the log',
          },
        ],
      },
      {
        id: "streaming",
        role: "assistant",
        purpose: "assistant",
        submissionId: "s9",
        parts: [{ type: "text", text: "Rotating now" }],
      },
    ];
    const harness = {
      task: async (_text: string, options: { tools: ToolDefinition[] }) => {
        const [, read] = options.tools;
        const pages: Array<Record<string, unknown>> = [];
        let page = (
          (await run(read, { start: 1, end: 6 })) as {
            output: Record<string, unknown>;
          }
        ).output;
        pages.push(page);
        while (typeof page.nextCursor === "string") {
          page = (
            (await run(read, { cursor: page.nextCursor })) as {
              output: Record<string, unknown>;
            }
          ).output;
          pages.push(page);
        }
        return { text: JSON.stringify(pages) };
      },
    };
    const result = (await run(
      createThreadSearchTools(calling, () => ({ db: env.DB, bindings }), {
        loadHistory: history(messages),
      })[1],
      { threadID: calling, question: "What was in the log?", context: "full" },
      harness,
    )) as { output: { answer: string } };
    const pages = JSON.parse(result.output.answer) as Array<{
      messages: Array<Record<string, unknown>>;
    }>;
    const all = pages.flatMap(({ messages }) => messages);
    expect(all[0]).toMatchObject({
      index: 1,
      origin: "human",
      fromUserID: "u2",
      sender: { name: "Ben", role: "contributor" },
      blocks: [{ type: "text", text: "Dump the log" }],
    });
    const chunks = all.filter(({ index }) => index === 3);
    expect(chunks.length).toBeGreaterThan(2);
    const rebuilt = JSON.parse(
      chunks.map(({ jsonChunk }) => jsonChunk as string).join(""),
    ) as { origin: string; blocks: Array<{ result: { output: string } }> };
    expect(rebuilt.origin).toBe("tool_result");
    expect(rebuilt.blocks[0]?.result.output).toBe(huge);
    expect(all.find(({ index }) => index === 4)).toMatchObject({
      blocks: [{ type: "text", text: "Done." }],
    });
    expect(all.find(({ index }) => index === 4)?.status).toBeUndefined();
    // Another thread's agent sent this message: generated, not human input.
    expect(all.find(({ index }) => index === 5)).toMatchObject({
      origin: "thread",
      fromThreadID: "thr_parent",
      blocks: [{ type: "text", text: "Please also rotate the log" }],
    });
    expect(all.find(({ index }) => index === 5)?.fromUserID).toBeUndefined();
    // A turn that has not settled is not a reliable conclusion.
    expect(all.find(({ index }) => index === 6)).toMatchObject({
      role: "assistant",
      status: "streaming",
    });
  });

  it("search_messages returns whole small messages and a prefix of a large one", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "heron");
    const report = `longreport ${"z".repeat(20_000)}`;
    const messages: HistoryMessage[] = [
      {
        id: "small",
        role: "user",
        purpose: "user",
        submissionId: "s1",
        parts: [{ type: "text", text: "short longreport note" }],
      },
      {
        id: "large",
        role: "user",
        purpose: "user",
        submissionId: "s2",
        parts: [{ type: "text", text: report }],
      },
    ];
    let output: {
      messageCount: number;
      hits: Array<{
        index: number;
        message?: { blocks: Array<{ text?: string }> };
        jsonChunk?: string;
        truncated?: boolean;
        totalBytes?: number;
      }>;
    } = { messageCount: 0, hits: [] };
    const harness = {
      task: async (_text: string, options: { tools: ToolDefinition[] }) => {
        const [search] = options.tools;
        output = (
          (await run(search, { query: "longreport" })) as never as {
            output: typeof output;
          }
        ).output;
        return { text: "ok" };
      },
    };
    await run(
      createThreadSearchTools(calling, () => ({ db: env.DB, bindings }), {
        loadHistory: history(messages),
      })[1],
      { threadID: calling, question: "Where is the report?", context: "full" },
      harness,
    );
    expect(output.messageCount).toBe(2);
    const [large, small] = output.hits;
    expect(large).toMatchObject({ index: 2, truncated: true });
    expect(large?.message).toBeUndefined();
    expect(large?.totalBytes).toBeGreaterThan(20_000);
    expect(
      new TextEncoder().encode(large?.jsonChunk ?? "").length,
    ).toBeLessThanOrEqual(8_192);
    expect(large?.jsonChunk?.startsWith('{"index":2')).toBe(true);
    expect(small).toMatchObject({
      index: 1,
      message: { blocks: [{ text: "short longreport note" }] },
    });
  });

  it("read_thread in a Claude Code Thread pages the Thread's messages, newest first, with no model call", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "plover");
    const noModel = {
      task: async () => {
        throw new Error("no model may run");
      },
      prompt: async () => {
        throw new Error("no model may run");
      },
    };
    const [, readThread] = createThreadSearchTools(
      calling,
      () => ({ db: env.DB, bindings }),
      { loadHistory: history(longHistory()), claudeCode: true },
    );
    type Page = {
      messageCount: number;
      messages: Array<{ index: number; blocks?: unknown; jsonChunk?: string }>;
      nextCursor?: string;
    };
    const pages: Page[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        (await run(
          readThread,
          {
            threadID: calling,
            question: "What did they settle on?",
            context: "full",
            ...(cursor === undefined ? {} : { cursor }),
          },
          noModel,
        )) as { output: Page }
      ).output;
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== undefined && pages.length < 100);
    const count = pages[0]?.messageCount ?? 0;
    expect(count).toBeGreaterThan(10);
    // The first page ends with the newest message, where a report is.
    expect(pages[0]?.messages.at(-1)?.index).toBe(count);
    expect(JSON.stringify(pages[0])).toContain("keep the ledger in D1");
    expect(pages.length).toBeGreaterThan(1);
    // Every message arrives once, across pages, and each page is bounded.
    const seen = pages.flatMap(({ messages }) =>
      messages.flatMap((message) =>
        message.jsonChunk === undefined ||
        (message as { chunk?: number }).chunk === 0
          ? [message.index]
          : [],
      ),
    );
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, at) => at + 1),
    );
    for (const page of pages)
      expect(JSON.stringify(page).length).toBeLessThan(50_000);
    // context "current" is the newest page alone.
    const current = (
      (await run(
        readThread,
        { threadID: calling, question: "Status?", context: "current" },
        noModel,
      )) as { output: Page & { note?: string } }
    ).output;
    expect(current.nextCursor).toBeUndefined();
    expect(current.messages.at(-1)?.index).toBe(count);
    // find_thread needs no model, so it works in a Claude Code Thread.
    const found = (await run(tools(calling).findThread, {
      query: "plover",
    })) as { output: { threads: Array<{ threadId: string }> } };
    expect(found.output.threads.map(({ threadId }) => threadId)).toEqual([
      calling,
    ]);
  });

  it("stops a reader that keeps calling tools", async () => {
    const calling = await seed(owner, ownerProject, "Caller", "kite");
    const harness = {
      task: async (_text: string, options: { tools: ToolDefinition[] }) => {
        const [search] = options.tools;
        for (let index = 0; index < READER_MAX_TOOL_CALLS; index++)
          await run(search, { query: "ledger" });
        await expect(
          (async () => run(search, { query: "ledger" }))(),
        ).rejects.toThrow(/budget is spent/);
        return { text: "answered" };
      },
    };
    const result = (await run(
      tools(calling).readThread,
      { threadID: calling, question: "Anything?", context: "full" },
      harness,
    )) as { output: { answer: string } };
    expect(result.output.answer).toBe("answered");
  });

  it('context "current" sends the newest messages in one call', async () => {
    const calling = await seed(owner, ownerProject, "Caller", "swift");
    let prompt = "";
    const harness = {
      task: async (text: string, options: { tools?: unknown }) => {
        expect(options.tools).toBeUndefined();
        prompt = text;
        return { text: "It reverted the migration." };
      },
    };
    const result = (await run(
      tools(calling).readThread,
      { threadID: calling, question: "Did it finish?", context: "current" },
      harness,
    )) as { output: { answer: string } };
    expect(result.output.answer).toBe("It reverted the migration.");
    expect(prompt).toContain('"index":182');
    expect(prompt).toContain("Revert the migration");
    expect(prompt).toMatch(
      /messages 1–\d+ are outside the current context window/,
    );
    expect(prompt).not.toContain('"index":1,');
  });
});
