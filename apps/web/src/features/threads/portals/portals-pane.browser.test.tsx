import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadPortalsPane } from "./portals-pane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000001319" as ThreadId;
const portalUrl =
  "https://t-00000000-0000-4000-8000-000000001319-p3000.portal/";
const listPath = `/v1/threads/${threadId}/portals`;
const publicPath = `${listPath}/3000/public`;
const OWNER_ONLY = "Only the Thread's owner can make a port public";

/** The Portals API as Core answers it for the owner or for a member. */
const portalsApi = (canPublish: boolean) => {
  const writes: Array<{ method: string; path: string; body?: string }> = [];
  let expiresAt: string | undefined;
  const json = (data: unknown) =>
    new Response(JSON.stringify({ status: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === listPath)
      return json({
        workspace: "running",
        portals: [{ port: 3000, url: portalUrl }],
        publicLinks:
          expiresAt === undefined
            ? []
            : [{ port: 3000, url: portalUrl, expiresAt }],
        canPublish,
      });
    if (method === "PUT" && path === publicPath) {
      writes.push({ method, path, body: String(init?.body) });
      expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      return json({ port: 3000, url: portalUrl, expiresAt });
    }
    writes.push({ method, path });
    return new Response("unexpected", { status: 500 });
  });
  return { fetch, writes };
};

const mounted: Array<() => Promise<void>> = [];

const renderPane = async (canPublish: boolean) => {
  const api = portalsApi(canPublish);
  vi.stubGlobal("fetch", api.fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ThreadPortalsPane threadId={threadId} active />
      </QueryClientProvider>,
    ),
  );
  mounted.push(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    client.clear();
  });
  await vi.waitFor(() =>
    expect(container.querySelector(".thread-portals-row")).not.toBeNull(),
  );
  return { api, container };
};

const globe = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(".thread-portals-public-trigger");

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );

afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
  vi.unstubAllGlobals();
});

describe("Portal public links", () => {
  it("lets the Thread's owner make a port public for a set time", async () => {
    const { api, container } = await renderPane(true);
    const trigger = globe(container);
    expect(trigger?.getAttribute("aria-disabled")).toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Make port 3000 public");

    await React.act(async () => trigger?.click());
    await vi.waitFor(() => expect(menuItem("Public for 1 hour")).toBeDefined());
    expect(menuItem("Public for 1 day")).toBeDefined();
    expect(menuItem("Public for 7 days")).toBeDefined();

    await React.act(async () => menuItem("Public for 1 hour")?.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Public until"),
    );
    expect(api.writes).toEqual([
      { method: "PUT", path: publicPath, body: '{"duration":"1h"}' },
    ]);
  });

  it("shows a member the globe disabled, with who can make a port public", async () => {
    const { api, container } = await renderPane(false);
    const trigger = globe(container);
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-disabled")).toBe("true");
    expect(trigger?.title).toBe(`${OWNER_ONLY}.`);
    expect(trigger?.getAttribute("aria-label")).toBe(
      `Port 3000 is private. ${OWNER_ONLY}.`,
    );

    await React.act(async () => trigger?.click());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(menuItem("Public for 1 hour")).toBeUndefined();
    expect(api.writes).toEqual([]);
  });
});
