// @vitest-environment happy-dom

import type {
  ProjectData,
  ThreadDetailData,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
} from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import { defaultThreadModelSelection } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const flue = vi.hoisted(() => {
  const client = { send: vi.fn() };
  return { client, createClient: vi.fn(() => client) };
});
const viewport = vi.hoisted(() => ({ mobile: true }));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@flue/react", () => ({ useFlueAgent: () => ({}) }));
vi.mock("@flue/sdk", () => ({ createFlueClient: flue.createClient }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (location: { href: string }) => string;
  }) => select({ href: "/threads/thread-1" }),
  useNavigate: () => router.navigate,
  useParams: () => ({ threadId: "thread-1" }),
}));
vi.mock("../../shared/auth/auth-context.js", () => ({
  useAuthenticatedIdentity: () => ({ identity: { id: "user-1" } }),
}));
vi.mock("../../shared/use-mobile.js", () => ({
  useMobile: () => viewport.mobile,
}));
vi.mock("./changes/changes-pane.js", () => ({
  ChangesPane: ({
    onReviewPrompt,
    onOpenFile,
  }: {
    onReviewPrompt: (prompt: string) => void;
    onOpenFile?: (worktree: string, path: string) => void;
  }) => (
    <div data-testid="changes-pane">
      <button
        type="button"
        onClick={() => onReviewPrompt("Review captured changes")}
      >
        Review changes
      </button>
      <button
        type="button"
        onClick={() => onOpenFile?.("primary", "src/selected.ts")}
      >
        Open selected change
      </button>
    </div>
  ),
}));
// Exercises the workspace-provided link resolver and file navigation exactly
// as transcript Markdown links and Edited rows do.
function TranscriptFileProbe() {
  const resolve = React.useContext(MarkdownFileLinkContext);
  const navigation = React.useContext(ThreadFileNavigationContext);
  return (
    <>
      {["/home/user/notes/todo.md", "src/linked.ts:4"].map((href) => (
        <button
          key={href}
          type="button"
          data-download={resolve?.(href)?.downloadUrl}
          onClick={() => resolve?.(href)?.open()}
        >
          {`Link ${href}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          navigation?.open(
            {
              kind: "workspace",
              worktree: "primary" as ThreadFilesWorktreeId,
              path: "src/linked.ts" as ThreadFilesPath,
            },
            { kind: "text", text: "edited" },
          )
        }
      >
        Open edit
      </button>
    </>
  );
}

vi.mock("./agent-panel.js", () => ({
  PendingAgentPanel: ({ creation }: { creation: { body: string } }) => (
    <section aria-label="Pending agent chat">
      <span>{creation.body}</span>
      <textarea aria-label="Message" disabled />
    </section>
  ),
  AgentPanel: ({
    archived,
    renderHeader,
    draft = "",
    onDraftChange,
    onOpenModelRouting,
    showArchivedNotice,
    workspaceStatus,
  }: {
    archived?: boolean;
    renderHeader?: (model: {
      rows: never[];
      turns: never[];
      outline: never[];
      capabilities: {
        paging: { available: false };
        subagents: { available: false };
      };
    }) => React.ReactNode;
    draft?: string;
    onDraftChange?: (draft: string) => void;
    onOpenModelRouting?: () => void;
    showArchivedNotice?: boolean;
    workspaceStatus?: string;
  }) => (
    <>
      {renderHeader?.({
        rows: [],
        turns: [],
        outline: [],
        capabilities: {
          paging: { available: false },
          subagents: { available: false },
        },
      })}
      {showArchivedNotice ? (
        <div role="note">Archived. Unarchive to resume or run commands.</div>
      ) : null}
      <section aria-label="Thread transcript">
        Existing chat remains visible
        <TranscriptFileProbe />
      </section>
      {workspaceStatus ? <div role="status">{workspaceStatus}</div> : null}
      {!archived && onOpenModelRouting !== undefined ? (
        <button type="button" onClick={onOpenModelRouting}>
          Open Model Routing
        </button>
      ) : null}
      {archived ? null : (
        <textarea
          aria-label="Thread composer"
          value={draft}
          onChange={(event) => onDraftChange?.(event.target.value)}
        />
      )}
    </>
  ),
}));

import { MarkdownFileLinkContext } from "../../shared/ui/markdown-file-link-context.js";
import { projectKeys } from "../projects/project-queries.js";
import { ThreadDesktopLayout } from "./thread-desktop-layout.js";
import { ThreadFileNavigationContext } from "./thread-file-navigation.js";
import { threadKeys } from "./thread-queries.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";
import { ThreadSessionRegistry } from "./thread-session-registry.js";
import { ThreadSession, ThreadWorkspace } from "./thread-workspace.js";

const userId = "user-1" as UserId;
const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;
const thread = {
  id: threadId,
  title: "A deliberately authoritative thread title",
  projectId,
  visibility: "private",
  lifecycleState: "active",
  agentUrl: "/v1/agents/dx/thread-1",
  agentInitialization: {
    selection: defaultThreadModelSelection(),
    skills: [],
  },
  executionWorkspace: { ready: true, preparationStatus: null },
} as unknown as ThreadDetailData;
const project = {
  id: projectId,
  name: "Project one",
  revision: 1,
} as unknown as ProjectData;

afterEach(() => {
  viewport.mobile = true;
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSession = async (
  sessionThread = thread,
  Terminal?: React.ComponentType<{
    readonly threadId: ThreadId;
    readonly onWorkspaceStatusChange?: (status?: string) => void;
  }>,
  onOpenModelRouting?: (destination: string) => void,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const render = (nextThread: ThreadDetailData, nextProject: ProjectData) => (
    <QueryClientProvider client={queryClient}>
      <ThreadSession
        thread={nextThread}
        project={nextProject}
        onOpenModelRouting={onOpenModelRouting}
        Terminal={Terminal}
      />
    </QueryClientProvider>
  );
  await React.act(() => root.render(render(sessionThread, project)));
  return { container, root, render };
};

const click = async (element: Element | null) => {
  await React.act(() =>
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};

const press = async (element: Element | null, key: string) => {
  await React.act(() =>
    element?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    ),
  );
};

describe("ThreadSession right pane", () => {
  it("activates Terminal immediately when no Changes content is supplied", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={<div>Main</div>}
          terminal={<div data-testid="terminal-only">Terminal content</div>}
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="terminal-only"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe("Terminal");
    await React.act(() => root.unmount());
  });

  it("defaults to Changes, lazily preserves Terminal, and keeps collapse mechanics", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    const Terminal = vi.fn(({ threadId: id }: { threadId: ThreadId }) => (
      <div className="thread-terminal" data-thread-id={id} />
    ));
    const { container, root } = await renderSession(thread, Terminal);
    const pane = container.querySelector<HTMLElement>("#thread-right-pane");
    const panel = container.querySelector<HTMLElement>(".right-pane-panel");

    expect(pane?.getAttribute("aria-label")).toBe("Right pane");
    expect(pane?.querySelector('[role="status"]')).toBeNull();
    const tabs = pane?.querySelectorAll('[role="tab"]');
    const changesTab =
      [...(tabs ?? [])].find((tab) => tab.textContent === "Changes") ?? null;
    const terminalTab =
      [...(tabs ?? [])].find((tab) => tab.textContent === "Terminal") ?? null;
    expect(changesTab?.textContent).toBe("Changes");
    expect(changesTab?.getAttribute("aria-selected")).toBe("true");
    expect(changesTab?.getAttribute("tabindex")).toBe("0");
    expect(pane?.querySelector('[data-testid="changes-pane"]')).not.toBeNull();
    expect(terminalTab?.textContent).toBe("Terminal");
    expect(terminalTab?.getAttribute("aria-selected")).toBe("false");
    expect(terminalTab?.getAttribute("tabindex")).toBe("-1");
    expect(changesTab?.getAttribute("aria-controls")).toBe(
      "thread-changes-panel",
    );
    expect(
      pane
        ?.querySelector("#thread-changes-panel")
        ?.getAttribute("aria-labelledby"),
    ).toBe("thread-workspace-tab-changes");
    expect(
      pane
        ?.querySelector("#thread-terminal-panel")
        ?.getAttribute("aria-labelledby"),
    ).toBe("thread-workspace-tab-terminal");
    expect(
      pane?.querySelector("#thread-terminal-panel")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(pane?.querySelector(".thread-terminal")).toBeNull();
    expect(Terminal).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '.thread-title-bar > [aria-label="Show Right Pane"]',
      ),
    ).not.toBeNull();
    expect(panel?.dataset.collapsed).toBe("true");
    expect(panel?.style.width).toBe("0px");
    expect(pane?.inert).toBe(true);

    await click(container.querySelector('[aria-label="Show Right Pane"]'));
    expect(panel?.hasAttribute("data-collapsed")).toBe(false);
    expect(panel?.style.width).toBe("360px");
    expect(pane?.inert).toBe(false);

    await click(terminalTab ?? null);
    expect(terminalTab?.getAttribute("aria-selected")).toBe("true");
    expect(pane?.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(Terminal).toHaveBeenCalledOnce();
    expect(Terminal.mock.calls[0]?.[0]).toMatchObject({ threadId });
    const mountedTerminal = pane?.querySelector(".thread-terminal");
    expect(mountedTerminal).not.toBeNull();

    await click(changesTab);
    expect(changesTab?.getAttribute("aria-selected")).toBe("true");
    expect(terminalTab?.getAttribute("aria-selected")).toBe("false");
    expect(pane?.querySelector(".thread-terminal")).toBe(mountedTerminal);
    expect(
      pane?.querySelector("#thread-terminal-panel")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      pane?.querySelector("#thread-terminal-panel")?.hasAttribute("inert"),
    ).toBe(true);
    expect(
      pane
        ?.querySelector("#thread-terminal-panel")
        ?.getAttribute("aria-labelledby"),
    ).toBe("thread-workspace-tab-terminal");
    await click(terminalTab);
    expect(pane?.querySelector(".thread-terminal")).toBe(mountedTerminal);

    await click(container.querySelector('[aria-label="Hide Right Pane"]'));
    expect(panel?.dataset.collapsed).toBe("true");
    expect(panel?.style.width).toBe("0px");
    expect(pane?.inert).toBe(true);
    expect(
      container.querySelector('[aria-label="Show Right Pane"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Resize right pane"]')
        ?.getAttribute("tabindex"),
    ).toBe("-1");
    expect(
      container
        .querySelector('[aria-label="Resize right pane"]')
        ?.getAttribute("role"),
    ).toBe("slider");
    expect(pane?.querySelector(".thread-terminal")).toBe(mountedTerminal);

    await click(container.querySelector('[aria-label="Show Right Pane"]'));
    expect(panel?.hasAttribute("data-collapsed")).toBe(false);
    expect(panel?.style.width).toBe("360px");
    expect(pane?.inert).toBe(false);
    expect(pane?.querySelector(".thread-terminal")).toBe(mountedTerminal);
    await React.act(() => root.unmount());
  });

  it("hides every right-pane affordance until first readiness", async () => {
    viewport.mobile = false;
    const Terminal = vi.fn(() => <div className="thread-terminal" />);
    const { container, root } = await renderSession(
      {
        ...thread,
        executionWorkspace: {
          ready: false,
          preparationStatus: "Cloning repository…",
        },
      },
      Terminal,
    );

    expect(container.querySelector("#thread-right-pane")).toBeNull();
    expect(
      container.querySelector('[aria-label="Resize right pane"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Show Right Pane"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Hide Right Pane"]'),
    ).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Cloning repository…",
    );
    expect(Terminal).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("supports roving tab navigation without remounting Terminal", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const Files = vi.fn(() => <div data-testid="files-instance" />);
    const Terminal = vi.fn(() => <div data-testid="terminal-instance" />);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={<div>Main</div>}
          changes={<div>Changes</div>}
          files={<Files />}
          terminal={<Terminal />}
        />,
      ),
    );
    const changesTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-changes",
    );
    changesTab?.focus();

    await press(changesTab, "ArrowRight");
    const filesTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-files",
    );
    expect(document.activeElement).toBe(filesTab);
    expect(filesTab?.getAttribute("aria-selected")).toBe("true");
    expect(Files).toHaveBeenCalledOnce();
    expect(Terminal).not.toHaveBeenCalled();

    await press(filesTab, "ArrowRight");
    const terminalTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-terminal",
    );
    expect(document.activeElement).toBe(terminalTab);
    expect(terminalTab?.getAttribute("aria-selected")).toBe("true");
    expect(Terminal).toHaveBeenCalledOnce();
    const mountedTerminal = container.querySelector(
      '[data-testid="terminal-instance"]',
    );

    await press(terminalTab, "Home");
    expect(document.activeElement).toBe(changesTab);
    expect(changesTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="terminal-instance"]')).toBe(
      mountedTerminal,
    );
    expect(container.querySelector('[data-testid="files-instance"]')).not.toBe(
      null,
    );

    await press(changesTab, "End");
    expect(document.activeElement).toBe(terminalTab);
    expect(Terminal).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
  });

  it("focuses the existing Terminal pane and restores collapse and keyboard focus", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderLayout = (rightPaneCollapsed: boolean) =>
      React.act(() =>
        root.render(
          <ThreadDesktopLayout
            rightPaneCollapsed={rightPaneCollapsed}
            main={<button type="button">Main focus target</button>}
            terminal={<div data-testid="focused-terminal">Terminal</div>}
          />,
        ),
      );
    await renderLayout(false);
    const mainTarget = container.querySelector<HTMLButtonElement>(
      ".thread-main-panel button",
    );
    mainTarget?.focus();
    const terminalNode = container.querySelector(
      '[data-testid="focused-terminal"]',
    );

    const focusControl = container.querySelector<HTMLButtonElement>(
      '[aria-label="Focus Pane"]',
    );
    await React.act(() => {
      focusControl?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      focusControl?.focus();
      focusControl?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const group = container.querySelector<HTMLElement>(".thread-panel-group");
    const panel = container.querySelector<HTMLElement>(".right-pane-panel");
    expect(group?.dataset.rightPaneFocused).toBe("true");
    expect(panel?.style.width).toBe("100%");
    expect(
      container.querySelector("#thread-right-pane")?.hasAttribute("inert"),
    ).toBe(false);
    expect(
      container.querySelector(".thread-main-panel")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      container
        .querySelector('[aria-label="Resize right pane"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(container.querySelector('[data-testid="focused-terminal"]')).toBe(
      terminalNode,
    );

    await renderLayout(true);
    await click(container.querySelector('[aria-label="Unfocus Pane"]'));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(group?.hasAttribute("data-right-pane-focused")).toBe(false);
    expect(panel?.style.width).toBe("0px");
    expect(document.activeElement).toBe(mainTarget);
    expect(container.querySelector('[data-testid="focused-terminal"]')).toBe(
      terminalNode,
    );
    await React.act(() => root.unmount());
  });

  it("places the Changes review prompt into the Thread composer", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    const { container, root } = await renderSession();

    const reviewButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review changes",
    );
    await click(reviewButton ?? null);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Thread composer"]',
      )?.value,
    ).toBe("Review captured changes");
    await React.act(() => root.unmount());
  });

  it("opens Model Routing without discarding the retained composer draft", async () => {
    const openModelRouting = vi.fn();
    const { container, root } = await renderSession(
      thread,
      undefined,
      openModelRouting,
    );
    const composer = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Thread composer"]',
    );
    await React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(composer, "Keep this draft");
      composer?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open Model Routing",
      ) ?? null,
    );

    expect(openModelRouting).toHaveBeenCalledExactlyOnceWith(
      "/settings/model-routing",
    );
    expect(composer?.value).toBe("Keep this draft");
    await React.act(() => root.unmount());
  });

  it("does not fall back to personal routing for an unresolved workspace", async () => {
    const openModelRouting = vi.fn();
    const { container, root, render } = await renderSession(
      thread,
      undefined,
      openModelRouting,
    );
    await React.act(() =>
      root.render(
        render(thread, {
          ...project,
          workspaceId: "workspace-unavailable",
        } as ProjectData),
      ),
    );

    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open Model Routing",
      ),
    ).toBeUndefined();
    expect(openModelRouting).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("opens a selected Changes file in the center editor navigation", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    const { container, root } = await renderSession();

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open selected change",
      ) ?? null,
    );
    const selected = container.querySelector(
      '[role="tab"][title="src/selected.ts"]',
    );
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    await React.act(() => root.unmount());
  });

  it("opens transcript file links and edits as center tabs without navigating", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    const { container, root } = await renderSession();
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label,
      ) ?? null;

    const sandboxLink = button("Link /home/user/notes/todo.md");
    expect(sandboxLink?.dataset.download).toContain(
      "files-sandbox?path=%2Fhome%2Fuser%2Fnotes%2Ftodo.md&download=1",
    );
    await click(sandboxLink);
    const sandboxTab = container.querySelector(
      '[role="tab"][title="/home/user/notes/todo.md"]',
    );
    expect(sandboxTab?.getAttribute("aria-selected")).toBe("true");
    expect(sandboxTab?.textContent).toContain("Sandbox");

    await click(button("Link src/linked.ts:4"));
    const repoTab = container.querySelector(
      '[role="tab"][title="src/linked.ts"]',
    );
    expect(repoTab?.getAttribute("aria-selected")).toBe("true");

    // Opening the same file from an Edited row reuses its tab.
    await click(button("Open edit"));
    expect(
      container.querySelectorAll('[role="tab"][title="src/linked.ts"]'),
    ).toHaveLength(1);
    expect(router.navigate).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("keyboard-resizes in 16px steps and clamps to desktop bounds", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    vi.stubGlobal("innerWidth", 1000);
    const { container, root } = await renderSession();
    await click(container.querySelector('[aria-label="Show Right Pane"]'));
    const handle = container.querySelector<HTMLElement>(
      '[aria-label="Resize right pane"]',
    );
    const panel = container.querySelector<HTMLElement>(".right-pane-panel");

    expect(handle?.getAttribute("aria-valuemin")).toBe("260");
    expect(handle?.getAttribute("aria-valuemax")).toBe("460");
    for (let index = 0; index < 10; index++)
      await React.act(() =>
        handle?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        ),
      );
    expect(panel?.style.width).toBe("460px");
    expect(handle?.getAttribute("aria-valuenow")).toBe("460");
    for (let index = 0; index < 20; index++)
      await React.act(() =>
        handle?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
    expect(panel?.style.width).toBe("260px");
    expect(handle?.getAttribute("aria-valuenow")).toBe("260");
    await React.act(() => root.unmount());
  });

  it("keeps layout state for the mounted Thread and resets it after navigation or refresh remount", async () => {
    viewport.mobile = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    const first = await renderSession();
    await click(
      first.container.querySelector('[aria-label="Hide Right Pane"]'),
    );
    await React.act(() =>
      first.root.render(
        first.render(thread, { ...project, name: "Refreshed" }),
      ),
    );
    expect(
      first.container.querySelector<HTMLElement>(".right-pane-panel")?.style
        .width,
    ).toBe("0px");
    await React.act(() => first.root.unmount());

    const remounted = await renderSession({
      ...thread,
      id: "thread-2" as ThreadId,
    });
    expect(
      remounted.container.querySelector<HTMLElement>(".right-pane-panel")?.style
        .width,
    ).toBe("0px");
    expect(
      remounted.container.querySelector('[aria-label="Show Right Pane"]'),
    ).not.toBeNull();
    await React.act(() => remounted.root.unmount());
  });

  it("omits the right pane and its controls on mobile", async () => {
    const Terminal = vi.fn(() => <div className="thread-terminal" />);
    const { container, root } = await renderSession(thread, Terminal);
    expect(container.querySelector("#thread-right-pane")).toBeNull();
    expect(
      container.querySelector('[aria-label="Resize right pane"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Thread composer"]'),
    ).not.toBeNull();
    expect(Terminal).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("keeps archived desktop chat visible while omitting the composer, Terminal, and right-pane controls", async () => {
    viewport.mobile = false;
    const renderTerminal = vi.fn(() => <div className="thread-terminal" />);
    const { container, root } = await renderSession(
      { ...thread, lifecycleState: "archived" },
      renderTerminal,
    );

    expect(
      container.querySelector('[aria-label="Thread transcript"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Existing chat remains visible");
    expect(
      container.querySelector('[aria-label="Thread composer"]'),
    ).toBeNull();
    expect(container.querySelector("#thread-right-pane")).toBeNull();
    expect(
      container.querySelector('[aria-label="Show Right Pane"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Hide Right Pane"]'),
    ).toBeNull();
    expect(container.querySelector(".thread-terminal")).toBeNull();
    expect(renderTerminal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Archived thread");
    expect(container.textContent).not.toContain("Undo");
    await React.act(() => root.unmount());
  });

  it("shows the archived warning and no composer in the mobile journey", async () => {
    viewport.mobile = true;
    const { container, root } = await renderSession({
      ...thread,
      lifecycleState: "archived",
    });

    expect(
      container.querySelector('[aria-label="Thread transcript"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Thread composer"]'),
    ).toBeNull();
    expect(container.querySelector('[role="note"]')?.textContent).toBe(
      "Archived. Unarchive to resume or run commands.",
    );
    expect(container.textContent).not.toContain("Undo");
    await React.act(() => root.unmount());
  });
});

describe("ThreadWorkspace cached metadata lifetime", () => {
  it("renders only an explicitly registered pending create without issuing a detail GET", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const registry = new ThreadSessionRegistry(queryClient, userId);
    registry.beginCreation({
      id: threadId,
      project,
      title: thread.title,
      profile: "medium",
      body: "Visible before the POST resolves",
      images: [],
    });
    const fetch = vi.fn(() =>
      Promise.reject(
        new Error("A pending create must not issue a detail GET."),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadSessionRegistryContext value={registry}>
            <ThreadWorkspace />
          </ThreadSessionRegistryContext>
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent).toContain("Visible before the POST resolves");
    expect(container.querySelector('[data-pending-thread=""]')).not.toBeNull();
    expect(container.querySelector(".thread-title-bar")).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Generating thread title"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Project one");
    expect(container.textContent).toContain("medium");
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')
        ?.disabled,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
    registry.clear();
  });

  it("does not reinterpret an arbitrary missing thread as pending", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            status: "error",
            error: { code: "THREAD_NOT_FOUND", message: "Thread not found." },
          },
          { status: 404 },
        ),
      ),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadWorkspace />
        </QueryClientProvider>,
      ),
    );
    await React.act(async () =>
      vi.waitFor(() =>
        expect(container.textContent).toContain("Thread unavailable"),
      ),
    );

    expect(container.querySelector('[data-pending-thread=""]')).toBeNull();
    await React.act(() => root.unmount());
  });

  it.each([
    ["Thread", threadKeys.detail(userId, threadId)],
    ["Project", projectKeys.detail(userId, projectId)],
  ] as const)(
    "keeps the live session and composer draft when %s refresh fails",
    async (_, failedKey) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(threadKeys.detail(userId, threadId), thread);
      queryClient.setQueryData(projectKeys.detail(userId, projectId), project);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await React.act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <ThreadWorkspace />
          </QueryClientProvider>,
        ),
      );
      const composer = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Thread composer"]',
      );
      await React.act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(composer, "sensitive draft");
        composer?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Metadata unavailable")),
      );

      await React.act(async () => {
        await queryClient.refetchQueries({ queryKey: failedKey, exact: true });
        await vi.waitFor(() =>
          expect(queryClient.getQueryState(failedKey)?.error).toBeInstanceOf(
            Error,
          ),
        );
      });
      await React.act(async () =>
        vi.waitFor(() =>
          expect(container.textContent).toContain(
            "Showing the last loaded Thread metadata.",
          ),
        ),
      );

      expect(
        container.querySelector<HTMLTextAreaElement>(
          '[aria-label="Thread composer"]',
        ),
      ).toBe(composer);
      expect(composer?.value).toBe("sensitive draft");
      expect(flue.createClient).toHaveBeenCalledTimes(1);
      await React.act(() => root.unmount());
    },
  );
});
