import { DateTime } from "effect";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  ...queries,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useParams: () => ({ projectId: "project-1" }),
}));
vi.mock("../../shared/auth/auth-context.js", () => ({
  useAuthenticatedIdentity: () => ({
    identity: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
    },
  }),
}));

import { ProjectPage } from "./project-page.js";

describe("project page thread state", () => {
  it("shows loading rather than an empty state while the initial query is pending", () => {
    queries.useQuery
      .mockReturnValueOnce({
        data: { id: "project-1", name: "Test project" },
        error: null,
        isPending: false,
      })
      .mockReturnValueOnce({ data: undefined, error: null, isPending: true });
    queries.useInfiniteQuery.mockReturnValue({
      data: undefined,
      error: null,
      isPending: true,
    });

    const markup = renderToStaticMarkup(<ProjectPage />);

    expect(markup).toContain("Loading recent threads…");
    expect(markup).not.toContain("No threads yet");
  });

  it("preserves server activity order and displays last activity time", () => {
    queries.useQuery
      .mockReturnValueOnce({
        data: { id: "project-1", name: "Test project" },
        error: null,
        isPending: false,
      })
      .mockReturnValueOnce({ data: undefined, error: null, isPending: false });
    queries.useInfiniteQuery.mockReturnValue({
      data: {
        pages: [
          {
            items: [
              {
                id: "thr_00000000-0000-4000-8000-000000AAAAAA",
                title: "First thread",
                lifecycleState: "active",
                updatedAt: DateTime.makeUnsafe("2026-08-20T10:00:00.000Z"),
                lastActivityAt: DateTime.makeUnsafe("2026-08-25T10:00:00.000Z"),
              },
            ],
          },
          {
            items: [
              {
                id: "thr_00000000-0000-4000-8000-000000BBBBBB",
                title: "Second thread",
                lifecycleState: "active",
                updatedAt: DateTime.makeUnsafe("2026-08-24T10:00:00.000Z"),
                lastActivityAt: DateTime.makeUnsafe("2026-08-24T10:00:00.000Z"),
              },
            ],
          },
        ],
      },
      error: null,
      isPending: false,
    });

    const markup = renderToStaticMarkup(<ProjectPage />);

    expect(markup.indexOf("First thread")).toBeLessThan(
      markup.indexOf("Second thread"),
    );
    expect(markup).toContain('<time dateTime="2026-08-25T10:00:00.000Z">');
    expect(markup).not.toContain('<time dateTime="2026-08-20T10:00:00.000Z">');
  });
});
