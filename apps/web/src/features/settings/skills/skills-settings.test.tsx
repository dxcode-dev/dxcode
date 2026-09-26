// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
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
  overridesPersonal: false,
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
    precedence: "workspace-over-personal" as const,
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

const mountSkills = async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    skillsQueryOptions(userId, target).queryKey,
    skillsListResponse.data as never,
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={queryClient}>
          <SkillsSettings onDirtyChange={() => undefined} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    ),
  );
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
    const dialog = document.querySelector(".skill-review-dialog");
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  });

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SkillsSettings import routing", () => {
  it("imports an export as a fresh skill after a dismissed Update instead of switching to an unrelated skill", async () => {
    const network = new FrontendNetworkHarness(
      respondSkills({
        name: "writing-helper",
        description: "Helps with writing.",
      }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const { container, root } = await mountSkills();

    await act(() => findButtonByText(container, "Update").click());
    expect(document.querySelector(".skill-review-dialog")).toBeNull();
    await act(() => setInputFiles(folderInputOf(container), []));
    expect(document.querySelector(".skill-review-dialog")).toBeNull();

    await act(() => findButtonByText(container, "Import export").click());
    await act(() =>
      setInputFiles(exportInputOf(container), [
        exportedPayload("writing-helper", "Helps with writing."),
      ]),
    );

    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("Review skill import");
    expect(dialog.textContent).not.toContain("code-reviewer update");
    expect(findButtonByText(dialog, "Import reviewed skill")).toBeDefined();

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

  it("publishes an activated new version when a real Update selection is made (regression guard for the legitimate publish path)", async () => {
    const network = new FrontendNetworkHarness(
      respondSkills({ name: "code-reviewer", description: "Reviews code." }),
    );
    vi.stubGlobal("fetch", network.fetch);
    const { container, root } = await mountSkills();

    await act(() => findButtonByText(container, "Update").click());
    await act(() =>
      setInputFiles(folderInputOf(container), [
        exportedPayload("code-reviewer", "Reviews code."),
      ]),
    );

    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("Review code-reviewer update");
    expect(findButtonByText(dialog, "Publish and activate")).toBeDefined();

    await act(() => findButtonByText(dialog, "Publish and activate").click());
    await vi.waitFor(() => {
      expect(
        network.requests.filter(
          (request) =>
            request.method === "POST" &&
            request.url === skillVersionEndpoint(codeReviewer.id),
        ).length,
      ).toBeGreaterThan(0);
    });

    await act(() => root.unmount());
  });
});
