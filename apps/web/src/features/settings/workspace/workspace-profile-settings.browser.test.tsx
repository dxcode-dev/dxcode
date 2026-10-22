import { WorkspaceProfileDataSchema } from "@dx/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProfileForm } from "./workspace-profile-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const clickButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")]
    .find((button) => button.textContent === label)
    ?.click();

const workspace = Schema.decodeUnknownSync(WorkspaceProfileDataSchema)({
  id: "stable-workspace-id",
  displayName: "DX Team",
  shortName: "dx-team",
  lifecycleState: "active",
  revision: 0,
  role: "owner",
});

describe("workspace profile settings", () => {
  it("shows a member the profile without an Edit button", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProfileForm
        initialWorkspace={{ ...workspace, role: "member" }}
        onDirtyChange={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("DX Team");
    expect(markup).toContain("dx-team");
    expect(markup).not.toContain(">Edit<");
    expect(markup).not.toContain("<input");
  });

  it("locks workspace profile fields while a save is pending", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (saving: boolean) =>
      root.render(
        <WorkspaceProfileForm
          initialWorkspace={workspace}
          onDirtyChange={() => undefined}
          onSaved={() => undefined}
          saving={saving}
        />,
      );
    act(() => render(false));
    act(() => clickButton(container, "Edit"));
    act(() => render(true));

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
        (button) => button.textContent === "Cancel",
      )?.disabled,
    ).toBe(true);
    act(() => root.unmount());
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
    expect(container.querySelector("dd")?.textContent).toBe("Remote Team");
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
    act(() => clickButton(container, "Edit"));
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
    await act(async () => clickButton(container, "Save"));

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
    const saveAs = async (value: string) => {
      act(() => clickButton(container, "Edit"));
      const input = container.querySelector<HTMLInputElement>(
        'input[name="displayName"]',
      );
      await act(() => {
        if (input !== null) {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await act(async () => clickButton(container, "Save"));
    };
    await saveAs("First Save");
    expect(container.querySelector("dd")?.textContent).toBe("First Save");
    await saveAs("Second Save");
    expect(mutateWorkspace.mock.calls[1]?.[0]).toMatchObject({
      input: { expectedRevision: 1 },
    });
    act(() => root.unmount());
    container.remove();
  });
});
