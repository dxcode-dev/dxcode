import {
  isClaudeCodeModel,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  ThreadSearchQueryError,
} from "@dx/domain";
import {
  defineTool,
  type SubagentDefinition,
  type ToolDefinition,
} from "@flue/runtime";
import * as v from "valibot";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { readCallingThread } from "../threads/calling-thread.js";
import { readHistory } from "./history.js";
import {
  currentUserMessage,
  type LoadedThread,
  readerTools,
  readerUserMessage,
  sharedCurrentPrompt,
  sharedReaderPrompt,
} from "./reader.js";
import {
  CURRENT_CONTEXT_SYSTEM_PROMPT,
  READ_THREAD_DESCRIPTION,
  THREAD_READER_SYSTEM_PROMPT,
} from "./reader-prompt.js";
import { searchThreadsItem } from "./routes.js";
import {
  searchThreads,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  type ThreadSearchScope,
} from "./service.js";

const FIND_THREAD_DESCRIPTION = `Find dx threads (conversation threads with the agent) using a query DSL.

## What this tool finds

This tool searches **dx threads** (conversations with the agent): the thread owner's threads and threads shared with them in their workspace, NOT git commits. Use this when the user asks about threads, conversations, or dx history.

## Query syntax

Scope broad searches by repository, project, or date when that context is known.

- **Keywords**: Bare words or quoted phrases for text search over thread titles and message text (people's messages and the agent's final replies, not tool calls or tool output): \`auth\` or \`"race condition"\`. To find threads about a file, search for its name as a keyword: \`"login.ts"\`
- **Thread ID filter**: \`id:thread\` to find one exact thread by ID or dx thread URL
- **Parent filter**: \`parent:thread\` to find the direct children of a thread ID or dx thread URL, including threads spawned with create_thread. Grandchildren and other descendants are not included
- **Project filter**: \`project:name\` to scope to a project by name or ID
- **Repo filter**: \`repo:url\` to scope to a repository: \`repo:github.com/owner/repo\` or \`repo:owner/repo\`
- **Pinned filter**: \`pinned:true\` for pinned threads or \`pinned:false\` for unpinned threads
- **Author filter**: \`author:name\` to find threads by a user: \`author:alice\` or \`author:me\` for the thread owner's own threads
- **Visibility filter**: \`visibility:private\` or \`visibility:workspace\` to narrow by sharing scope. This does not grant access
- **Color filter**: \`color:blue\`, or \`color:auto\` for threads without a chosen color
- **Date filters**: \`after:date\` and \`before:date\` filter by the thread's last activity: \`after:2026-01-15\`, \`after:7d\`, \`before:2w\`
- **Explicit update filters**: \`updated_after:date\` and \`updated_before:date\` use the same time. Use \`updated_before:7d\` to find threads with no activity in the last week
- **Archive filter**: \`archived:false\` to exclude archived threads or \`archived:true\` for archived only; by default results include both
- **Combine filters**: Use implicit AND: \`auth repo:dx after:7d\`

All matching is case-insensitive. Keywords match by word stem; there is no prefix, typo, OR, or exclusion matching, quotes do not require words to be adjacent, and common words such as "the" are ignored. An unknown \`key:value\` is searched as keywords. Date formats: ISO dates (\`2026-01-15\`), relative days (\`7d\`), or weeks (\`2w\`).

## Results

Each thread has threadId, title, projectName, ownerName, ownedByYou, parentThreadId when it has one, color, archived, pinned, visibility, state, lastActivityAt, and createdAt. Keyword results add matchedSearchText, an excerpt of the newest message holding the first keyword.

## Pagination

Results are ordered by most recent activity first, not by relevance. A page holds at most 100 threads. When nextCursor is present, call again with the same \`query\` and \`limit\` and set \`cursor\` to it to get the next page.

## When NOT to use this tool

- If the user asks about git commits, git history, or git blame, use git commands instead
- If the user wants to know WHO (a person) made changes, use git log

# Examples

User asks: "Find threads where we discussed the monorepo migration"
\`\`\`json
{"query":"monorepo migration","limit":10}
\`\`\`

User asks: "Which threads worked on the tool service?"
\`\`\`json
{"query":"\\"tool-service.ts\\" repo:owner/repo","limit":5}
\`\`\`

User asks: "Show me my recent threads"
\`\`\`json
{"query":"author:me","limit":10}
\`\`\`

User asks: "Find threads from the last week about authentication"
\`\`\`json
{"query":"auth after:7d","limit":10}
\`\`\`
`;

/**
 * `find_thread` and `read_thread`. Both only read, so besides the calling
 * Thread owner's own Threads they reach Threads shared with the owner's
 * workspace. From a shared calling Thread, of the owner's own Threads only
 * its family is reachable, as for the other Thread tools.
 */
/**
 * How `read_thread` runs its reader. `isolated`: a subagent with a fresh
 * context, its own system prompt and message, and only its two tools.
 * `shared`: Flue's tool harness, which keeps the calling agent's context and
 * tools and adds the reader's.
 */
export type ReaderMode = "isolated" | "shared";

const THREAD_READER = {
  name: "thread_reader",
  description: "Reads one dx thread to answer a question about it.",
  agent: () => THREAD_READER_SYSTEM_PROMPT,
  thinkingLevel: "low",
  environment: "none",
} as const satisfies SubagentDefinition;

const CURRENT_READER = {
  ...THREAD_READER,
  agent: () => CURRENT_CONTEXT_SYSTEM_PROMPT,
} as const satisfies SubagentDefinition;

export interface ThreadSearchToolOptions {
  /** Replaces the history read; tests run without Flue's agent objects. */
  readonly loadHistory?: typeof readHistory;
  readonly readerMode?: ReaderMode;
}

