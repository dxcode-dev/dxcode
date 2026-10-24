import { env } from "cloudflare:test";
import type { CreateThreadResponse } from "@dx/api";
import type { FlueObservation } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
} from "./product-route-fixture.js";

interface Row {
  readonly id: string;
  readonly title: string;
  readonly activityStatus: string;
  readonly childCount?: number;
  readonly unread?: true;
  readonly turnFailed?: true;
  readonly childActivity?: {
    readonly working: number;
    readonly unread: number;
    readonly failed: number;
  };
}

const observe = (value: Record<string, unknown>) =>
  recordFlueThreadActivity(
    value as unknown as FlueObservation,
    {
      id: "fixture",
      agentName: "dx",
      env: { DB: env.DB },
    } as never,
  );

// Turns finish in the past, before any open the routes stamp with now.
let clock = Date.UTC(2026, 0, 5, 12, 0, 0);
const tick = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

const start = (threadId: string, submissionId: string) =>
  observe({
    type: "submission_running",
    instanceId: threadId,
    submissionId,
    timestamp: tick(),
  });

const settle = (
  threadId: string,
  submissionId: string,
  outcome: "completed" | "failed" | "aborted",
  timestamp = tick(),
) =>
  observe({
    type: "submission_settled",
    instanceId: threadId,
    submissionId,
    outcome,
    timestamp,
  });

const createChild = async (projectId: string, parentThreadId: string) =>
  (
    await createProductApp().request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ projectId, title: "Child", parentThreadId }),
      },
      bindings,
    )
  ).json<CreateThreadResponse>();

const roots = async () => {
  const response = await createProductApp().request(
    "/threads?lifecycleState=active&roots=true",
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: { items: Row[]; children?: Row[] } }>())
    .data;
};

const listItem = async (threadId: string) => {
  const response = await createProductApp().request(
    `/threads/${threadId}/list-item`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: Row }>()).data;
};

const markSeen = (threadId: string, principal?: typeof otherPrincipal) =>
  createProductApp(principal).request(
    `/threads/${threadId}/seen`,
    { method: "POST" },
    bindings,
  );

/** The sidebar as a person reads it: what each row would draw. */
const sidebar = (data: { items: Row[]; children?: Row[] }, names: Names) =>
  data.items
    .filter(({ id }) => names.has(id))
    .flatMap((root) => [
      draw(root, names),
      ...(data.children ?? [])
        .filter(
          (child) =>
            (child as { parentThreadId?: string }).parentThreadId === root.id,
        )
        .map((child) => `  ↳ ${draw(child, names)}`),
    ]);

type Names = ReadonlyMap<string, string>;

const draw = (row: Row, names: Names) => {
  const activity = row.childActivity;
  const count =
    row.childCount === undefined
      ? ""
      : ` [${(activity?.working ?? 0) > 0 ? `${activity?.working}/` : ""}${row.childCount}${(activity?.failed ?? 0) > 0 ? " red" : ""}${(activity?.unread ?? 0) > 0 ? " •" : ""}]`;
  return `${row.activityStatus === "working" ? "◌" : "○"}${row.unread ? "•" : ""} ${names.get(row.id)}${row.turnFailed ? " (Error)" : ""}${count}`;
};

