// Sign-out ends the huddle (#2626). The call lives outside React and its
// RealtimeKit token doesn't depend on the dx session, so ways it could fail:
// - the joined meeting is never left, so the mic keeps publishing as the
//   person who signed out;
// - a meeting prepared behind the pre-join dialog stays open;
// - the dock's place survives, so the next account sees the old Thread's
//   huddle;
// - pictures fetched for the old account show on the next account's call.

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Handler = (...args: never[]) => void;
const emitter = () => ({
  on: (_event: string, _handler: Handler) => undefined,
  off: (_event: string, _handler: Handler) => undefined,
});

const meetings: Array<{ left: boolean; userId: string }> = [];

const fakeMeeting = () => {
  const record = { left: false, userId: "usr_a" };
  meetings.push(record);
  const joined = { ...emitter(), toArray: () => [] };
  return {
    self: {
      ...emitter(),
      id: `peer-${record.userId}`,
      peerId: `peer-${record.userId}`,
      customParticipantId: record.userId,
      name: record.userId,
      audioEnabled: false,
      videoEnabled: false,
      screenShareEnabled: false,
      enableAudio: async () => undefined,
    },
    participants: { ...emitter(), joined, lastActiveSpeaker: undefined },
    meta: emitter(),
    join: async () => undefined,
    leave: async () => {
      record.left = true;
    },
  };
};

vi.mock("@cloudflare/realtimekit", () => ({
  default: { init: async () => fakeMeeting() },
}));
vi.mock("./huddle-join-mutations.js", () => ({
  postHuddleJoin: async () => ({ authToken: "token" }),
}));
vi.mock("./huddle-summary-queries.js", () => ({
  getHuddleSummary: async () => ({
    active: true,
    participants: [
      { userId: "usr_a", name: "A", avatarUrl: "https://dx.test/a.png" },
    ],
  }),
}));

const { endHuddleOnSignOut, huddleClient, joinHuddle, useHuddleView } =
  await import("./huddle-session.js");

// What the dock shows as the huddle's place.
const shownPlace = () => document.querySelector("[data-place]")?.textContent;
function PlaceReader() {
  return <p data-place>{useHuddleView().place?.name ?? ""}</p>;
}
const root = createRoot(
  document.body.appendChild(document.createElement("div")),
);
await React.act(() => root.render(<PlaceReader />));

const threadA = {
  scope: { kind: "thread", threadId: "thr_a" },
  name: "A's Thread",
  threadId: "thr_a",
} as const;

afterEach(async () => {
  await React.act(() => endHuddleOnSignOut());
  meetings.length = 0;
});

it("leaves the call and forgets the place when the person signs out", async () => {
  await huddleClient.fetchSummary(threadA.scope);
  await React.act(() => joinHuddle(threadA, { audio: true, video: false }));
  expect(huddleClient.getSnapshot().status).toBe("connected");
  expect(shownPlace()).toBe("A's Thread");
  expect(huddleClient.getSnapshot().participants[0]?.avatarUrl).toBe(
    "https://dx.test/a.png",
  );

  await React.act(() => endHuddleOnSignOut());

  expect(meetings.map((meeting) => meeting.left)).toEqual([true]);
  expect(shownPlace()).toBe("");
  expect(huddleClient.getSnapshot().status).toBe("idle");
});

it("releases a meeting prepared behind the pre-join dialog", async () => {
  huddleClient.prepare(threadA.scope);
  await vi.waitFor(() => expect(meetings).toHaveLength(1));

  await endHuddleOnSignOut();

  await vi.waitFor(() =>
    expect(meetings.map((meeting) => meeting.left)).toEqual([true]),
  );
});

it("shows the old account's pictures to nobody after sign-out", async () => {
  await huddleClient.fetchSummary(threadA.scope);
  await endHuddleOnSignOut();

  // The next account's call reports the same participant id the old
  // summary pictured: no picture carries over.
  await React.act(() => joinHuddle(threadA, { audio: false, video: false }));
  expect(huddleClient.getSnapshot().status).toBe("connected");
  expect(huddleClient.getSnapshot().participants[0]?.avatarUrl).toBeUndefined();
});
