import { DateTime, Effect, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PersistenceUnavailable } from "../persistence/errors.js";
import { ProjectId } from "../projects/project-id.js";
import { ThreadId } from "../threads/thread-id.js";
import {
  decodeProjectPageCursor,
  decodeThreadPageCursor,
  encodeProjectPageCursor,
  encodeThreadPageCursor,
  MAX_PAGE_CURSOR_LENGTH,
} from "./cursor.js";
import { PageRequest } from "./page.js";

const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);
const createdAt = DateTime.makeUnsafe("2026-08-20T12:00:00.000Z");

describe("cursor pagination", () => {
  it("round-trips a versioned feature-specific cursor", async () => {
    const cursor = await Effect.runPromise(
      encodeProjectPageCursor({ createdAt, id: projectId }),
    );
    const decoded = await Effect.runPromise(decodeProjectPageCursor(cursor));

    expect(decoded.id).toBe(projectId);
    expect(DateTime.formatIso(decoded.createdAt)).toBe(
      DateTime.formatIso(createdAt),
    );
  });

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

    const deployed = Encoding.encodeBase64Url(
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
      Encoding.encodeBase64Url(
        JSON.stringify({
          v: 2,
          createdAt: "2026-08-20T12:00:00.000Z",
          id: projectId,
        }),
      ),
      Encoding.encodeBase64Url(
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

  it("bounds page sizes", () => {
    expect(() => Schema.decodeUnknownSync(PageRequest)({ limit: 0 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PageRequest)({ limit: 101 }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(PageRequest)({ limit: 100 }).limit).toBe(
      100,
    );
  });

  it("keeps infrastructure causes out of encoded errors", () => {
    const error = PersistenceUnavailable.new(
      { operation: "project.insert" },
      new Error("secret SQL and bound value", { cause: "driver stack" }),
    );
    const encoded = Schema.encodeSync(PersistenceUnavailable)(error);

    expect(encoded).toEqual({
      _tag: "PersistenceUnavailable",
      operation: "project.insert",
    });
    expect(JSON.stringify(encoded)).not.toContain("secret SQL");
    expect(error.cause).toBeInstanceOf(Error);
  });
});
