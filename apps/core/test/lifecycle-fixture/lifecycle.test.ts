import { createFlueClient } from "@flue/sdk";
import { newThreadId, ProjectNameInput } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runReferenceLifecycle } from "../../src/dev/reference-lifecycle/workflow.js";
import { ORPHAN_RESULT } from "./src/sandbox.js";

const fixtureUrl = process.env.DX_LIFECYCLE_FIXTURE_URL;
if (fixtureUrl === undefined)
  throw new Error("Lifecycle fixture URL is missing.");
const BASE_URL = new URL(fixtureUrl);
const TOKEN = "dxu_fixture-token-0000000000000000000";
const authorization = { authorization: `Bearer ${TOKEN}` };
const PERSONAL_INSTRUCTION = "PRIVATE-LIFECYCLE-PERSONAL-INSTRUCTION";
const fetchFixture: typeof fetch = fetch.bind(globalThis);

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
          (part) => part.type === "text" && part.text === prompt,
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
          (part) => part.type === "text" && part.text === followUp,
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
});
