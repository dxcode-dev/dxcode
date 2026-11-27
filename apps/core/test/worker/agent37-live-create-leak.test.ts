import { env } from "cloudflare:test";
import { AGENT37_ORB_SIZES, type UserId } from "@dx/domain";
import { Redacted } from "effect";
import { http, passthrough } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent37Api } from "../../src/execution/agent37/api.js";
import { makeAgent37ExecutionProvider } from "../../src/execution/agent37/provider.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { network } from "./network-boundary.js";

/**
 * Replays, on a real Agent37 account, how a new Thread leaked an instance
 * (thr_5ab58742, 2026-11-27): the web UI starts the Thread's Orb early in
 * `waitUntil`, Workers cancel that work 30 s after the response while
 * Agent37's create still waits for the instance to run, and the first run
 * opens the Orb at the same time. Afterwards the Thread must have exactly
 * one live instance, the one its record holds.
 *
 * Opt-in: set DX_TEST_AGENT37_API_KEY and DX_TEST_AGENT37_TEMPLATE (a dx
 * Orb template registered in that Agent37 workspace). Each run creates and
 * then deletes 2-vCPU instances tagged with its own Thread.
 */

const live = env as unknown as {
  readonly DX_TEST_AGENT37_API_KEY?: string;
  readonly DX_TEST_AGENT37_TEMPLATE?: string;
};
const apiKey = live.DX_TEST_AGENT37_API_KEY;
const template = live.DX_TEST_AGENT37_TEMPLATE;

const owner = "a37-live-owner" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000037e1";
const timestamp = "2026-11-27T00:00:00.000Z";

const size = AGENT37_ORB_SIZES.find(({ id }) => id === "a37.small");

describe.skipIf(apiKey === undefined || template === undefined)(
  "Agent37 on a real account",
  () => {
    const threadIds: Array<string> = [];
    /** Agent37's own list, read here so main's parser cannot hide one. */
    const tagged = async (threadId: string) => {
      const listed = (await (
        await fetch("https://api.agent37.com/v1/instances", {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json()) as {
        readonly data: ReadonlyArray<{
          readonly id: string;
          readonly status: string;
          readonly metadata?: Record<string, string>;
        }>;
      };
      return listed.data.filter(
        ({ metadata, status }) =>
          metadata?.dxThread === threadId &&
          !["deleting", "deleted"].includes(status),
      );
    };

    beforeEach(async () => {
      network.use(
        http.all("https://api.agent37.com/*", () => passthrough()),
        http.all("https://sandbox.agent37.app/*", () => passthrough()),
      );
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
        ).bind(owner, owner, `${owner}@example.com`, 1, 1),
        env.DB.prepare(
          `INSERT OR REPLACE INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
           VALUES (?, ?, NULL, 'Agent37 live', 'a37.small', ?, ?)`,
        ).bind(project, owner, timestamp, timestamp),
      ]);
    });

    // Every instance a run made is deleted, whatever it asserted.
    afterEach(async () => {
      for (const threadId of threadIds.splice(0))
        for (const { id } of await tagged(threadId))
          await agent37Api(apiKey as string).deleteInstance(id);
    });

    const thread = async () => {
      const threadId = `thr_${crypto.randomUUID()}`;
      threadIds.push(threadId);
      await env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(threadId, project, owner, timestamp, timestamp)
        .run();
      return threadId;
    };
    const context = (): ExecutionContext => ({
      account: { scope: "personal", userId: owner, providerAccount: "live" },
      credentials: Redacted.make({ apiKey: apiKey as string }),
      profile: {
        ...size,
        adapter: "agent37",
        template,
      } as unknown as ExecutionContext["profile"],
    });
    const recorded = (threadId: string) =>
      env.DB.prepare(
        "SELECT state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
      )
        .bind(threadId)
        .first<{ state: string; provider_sandbox_id: string | null }>();

    /** Counts creates; with `cancel`, the create's caller gives up early. */
    const sender = (cancel: boolean, creates: { count: number }) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const create =
          (init?.method ?? "GET").toUpperCase() === "POST" &&
          url === "https://api.agent37.com/v1/instances";
        if (create) creates.count += 1;
        if (!(create && cancel)) return fetch(input, init);
        // Agent37 accepted the create; the caller's request then ends before
        // dx records the instance, as a cancelled `waitUntil` did.
        await fetch(input, init);
        throw new Error("waitUntil() tasks were cancelled");
      }) as typeof fetch;

    it("leaves one instance when the early start is cancelled mid-create", async ({
      annotate,
    }) => {
      const threadId = await thread();
      const creates = { count: 0 };
      const open = (cancel: boolean) =>
        makeAgent37ExecutionProvider({
          fetch: sender(cancel, creates),
        }).workspace.create(
          context(),
          { threadId: threadId as never },
          { authorize: async () => {} },
        );
      const startedAt = Date.now();
      const early = open(true);
      // Settled below; the early start is expected to fail.
      early.catch(() => undefined);
      // The first run follows the early start by about two seconds.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const run = open(false);
      const [earlySettled, runSettled] = await Promise.allSettled([early, run]);
      const instances = await tagged(threadId);
      const record = await recorded(threadId);
      const whoami =
        runSettled.status === "fulfilled"
          ? (await runSettled.value.guest.commands.run("whoami")).stdout.trim()
          : undefined;
      const proof = JSON.stringify({
        proof: "agent37-cancelled-early-start",
        threadId,
        creates: creates.count,
        early: earlySettled.status,
        run: runSettled.status,
        instances: instances.map(({ id, status, metadata }) => ({
          id,
          status,
          attempt: metadata?.dxAttempt ?? null,
        })),
        record,
        whoami,
        seconds: Math.round((Date.now() - startedAt) / 1_000),
      });
      console.log(proof);
      await annotate(proof);
      expect(earlySettled.status).toBe("rejected");
      expect(runSettled.status).toBe("fulfilled");
      expect(whoami).toBe("user");
      expect(instances.map(({ id }) => id)).toEqual([
        record?.provider_sandbox_id,
      ]);
      expect(record?.state).toBe("initialized");
    }, 300_000);

    it("leaves one instance when two activations open a new Thread at once", async ({
      annotate,
    }) => {
      const threadId = await thread();
      const creates = { count: 0 };
      const open = () =>
        makeAgent37ExecutionProvider({
          fetch: sender(false, creates),
        }).workspace.create(
          context(),
          { threadId: threadId as never },
          { authorize: async () => {} },
        );
      const [first, second] = await Promise.all([open(), open()]);
      const instances = await tagged(threadId);
      const record = await recorded(threadId);
      const proof = JSON.stringify({
        proof: "agent37-concurrent-open",
        threadId,
        creates: creates.count,
        instances: instances.map(({ id, status }) => ({ id, status })),
        record,
      });
      console.log(proof);
      await annotate(proof);
      expect((await first.guest.commands.run("whoami")).stdout.trim()).toBe(
        "user",
      );
      expect((await second.guest.commands.run("whoami")).stdout.trim()).toBe(
        "user",
      );
      expect(creates.count).toBe(1);
      expect(instances.map(({ id }) => id)).toEqual([
        record?.provider_sandbox_id,
      ]);
    }, 300_000);
  },
);