describe("Thread attention: unread, failed, and child activity", () => {
  it("marks finished turns unread until opened, failed turns until the next starts, and counts them on the parent", async () => {
    const project = await createProjectViaApi("attention");
    const parent = (await createThreadViaApi(project.data.id)).data.id;
    const children = [
      (await createChild(project.data.id, parent)).data.id,
      (await createChild(project.data.id, parent)).data.id,
      (await createChild(project.data.id, parent)).data.id,
    ];
    const [one, two, three] = children as [string, string, string];
    const names: Names = new Map([
      [parent, "parent"],
      [one, "one"],
      [two, "two"],
      [three, "three"],
    ]);
    const steps: Array<{ step: string; sidebar: string[] }> = [];
    const snapshot = async (step: string) => {
      const data = await roots();
      steps.push({ step, sidebar: sidebar(data, names) });
      // The one-row read a realtime hint triggers agrees with the list.
      const row = await listItem(parent);
      const listed = data.items.find(({ id }) => id === parent);
      expect({
        unread: row.unread,
        turnFailed: row.turnFailed,
        childCount: row.childCount,
        childActivity: row.childActivity,
      }).toEqual({
        unread: listed?.unread,
        turnFailed: listed?.turnFailed,
        childCount: listed?.childCount,
        childActivity: listed?.childActivity,
      });
      return data;
    };

    // Nothing has finished: nothing is unread, and an idle family shows
    // only its count.
    let data = await snapshot("three idle children");
    expect(data.items.find(({ id }) => id === parent)).not.toHaveProperty(
      "childActivity",
    );

    // Two children work: 2/3.
    await start(one, "one-1");
    await start(two, "two-1");
    data = await snapshot("two children working");
    expect(data.items.find(({ id }) => id === parent)?.childActivity).toEqual({
      working: 2,
      unread: 0,
      failed: 0,
    });

    // One finishes, one fails; neither was open, so both are unread.
    const oneFinished = tick();
    await settle(one, "one-1", "completed", oneFinished);
    await settle(two, "two-1", "failed");
    data = await snapshot("one finished, one failed");
    const childRow = (id: string) =>
      data.children?.find((child) => child.id === id);
    expect(childRow(one)).toMatchObject({ unread: true });
    expect(childRow(one)).not.toHaveProperty("turnFailed");
    expect(childRow(two)).toMatchObject({ unread: true, turnFailed: true });
    expect(data.items.find(({ id }) => id === parent)?.childActivity).toEqual({
      working: 0,
      unread: 2,
      failed: 1,
    });
    expect(await listItem(two)).toMatchObject({
      unread: true,
      turnFailed: true,
    });

    // Opening a child sees it; the parent counts one unread child fewer.
    expect((await markSeen(one)).status).toBe(200);
    data = await snapshot("opened one");
    expect(childRow(one)).not.toHaveProperty("unread");
    expect(data.items.find(({ id }) => id === parent)?.childActivity).toEqual({
      working: 0,
      unread: 1,
      failed: 1,
    });

    // A replayed settlement from before the open does not make it unread
    // again.
    await settle(one, "one-1", "completed", oneFinished);
    expect(await listItem(one)).not.toHaveProperty("unread");

    // A retry clears the failure as it starts; the earlier finish stays
    // unread until opened.
    await start(two, "two-2");
    data = await snapshot("retrying two");
    expect(childRow(two)).toMatchObject({
      unread: true,
      activityStatus: "working",
    });
    expect(childRow(two)).not.toHaveProperty("turnFailed");

    // A turn someone aborted was watched: it neither fails nor turns unread.
    await start(three, "three-1");
    await settle(three, "three-1", "aborted");
    data = await snapshot("three aborted");
    expect(childRow(three)).not.toHaveProperty("unread");
    expect(childRow(three)).not.toHaveProperty("turnFailed");

    // The parent itself finishes and fails while the owner is away.
    await start(parent, "parent-1");
    await settle(parent, "parent-1", "failed");
    data = await snapshot("parent failed");
    expect(data.items.find(({ id }) => id === parent)).toMatchObject({
      unread: true,
      turnFailed: true,
    });

    // Another person cannot mark the owner's private Thread seen.
    expect((await markSeen(parent, otherPrincipal)).status).toBe(404);
    expect(await listItem(parent)).toMatchObject({ unread: true });

    // ◌ working, ○ idle, • unread, (Error) failed, [working/total] count.
    await expect(
      steps
        .map(({ step, sidebar: rows }) => `${step}\n${rows.join("\n")}\n`)
        .join("\n"),
    ).toMatchFileSnapshot("../../../../artifacts/thread-attention/sidebar.txt");
  });
});
