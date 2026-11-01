import type { ProjectData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import "../../styles.css";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import { projectQueryOptions } from "./project-queries.js";

// #1176: the phone project title bar cut the project's name to
// "qa-nt-scratc…" and "pi-remer…", so the page never said which project was
// open. The owner crumb gives up its space first.

const ids = vi.hoisted(() => ({
  user: "usr_00000000000000000000000000001176",
  project: "prj_00000000-0000-4000-8000-000000001176",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
    }: {
      readonly children: React.ReactNode;
      readonly className?: string;
    }) => (
      <a href="/" className={className}>
        {children}
      </a>
    ),
    useParams: () => ({ projectId: ids.project }),
  };
});
vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({
    identity: {
      id: ids.user,
      name: "dx deployment runtime owner",
      email: "owner@example.com",
    },
  }),
}));

const { ProjectPage } = await import("./project-page.js");

const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

afterEach(async () => {
  document.body.replaceChildren();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 800);
});

describe.each(PHONES)(
  "the phone project title bar at $width x $height",
  ({ width, height }) => {
    it.each(["qa-nt-scratch", "notes-keeper", "dx-landing-site"])(
      "shows all of %s, shortening the owner first (#1176)",
      async (name) => {
        await page.viewport(width, height);
        await cdp().send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
        document.body.style.margin = "0";
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        });
        const userId = ids.user as UserId;
        const projectId = ids.project as ProjectId;
        client.setQueryData(projectQueryOptions(userId, projectId).queryKey, {
          id: projectId,
          name,
          viewerAccess: { canManage: true },
        } as unknown as ProjectData);
        client.setQueryData(threadsQueryOptions(userId, projectId).queryKey, {
          pages: [{ items: [] }],
          pageParams: [undefined],
        } as never);
        const container = document.body.appendChild(
          document.createElement("div"),
        );
        Object.assign(container.style, {
          display: "flex",
          flexDirection: "column",
          height: "100vh",
        });
        const root = createRoot(container);
        await React.act(() =>
          root.render(
            <QueryClientProvider client={client}>
              <ProjectPage />
            </QueryClientProvider>,
          ),
        );
        const title = container.querySelector(
          ".project-detail-title",
        ) as HTMLElement;
        // The name's text, measured whole, fits inside the box that clips it.
        const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
        let text: Text | undefined;
        while (walker.nextNode())
          if (walker.currentNode.textContent === name)
            text = walker.currentNode as Text;
        expect(text, `${name} is in the title`).toBeDefined();
        const range = document.createRange();
        range.selectNodeContents(text as Text);
        const textBox = range.getBoundingClientRect();
        const clip = (text as Text).parentElement as HTMLElement;
        expect(textBox.width).toBeGreaterThan(0);
        expect(textBox.right, `${name} is not cut off`).toBeLessThanOrEqual(
          clip.getBoundingClientRect().right + 0.5,
        );
        expect(clip.scrollWidth).toBeLessThanOrEqual(clip.clientWidth);
        expect(textBox.right).toBeLessThanOrEqual(
          title.getBoundingClientRect().right + 0.5,
        );

        // The owner gave up width first, but its mark still shows.
        const owner = title.querySelector(
          ".projects-title-owner",
        ) as HTMLElement;
        expect(owner.getBoundingClientRect().width).toBeGreaterThanOrEqual(18);
        const actions = container.querySelector(
          ".project-detail-actions",
        ) as HTMLElement;
        expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
          actions.getBoundingClientRect().left,
        );
        await React.act(() => root.unmount());
        client.clear();
      },
    );
  },
);
