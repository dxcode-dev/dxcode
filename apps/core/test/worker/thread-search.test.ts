/**
 * Thread search end to end in workerd: real D1 decides access and filters,
 * real per-owner search-index Durable Objects (SQLite FTS5) match keywords.
 *
 * Ways it could fail, each covered below:
 *  1. Text deep in a long Thread, or split across messages, is not found
 *     (truncation; per-message AND instead of per-Thread AND).
 *  2. Tool calls, tool results, text between tool calls, or a reply still
 *     streaming become searchable.
 *  3. Stems do not match; stopwords make a query match everything; quotes act
 *     as phrases; an unknown `key:value` errors instead of being keywords.
 *  4. A file name does not find its full path; a partial path or a path
 *     without an extension matches too loosely.
 *  5. Access leaks: another member's private Thread, an outsider's Thread, a
 *     workspace-Project Thread after its owner left, or (from a shared
 *     calling Thread) the owner's private non-family Threads.
 *  6. Filters, ordering, or keyset pages are wrong; pages repeat or skip.
 *  7. Re-indexing duplicates; a renamed title keeps matching; a dropped Thread
 *     still matches.
 *  8. Snippets are empty or leak the hidden encoded terms.
 *  9. Billable rows read grow with every indexed message instead of with the
 *     query's matches.
 * 10. The route accepts an invalid filter value or omits the cursor.
 */
import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  type HistoryPage,
  indexableMessages,
} from "../../src/thread-search/history.js";
import { ownerSearchIndex } from "../../src/thread-search/index-client.js";
import { threadSearchRoutes } from "../../src/thread-search/routes.js";
import {
  searchThreads,
  type ThreadSearchScope,
} from "../../src/thread-search/service.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "search-owner" as UserId;
const member = "search-member" as UserId;
const outsider = "search-outsider" as UserId;
const workspaceId = "search-workspace";
const otherWorkspaceId = "search-other-workspace";

const bindings: Bindings = {
  DB: env.DB,
  THREAD_SEARCH_INDEX: env.THREAD_SEARCH_INDEX,
};

const ids = {
  ownerPersonal: "prj_00000000-0000-4000-8000-000000000001" as ProjectId,
  ownerWorkspace: "prj_00000000-0000-4000-8000-000000000002" as ProjectId,
  memberPersonal: "prj_00000000-0000-4000-8000-000000000003" as ProjectId,
  outsiderPersonal: "prj_00000000-0000-4000-8000-000000000004" as ProjectId,
};

const newId = () => `thr_${crypto.randomUUID()}`;

interface Seeded {
  readonly id: string;
  readonly owner: UserId;
}

let minute = 0;
/** Each seeded Thread is newer than the last. */
const seed = async (
  ownerUserId: UserId,
  projectId: ProjectId,
  title: string,
  messages: ReadonlyArray<string>,
  extra: Record<string, string | null> = {},
): Promise<Seeded> => {
  const id = newId();
  minute += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  await runRepositories(
    Effect.gen(function* () {
      const threads = yield* ThreadRepository;
      yield* threads.insert(thread(id, projectId, ownerUserId, at));
    }),
  );
  const assignments = Object.entries({ title, ...extra });
  await env.DB.prepare(
    `UPDATE threads SET ${assignments.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
  )
    .bind(...assignments.map(([, value]) => value), id)
    .run();
  await ownerSearchIndex(bindings, ownerUserId)?.indexMessages(
    id,
    title,
    messages.map((text, index) => ({
      messageId: `${id}-m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text,
    })),
  );
  return { id, owner: ownerUserId };
};

const search = (query: string, scope: ThreadSearchScope = { userId: owner }) =>
  searchThreads({ db: env.DB, bindings, scope, query, limit: 50 });

