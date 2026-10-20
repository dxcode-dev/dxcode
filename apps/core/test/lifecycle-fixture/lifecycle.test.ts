import { parseMessageAuthor } from "@dx/api";
import { newThreadId, ProjectNameInput } from "@dx/domain";
import { createFlueClient } from "@flue/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runReferenceLifecycle } from "../../src/dev/reference-lifecycle/workflow.js";
import { HEAVY_TURNS } from "./src/heavy-history.js";
import { ORPHAN_RESULT } from "./src/sandbox.js";

const fixtureUrl = process.env.DX_LIFECYCLE_FIXTURE_URL;
if (fixtureUrl === undefined)
  throw new Error("Lifecycle fixture URL is missing.");
const BASE_URL = new URL(fixtureUrl);
const TOKEN = "dxu_fixture-token-0000000000000000000";
const authorization = { authorization: `Bearer ${TOKEN}` };
const PERSONAL_INSTRUCTION = "PRIVATE-LIFECYCLE-PERSONAL-INSTRUCTION";
const fetchFixture: typeof fetch = fetch.bind(globalThis);
const HISTORY_PAGE_BYTES = 1_048_576;
const UNBOUNDED_FIRST_PAGE_BYTES = 2_768_397;

const fixtureRequest = (path: string, init?: RequestInit) =>
  fetch(new Request(new URL(path, BASE_URL), init));

