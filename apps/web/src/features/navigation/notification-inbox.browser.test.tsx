import type { NotificationData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The row links to its Thread; no router runs here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
  }) => (
    <a href="#thread" className={className}>
      {children}
    </a>
  ),
}));

import { notificationKeys } from "../notifications/notifications-queries.js";
import { NotificationInbox } from "./notification-inbox.js";

/**
 * Who a mention came from, as the Mentions inbox shows it. Ways it could go
 * wrong: a mention dx sent, such as an `@handle` in a Space's post, shows a
 * stranger's initials ("S" for Someone) instead of dx; a person's mention
 * loses their initials; dx's Markdown (links, bold, code, mention tokens)
 * shows raw in the row.
 */

const userId = "inbox-user" as UserId;
const threadId = "thr_00000000-0000-4000-8000-0000000000d1" as ThreadId;

const notification = (
  id: string,
  actor: NotificationData["actor"],
  excerpt = "@benm could you review the rounding?",
): NotificationData => ({
  id: `ntf_${id.padEnd(32, "0")}`,
  topic: "mention",
  threadId,
  threadTitle: "Checkout v2",
  ...(actor === undefined ? {} : { actor }),
  excerpt,
  createdAt: new Date().toISOString(),
});

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) React.act(() => root.unmount());
  document.body.innerHTML = "";
});

const open = async (items: ReadonlyArray<NotificationData>) => {
  const client = new QueryClient();
  client.setQueryData(notificationKeys.inbox(userId), {
    items,
    unreadCount: items.length,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NotificationInbox userId={userId} onNavigate={() => undefined} />
      </QueryClientProvider>,
    ),
  );
  const trigger =
    container.querySelector<HTMLButtonElement>('[title="Mentions"]');
  await React.act(async () => trigger?.click());
  return [...document.querySelectorAll<HTMLElement>(".notification-row")];
};

describe("The Mentions inbox", () => {
  it("shows dx as the sender of a mention dx sent", async () => {
    const [row] = await open([
      notification("a1", { kind: "agent", name: "dx" }),
    ]);
    const sender = row?.querySelector('[aria-label="dx"]');
    expect(sender).not.toBeNull();
    expect(sender?.querySelector(".dx-brand-wordmark")).not.toBeNull();
    expect(row?.querySelector(".dx-avatar")?.textContent).not.toBe("S");
  });

  it("shows dx's Markdown as the words people read", async () => {
    const [row] = await open([
      notification(
        "c3",
        { kind: "agent", name: "dx" },
        `@benm **Top-level repo folders** is ready: [the folder list](<https://dx.test/threads/${threadId}>). See \`apps/web\`, and ask @[Ada Owner](user:usr_ada) or @[dx](agent).`,
      ),
    ]);
    const excerpt = row?.querySelector(".notification-excerpt");
    expect(excerpt?.textContent).toBe(
      "@benm Top-level repo folders is ready: the folder list. See apps/web, and ask @Ada Owner or @dx.",
    );
    expect(
      [...(excerpt?.querySelectorAll(".notification-mention") ?? [])].map(
        (mention) => mention.textContent,
      ),
    ).toEqual(["@benm", "@Ada Owner", "@dx"]);
  });

  it("shows a picked person named dx… as one mention, never as @dx", async () => {
    const [tokens, plain] = await open([
      notification(
        "d4",
        { kind: "agent", name: "dx" },
        "@[dx second reviewer](user:usr_second) please check the totals",
      ),
      notification(
        "e5",
        { userId: "inbox-ben" as UserId, name: "Ben Member" },
        "@benm please check the totals",
      ),
    ]);
    const mentions = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll(".notification-mention") ?? [])].map(
        (mention) => mention.textContent,
      );
    expect(tokens?.querySelector(".notification-excerpt")?.textContent).toBe(
      "@dx second reviewer please check the totals",
    );
    expect(mentions(tokens)).toEqual(["@dx second reviewer"]);
    // An excerpt from before tokens still tints its handle.
    expect(mentions(plain)).toEqual(["@benm"]);
  });

  it("keeps a person's initials", async () => {
    const [row] = await open([
      notification("b2", {
        userId: "inbox-ben" as UserId,
        name: "Ben Member",
      }),
    ]);
    expect(row?.querySelector(".dx-avatar")?.textContent).toBe("BM");
    expect(row?.querySelector('[aria-label="dx"]')).toBeNull();
  });
});
