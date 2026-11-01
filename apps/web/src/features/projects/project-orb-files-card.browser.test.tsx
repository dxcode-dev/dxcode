import type { ProjectId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NewThreadSurfaceContext } from "../../shared/new-thread-surface.js";
import { ProjectOrbFilesCard } from "./project-orb-files-card.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "user-1" as UserId;
const projectId = "project-1" as ProjectId;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Answers the Project's Orb files request with `answer`. */
const serve = (answer: () => Response) => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const url = String(input);
    requests.push(url);
    if (!url.endsWith(`/v1/projects/${projectId}/orb-files`))
      return new Promise<Response>(() => {});
    return answer();
  });
  return requests;
};

const render = async () => {
  const openNewThread = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewThreadSurfaceContext.Provider value={{ openNewThread }}>
          <ProjectOrbFilesCard projectId={projectId} userId={userId} />
        </NewThreadSurfaceContext.Provider>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).not.toContain("Checking"),
  );
  return { container, openNewThread };
};

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((row) => ({
    path: row.querySelector("code")?.textContent,
    status: row.querySelector(".project-orb-file-status")?.textContent,
    href: row.querySelector("a")?.getAttribute("href") ?? undefined,
  }));

it("lists each repository file on the default branch, linking the ones it has", async () => {
  serve(() =>
    Response.json({
      status: "success",
      data: {
        state: "checked",
        repository: { fullName: "acme/app", defaultBranch: "main" },
        files: [
          {
            path: ".agents/setup",
            present: true,
            url: "https://github.com/acme/app/blob/main/.agents/setup",
          },
          { path: ".agents/resume", present: false },
          {
            path: ".agents/desktop/resume",
            present: true,
            url: "https://github.com/acme/app/blob/main/.agents/desktop/resume",
          },
          { path: ".dx/services.yaml", present: false },
        ],
      },
    }),
  );
  const { container, openNewThread } = await render();

  expect(rows(container)).toEqual([
    {
      path: ".agents/setup",
      status: "Found",
      href: "https://github.com/acme/app/blob/main/.agents/setup",
    },
    { path: ".agents/resume", status: "Missing", href: undefined },
    {
      path: ".agents/desktop/resume",
      status: "Found",
      href: "https://github.com/acme/app/blob/main/.agents/desktop/resume",
    },
    { path: ".dx/services.yaml", status: "Missing", href: undefined },
  ]);
  expect(container.textContent).toContain("acme/app");
  expect(container.textContent).toContain("main");
  // The repository's Desktop resume replaces the project's script.
  expect(container.textContent).toContain(
    "replaces the project's Desktop Resume Script",
  );

  const setUp = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Set up with dx",
  );
  expect(setUp).toBeDefined();
  await React.act(() => setUp?.click());
  expect(openNewThread).toHaveBeenCalledTimes(1);
  const [openedProject, prompt] = openNewThread.mock.calls[0] as [
    ProjectId,
    string,
  ];
  expect(openedProject).toBe(projectId);
  expect(prompt).toContain(".agents/resume");
  expect(prompt).toContain(".dx/services.yaml");
  expect(prompt).not.toContain(".agents/desktop/resume");
});

it("offers no setup when the repository has every file", async () => {
  serve(() =>
    Response.json({
      status: "success",
      data: {
        state: "checked",
        repository: { fullName: "acme/app", defaultBranch: "trunk" },
        files: [
          ".agents/setup",
          ".agents/resume",
          ".agents/desktop/resume",
          ".dx/services.yaml",
        ].map((path) => ({
          path,
          present: true,
          url: `https://bitbucket.org/acme/app/src/trunk/${path}`,
        })),
      },
    }),
  );
  const { container } = await render();

  expect(rows(container).map((row) => row.status)).toEqual([
    "Found",
    "Found",
    "Found",
    "Found",
  ]);
  expect(container.textContent).not.toContain("Set up with dx");
});

it("describes the files without a status when the repository is not connected", async () => {
  serve(() =>
    Response.json({ status: "success", data: { state: "not-connected" } }),
  );
  const { container } = await render();

  expect(rows(container)).toEqual([
    { path: ".agents/setup", status: undefined, href: undefined },
    { path: ".agents/resume", status: undefined, href: undefined },
    { path: ".agents/desktop/resume", status: undefined, href: undefined },
    { path: ".dx/services.yaml", status: undefined, href: undefined },
  ]);
  expect(container.textContent).toContain(
    "Connect this project to GitHub or Bitbucket",
  );
  expect(container.textContent).not.toContain("Set up with dx");
});

it("says when dx cannot read the repository", async () => {
  serve(() =>
    Response.json({ status: "success", data: { state: "unreadable" } }),
  );
  const { container } = await render();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not read",
  );
  expect(rows(container).map((row) => row.status)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

it("reports a failed request", async () => {
  serve(() =>
    Response.json(
      {
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Persistence is temporarily unavailable.",
          requestId: "r",
        },
      },
      { status: 503 },
    ),
  );
  const { container } = await render();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be checked",
  );
});

it("names the default branch generically for a public repository read without a connection", async () => {
  serve(() =>
    Response.json({
      status: "success",
      data: {
        state: "checked",
        repository: { fullName: "acme/public" },
        files: [
          {
            path: ".agents/setup",
            present: true,
            url: "https://github.com/acme/public/blob/HEAD/.agents/setup",
          },
          { path: ".agents/resume", present: false },
          { path: ".agents/desktop/resume", present: false },
          { path: ".dx/services.yaml", present: false },
        ],
      },
    }),
  );
  const { container, openNewThread } = await render();

  expect(container.textContent).toContain(
    "acme/public has them on its default branch.",
  );
  const setUp = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Set up with dx",
  );
  await React.act(() => setUp?.click());
  expect(openNewThread.mock.calls[0]?.[1]).toContain(
    "Its default branch has no",
  );
});
