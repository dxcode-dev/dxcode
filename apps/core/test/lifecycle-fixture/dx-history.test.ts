import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFlueClient } from "@flue/sdk";
import { describe, expect, it } from "vitest";
import { CONTEXT_IMAGE_BYTES } from "../../src/runtime/context-attachments.js";
import { SCREENSHOT_BYTES, screenshot } from "./src/claude-code-history.js";
import type { DxHistoryCall } from "./src/dx-history.js";

/**
 * A dx-mode Thread that viewed many contact sheets ran its Durable Object
 * out of memory on every attempt: each call held every image the Thread
 * had viewed, and a long turn kept each image it read. The model must still
 * get recent images. Each message here asks for a range of screenshots,
 * which its turn reads one call at a time; the model stand-in records which
 * screenshots every call was given.
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

/** One long turn, then two more on top of its history. */
const RANGES = [
  [1, 10],
  [11, 14],
  [15, 18],
] as const;
const ATTACHED_BYTES = "\x89PNG\r\n\x1a\nattached-by-the-owner";
const ATTACHED = btoa(ATTACHED_BYTES);

describe("a dx-mode Thread that views many screenshots", () => {
  it("gives every call the newest screenshots within its budget, and the transcript still serves every screenshot", async () => {
    const project = await fixtureRequest(
      "/v1/projects",
      json({ name: "dx-history-lifecycle" }),
    );
    expect(project.status).toBe(201);
    const projectId = (await project.json<{ data: { id: string } }>()).data.id;
    const created = await fixtureRequest(
      "/v1/threads",
      json({ projectId, title: "Social video studio 2" }),
    );
    expect(created.status).toBe(201);
    const threadId = (await created.json<{ data: { id: string } }>()).data.id;
    const agentUrl = new URL(`/v1/agents/dx-history/${threadId}`, BASE_URL);
    const client = createFlueClient({
      url: agentUrl.toString(),
      fetch: fetch.bind(globalThis),
      headers: authorization,
    });

    for (const [from, to] of RANGES)
      await client.wait(
        await client.send({
          message: { kind: "user", body: `Read screenshots ${from} to ${to}` },
          idempotencyKey: `dx-history-${from}`,
        }),
      );
    await client.wait(
      await client.send({
        message: {
          kind: "user",
          body: "look at this one",
          attachments: [
            { type: "image", mimeType: "image/png", data: ATTACHED },
          ],
        },
        idempotencyKey: "dx-history-attached",
      }),
    );

    const calls = await (
      await fixtureRequest("/__fixture/dx-history-calls")
    ).json<DxHistoryCall[]>();
    // Each turn reads its screenshots, then answers; the last turn answers.
    expect(calls).toHaveLength(
      RANGES.reduce((sum, [from, to]) => sum + to - from + 2, 0) + 1,
    );
    const directory = process.env.DX_DX_HISTORY_ARTIFACTS;
    if (directory !== undefined) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "model-calls.json"),
        `${JSON.stringify(
          {
            screenshotBytes: SCREENSHOT_BYTES,
            budgetBytes: CONTEXT_IMAGE_BYTES,
            historyBytes: 18 * SCREENSHOT_BYTES,
            largestCallImageBytes: Math.max(
              ...calls.map((call) => call.imageBytes),
            ),
            calls,
          },
          null,
          2,
        )}\n`,
      );
    }

    // No call holds more image bytes than the budget, though the Thread
    // viewed 27 MB, 15 MB of it in its first turn alone.
    for (const call of calls)
      expect(call.imageBytes).toBeLessThanOrEqual(
        CONTEXT_IMAGE_BYTES + ATTACHED_BYTES.length,
      );
    // Each call holds the newest screenshots it has read, in order, without
    // a gap, and at least the last three of them.
    let read = 0;
    for (const call of calls) {
      const newest = call.screenshots.at(-1) ?? 0;
      expect(newest).toBe(read);
      expect(call.screenshots).toEqual(
        Array.from(
          { length: call.screenshots.length },
          (_, index) => newest - call.screenshots.length + 1 + index,
        ),
      );
      expect(call.screenshots.length).toBeGreaterThanOrEqual(Math.min(read, 3));
      const range = /screenshots (\d+) to (\d+)/.exec(call.lastUser);
      if (range !== null && read < Number(range[2]))
        read = Math.max(read + 1, Number(range[1]));
    }
    // The owner's image reaches the model with the newest screenshots.
    expect(calls.at(-1)).toMatchObject({
      otherImages: 1,
      lastUser: expect.stringContaining("look at this one"),
    });
    expect(calls.at(-1)?.screenshots.at(-1)).toBe(18);

    // The transcript shows each screenshot from the agent's attachment
    // route, which still serves the first one byte for byte.
    const history = await client.history();
    const shown = [
      ...JSON.stringify(history.messages).matchAll(
        /\{"type":"image","data":"(att_[^"]+)"/g,
      ),
    ].map(([, id]) => id ?? "");
    expect(shown.length).toBeGreaterThanOrEqual(18);
    const first = await fixtureRequest(
      `${agentUrl.pathname}/attachments/${encodeURIComponent(shown[0] ?? "")}`,
      { headers: authorization },
    );
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(screenshot(1));
  }, 240_000);
});
