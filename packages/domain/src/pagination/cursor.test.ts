import { DateTime, Effect, Schema } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../projects/project-id.js";
import { ThreadId } from "../threads/thread-id.js";
import {
  decodeProjectPageCursor,
  decodeThreadPageCursor,
  encodeThreadPageCursor,
  MAX_PAGE_CURSOR_LENGTH,
} from "./cursor.js";

const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);
const createdAt = DateTime.makeUnsafe("2026-08-20T12:00:00.000Z");

describe("cursor pagination", () => {
  it("round-trips current thread cursors and accepts deployed v2 cursors", async () => {
    const current = await Effect.runPromise(
      encodeThreadPageCursor({
        ordering: "pin-snapshot",
        snapshotSequence: 12,
        snapshotPinSequence: 7,
        pinnedAt: undefined,
        lastActivityAt: createdAt,
        id: threadId,
        lifecycleState: "archived",
      }),
    );
    await expect(
      Effect.runPromise(decodeThreadPageCursor(current)),
    ).resolves.toMatchObject({
      ordering: "pin-snapshot",
      snapshotSequence: 12,
      snapshotPinSequence: 7,
      pinnedAt: undefined,
      id: threadId,
      lifecycleState: "archived",
    });

    const deployed = Base64Url.encode(
      JSON.stringify({
        v: 2,
        snapshotSequence: 9,
        lastActivityAt: "2026-08-20T12:00:00.000Z",
        id: threadId,
      }),
    );
    await expect(
      Effect.runPromise(decodeThreadPageCursor(deployed)),
    ).resolves.toMatchObject({
      ordering: "activity",
      snapshotSequence: 9,
      id: threadId,
    });
  });

  it("rejects corruption, oversize values, versions, and wrong feature IDs", async () => {
    const invalid = [
      "not base64!",
      "a".repeat(MAX_PAGE_CURSOR_LENGTH + 1),
      Base64Url.encode(
        JSON.stringify({
          v: 2,
          createdAt: "2026-08-20T12:00:00.000Z",
          id: projectId,
        }),
      ),
      Base64Url.encode(
        JSON.stringify({
          v: 1,
          createdAt: "2026-08-20T12:00:00.000Z",
          id: threadId,
        }),
      ),
    ];

    for (const cursor of invalid) {
      const error = await Effect.runPromise(
        Effect.flip(decodeProjectPageCursor(cursor)),
      );
      expect(error._tag).toBe("InvalidPageCursor");
    }
  });
});
