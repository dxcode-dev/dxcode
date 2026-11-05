import type { ProjectData } from "@dx/api";
import type { ModeId, ThreadVisibility } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import { NewThreadConfigurationStrip } from "./new-thread-configuration-strip.js";

// #1635: the composer's ⋮ menu sets who can see the Thread from its start.

const projects = [] as ReadonlyArray<ProjectData>;

async function mountStrip({ inWorkspace }: { readonly inWorkspace: boolean }) {
  const container = document.body.appendChild(document.createElement("div"));
  container.className = "new-thread-dialog";
  const root = createRoot(container);
  const chosen = vi.fn();
  function Harness() {
    const [visibility, setVisibility] =
      React.useState<ThreadVisibility>("private");
    return (
      <NewThreadConfigurationStrip
        projects={projects}
        projectId=""
        profile={"medium" as ModeId}
        locked={false}
        submitting={false}
        ready
        retrying={false}
        onProjectChange={() => undefined}
        onModelChange={() => undefined}
        onProfileChange={() => undefined}
        visibility={visibility}
        onVisibilityChange={
          inWorkspace
            ? (next) => {
                chosen(next);
                setVisibility(next);
              }
            : undefined
        }
      />
    );
  }
  await React.act(() => root.render(<Harness />));
  return { container, root, chosen };
}

const optionsButton = () =>
  page.getByRole("button", { name: /^Create Thread options/ });

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1280, 800);
});

describe.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])("Create Thread options at $width x $height", (viewport) => {
  it("makes a Thread visible to the workspace from Visibility", async () => {
    await page.viewport(viewport.width, viewport.height);
    const { root, chosen } = await mountStrip({ inWorkspace: true });
    await expect
      .element(optionsButton())
      .toHaveAccessibleName("Create Thread options");
    await optionsButton().click();
    const visibilityRow = page.getByRole("menuitem", { name: /Visibility/ });
    await expect.element(visibilityRow).toHaveTextContent("Private");
    await visibilityRow.click();
    const workspace = page.getByRole("menuitemradio", { name: /Workspace/ });
    await expect
      .element(page.getByRole("menuitemradio", { name: /Private/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(workspace)
      .toHaveTextContent("Visible to all members of the workspace");
    const submenu = document.querySelector(
      '[role="menu"][aria-label="Visibility"]',
    );
    if (submenu === null) throw new Error("Expected the Visibility submenu.");
    const { left, right, top, bottom } = submenu.getBoundingClientRect();
    // Fully on screen, so both choices can be tapped on a phone.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(innerWidth);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(innerHeight);
    await workspace.click();
    expect(chosen).toHaveBeenCalledExactlyOnceWith("workspace");
    // The trigger says the Thread will be shared.
    await expect
      .element(optionsButton())
      .toHaveAccessibleName("Create Thread options: visible to the workspace");
    await React.act(() => root.unmount());
  });
});

describe("Create Thread options outside a workspace", () => {
  it("offers no options, so the Thread stays private", async () => {
    const { container, root } = await mountStrip({ inWorkspace: false });
    expect(container.querySelector(".new-thread-options")).toBeNull();
    await React.act(() => root.unmount());
  });
});