const found = async (query: string, scope?: ThreadSearchScope) =>
  (await search(query, scope)).items.map(({ id }) => id);

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  minute = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Search Team",
      "search-team",
      otherWorkspaceId,
      "Other",
      "search-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('q-owner', ?1, ?2, 'owner', 1),
         ('q-member', ?1, ?3, 'member', 2),
         ('q-outsider', ?4, ?5, 'owner', 3)`,
    ).bind(workspaceId, owner, member, otherWorkspaceId, outsider),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(project(ids.ownerPersonal, owner, "Personal"));
      yield* projects.insert(project(ids.ownerWorkspace, owner, "Team repo"));
      yield* projects.insert(project(ids.memberPersonal, member, "Ben's"));
      yield* projects.insert(
        project(ids.outsiderPersonal, outsider, "Outside"),
      );
    }),
  );
  await env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?")
    .bind(workspaceId, ids.ownerWorkspace)
    .run();
});

describe("Thread search with real D1 and per-owner FTS5 indexes", () => {
  it("indexes people's messages and final replies only", () => {
    const page: HistoryPage = {
      settled: new Map([["s1", "completed"]]),
      hasOlder: false,
      messages: [
        {
          id: "u1",
          role: "user",
          purpose: "user",
          submissionId: "s1",
          parts: [
            {
              type: "text",
              text: '<dx_message_author role="owner" user_id="u" name="Ada"/>\nPlease migrate the billing ledger',
            },
          ],
        },
        {
          id: "a1",
          role: "assistant",
          purpose: "assistant",
          submissionId: "s1",
          parts: [
            { type: "reasoning", text: "thinking about secretplan" },
            { type: "text", text: "Checking meanwhile" },
            {
              type: "dynamic-tool",
              toolName: "shell_command",
              input: { command: "cat toolinputonly.txt" },
              output: "tooloutputonly",
            },
            { type: "text", text: "The ledger migration is done." },
          ],
        },
        {
          id: "a2",
          role: "assistant",
          purpose: "assistant",
          submissionId: "s2",
          parts: [{ type: "text", text: "Still streaming draft" }],
        },
      ],
    };
    expect(indexableMessages(page)).toEqual([
      {
        messageId: "u1",
        role: "user",
        text: "Please migrate the billing ledger",
      },
      {
        messageId: "a1",
        role: "assistant",
        text: "The ledger migration is done.",
      },
    ]);
  });

  it("matches words anywhere in a Thread with loose rules", async () => {
    const filler = Array.from(
      { length: 400 },
      (_, index) => `routine progress note ${index} about the dashboard`,
    );
    const long = await seed(owner, ids.ownerPersonal, "Release prep", [
      "Plan the orchestrator rollout",
      ...filler,
      "Finally the ledger reconciliation passed",
    ]);
    const other = await seed(owner, ids.ownerPersonal, "Sidebar colors", [
      "Make the workspace sharing badge blue",
    ]);

    // Deep in a long Thread, and AND across different messages.
    expect(await found("reconciliation")).toEqual([long.id]);
    expect(await found("orchestrator reconciliation")).toEqual([long.id]);
    // Stems match; the title is searchable.
    expect(await found("orchestrating")).toEqual([long.id]);
    expect(await found("prep")).toEqual([long.id]);
    // One unknown word empties the result; typos and prefixes do not match.
    expect(await found("orchestrator zzqqxxyy")).toEqual([]);
    expect(await found("orkestrator")).toEqual([]);
    expect(await found("orch*")).toEqual([]);
    // Quotes only group: order and adjacency do not matter.
    expect(await found('"sharing workspace"')).toEqual([other.id]);
    // Stopwords alone match nothing; OR and a leading dash are not operators.
    expect(await found("the")).toEqual([]);
    expect(await found("blue OR zzqqxxyy")).toEqual([]);
    expect(await found("workspace -sharing")).toEqual([other.id]);
    // An unknown key:value is keywords.
    expect(await found("color:blue")).toEqual([]);
    expect(await found("badge:blue")).toEqual([other.id]);
  });

  it("finds a file by name, keeps paths whole otherwise, and splits words", async () => {
    const paths = await seed(owner, ids.ownerPersonal, "Thread tools", [
      "Edited apps/core/src/threads/agent-tools.ts and bumped 0.2.10",
    ]);
    const words = await seed(owner, ids.ownerPersonal, "Words", [
      "the agent tools are fine",
    ]);
    expect(await found("apps/core/src/threads/agent-tools.ts")).toEqual([
      paths.id,
    ]);
    expect(await found("agent-tools.ts")).toEqual([paths.id]);
    expect(await found("src/threads/agent-tools.ts")).toEqual([paths.id]);
    expect(await found("agent-tools")).toEqual([paths.id]);
    expect(await found("0.2.10")).toEqual([paths.id]);
    // A path without an extension must appear whole.
    expect(await found("apps/core")).toEqual([]);
    // Plain words match the parts of compounds too.
    expect(new Set(await found("agent tools"))).toEqual(
      new Set([paths.id, words.id]),
    );
  });

  it("returns own and workspace-shared Threads, never others", async () => {
    const mine = await seed(owner, ids.ownerPersonal, "Mine", [
      "kestrel migration",
    ]);
    const shared = await seed(member, ids.memberPersonal, "Shared", [
      "kestrel shared notes",
    ]);
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    )
      .bind(workspaceId, shared.id)
      .run();
    const memberPrivate = await seed(member, ids.memberPersonal, "Private", [
      "kestrel private",
    ]);
    const outside = await seed(outsider, ids.outsiderPersonal, "Outside", [
      "kestrel outside",
    ]);
    const team = await seed(owner, ids.ownerWorkspace, "Team", [
      "kestrel team project",
    ]);

    expect(new Set(await found("kestrel"))).toEqual(
      new Set([mine.id, shared.id, team.id]),
    );
    expect(await found("kestrel visibility:workspace")).toEqual([shared.id]);
    expect(new Set(await found("kestrel author:me"))).toEqual(
      new Set([mine.id, team.id]),
    );
    expect(await found("kestrel", { userId: member })).not.toContain(mine.id);
    expect(new Set(await found("kestrel", { userId: member }))).toEqual(
      new Set([shared.id, memberPrivate.id]),
    );
    expect(await found("kestrel", { userId: outsider })).toEqual([outside.id]);

    // From a shared calling Thread: only its family of the owner's Threads,
    // plus Threads shared with the owner.
    expect(
      new Set(await found("kestrel", { userId: owner, familyRoot: team.id })),
    ).toEqual(new Set([team.id, shared.id]));

    // Leaving the workspace hides its Projects' Threads and shared Threads.
    await env.DB.prepare("DELETE FROM member WHERE id = 'q-owner'").run();
    expect(await found("kestrel")).toEqual([mine.id]);
  });

  it("applies filters and pages by last activity without repeats", async () => {
    const parent = await seed(owner, ids.ownerPersonal, "Parent", ["heron"]);
    const child = await seed(owner, ids.ownerPersonal, "Child", ["heron"], {
      parent_thread_id: parent.id,
      color: "blue",
    });
    const archived = await seed(owner, ids.ownerWorkspace, "Old", ["heron"], {
      lifecycle_state: "archived",
    });
    const pinned = await seed(owner, ids.ownerPersonal, "Pinned", ["heron"], {
      pinned_at: "2026-10-02T00:00:00.000Z",
    });

    expect(await found(`heron parent:${parent.id}`)).toEqual([child.id]);
    expect(await found(`id:https://dx.example/threads/${child.id}`)).toEqual([
      child.id,
    ]);
    expect(await found("heron archived:true")).toEqual([archived.id]);
    expect(await found("heron pinned:true")).toEqual([pinned.id]);
    expect(await found("heron color:blue")).toEqual([child.id]);
    expect(await found("heron project:personal")).toEqual([
      pinned.id,
      child.id,
      parent.id,
    ]);
    expect(await found(`heron project:${ids.ownerWorkspace}`)).toEqual([
      archived.id,
    ]);
    expect(await found("color:auto archived:false heron")).toEqual([
      pinned.id,
      parent.id,
    ]);
    expect(await found("heron after:2026-10-01T00:03:00Z")).toEqual([
      pinned.id,
      archived.id,
    ]);
    expect(await found("heron before:2026-10-01T00:02:00Z")).toEqual([
      parent.id,
    ]);
    await expect(search("pinned:maybe")).rejects.toThrow(/true or false/);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await searchThreads({
        db: env.DB,
        bindings,
        scope: { userId: owner },
        query: "heron",
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map(({ id }) => id));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual([pinned.id, archived.id, child.id, parent.id]);
  });

  it("is idempotent, follows renames, forgets dropped Threads, and snippets text", async () => {
    const renamed = await seed(owner, ids.ownerPersonal, "Gannet plan", [
      "Investigated apps/web/src/sidebar.tsx for the pelican bug",
    ]);
    const index = ownerSearchIndex(bindings, owner);
    const again = await index?.indexMessages(renamed.id, "Gannet plan", [
      {
        messageId: `${renamed.id}-m0`,
        role: "user",
        text: "Investigated apps/web/src/sidebar.tsx for the pelican bug",
      },
    ]);
    expect(again?.inserted).toBe(0);

    const result = await search("pelican");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.matchedSearchText).toContain("pelican");
    expect(result.items[0]?.matchedSearchText).not.toMatch(/zz/);

    await index?.indexMessages(renamed.id, "Albatross plan", []);
    expect(await found("albatross")).toEqual([renamed.id]);
    expect(await found("gannet")).toEqual([]);

    await index?.dropThread(renamed.id);
    expect(await found("pelican")).toEqual([]);
    expect(await found("albatross")).toEqual([]);
  });

  it("reads rows in proportion to matches, not to the index size", async () => {
    const filler = Array.from(
      { length: 60 },
      (_, index) => `common words about builds and deploys number ${index}`,
    );
    const threads: Seeded[] = [];
    for (let index = 0; index < 30; index++)
      threads.push(
        await seed(owner, ids.ownerPersonal, `Thread ${index}`, filler),
      );
    const rare = await seed(owner, ids.ownerPersonal, "Rare", [
      ...filler,
      "the cormorant incident",
    ]);
    const rareQuery = await search("cormorant");
    expect(rareQuery.items.map(({ id }) => id)).toEqual([rare.id]);
    const byId = await search(`cormorant id:${rare.id}`);
    const common = await search("deploys");
    const report = {
      indexedMessages: 31 * 60 + 1,
      rareWord: rareQuery.cost,
      rareWordWithId: byId.cost,
      commonWord: { ...common.cost, threads: common.items.length },
    };
    console.log(`THREAD_SEARCH_COST ${JSON.stringify(report)}`);
    expect(rareQuery.cost.indexRowsRead).toBeLessThan(40);
    expect(byId.cost.indexRowsRead).toBeLessThan(40);
    // A common word costs a few rows per matching chunk (here one chunk per
    // Thread): the posting and naming its Thread. Each snippet reads one.
    expect(common.cost.indexRowsRead).toBeLessThanOrEqual(
      4 * common.items.length,
    );
    expect(common.cost.snippetRowsRead).toBeLessThanOrEqual(
      2 * common.items.length,
    );
  });

  it("serves the query language over GET /v1/thread-search", async () => {
    const hit = await seed(owner, ids.ownerPersonal, "Route", [
      "albatross route check",
    ]);
    const app = new Hono<AppEnv>();
    app.use("*", requestId);
    app.use("*", async (context, next) => {
      context.set("principal", {
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      } as never);
      await next();
    });
    app.route("/v1/thread-search", threadSearchRoutes);
    app.onError(errorHandler);

    const ok = await app.request(
      `/v1/thread-search?q=${encodeURIComponent("albatross route")}&limit=5`,
      {},
      bindings,
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      status: "success",
      data: {
        items: [
          {
            id: hit.id,
            title: "Route",
            projectName: "Personal",
            matchedSearchText: expect.stringContaining("albatross"),
          },
        ],
      },
    });
    const invalid = await app.request(
      "/v1/thread-search?q=archived:maybe",
      {},
      bindings,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      data: {
        code: "INVALID_REQUEST",
        message: "archived: takes true or false.",
      },
    });
  });
});
