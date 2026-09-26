// @vitest-environment happy-dom

import { WorkspaceProfileDataSchema } from "@dx/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CreateWorkspaceCard,
  WorkspaceProfileForm,
} from "./workspace-profile-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const workspace = Schema.decodeUnknownSync(WorkspaceProfileDataSchema)({
  id: "stable-workspace-id",
  displayName: "DX Team",
  shortName: "dx-team",
  lifecycleState: "active",
  revision: 0,
  role: "owner",
});

describe("workspace profile settings", () => {
  it("renders owner profile editing without identity and lifecycle details", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProfileForm
        initialWorkspace={workspace}
        onDirtyChange={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain('name="displayName"');
    expect(markup).toContain('name="shortName"');
    expect(markup).toContain('aria-label="Copy workspace ID"');
    expect(markup).not.toContain("stable-workspace-id");
    expect(markup).not.toContain("Identity and lifecycle");
    expect(markup).not.toContain("Stable workspace ID");
    expect(markup).toContain("canonical URL");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toMatch(
      /billing|credits|subscription|public profile|hosted.orb|polic/i,
    );
    expect(markup).not.toMatch(/select.*workspace|workspace picker/i);
  });

  it("copies the workspace ID from the profile summary", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={workspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
        />,
      ),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy workspace ID"]')
        ?.click();
    });

    expect(writeText).toHaveBeenCalledWith("stable-workspace-id");
    expect(
      container.querySelector('[aria-label="Workspace ID copied"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it("reveals the workspace ID when clipboard access is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={workspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
        />,
      ),
    );

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy workspace ID"]')
        ?.click();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Copy unavailable.",
    );
    expect(container.querySelector("code")?.textContent).toBe(
      "stable-workspace-id",
    );
    act(() => root.unmount());
  });

  it("keeps member profile visible and read only", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProfileForm
        initialWorkspace={{ ...workspace, role: "member" }}
        onDirtyChange={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("readOnly");
    expect(markup).not.toContain(">Save<");
  });

  it("locks workspace profile fields while a save is pending", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={workspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
          saving
        />,
      ),
    );

    expect(
      container.querySelector<HTMLInputElement>('input[name="displayName"]')
        ?.readOnly,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[name="shortName"]')
        ?.readOnly,
    ).toBe(true);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Reset",
      )?.disabled,
    ).toBe(true);
    act(() => root.unmount());
  });

  it("offers first-workspace creation without a chooser", () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceCard
        onDirtyChange={() => undefined}
        onCreated={() => undefined}
      />,
    );

    expect(markup).toContain("Create workspace");
    expect(markup).toContain("You can belong to one workspace");
    expect(markup).toContain("/workspaces/");
    expect(markup).not.toMatch(/select|switch workspace|picker/i);
  });

  it("adopts a newer profile when the form is clean", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (initialWorkspace: typeof workspace) =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={initialWorkspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
        />,
      );

    act(() => render(workspace));
    act(() =>
      render({
        ...workspace,
        displayName: "Remote Team" as typeof workspace.displayName,
        revision: 1,
      }),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[name="displayName"]')
        ?.value,
    ).toBe("Remote Team");
    act(() => root.unmount());
  });

  it("keeps a dirty draft on its original revision and preserves it after conflict", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mutateWorkspace = vi.fn().mockRejectedValue(new Error("conflict"));
    const render = (initialWorkspace: typeof workspace) =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={initialWorkspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
          mutateWorkspace={mutateWorkspace}
        />,
      );

    act(() => render(workspace));
    const displayName = container.querySelector<HTMLInputElement>(
      'input[name="displayName"]',
    );
    await act(() => {
      if (displayName !== null) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(displayName, "Local Draft");
        displayName.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    act(() =>
      render({
        ...workspace,
        displayName: "Remote Team" as typeof workspace.displayName,
        revision: 1,
      }),
    );
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")
        ?.click();
    });

    expect(mutateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          displayName: "Local Draft",
          expectedRevision: 0,
        }),
      }),
    );
    expect(displayName?.value).toBe("Local Draft");
    expect(container.textContent).toContain(
      "Workspace profile could not be saved.",
    );
    act(() => root.unmount());
    container.remove();
  });

  it("adopts the returned revision after a successful save", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mutateWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        ...workspace,
        displayName: "First Save",
        revision: 1,
      })
      .mockRejectedValueOnce(new Error("stop"));
    act(() =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={workspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
          mutateWorkspace={mutateWorkspace}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[name="displayName"]',
    );
    const save = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      );
    await act(() => {
      if (input !== null) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "First Save");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      save()?.click();
    });
    await act(() => {
      if (input !== null) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, "Second Save");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      save()?.click();
    });
    expect(mutateWorkspace.mock.calls[1]?.[0]).toMatchObject({
      input: { expectedRevision: 1 },
    });
    act(() => root.unmount());
    container.remove();
  });
});
