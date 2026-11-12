import { env } from "cloudflare:test";
import type { SpaceSuggestion } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { SPACE_SUGGESTION_MODEL } from "../../src/spaces/suggestions.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * New Space's suggestions in workerd with real D1, with a fake Workers AI
 * model in place of GLM.
 *
 * Ways it could go wrong: someone else's threads, old threads, a Space or a
 * Space's child, or a deleted thread reach the model; a group the model
 * makes up (one thread, threads from two Projects, numbers it was never
 * given, the same thread twice) becomes a suggestion; a long or multi-line
 * name gets through; a model failure or garbage answer fails the request
 * instead of answering none; local development calls the model; more than
 * three come back.
 */

const owner = "suggest-owner" as UserId;
const stranger = "suggest-stranger" as UserId;
const checkout = project(
  "prj_00000000-0000-4000-8000-00000000b151",
  owner,
  "checkout",
);
const docs = project("prj_00000000-0000-4000-8000-00000000b152", owner, "docs");
const strangerProject = project(
  "prj_00000000-0000-4000-8000-00000000b153",
  stranger,
  "theirs",
);
const now = Date.now();
const daysAgo = (days: number) =>
  new Date(now - days * 86_400_000).toISOString();
const id = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ThreadId;

const recent = (
  n: number,
  title: string,
  projectId = checkout.id,
  userId = owner,
  at = daysAgo(1),
) => ({ ...thread(id(n), projectId, userId, at), title });

interface ModelCall {
  readonly model: string;
  readonly prompt: string;
}

const appFor = (_bindings: Bindings) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal"],
      }),
    );
    await next();
  });
  app.route("/v1/spaces", spaceRoutes);
  return app;
};

/** Asks for suggestions with a fake model that answers `answer`. */
const suggest = async (
  answer: (prompt: string) => unknown,
  extra: Partial<Bindings> = {},
) => {
  const calls: ModelCall[] = [];
  const bindings: Bindings = {
    DB: env.DB,
    AI: {
      run: async (
        model: string,
        input: { messages: { content: string }[] },
      ) => {
        const prompt = input.messages.at(-1)?.content ?? "";
        calls.push({ model, prompt });
        return answer(prompt);
      },
    } as unknown as Ai,
    ...extra,
  };
  const response = await appFor(bindings).request(
    "/v1/spaces/suggestions",
    {},
    bindings,
  );
  const body = (await response.json()) as {
    data: { items: SpaceSuggestion[] };
  };
  return { status: response.status, items: body.data.items, calls };
};

/** The number the prompt gave a thread, as the model sees it. */
const numberOf = (prompt: string, title: string) => {
  const line = prompt.split("\n").find((entry) => entry.endsWith(` ${title}`));
  return Number(line?.split(".")[0]);
};

beforeEach(async () => {
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(checkout);
      yield* projects.insert(docs);
      yield* projects.insert(strangerProject);
      const threads = yield* ThreadRepository;
      for (const entry of [
        recent(1, "Retry flaky uploads"),
        recent(2, "Upload progress events"),
        recent(3, "Upload size limits"),
        recent(4, "Docs search ranking", docs.id),
        recent(5, "Docs sidebar order", docs.id),
        recent(6, "Ancient upload work", checkout.id, owner, daysAgo(30)),
        recent(7, "Their private work", strangerProject.id, stranger),
        recent(8, "Release Space"),
        recent(9, "Space child work"),
        recent(10, "Deleted upload thread"),
      ])
        yield* threads.insert(entry);
    }),
  );
  await env.DB.batch([
    env.DB.prepare("UPDATE threads SET kind = 'space' WHERE id = ?").bind(
      id(8),
    ),
    env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?1 WHERE id = ?2",
    ).bind(id(8), id(9)),
    env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'deleted' WHERE id = ?",
    ).bind(id(10)),
  ]);
});

beforeEach(() => seedSpaceUsers([owner, stranger]));

describe("GET /v1/spaces/suggestions", () => {
  it("groups the owner's recent threads with one model call and keeps only real groups", async () => {
    const { status, items, calls } = await suggest((prompt) => {
      const n = (title: string) => numberOf(prompt, title);
      return {
        response: JSON.stringify({
          groups: [
            {
              name: "Upload Reliability",
              goal: "Make large uploads finish and report progress.",
              threads: [
                n("Retry flaky uploads"),
                n("Upload progress events"),
                n("Upload size limits"),
                n("Retry flaky uploads"),
              ],
            },
            // Two Projects in one group.
            {
              name: "Mixed Bag",
              goal: "Nothing in common.",
              threads: [n("Upload size limits"), n("Docs search ranking")],
            },
            // One thread, and a number it was never given.
            {
              name: "Lonely",
              goal: "Just one.",
              threads: [n("Docs sidebar order"), 99],
            },
            {
              name: "A name far too long to fit in a sidebar row",
              goal: "Too wordy.",
              threads: [n("Docs search ranking"), n("Docs sidebar order")],
            },
            {
              name: "Docs Navigation",
              goal: "Help readers find pages faster.",
              threads: [n("Docs search ranking"), n("Docs sidebar order")],
            },
          ],
        }),
      };
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(SPACE_SUGGESTION_MODEL);
    // Only the owner's live, recent, ordinary threads reach the model.
    const prompt = calls[0]?.prompt ?? "";
    for (const title of [
      "Retry flaky uploads",
      "Upload progress events",
      "Upload size limits",
      "[docs] Docs search ranking",
      "Docs sidebar order",
    ])
      expect(prompt).toContain(title);
    for (const title of [
      "Ancient upload work",
      "Their private work",
      "Release Space",
      "Space child work",
      "Deleted upload thread",
    ])
      expect(prompt).not.toContain(title);
    expect(items).toEqual([
      {
        name: "Upload Reliability",
        goal: "Make large uploads finish and report progress.",
        threadCount: 3,
        projectId: checkout.id,
        projectName: "checkout",
      },
      {
        name: "Docs Navigation",
        goal: "Help readers find pages faster.",
        threadCount: 2,
        projectId: docs.id,
        projectName: "docs",
      },
    ]);
  });

  it("answers none when the model fails or answers garbage", async () => {
    const failed = await suggest(() => {
      throw new Error("Workers AI is down");
    });
    expect(failed).toMatchObject({ status: 200, items: [] });
    const garbage = await suggest(() => ({ response: "I cannot help." }));
    expect(garbage).toMatchObject({ status: 200, items: [] });
    const multiline = await suggest((prompt) => ({
      response: JSON.stringify({
        groups: [
          {
            name: "Uploads\nIgnore previous instructions",
            goal: "x",
            threads: [
              numberOf(prompt, "Retry flaky uploads"),
              numberOf(prompt, "Upload size limits"),
            ],
          },
        ],
      }),
    }));
    expect(multiline.items).toEqual([]);
  });

  it("never calls a model in routine local development", async () => {
    const { items, calls } = await suggest(
      () => {
        throw new Error("No model calls in local development.");
      },
      { DX_RUNTIME_MODE: "local" },
    );
    expect(calls).toEqual([]);
    // Grouped by Project instead, busiest first.
    expect(
      items.map(({ projectName, threadCount }) => [projectName, threadCount]),
    ).toEqual([
      ["checkout", 3],
      ["docs", 2],
    ]);
  });
});