describe("generated Flue Worker lifecycle", () => {
  it("proves the native lifecycle, authorization boundary, and product-state separation", async () => {
    const settingsResponse = await fixtureRequest(
      "/v1/settings/personal/agent-instructions",
      {
        method: "PATCH",
        headers: {
          ...authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          instructions: PERSONAL_INSTRUCTION,
          expectedRevision: 0,
        }),
      },
    );
    expect(settingsResponse.status).toBe(200);

    const evidence = await runReferenceLifecycle(
      {
        baseUrl: BASE_URL,
        apiToken: Redacted.make(TOKEN),
        project: {
          kind: "create",
          name: Schema.decodeUnknownSync(ProjectNameInput)("lifecycle-fixture"),
        },
      },
      { fetch: fetchFixture },
    );

    expect(evidence.abortReceipt).toBe(true);
    expect(evidence.initialSubmission.submissionId).toMatch(/^sub_/);
    expect(evidence.continuationUid).not.toBe("");
    expect(evidence.initialSubmission.streamUrl).toBe(
      new URL(`/v1/agents/dx/${evidence.threadId}`, BASE_URL).toString(),
    );
    expect(new URL(evidence.initialSubmission.streamUrl).search).toBe("");
    expect(evidence.initialSubmission.streamUrl).not.toContain(TOKEN);
    expect(evidence.activeAbort.outcome).toBe("aborted");
    expect(evidence.queuedAbort.outcome).toBe("aborted");
    expect(evidence.activeAbort.submissionId).not.toBe(
      evidence.queuedAbort.submissionId,
    );
    expect(evidence.headerResolutionCount).toBeGreaterThan(8);

    const agentPath = `/v1/agents/dx/${evidence.threadId}`;
    const client = createFlueClient({
      url: new URL(agentPath, BASE_URL).toString(),
      fetch: fetchFixture,
      headers: authorization,
    });
    const nativeHistory = await fixtureRequest(agentPath, {
      headers: authorization,
    });
    expect(nativeHistory.status).toBe(200);
    expect(nativeHistory.headers.get("cache-control")).toBe("no-store");
    expect(nativeHistory.headers.get("stream-next-offset")).toContain("_");
    expect(nativeHistory.headers.get("stream-up-to-date")).toBe("true");
    expect(await nativeHistory.clone().json()).toMatchObject({
      conversationId: expect.stringMatching(/^conv_/),
    });
    const history = await client.history();
    const encodedHistory = JSON.stringify(history);
    expect(encodedHistory).toContain("reference-lifecycle");
    expect(encodedHistory).toContain(evidence.threadId);
    expect(encodedHistory).toContain("settled");
    expect(encodedHistory).not.toContain(PERSONAL_INSTRUCTION);
    expect(encodedHistory).toContain(
      '"path":"/.dx/initialization-count"},"output":"1"',
    );
    expect(encodedHistory).not.toContain(ORPHAN_RESULT);
    expect(history.settlements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: evidence.activeAbort.submissionId,
          outcome: "aborted",
        }),
        expect.objectContaining({
          submissionId: evidence.queuedAbort.submissionId,
          outcome: "aborted",
        }),
      ]),
    );

    const headerDiagnostics = await (
      await fixtureRequest("/__fixture/reference-headers")
    ).json<{
      sequences: string[];
      updateOffsets: string[];
      nativeAdmissionStatuses: number[];
      injectedUpdatesFailure: boolean;
    }>();
    expect(headerDiagnostics.injectedUpdatesFailure).toBe(true);
    expect(headerDiagnostics.nativeAdmissionStatuses.length).toBeGreaterThan(0);
    expect(new Set(headerDiagnostics.nativeAdmissionStatuses)).toEqual(
      new Set([202]),
    );
    expect(new Set(headerDiagnostics.sequences).size).toBe(
      headerDiagnostics.sequences.length,
    );
    expect(headerDiagnostics.updateOffsets.length).toBeGreaterThan(1);
    expect(new Set(headerDiagnostics.updateOffsets).size).toBeGreaterThan(1);
    for (const offset of headerDiagnostics.updateOffsets) {
      // `read(submissionId)` explicitly reattaches from Flue's `-1` origin.
      // Subsequent observation updates use durable stream offsets.
      expect(offset === "-1" || offset.includes("_")).toBe(true);
    }

    const attachment = history.messages
      .flatMap(({ parts }) => parts)
      .find((part) => part.type === "file");
    expect(attachment?.type).toBe("file");
    if (attachment?.type !== "file" || attachment.url === undefined) {
      throw new Error("Attachment is missing.");
    }
    const attachmentResponse = await fetch(attachment.url, {
      headers: authorization,
    });
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("content-type")).toBe("image/png");
    expect(attachmentResponse.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(attachmentResponse.headers.get("content-security-policy")).toBe(
      "sandbox",
    );
    expect((await attachmentResponse.arrayBuffer()).byteLength).toBeGreaterThan(
      0,
    );

    const unauthenticatedHeaders: HeadersInit[] = [
      new Headers(),
      new Headers({ authorization: "Bearer invalid-token" }),
    ];
    for (const request of [
      { method: "POST", path: agentPath },
      { method: "GET", path: agentPath },
      { method: "HEAD", path: agentPath },
      { method: "POST", path: `${agentPath}/abort` },
      { method: "GET", path: `${agentPath}/attachments/not-present` },
      { method: "PATCH", path: agentPath },
    ]) {
      for (const headers of unauthenticatedHeaders) {
        const response = await fixtureRequest(request.path, {
          method: request.method,
          headers,
        });
        expect(response.status, `${request.method} ${request.path}`).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      }
    }

    const head = await fixtureRequest(agentPath, {
      method: "HEAD",
      headers: authorization,
    });
    expect(head.status).toBe(200);
    const unsupported = await fixtureRequest(agentPath, {
      method: "PATCH",
      headers: authorization,
    });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBeTruthy();
    expect(await unsupported.json()).toMatchObject({
      error: { type: "method_not_allowed" },
    });
    const missingAttachment = await fixtureRequest(
      `${agentPath}/attachments/not-present`,
      { headers: authorization },
    );
    expect(missingAttachment.status).toBe(404);

    const crossOwner = await (
      await fixtureRequest("/__fixture/seed-cross-owner", { method: "POST" })
    ).json<{ threadId: string }>();
    for (const threadId of [
      "thr_00000000-0000-4000-8000-000000000099",
      crossOwner.threadId,
    ]) {
      const response = await fixtureRequest(`/v1/agents/dx/${threadId}`, {
        headers: authorization,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        status: "error",
        data: { code: "THREAD_NOT_FOUND" },
      });
    }

    const state = await (
      await fixtureRequest(`/__fixture/state/${evidence.threadId}`)
    ).json<{
      initialThreadRow: {
        created_at: string;
        updated_at: string;
        last_activity_at: string;
        activity_status: string;
      };
      currentThreadRow: {
        created_at: string;
        updated_at: string;
        last_activity_at: string;
        activity_status: string;
      };
      activities: Array<{ kind: string; occurred_at: string }>;
      submissionStates: string[];
      tables: string[];
    }>();
    expect(state.initialThreadRow).toBeDefined();
    // The successful creation response is returned only after the server has
    // durably admitted the initial prompt, so its activity is already working.
    expect(state.initialThreadRow.activity_status).toBe("working");
    expect(state.initialThreadRow.last_activity_at).not.toBe(
      state.initialThreadRow.created_at,
    );
    expect(state.currentThreadRow.updated_at).toBe(
      state.initialThreadRow.updated_at,
    );
    expect(state.currentThreadRow.last_activity_at).not.toBe(
      state.initialThreadRow.last_activity_at,
    );
    expect(state.currentThreadRow.activity_status).toBe("idle");
    expect(state.activities.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["created", "submitted", "settled"]),
    );
    expect(new Set(state.submissionStates)).toEqual(new Set(["settled"]));
    const applicationTables = state.tables.filter(
      (name) => name !== "d1_migrations" && name !== "_cf_METADATA",
    );
    expect(applicationTables).toEqual(
      expect.arrayContaining(["projects", "threads", "user", "apikey"]),
    );
    expect(applicationTables.join(" ")).not.toMatch(
      /conversation|message|offset|provider/i,
    );
  });

  it("delivers initial and follow-up images through Flue", async () => {
    const projectResponse = await fixtureRequest("/v1/projects", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "retry-admission-lifecycle" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json<{ data: { id: string } }>();
    const threadId = newThreadId();
    const prompt = "Preserve this prompt through an admission retry.";
    const attachment = {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    };
    const body = JSON.stringify({
      projectId: project.data.id,
      title: "Initial admission retry",
      threadId,
      initialMessage: {
        body: prompt,
        attachments: [{ ...attachment, filename: "initial.png" }],
      },
    });

    expect(
      (
        await fixtureRequest("/__fixture/reject-next-initial-admission", {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    const rejected = await fixtureRequest("/v1/threads", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body,
    });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      data: { code: "INITIAL_ADMISSION_UNAVAILABLE" },
    });

    const retried = await fixtureRequest("/v1/threads", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body,
    });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ data: { id: threadId } });

    const client = createFlueClient({
      url: new URL(`/v1/agents/dx/${threadId}`, BASE_URL).toString(),
      fetch: fetchFixture,
      headers: authorization,
    });
    const history = await client.history();
    const initialMessages = history.messages.filter(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" &&
            parseMessageAuthor(part.text).text === prompt,
        ),
    );
    expect(initialMessages).toHaveLength(1);
    const initialMessage = initialMessages[0];
    expect(initialMessage?.parts).toContainEqual(
      expect.objectContaining({ type: "file", filename: "initial.png" }),
    );

    const followUp = "Continue using this image.";
    const continuation = await client.send({
      message: {
        kind: "user",
        body: followUp,
        attachments: [{ ...attachment, filename: "follow-up.png" }],
      },
      idempotencyKey: "follow-up-image",
    });
    await client.wait(continuation);
    const continuedHistory = await client.history();
    const followUpMessage = continuedHistory.messages.find(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" &&
            parseMessageAuthor(part.text).text === followUp,
        ),
    );
    expect(followUpMessage?.parts).toContainEqual(
      expect.objectContaining({ type: "file", filename: "follow-up.png" }),
    );

    const state = await (
      await fixtureRequest(`/__fixture/state/${threadId}`)
    ).json<{
      matchingThreadCount: number;
      startupPhases: Array<{
        journey: string;
        phase: string;
        submission_id: string;
      }>;
    }>();
    expect(state.matchingThreadCount).toBe(1);
    expect(state.startupPhases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          journey: "submission",
          phase: "submission_accepted",
          submission_id: expect.stringMatching(/^sub_/),
        }),
      ]),
    );
  });

  it("keeps a follow-up whose workspace activation fails, and Retry answers it once", async () => {
    const projectResponse = await fixtureRequest("/v1/projects", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "activation-lifecycle" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json<{ data: { id: string } }>();
    const threadId = newThreadId();
    const created = await fixtureRequest("/v1/threads", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.data.id,
        title: "Activation failure",
        threadId,
        initialMessage: {
          body: "Start the activation journey.",
          attachments: [],
        },
      }),
    });
    expect(created.status).toBe(201);
    const client = createFlueClient({
      url: new URL(`/v1/agents/dx/${threadId}`, BASE_URL).toString(),
      fetch: fetchFixture,
      headers: authorization,
    });
    // The follow-up must claim an idle Thread, not join the first turn.
    for (let attempt = 0; ; attempt += 1) {
      if ((await client.history()).settlements.length > 0) break;
      if (attempt === 100) throw new Error("The first turn never settled.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const followUp = "Keep this follow-up when activation fails.";
    const userTexts = async () =>
      (await client.history()).messages.flatMap((message) =>
        message.role === "user"
          ? message.parts.flatMap((part) =>
              part.type === "text" ? [parseMessageAuthor(part.text).text] : [],
            )
          : [],
      );
    expect(
      (
        await fixtureRequest(`/__fixture/fail-next-activation/${threadId}`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    const failed = await client.send({
      message: { kind: "user", body: followUp },
      idempotencyKey: "activation-failure-follow-up",
    });
    await expect(client.wait(failed)).rejects.toThrow();
    // Before the fix the message vanished here, and Retry re-ran the first turn.
    expect(await userTexts()).toEqual([
      "Start the activation journey.",
      followUp,
    ]);

    const retry = { idempotencyKey: "activation-failure-retry" };
    const resumed = await client.resume(retry);
    // A lost acknowledgement resends the same key and admits nothing new.
    expect((await client.resume(retry)).submissionId).toBe(
      resumed.submissionId,
    );
    await client.wait(resumed);
    const history = await client.history();
    expect(await userTexts()).toEqual([
      "Start the activation journey.",
      followUp,
    ]);
    const answers = history.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.parts.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          )
        : [],
    );
    expect(answers).toEqual([
      "activation-first-complete",
      "activation-resume-complete",
    ]);
  });

  // Byte budget for opening a long, tool-heavy Thread (src/heavy-history.ts):
  // 40 turns, two 50 KB tool outputs each, and eight outputs of 240 KB to
  // 2 MB. Measures raw JSON bodies only: not compressed size, not browser
  // memory or parse time (test/history-first-paint-proof.mjs in apps/web).
  it("keeps the first history page of a tool-heavy Thread within its byte budget", async () => {
    const projectResponse = await fixtureRequest("/v1/projects", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "heavy-history" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json<{ data: { id: string } }>();
    const queueTurn = async (turn: number) =>
      expect(
        (
          await fixtureRequest(`/__fixture/heavy-turn/${turn}`, {
            method: "POST",
          })
        ).status,
      ).toBe(204);
    const threadId = newThreadId();
    await queueTurn(0);
    const created = await fixtureRequest("/v1/threads", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.data.id,
        title: "Heavy history",
        threadId,
        initialMessage: { body: "Heavy turn 0", attachments: [] },
      }),
    });
    expect(created.status).toBe(201);
    const agentPath = `/v1/agents/dx/${threadId}`;
    const client = createFlueClient({
      url: new URL(agentPath, BASE_URL).toString(),
      fetch: fetchFixture,
      headers: authorization,
    });
    for (let attempt = 0; ; attempt += 1) {
      if ((await client.history({ promptLimit: 1 })).settlements.length > 0)
        break;
      if (attempt === 200) throw new Error("The first turn never settled.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let turn = 1; turn < HEAVY_TURNS; turn += 1) {
      await queueTurn(turn);
      const sent = await client.send({
        message: { kind: "user", body: `Heavy turn ${turn}` },
        idempotencyKey: `heavy-turn-${turn}`,
      });
      await client.wait(sent);
    }

    const read = async (query: string) => {
      const response = await fixtureRequest(`${agentPath}?${query}`, {
        headers: authorization,
      });
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    };
    const prompts = (page: Buffer) =>
      (
        JSON.parse(page.toString()) as {
          messages: Array<{
            role: string;
            parts: Array<{ type: string; text?: string }>;
          }>;
        }
      ).messages.flatMap((message) =>
        message.role === "user"
          ? message.parts.flatMap((part) =>
              part.type === "text" && part.text !== undefined
                ? [parseMessageAuthor(part.text).text]
                : [],
            )
          : [],
      );
    // Every page from the newest, following `before` cursors.
    const walk = async (query: string) => {
      const pages: Buffer[] = [];
      let before = "";
      for (;;) {
        const page = await read(`${query}${before}`);
        pages.push(page);
        const cursor = (
          JSON.parse(page.toString()) as { olderCursor: string | null }
        ).olderCursor;
        if (cursor === null) return pages;
        before = `&before=${encodeURIComponent(cursor)}`;
      }
    };
    const all = Array.from(
      { length: HEAVY_TURNS },
      (_, turn) => `Heavy turn ${turn}`,
    );
    const unbounded = await walk("view=history&promptLimit=2");
    // The web client's page: two prompts within 1 MiB (THREAD_HISTORY_PAGE).
    const bounded = await walk(
      `view=history&promptLimit=2&maxBytes=${HISTORY_PAGE_BYTES}`,
    );
    for (const pages of [unbounded, bounded])
      expect(pages.toReversed().flatMap(prompts)).toEqual(all);
    for (const page of bounded)
      expect(
        page.byteLength <= HISTORY_PAGE_BYTES || prompts(page).length === 1,
      ).toBe(true);
    const first = unbounded[0]!.byteLength;
    const firstBounded = bounded[0]!.byteLength;
    const artifacts = process.env.DX_HISTORY_BUDGET_ARTIFACTS;
    if (artifacts !== undefined)
      for (const [name, pages] of [
        ["unbounded", unbounded],
        ["bounded", bounded],
      ] as const) {
        mkdirSync(path.join(artifacts, name), { recursive: true });
        for (const [index, page] of pages.entries())
          writeFileSync(path.join(artifacts, name, `page-${index}.json`), page);
      }

    // Pinned: the two-prompt page before the byte budget. Only each tool
    // part's `durationMs` varies between runs, by a digit or two.
    expect(Math.abs(first - UNBOUNDED_FIRST_PAGE_BYTES)).toBeLessThanOrEqual(
      64,
    );
    // The newest two turns exceed the budget, so the page holds the newest
    // turn alone and whole, with its 900 KB tool output.
    expect(prompts(bounded[0]!)).toEqual(["Heavy turn 39"]);
    // Ceiling: the newest turn of this Thread, 1.0 MiB today.
    expect(firstBounded).toBeLessThanOrEqual(1.1 * 1024 * 1024);
    // Ratio against the unbounded page (0.38 today).
    expect(firstBounded / first).toBeLessThanOrEqual(0.4);
  }, 600_000);
});
