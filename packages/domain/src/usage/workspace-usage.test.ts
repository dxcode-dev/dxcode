import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PageCursor } from "../pagination/cursor.js";
import {
  decodeWorkspaceUsageRankingCursor,
  encodeWorkspaceUsageRankingCursor,
  normalizeWorkspacePrivateThreadInspectionReason,
} from "./workspace-usage.js";

describe("workspace usage domain", () => {
  it("binds keyset cursors to one ranking", async () => {
    const cursor = await Effect.runPromise(
      encodeWorkspaceUsageRankingCursor({
        ranking: "projects",
        estimatedCostMicros: 4_200,
        id: "project-42",
      }),
    );
    await expect(
      Effect.runPromise(decodeWorkspaceUsageRankingCursor(cursor, "projects")),
    ).resolves.toEqual({
      ranking: "projects",
      estimatedCostMicros: 4_200,
      id: "project-42",
    });
    await expect(
      Effect.runPromise(decodeWorkspaceUsageRankingCursor(cursor, "users")),
    ).rejects.toMatchObject({ _tag: "InvalidUsageQuery", reason: "cursor" });
    expect(Schema.decodeUnknownSync(PageCursor)(cursor)).toBe(cursor);
  });

  it("requires a nonempty trimmed inspection reason bounded to 500 characters", async () => {
    await expect(
      Effect.runPromise(
        normalizeWorkspacePrivateThreadInspectionReason("  Incident 42  "),
      ),
    ).resolves.toBe("Incident 42");
    await expect(
      Effect.runPromise(normalizeWorkspacePrivateThreadInspectionReason("  ")),
    ).rejects.toMatchObject({
      _tag: "InvalidWorkspacePrivateThreadInspectionReason",
    });
    await expect(
      Effect.runPromise(
        normalizeWorkspacePrivateThreadInspectionReason("x".repeat(501)),
      ),
    ).rejects.toMatchObject({
      _tag: "InvalidWorkspacePrivateThreadInspectionReason",
    });
  });
});
