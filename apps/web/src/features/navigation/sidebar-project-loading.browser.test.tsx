// After a reload the Thread list can answer before the Project list. A
// Thread in a Project must not show under No Project meanwhile (#1349): it
// waits under a loading heading, then takes its Project's name. Only a
// Thread Core marks projectless shows under No Project.

import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => <p>Page</p>,
  Link: ({
    children,
    className,
    to,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
    readonly to: string;
  }) => (
    // Never clicked here, so the anchor cannot navigate the test page.
    <a className={className} href={to}>
      {children}
    </a>
  ),
  useLocation: ({
    select,
  }: {
    readonly select: (location: { readonly pathname: string }) => unknown;
  }) => select({ pathname: "/" }),
  useNavigate: () => () => undefined,
}));
vi.mock("./sidebar-account-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar-account-menu.js")>()),
  SidebarAccountMenu: () => null,
}));

vi.mock("../../shared/thread-archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/thread-archive.js")>()),
  useThreadArchive: () => ({ setArchived: () => undefined }),
}));
vi.mock("../../shared/new-thread-surface.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/new-thread-surface.js")
  >()),
  useNewThreadSurface: () => ({ openNewThread: () => undefined }),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { ProductShell } from "./product-shell.js";

const userId = "usr_sidebar_project_loading" as UserId;
const projectId = "prj_00000000-0000-4000-8000-000000001349";
const hiddenProjectId = "prj_00000000-0000-4000-8000-000000000000";
const recent = new Date(Date.now() - 60_000).toISOString();

const thread = (id: string, title: string, inProject: string) => ({
  id,
  title,
  projectId: inProject,
  visibility: "private",
  createdAt: recent,
  updatedAt: recent,
  lastActivityAt: recent,
  activityStatus: "idle",
  lifecycleState: "active",
  agentUrl: `/v1/agents/dx/${id}`,
  mode: "high",
});

const threadPage = {
  items: [
    thread(
      "thr_00000000-0000-4000-8000-000000000001",
      "Project Thread",
      projectId,
    ),
    {
      ...thread(
        "thr_00000000-0000-4000-8000-000000000002",
        "Projectless Thread",
        hiddenProjectId,
      ),
      projectless: true,
    },
  ],
};

const projectPage = {
  items: [
    {
      id: projectId,
      name: "notes-keeper",
      configuration: {
        shipAction: "ship",
        commitAuthor: {
          preference: "dx",
          name: "dx",
          email: "noreply@dx.local",
        },
        signingPreference: "disabled",
        runnerProfileId: "e2b-default",
        publicCodeEnabled: false,
        dxCoAuthor: true,
      },
      revision: 0,
      createdAt: recent,
      updatedAt: recent,
    },
  ],
};

let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/**
 * The Thread list answers at once; the Project list waits for `release`.
 * Every other request hangs.
 */
const throttledProjects = () => {
  let release: () => void = () => undefined;
  const projectsReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === "/v1/threads" && url.searchParams.has("roots"))
      return Response.json({ status: "success", data: threadPage });
    if (url.pathname === "/v1/projects") {
      await projectsReleased;
      return Response.json({ status: "success", data: projectPage });
    }
    return new Promise<Response>(() => {});
  });
  return { release };
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 300)));

const mount = async () => {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1440px";
  container.style.height = "900px";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ProductShell />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

/** Each Thread project section's heading with the Thread titles under it. */
const projectSections = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(".thread-project-group"),
    (section) => ({
      heading:
        section.querySelector(".thread-group-heading > span")?.textContent ??
        "",
      busy: section.getAttribute("aria-busy") === "true",
      threads: Array.from(
        section.querySelectorAll(".thread-row-title-text"),
        (title) => title.textContent,
      ),
    }),
  );

it("keeps a project's Thread out of No Project while the Project list loads", async () => {
  const server = throttledProjects();
  await mount();

  const loading = projectSections();
  expect(loading).toContainEqual({
    heading: "No Project",
    busy: false,
    threads: ["Projectless Thread"],
  });
  expect(loading).toContainEqual({
    heading: "Loading…",
    busy: true,
    threads: ["Project Thread"],
  });

  server.release();
  await settle();

  const loaded = projectSections();
  expect(loaded).toContainEqual({
    heading: "notes-keeper",
    busy: false,
    threads: ["Project Thread"],
  });
  expect(loaded).toContainEqual({
    heading: "No Project",
    busy: false,
    threads: ["Projectless Thread"],
  });
});
