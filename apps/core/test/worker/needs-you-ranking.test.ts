import { env } from "cloudflare:test";
import type {
  CreateProjectResponse,
  CreateThreadResponse,
  NeedsYouItem,
  NeedsYouRankingData,
} from "@dx/api";
import type { Principal, ThreadId } from "@dx/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { linkThread } from "../../src/automations/links.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  DEFAULT_RANKING_MODEL,
  RANKING_REASONS,
  type RankingCall,
  type RankingCaller,
  rankNeedsYou,
} from "../../src/needs-you/ranking.js";
import { requestAttention } from "../../src/needs-you/repository.js";
import { createNeedsYouRoutes } from "../../src/needs-you/routes.js";
import {
  bindings,
  createProductApp,
  jsonHeaders,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

/**
 * Needs-you Prioritize in workerd with real D1: the flag gates every route,
 * each person ranks and reads only their own inbox and ranking, it runs only
 * on Workers AI's Clef models, and Clef's answer is untrusted, so only
 * in-range scores and dx's own reasons for the questions dx asked count.
 * The Clef call is replaced; it records what it was sent.
 */

interface Call {
  readonly model: string;
  readonly state: string;
  readonly questions: ReadonlyArray<string>;
}

const fakeClef = () => {
  const calls: Call[] = [];
  let answer: (questions: Record<string, unknown>) => RankingCall = () => ({
    ok: false,
  });
  const call: RankingCaller = async (input) => {
    calls.push({
      model: input.model,
      state: JSON.stringify(input.state),
      questions: Object.keys(input.questions),
    });
    return answer(input.questions);
  };
  return {
    calls,
    call,
    answer: (next: (questions: Record<string, unknown>) => RankingCall) => {
      answer = next;
    },
  };
};

const score = (value: number) => ({
  type: "score",
  score: value,
  legend: {},
  probabilities: {},
  confidence: 0.9,
});
const choice = (value: string) => ({
  type: "choice",
  choice: value,
  probabilities: {},
  confidence: 0.9,
});

const appFor = (call: RankingCaller, who: Principal) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", who);
    await next();
  });
  app.route("/needs-you", createNeedsYouRoutes(call));
  return app;
};

const enablePrioritize = (who: Principal, enabled = true) =>
  env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      who.userId,
      JSON.stringify(enabled ? [{ id: "needs-you-prioritize", enabled }] : []),
      new Date().toISOString(),
    )
    .run();

const askingThread = async (
  who: Principal,
  title: string,
  summary: string,
  hoursAgo: number,
) => {
  const app = createProductApp(who);
  const project = await (
    await app.request(
      "/projects",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: `${title} project` }),
      },
      bindings,
    )
  ).json<CreateProjectResponse>();
  const thread = await (
    await app.request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ projectId: project.data.id, title }),
      },
      bindings,
    )
  ).json<CreateThreadResponse>();
  await requestAttention(env.DB, thread.data.id, {
    kind: "approval",
    summary,
    requestedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  });
  return thread.data.id;
};

