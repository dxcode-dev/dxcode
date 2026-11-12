import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseClaudePlanLimit } from "@dx/domain";
import { createFlueClient } from "@flue/sdk";
import { describe, expect, it } from "vitest";

/**
 * #1578: a wake that arrives while the Thread's Claude plan is used up fails
 * on the limit. It must wait for the plan's reset and then run, once, rather
 * than being dropped.
 */

const fixtureUrl = process.env.DX_LIFECYCLE_FIXTURE_URL;
if (fixtureUrl === undefined)
  throw new Error("Lifecycle fixture URL is missing.");
const BASE_URL = new URL(fixtureUrl);
const authorization = {
  authorization: "Bearer dxu_fixture-token-0000000000000000000",
};

const fixtureRequest = (path: string, init?: RequestInit) =>
  fetch(new Request(new URL(path, BASE_URL), init));

const json = (body: unknown) => ({
  method: "POST",
  headers: { ...authorization, "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** One Worker cron tick of the plan-reset sweep. */
const tick = async () => {
  const response = await fixtureRequest("/__fixture/plan/tick", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return (
    await response.json<{
      resumed: Array<{ threadId: string; submissionId: string }>;
    }>()
  ).resumed;
};

const tickSweep = () => tick();

const writeProof = (name: string, proof: unknown) => {
  const directory = process.env.DX_PLAN_RESET_ARTIFACTS;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${name}.json`),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
};

describe("a wake while the Thread's Claude plan is used up", () => {
  it("waits for the plan's reset, then runs once with every wake that queued, in order", async () => {
    const project = await fixtureRequest(
      "/v1/projects",
      json({ name: "plan-reset-lifecycle" }),
    );
    expect(project.status).toBe(201);
    const projectId = (await project.json<{ data: { id: string } }>()).data.id;
    const created = await fixtureRequest(
      "/v1/threads",
      json({ projectId, title: "Plan reset" }),
    );
    expect(created.status).toBe(201);
    const threadId = (await created.json<{ data: { id: string } }>()).data.id;
    const client = createFlueClient({
      url: new URL(`/v1/agents/plan/${threadId}`, BASE_URL).toString(),
      fetch: fetch.bind(globalThis),
      headers: authorization,
    });
    const answers = async () =>
      (await client.history()).messages.flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            )
          : [],
      );

    // The Claude Code runner reports the plan used up for a few seconds.
    const resetsAt = Math.floor(Date.now() / 1000) + 8;
    expect(
      (
        await fixtureRequest(
          `/__fixture/plan/report-limit/${threadId}`,
          json({ resetsAt }),
        )
      ).status,
    ).toBe(204);

    // A GitHub event wakes the Thread, and the turn fails on the limit,
    // naming the reset to the second.
    const first = await client.send({
      message: { kind: "user", body: "First wake: the PR comment" },
      idempotencyKey: "plan-reset-first-wake",
    });
    const failure = await client.wait(first).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(failure).toBeDefined();
    expect(parseClaudePlanLimit(failure ?? "")).toEqual({
      window: "five_hour",
      resetsAt,
      cause: "not-started",
    });

    // A Thread message during the limit fails the same way and queues too.
    const second = await client.send({
      message: { kind: "user", body: "Second wake: a Thread message" },
      idempotencyKey: "plan-reset-second-wake",
    });
    await expect(client.wait(second)).rejects.toThrow(
      /Claude plan limit reached/,
    );

    // Before the reset, the cron runs nothing.
    expect(await tick()).toEqual([]);
    expect(await answers()).toEqual([]);

    // Once the reset passes, one tick runs the Thread, once, and the turn
    // answers both wakes in the order they arrived.
    while (Date.now() / 1000 < resetsAt)
      await new Promise((resolve) => setTimeout(resolve, 250));
    const resumed = await tick();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.threadId).toBe(threadId);
    await client.read(resumed[0]?.submissionId ?? "");
    expect(await answers()).toEqual([
      "Answered: First wake: the PR comment | Second wake: a Thread message",
    ]);

    // Later ticks find nothing left to run.
    expect(await tick()).toEqual([]);
    expect(await answers()).toHaveLength(1);
    writeProof("plan-reset", {
      threadId,
      resetsAt: new Date(resetsAt * 1000).toISOString(),
      limitText: failure,
      resumed,
      answers: await answers(),
    });
  });

  it("does the same for a person's @dx comments in an artifact, and a tick wakes nothing (#1606, #1765)", async () => {
    const project = await fixtureRequest(
      "/v1/projects",
      json({ name: "plan-reset-artifacts" }),
    );
    const projectId = (await project.json<{ data: { id: string } }>()).data.id;
    const created = await fixtureRequest(
      "/v1/threads",
      json({ projectId, title: "Plan reset, artifacts" }),
    );
    const threadId = (await created.json<{ data: { id: string } }>()).data.id;
    const client = createFlueClient({
      url: new URL(`/v1/agents/plan/${threadId}`, BASE_URL).toString(),
      fetch: fetch.bind(globalThis),
      headers: authorization,
    });
    const answers = async () =>
      (await client.history()).messages.flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            )
          : [],
      );
    // Two wakes and their failed reads run before the reset; under a full
    // verify's load they took over 8 seconds.
    const resetsAt = Math.floor(Date.now() / 1000) + 20;
    await fixtureRequest(
      `/__fixture/plan/report-limit/${threadId}`,
      json({ resetsAt }),
    );
    const wake = async (
      kind: "tick" | "comment",
      now: number,
      comment?: number,
    ) => {
      const response = await fixtureRequest(
        `/__fixture/plan/artifact-wake/${threadId}`,
        { method: "POST", body: JSON.stringify({ kind, now, comment }) },
      );
      expect(response.status).toBe(200);
      return (await response.json<{ delivered: string[] }>()).delivered;
    };

    // A tick wakes nothing (#1765).
    expect(await wake("tick", Date.now())).toEqual([]);
    // Each comment's wake fails on the limit; the second comes after the
    // agent wake window, so it wakes on its own.
    const t0 = Date.now();
    for (const [comment, now] of [
      [1, t0],
      [2, t0 + 31_000],
    ] as const) {
      const delivered = await wake("comment", now, comment);
      expect(delivered).toHaveLength(1);
      await expect(client.read(delivered[0] ?? "")).rejects.toThrow(
        /Claude plan limit reached/,
      );
    }

    // Nothing runs before the reset; then one tick runs the Thread once,
    // and its turn answers both wakes in order.
    expect(await tickSweep()).toEqual([]);
    expect(await answers()).toEqual([]);
    while (Date.now() / 1000 < resetsAt)
      await new Promise((resolve) => setTimeout(resolve, 250));
    const resumed = await tickSweep();
    expect(resumed).toEqual([expect.objectContaining({ threadId })]);
    await client.read(resumed[0]?.submissionId ?? "");
    const [answer, ...more] = await answers();
    expect(more).toEqual([]);
    expect(answer).toMatch(
      /^Answered: A person mentioned you in a comment \(cmt_0{31}1\)[\s\S]* \| A person mentioned you in a comment \(cmt_0{31}2\)/,
    );
    expect(await tickSweep()).toEqual([]);
    writeProof("plan-reset-artifacts", {
      threadId,
      resetsAt: new Date(resetsAt * 1000).toISOString(),
      resumed,
      answer,
    });
  }, 60_000);
});
