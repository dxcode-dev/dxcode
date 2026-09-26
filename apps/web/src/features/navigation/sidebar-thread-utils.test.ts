import type { ProjectData, ThreadData } from "@dx/api";
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import { buildThreadSections } from "./sidebar-thread-utils.js";

const now = Date.parse("2026-09-08T12:00:00Z");
const projects = [
  { id: "older", name: "Older project" },
  { id: "newer", name: "Newer project" },
] as unknown as ReadonlyArray<ProjectData>;
const thread = (id: string, projectId: string, hours: number, extra = {}) =>
  ({
    id,
    projectId,
    lastActivityAt: DateTime.makeUnsafe(now - hours * 3_600_000),
    activityStatus: "idle",
    lifecycleState: "active",
    ...extra,
  }) as ThreadData;

describe("fixed sidebar sections", () => {
  it("orders pinned first and projects by their newest thread, with recent threads first", () => {
    const input = [
      thread("older-row", "older", 24),
      thread("newer-second", "newer", 8),
      thread("pinned", "older", 100, { pinnedAt: DateTime.makeUnsafe(now) }),
      thread("newer-first", "newer", 1),
    ];
    const sections = buildThreadSections(projects, input, now);
    expect(sections.map((section) => section.id)).toEqual([
      "pinned",
      "newer",
      "older",
    ]);
    expect(sections[1]?.threads.map((item) => item.id)).toEqual([
      "newer-first",
      "newer-second",
    ]);
    expect(input[0]?.id).toBe("older-row");
    expect(sections[0]?.label).toBeUndefined();
  });

  it("orders pinned threads by pin time before activity", () => {
    const sections = buildThreadSections(
      projects,
      [
        thread("newer-activity", "older", 1, {
          pinnedAt: DateTime.makeUnsafe(now - 2 * 3_600_000),
        }),
        thread("newer-pin", "newer", 12, {
          pinnedAt: DateTime.makeUnsafe(now - 3_600_000),
        }),
      ],
      now,
    );

    expect(sections[0]?.threads.map((item) => item.id)).toEqual([
      "newer-pin",
      "newer-activity",
    ]);
  });

  it("uses the 72-hour boundary, keeps working threads visible, and archives even pinned threads", () => {
    const sections = buildThreadSections(
      projects,
      [
        thread("recent", "newer", 71.99),
        thread("boundary", "older", 72),
        thread("old", "older", 200),
        thread("working", "older", 100, { activityStatus: "working" }),
        thread("archived", "older", 1, {
          lifecycleState: "archived",
          pinnedAt: DateTime.makeUnsafe(now),
        }),
        thread("deleted", "older", 0, { lifecycleState: "deleted" }),
      ],
      now,
    );
    expect(
      sections.map((section) => [
        section.id,
        section.threads.map((item) => item.id),
      ]),
    ).toEqual([
      ["newer", ["recent"]],
      ["older", ["working"]],
      ["inactive", ["boundary", "old"]],
      ["archived", ["archived"]],
    ]);
  });

  it("keeps unknown projects distinct and breaks activity ties by thread id", () => {
    const sections = buildThreadSections(
      [],
      [thread("a", "unknown-a", 1), thread("z", "unknown-b", 1)],
      now,
    );
    expect(sections.slice(0, 2).map((section) => section.id)).toEqual([
      "unknown-b",
      "unknown-a",
    ]);
    expect(sections[0]?.label).toBe("Project");
  });

  it("omits empty categories but keeps a separately available archive reachable", () => {
    expect(buildThreadSections([], [], now)).toEqual([]);
    expect(buildThreadSections([], [], now, true)).toEqual([
      { id: "archived", label: "Archived", threads: [] },
    ]);
  });
});
