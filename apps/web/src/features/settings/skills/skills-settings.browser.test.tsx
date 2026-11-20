import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";

// The Files pane's editor, as a plain text box: the page owns what Save does.
vi.mock("../../../shared/ui/file-view-editor.js", () => ({
  FileViewEditor: ({
    content,
    onChange,
  }: {
    readonly content: string;
    readonly onChange: (content: string) => void;
  }) => (
    <textarea
      aria-label="File editor"
      defaultValue={content}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { FrontendNetworkHarness } from "../../../testing/frontend-network-harness.js";
import { skillsQueryOptions } from "./skills-queries.js";
import { SkillsSettings } from "./skills-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_test" as never;
const target = { scope: "personal" } as const;
const integrity = "a".repeat(64);
const timestamp = "2026-08-25T10:00:00.000Z";

const manifest = (name: string, description: string) => ({
  schemaVersion: 1 as const,
  name,
  description,
  mcpServerIds: [] as ReadonlyArray<string>,
});

const versionData = (name: string, description: string) => ({
  version: 1,
  manifest: manifest(name, description),
  instructions: `${name} instructions.`,
  resources: [] as ReadonlyArray<unknown>,
  source: { type: "browser-files", label: "Browser file selection" },
  integrity,
  createdAt: timestamp,
});

const skillData = (id: string, name: string, description: string) => ({
  id,
  scope: "personal" as const,
  name,
  enabled: true,
  activeVersion: 1,
  pinned: false,
  versions: [1],
  active: versionData(name, description),
  effectiveState: "effective" as const,
  overridesWorkspace: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const codeReviewer = skillData(
  "skl_00000000-0000-4000-8000-000000000001",
  "code-reviewer",
  "Reviews code.",
);
const writingHelper = skillData(
  "skl_00000000-0000-4000-8000-000000000002",
  "writing-helper",
  "Helps with writing.",
);

const skillsListResponse = {
  status: "success",
  data: {
    items: [codeReviewer, writingHelper],
    canMutate: true,
    precedence: "personal-over-workspace" as const,
  },
};

const previewResponse = (name: string, description: string) => ({
  status: "success",
  data: {
    manifest: manifest(name, description),
    instructions: `${name} instructions.`,
    resources: [] as ReadonlyArray<unknown>,
    source: { type: "browser-files", label: "Browser file selection" },
    integrity,
    totalBytes: 2,
  },
});

const exportedPayload = (name: string, description: string) =>
  new File(
    [
      JSON.stringify({
        source: { type: "browser-files", label: "Exported skill" },
        files: [
          {
            path: "skill.json",
            kind: "file",
            mediaType: "application/json",
            encoding: "utf-8",
            content: JSON.stringify(manifest(name, description)),
          },
          {
            path: "instructions.md",
            kind: "file",
            mediaType: "text/markdown",
            encoding: "utf-8",
            content: `${name} instructions.`,
          },
        ],
      }),
    ],
    `${name}.skill.json`,
    { type: "application/json" },
  );

const skillsImportEndpoint = "/v1/settings/personal/skills";
const skillsPreviewEndpoint = "/v1/settings/personal/skills/preview";
const skillVersionEndpoint = (id: string) =>
  `/v1/settings/personal/skills/${id}/versions`;
const skillExportEndpoint = (id: string) =>
  `/v1/settings/personal/skills/${id}/export`;

const respondSkills =
  (preview: { readonly name: string; readonly description: string }) =>
  ({ method, url }: { readonly method: string; readonly url: string }) => {
    if (method === "GET" && url === skillsImportEndpoint)
      return Response.json(skillsListResponse);
    if (method === "POST" && url === skillsPreviewEndpoint)
      return Response.json(previewResponse(preview.name, preview.description));
    if (method === "POST" && url === skillsImportEndpoint)
      return Response.json(
        { status: "success", data: writingHelper },
        { status: 201 },
      );
    if (method === "GET" && url === skillExportEndpoint(codeReviewer.id))
      return Response.json({
        status: "success",
        data: {
          source: { type: "browser-files", label: "Exported skill" },
          integrity,
          files: [],
        },
      });
    if (method === "POST" && url === skillVersionEndpoint(codeReviewer.id))
      return Response.json(
        {
          status: "success",
          data: {
            ...codeReviewer,
            activeVersion: 2,
            versions: [2, 1],
            active: { ...codeReviewer.active, version: 2 },
          },
        },
        { status: 201 },
      );
    return Response.json(
      {
        status: "error",
        data: {
          code: "UNHANDLED",
          message: `Unhandled ${method} ${url}`,
        },
      },
      { status: 599 },
    );
  };

const authValue = {
  identity: {
    id: userId,
    name: "Test User",
    email: "test@example.com",
  },
  logout: () => undefined,
};

const mountSkills = async (data: unknown = skillsListResponse.data) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    skillsQueryOptions(userId, target).queryKey,
    data as never,
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // The page reads a linked proposal from the URL, so it needs a router.
  const rootRoute = createRootRoute({
    component: () => <SkillsSettings onDirtyChange={() => undefined} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/settings/skills"] }),
  });
  await act(async () => {
    root.render(
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    await router.load();
  });
  return { queryClient, container, root };
};

const setInputFiles = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const findButtonByText = (scope: ParentNode, text: string) => {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button with text "${text}" not found.`);
  return button;
};

const folderInputOf = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Select skill folder"]',
  );
  if (!input) throw new Error("Folder input not found.");
  return input;
};
const exportInputOf = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Select exported skill"]',
  );
  if (!input) throw new Error("Export input not found.");
  return input;
};

const waitForDialog = () =>
  vi.waitFor(() => {
    const dialog = document.querySelector(".skill-import-review");
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  });

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const clickMenuItem = async (text: string) => {
  const item = await vi.waitFor(() => {
    const found = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((candidate) => candidate.textContent?.trim() === text);
    if (!found) throw new Error(`Menu item "${text}" not found.`);
    return found;
  });
  await act(() => item.click());
};

/** Opens Add skill → Upload a folder. */
const openImport = async (container: HTMLElement) => {
  await act(() => findButtonByText(container, "Add skill").click());
  await clickMenuItem("Upload a folder");
};

describe("SkillsSettings import routing", () => {
  it("offers a prompt to copy when there are no personal skills", async () => {
    const copied: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async (text: string) => copied.push(text) },
    });
    const { container, root } = await mountSkills({
      ...skillsListResponse.data,
      items: [],
    });
    const prompt = "Create a personal skill for writing our release notes";
    expect(container.textContent).toContain(prompt);
    await act(async () => findButtonByText(container, "Copy prompt").click());
    expect(copied).toEqual([prompt]);
    expect(container.textContent).toContain("Copied");
    await act(() => root.unmount());
  });

  it("imports an export as a new skill, not a version of the open one", async () => {
    const network = new FrontendNetworkHarness(
      respondSkills({
        name: "writing-helper",
        description: "Helps with writing.",
      }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const { container, root } = await mountSkills();

    await openImport(container);
    await act(() => findButtonByText(document, "Choose .skill.json").click());
    await act(() =>
      setInputFiles(exportInputOf(container), [
        exportedPayload("writing-helper", "Helps with writing."),
      ]),
    );

    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("Review skill import");
    await act(() => findButtonByText(dialog, "Import reviewed skill").click());
    await vi.waitFor(() => {
      expect(
        network.requests.filter(
          (request) =>
            request.method === "POST" && request.url === skillsImportEndpoint,
        ).length,
      ).toBeGreaterThan(0);
    });
    expect(
      network.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url === skillVersionEndpoint(codeReviewer.id),
      ),
    ).toEqual([]);

    await act(() => root.unmount());
  });

  it("uploads a file quoting U+FFFD as text, and refuses a file that is not UTF-8 by name", async () => {
    const network = new FrontendNetworkHarness(
      respondSkills({ name: "captions", description: "Captions." }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const { container, root } = await mountSkills();
    const skill = new File(
      ["---\nname: captions\ndescription: Captions.\n---\n\nUse it.\n"],
      "SKILL.md",
      { type: "text/markdown" },
    );
    const quoting = new File(
      ["Over 20% `\uFFFD` tokens means it failed.\n"],
      "captions.md",
      { type: "text/markdown" },
    );

    await act(() => setInputFiles(folderInputOf(container), [skill, quoting]));
    const preview = await vi.waitFor(() => {
      const request = network.requests.find(
        ({ method, url }) => method === "POST" && url === skillsPreviewEndpoint,
      );
      expect(request).toBeDefined();
      return request;
    });
    const sent = JSON.parse(String(preview && network.bodyOf(preview))) as {
      files: Array<{ path: string; content: string }>;
    };
    expect(sent.files.find(({ path }) => path === "captions.md")?.content).toBe(
      "Over 20% `\uFFFD` tokens means it failed.\n",
    );

    const before = network.requests.length;
    const image = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])],
      "logo.png",
      {
        type: "image/png",
      },
    );
    await act(() => setInputFiles(folderInputOf(container), [skill, image]));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "logo.png: Only valid UTF-8 text without NUL bytes is allowed.",
      ),
    );
    expect(network.requests.slice(before)).toEqual([]);

    await act(() => root.unmount());
  });

  it("publishes an edited SKILL.md as the skill's next active version", async () => {
    const network = new FrontendNetworkHarness(
      respondSkills({ name: "code-reviewer", description: "Reviews diffs." }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const { container, root } = await mountSkills();

    expect(container.querySelector(".skill-browser h2")?.textContent).toBe(
      "code-reviewer",
    );
    await act(() => findButtonByText(container, "Edit").click());
    const editor = await vi.waitFor(() => {
      const found = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="File editor"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLTextAreaElement;
    });
    const edited =
      "---\nname: code-reviewer\ndescription: Reviews diffs.\n---\n\nReview the diff.\n";
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(editor, edited);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => findButtonByText(container, "Save").click());

    const published = await vi.waitFor(() => {
      const request = network.requests.find(
        ({ method, url }) =>
          method === "POST" && url === skillVersionEndpoint(codeReviewer.id),
      );
      expect(request).toBeDefined();
      return request;
    });
    const body = JSON.parse(String(published && network.bodyOf(published))) as {
      readonly bundle: {
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly content: string;
        }>;
      };
      readonly activate: boolean;
    };
    expect(body.activate).toBe(true);
    const files = new Map(body.bundle.files.map((f) => [f.path, f.content]));
    expect(JSON.parse(files.get("skill.json") ?? "{}")).toMatchObject({
      name: "code-reviewer",
      description: "Reviews diffs.",
    });
    expect(files.get("instructions.md")).toBe("code-reviewer instructions.\n");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("code-reviewer version 2 saved."),
    );

    await act(() => root.unmount());
  });
});