export const createThreadSearchTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
  {
    loadHistory = readHistory,
    readerMode = "isolated",
  }: ThreadSearchToolOptions = {},
): ToolDefinition[] => {
  const scopeOf = async (context: ThreadToolsContext) => {
    const calling = await readCallingThread(context.db, callingThreadId);
    const scope: ThreadSearchScope = {
      userId: calling.ownerUserId,
      ...(calling.sharedFamilyRoot === undefined
        ? {}
        : { familyRoot: calling.sharedFamilyRoot }),
    };
    return { calling, scope };
  };

  const findThread = defineTool({
    name: "find_thread",
    description: FIND_THREAD_DESCRIPTION,
    input: v.object({
      query: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
        v.description("Keywords and filters."),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(THREAD_SEARCH_MAX_LIMIT),
          v.description(
            `Threads per page; default ${THREAD_SEARCH_DEFAULT_LIMIT}.`,
          ),
        ),
      ),
      cursor: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(512),
          v.description("nextCursor from the previous page."),
        ),
      ),
    }),
    run: async ({ data }) => {
      const context = getContext();
      const { calling, scope } = await scopeOf(context);
      try {
        const result = await searchThreads({
          db: context.db,
          bindings: context.bindings,
          scope,
          query: data.query,
          ...(data.limit === undefined ? {} : { limit: data.limit }),
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        });
        return {
          output: {
            threads: result.items.map((hit) => {
              const item = searchThreadsItem(hit);
              const { id, ownerUserId, ...rest } = item;
              return {
                threadId: id,
                ...rest,
                ownedByYou: ownerUserId === calling.ownerUserId,
              };
            }),
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          },
        };
      } catch (error) {
        if (error instanceof ThreadSearchQueryError)
          throw new Error(`find_thread: ${error.message}`);
        throw error;
      }
    },
  });

  const readThread = defineTool({
    name: "read_thread",
    description: READ_THREAD_DESCRIPTION,
    harness: true,
    input: v.object({
      threadID: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(2_048),
        v.description(
          "A dx thread URL whose last path segment is thr_{uuid}, or a thread ID in format thr_{uuid}.",
        ),
      ),
      question: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(8_000),
        v.description(
          "The question you want to ask the thread. Be clear and specific.",
        ),
      ),
      context: v.pipe(
        v.picklist(["full", "current"]),
        v.description(
          'Which context windows of the target thread to consider: "full" or "current".',
        ),
      ),
    }),
    run: async ({ data, harness, signal }) => {
      const context = getContext();
      const { calling, scope } = await scopeOf(context);
      // A Claude Code model call runs the Thread's Claude Code session, so
      // it cannot also run a reader. Until a subagent model is configured
      // for such Threads, the tool says so instead.
      if (
        calling.selection?.kind === "model" &&
        isClaudeCodeModel(calling.selection.model)
      )
        throw new Error(
          "Subagent not configured: read_thread runs its reader on a subagent model, and this Claude Code Thread has none.",
        );
      let target: LoadedThread;
      try {
        const found = await searchThreads({
          db: context.db,
          bindings: context.bindings,
          scope,
          query: `id:${data.threadID.trim()}`,
          limit: 1,
        });
        const row = found.items[0];
        if (row === undefined)
          throw new Error(
            scope.familyRoot === undefined
              ? `Thread ${data.threadID} was not found among the Threads this Thread's owner can read.`
              : `Thread ${data.threadID} is not reachable from this shared Thread: it reaches only its parent and child Threads and Threads shared with the workspace.`,
          );
        const history = await loadHistory(
          context.bindings,
          calling.ownerUserId,
          row.id,
        );
        if (history.kind === "busy")
          throw new Error(
            "That Thread's history is still loading; try again shortly.",
          );
        if (history.kind === "unavailable")
          throw new Error(
            `That Thread's history is unavailable (${history.status}).`,
          );
        if (history.kind === "empty")
          return { output: { answer: "That Thread has no messages yet." } };
        target = { threadId: row.id, title: row.title, page: history.page };
      } catch (error) {
        if (error instanceof ThreadSearchQueryError)
          throw new Error(`read_thread: ${error.message}`);
        throw error;
      }
      // Until subagent routes are pinned per submission, the reader runs on
      // the calling Thread's own model, at low thinking.
      const thinkingLevel = "low" as const;
      const aborts = signal === undefined ? {} : { signal };
      const current = data.context === "current";
      const reader = current ? undefined : readerTools(target);
      let answer: string;
      if (readerMode === "isolated") {
        // A fresh child conversation that knows only the reader's own
        // instructions and tools: no sandbox, no workspace context, none of
        // the calling agent's instructions or tools.
        const response = await harness.task(
          current
            ? currentUserMessage(target, data.question)
            : readerUserMessage(
                target,
                reader?.messageCount ?? 0,
                data.question,
              ),
          {
            agent: current ? CURRENT_READER : THREAD_READER,
            ...(reader === undefined ? {} : { tools: [...reader.tools] }),
            ...aborts,
          },
        );
        answer = response.text;
      } else {
        // Flue's own tool harness: the calling agent's conversation context
        // and tools stay present, so the reader's instructions lead.
        const response = await harness.prompt(
          current
            ? sharedCurrentPrompt(target, data.question)
            : sharedReaderPrompt(
                target,
                reader?.messageCount ?? 0,
                data.question,
              ),
          {
            thinkingLevel,
            ...(reader === undefined ? {} : { tools: [...reader.tools] }),
            ...aborts,
          },
        );
        answer = response.text;
      }
      return {
        output: {
          answer: answer.trim(),
          ...(reader === undefined ? {} : { readerToolCalls: reader.calls() }),
        },
      };
    },
  });

  return [findThread, readThread];
};