describe("Needs-you Prioritize", () => {
  it("ranks only the person's own inbox with Clef, behind the flag, from an untrusted answer", async () => {
    const clef = fakeClef();
    const owner = appFor(clef.call, principal);
    const other = appFor(clef.call, otherPrincipal);
    const rank = (
      app: Hono<AppEnv>,
      body: unknown = {},
      on: Bindings = bindings,
    ) =>
      app.request(
        "/needs-you/ranking",
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        },
        on,
      );
    const read = (app: Hono<AppEnv>, on: Bindings = bindings) =>
      app.request("/needs-you/ranking", {}, on);

    // Newest ask first in the inbox: the release gate is a1, the cache a2.
    const cache = await askingThread(
      principal,
      "Cache fix",
      "Approve merging PR #41",
      5,
    );
    const release = await askingThread(
      principal,
      "Release gate",
      "Approve the release gate PR #16",
      3,
    );
    for (const threadId of [cache, release])
      await linkThread(env.DB, {
        threadId,
        repository: "acme/app",
        number: 16,
        kind: "pull",
      });
    const secret = await askingThread(
      otherPrincipal,
      "Other person's secret plan",
      "Approve the secret merger",
      1,
    );

    // Off by default: nothing is read, ranked, or sent to Clef.
    for (const response of [await read(owner), await rank(owner)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        data: { code: "RANKING_DISABLED" },
      });
    }
    expect(clef.calls).toEqual([]);

    await enablePrioritize(principal);
    const before = await read(owner);
    expect(before.status).toBe(200);
    const choices = (await before.json<{ data: NeedsYouRankingData }>()).data;
    expect(choices.ranking).toBeUndefined();
    expect(choices.defaultModel).toBe(DEFAULT_RANKING_MODEL);
    // Only Cloudflare's Clef models.
    expect(choices.models.map(({ model }) => model)).toEqual([
      "@cf/cloudflare/clef-flash",
      "@cf/cloudflare/clef",
    ]);

    // Any other model family, or a Claude plan, is refused before a call.
    for (const refused of [
      "claude-code/claude-opus-5-5",
      "cloudflare/@cf/zai-org/glm-5.3-flash",
      "openai/gpt-5",
    ]) {
      const response = await rank(owner, { model: refused });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        data: { code: "RANKING_MODEL_UNAVAILABLE" },
      });
    }
    // A deployment without Workers AI offers nothing and ranks nothing.
    const { AI: _ai, ...withoutAi } = bindings;
    expect(
      (
        await (
          await read(owner, withoutAi)
        ).json<{
          data: NeedsYouRankingData;
        }>()
      ).data.models,
    ).toEqual([]);
    expect((await rank(owner, {}, withoutAi)).status).toBe(409);
    expect(clef.calls).toEqual([]);

    // The answer tries everything: an out-of-range score and an unknown
    // reason for a1, answers for an ask and a Thread it was never asked
    // about, and a wrong answer type.
    clef.answer(() => ({
      ok: true,
      answers: {
        "a1.urgency": score(99),
        "a1.why": choice("<script>alert(1)</script>"),
        "a2.urgency": score(3),
        "a2.why": choice("unblocks"),
        "a9.urgency": score(3),
        [`${secret}.urgency`]: score(3),
        "a1.extra": choice("outage"),
      },
    }));
    const ranked = await rank(owner);
    expect(ranked.status).toBe(200);
    const saved = (await ranked.json<{ data: NeedsYouRankingData }>()).data
      .ranking;
    // One call to Clef Flash with the owner's asks only, two questions each.
    expect(clef.calls).toHaveLength(1);
    expect(clef.calls[0]?.model).toBe(DEFAULT_RANKING_MODEL);
    expect(clef.calls[0]?.questions).toEqual([
      "a1.urgency",
      "a1.why",
      "a2.urgency",
      "a2.why",
    ]);
    expect(clef.calls[0]?.state).toContain("Cache fix");
    expect(clef.calls[0]?.state).toContain("acme/app#16 pull request open");
    expect(clef.calls[0]?.state).not.toContain("secret");
    // The cache fix scored highest and keeps dx's reason; the release gate,
    // whose answers were invalid, follows without one.
    expect(saved?.items.map(({ threadId }) => threadId)).toEqual([
      cache,
      release,
    ]);
    expect(saved?.items[0]?.why).toBe(RANKING_REASONS.unblocks);
    expect(saved?.items[1]?.why).toBeUndefined();
    // Both share acme/app#16, so dx groups them by it.
    expect(saved?.items.map(({ group }) => group)).toEqual([
      "acme/app#16",
      "acme/app#16",
    ]);
    expect(saved?.model).toBe("@cf/cloudflare/clef-flash");
    expect(saved?.modelName).toBe("Clef Flash");
    expect(Date.parse(saved?.rankedAt ?? "")).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain("script");

    // Clef, not Clef Flash, when the person picks it.
    clef.answer(() => ({
      ok: true,
      answers: { "a1.urgency": score(2), "a2.urgency": score(1) },
    }));
    const larger = (
      await (
        await rank(owner, { model: "@cf/cloudflare/clef" })
      ).json<{ data: NeedsYouRankingData }>()
    ).data;
    expect(clef.calls.at(-1)?.model).toBe("@cf/cloudflare/clef");
    expect(larger.ranking?.items.map(({ threadId }) => threadId)).toEqual([
      release,
      cache,
    ]);
    // The saved model is the default next time.
    expect(larger.defaultModel).toBe("@cf/cloudflare/clef");
    const latest = larger.ranking;

    // Reading it again returns it unchanged.
    expect(
      (await (await read(owner)).json<{ data: NeedsYouRankingData }>()).data
        .ranking,
    ).toEqual(latest);

    // No usable score, or a failed call, keeps the saved ranking.
    clef.answer(() => ({ ok: true, answers: { "a1.why": choice("merge") } }));
    expect((await rank(owner)).status).toBe(502);
    clef.answer(() => ({ ok: false }));
    const failed = await rank(owner);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      data: { code: "RANKING_FAILED" },
    });
    expect(
      (await (await read(owner)).json<{ data: NeedsYouRankingData }>()).data
        .ranking,
    ).toEqual(latest);

    // Another person cannot read or trigger the owner's ranking: with the
    // flag off they get nothing; with it on they see only their own.
    expect((await read(other)).status).toBe(404);
    expect((await rank(other)).status).toBe(404);
    await enablePrioritize(otherPrincipal);
    const otherView = (
      await (await read(other)).json<{ data: NeedsYouRankingData }>()
    ).data;
    expect(otherView.ranking).toBeUndefined();
    const callsBefore = clef.calls.length;
    clef.answer(() => ({
      ok: true,
      answers: { "a1.urgency": score(1), "a1.why": choice("decision") },
    }));
    const otherRanked = (
      await (await rank(other)).json<{ data: NeedsYouRankingData }>()
    ).data.ranking;
    expect(otherRanked?.items.map(({ threadId }) => threadId)).toEqual([
      secret,
    ]);
    expect(clef.calls[callsBefore]?.state).not.toContain("Cache fix");
    expect(
      (await (await read(owner)).json<{ data: NeedsYouRankingData }>()).data
        .ranking,
    ).toEqual(latest);

    // Turning the flag off hides the saved ranking again.
    await enablePrioritize(principal, false);
    expect((await read(owner)).status).toBe(404);

    // Nothing waiting: nothing to rank, and no call.
    await enablePrioritize(principal);
    await env.DB.prepare("DELETE FROM thread_attention_request").run();
    const calls = clef.calls.length;
    const empty = await rank(owner);
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({
      data: { code: "NOTHING_TO_RANK" },
    });
    expect(clef.calls).toHaveLength(calls);
  });

  it("asks Clef about at most 32 asks a call and merges the batches", async () => {
    const clef = fakeClef();
    const items: NeedsYouItem[] = Array.from({ length: 40 }, (_, index) => ({
      threadId: `thr_${String(index).padStart(32, "0")}` as ThreadId,
      threadTitle: `Ask ${index + 1}`,
      projectName: "",
      kind: "question",
      summary: `Question ${index + 1}`,
      requestedAt: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    // Clef scores each ask by its number, so the last ask ranks first.
    clef.answer((questions) => ({
      ok: true,
      answers: Object.fromEntries(
        Object.keys(questions)
          .filter((id) => id.endsWith(".urgency"))
          .map((id) => [id, score((Number(id.slice(1, -8)) / 40) * 3)]),
      ),
    }));
    const ranked = await rankNeedsYou(
      clef.call,
      bindings,
      DEFAULT_RANKING_MODEL,
      items,
    );
    expect(clef.calls.map(({ questions }) => questions.length)).toEqual([
      64, 16,
    ]);
    // Every call sees the whole inbox, so it ranks each ask against all.
    for (const call of clef.calls) expect(call.state).toContain("Ask 40");
    expect(ranked?.map(({ threadTitle }) => threadTitle).slice(0, 3)).toEqual([
      "Ask 40",
      "Ask 39",
      "Ask 38",
    ]);
    expect(ranked).toHaveLength(40);
  });
});
