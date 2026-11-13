import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFlueClient } from "@flue/sdk";
import { describe, expect, it } from "vitest";
import {
  type ClaudeCodeCall,
  SCREENSHOT_BYTES,
  screenshot,
} from "./src/claude-code-history.js";

/**
 * A Claude Code Thread whose history filled with screenshots ran its
 * Durable Object out of memory on every turn: each context rebuild loaded
 * every image of the Thread, though Claude Code is only ever sent the new
 * input. Each turn here reads one screenshot; the model stand-in records
 * the image bytes every call was given.
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

const TURNS = 12;
/** Base64 characters of one screenshot. */
const SCREENSHOT_CHARS = Math.ceil(SCREENSHOT_BYTES / 3) * 4;
const ATTACHED = btoa("\x89PNG\r\n\x1a\nattached-by-the-owner");

describe("a Claude Code Thread whose history holds many screenshots", () => {
  it("loads only the new input's images, and the transcript still serves every screenshot", async () => {
    const project = await fixtureRequest(
      "/v1/projects",
      json({ name: "claude-code-history-lifecycle" }),
    );
    expect(project.status).toBe(201);
    const projectId = (await project.json<{ data: { id: string } }>()).data.id;
    const created = await fixtureRequest(
      "/v1/threads",
      json({ projectId, title: "Social video studio" }),
    );
    expect(created.status).toBe(201);
    const threadId = (await created.json<{ data: { id: string } }>()).data.id;
    const agentUrl = new URL(`/v1/agents/claude-code/${threadId}`, BASE_URL);
    const client = createFlueClient({
      url: agentUrl.toString(),
      fetch: fetch.bind(globalThis),
      headers: authorization,
    });

    for (let turn = 1; turn <= TURNS; turn += 1)
      await client.wait(
        await client.send({
          message: {
            kind: "user",
            body: `Read the screenshot of turn ${turn}`,
          },
          idempotencyKey: `claude-code-history-${turn}`,
        }),
      );
    // The owner's next message carries an image of its own.
    await client.wait(
      await client.send({
        message: {
          kind: "user",
          body: "look at this one",
          attachments: [
            { type: "image", mimeType: "image/png", data: ATTACHED },
          ],
        },
        idempotencyKey: "claude-code-history-attached",
      }),
    );

    const calls = await (
      await fixtureRequest("/__fixture/claude-code-calls")
    ).json<ClaudeCodeCall[]>();
    // Two calls a turn (read, then answer), and one for the attached image.
    expect(calls).toHaveLength(TURNS * 2 + 1);
    const proof = {
      turns: TURNS,
      screenshotBytes: SCREENSHOT_BYTES,
      historyImageChars: TURNS * SCREENSHOT_CHARS,
      largestCallImageChars: Math.max(...calls.map((call) => call.imageChars)),
      calls,
    };
    const directory = process.env.DX_CLAUDE_CODE_HISTORY_ARTIFACTS;
    if (directory !== undefined) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "model-calls.json"),
        `${JSON.stringify(proof, null, 2)}\n`,
      );
    }
    // No call holds more than the screenshot its own turn just read, though
    // the history holds twelve.
    for (const call of calls)
      expect(call.imageChars).toBeLessThanOrEqual(SCREENSHOT_CHARS);
    // The attached image reaches the model; every screenshot before it is
    // left in storage as "[image]".
    expect(calls.at(-1)).toMatchObject({
      images: 1,
      imageChars: ATTACHED.length,
      omitted: TURNS,
      lastUser: expect.stringContaining("look at this one"),
    });

    // The transcript shows a tool's image from the agent's attachment route,
    // by the id its recorded result holds in place of the bytes; the route
    // still serves the first screenshot byte for byte.
    const history = await client.history();
    const shown = [
      ...JSON.stringify(history.messages).matchAll(
        /\{"type":"image","data":"(att_[^"]+)"/g,
      ),
    ].map(([, id]) => id ?? "");
    expect(shown.length).toBeGreaterThanOrEqual(TURNS);
    const first = await fixtureRequest(
      `${agentUrl.pathname}/attachments/${encodeURIComponent(shown[0] ?? "")}`,
      { headers: authorization },
    );
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(screenshot(1));
  }, 180_000);
});
