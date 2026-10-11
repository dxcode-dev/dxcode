// @vitest-environment happy-dom

import { PersonalAgentInstructionsDataSchema } from "@dx/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/client.js";
import { PersonalAgentInstructionsForm } from "./personal-advanced-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const instructions = (revision: number, value: string) =>
  Schema.decodeUnknownSync(PersonalAgentInstructionsDataSchema)({
    instructions: value,
    revision,
    version: 1,
    updatedAt: `2026-08-2${revision}T12:00:00.000Z`,
  });

describe("personal Advanced settings", () => {
  it("keeps a dirty draft on its original revision when a newer revision arrives", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const updateInstructions = vi.fn().mockRejectedValue(new Error("conflict"));
    const renderForm = (revision: number, value: string, saving = false) => (
      <PersonalAgentInstructionsForm
        initialSettings={instructions(revision, value)}
        onDirtyChange={() => undefined}
        onReload={() => Promise.resolve(undefined)}
        updateInstructions={updateInstructions}
        resetInstructions={() => Promise.reject(new Error("not submitted"))}
        saving={saving}
      />
    );

    act(() => root.render(renderForm(3, "Original")));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      if (textarea !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(textarea, "Local draft");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    act(() => root.render(renderForm(4, "Remote revision")));

    expect(textarea?.value).toBe("Local draft");
    await act(async () => {
      textarea?.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(updateInstructions).toHaveBeenCalledWith({
      instructions: "Local draft",
      expectedRevision: 3,
    });

    act(() => root.render(renderForm(4, "Remote revision", true)));
    expect(textarea?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it("keeps a conflicting draft when reloading fails", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onDirtyChange = vi.fn();
    const onReload = vi.fn().mockResolvedValue(undefined);

    act(() =>
      root.render(
        <PersonalAgentInstructionsForm
          initialSettings={instructions(3, "Original")}
          onDirtyChange={onDirtyChange}
          onReload={onReload}
          updateInstructions={() =>
            Promise.reject(
              new ApiError(
                409,
                "Agent instructions changed in another session.",
                "PERSONAL_AGENT_INSTRUCTIONS_CONFLICT",
                undefined,
                4,
                true,
              ),
            )
          }
          resetInstructions={() => Promise.reject(new Error("not submitted"))}
        />,
      ),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Local draft");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea?.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    });
    const reload = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Reload latest",
    );
    await act(async () => reload?.click());

    expect(onReload).toHaveBeenCalledOnce();
    expect(textarea?.value).toBe("Local draft");
    expect(container.textContent).toContain(
      "Latest agent instructions could not be loaded.",
    );
    expect(container.textContent).toContain("revision 4");
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
    act(() => root.unmount());
  });

  it("adopts the fetched revision only after reloading succeeds", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onDirtyChange = vi.fn();
    let resolveReload: (
      latest: ReturnType<typeof instructions> | undefined,
    ) => void = () => undefined;
    const reloadResult = new Promise<
      ReturnType<typeof instructions> | undefined
    >((resolve) => {
      resolveReload = resolve;
    });
    const onReload = vi.fn().mockReturnValue(reloadResult);

    act(() =>
      root.render(
        <PersonalAgentInstructionsForm
          initialSettings={instructions(3, "Original")}
          onDirtyChange={onDirtyChange}
          onReload={onReload}
          updateInstructions={() =>
            Promise.reject(
              new ApiError(
                409,
                "Agent instructions changed in another session.",
                "PERSONAL_AGENT_INSTRUCTIONS_CONFLICT",
                undefined,
                4,
                true,
              ),
            )
          }
          resetInstructions={() => Promise.reject(new Error("not submitted"))}
        />,
      ),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Local draft");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea?.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    });
    const reload = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Reload latest",
    );
    act(() => reload?.click());

    expect(textarea?.disabled).toBe(true);
    expect(
      [
        ...(container
          .querySelector(".settings-form-actions")
          ?.querySelectorAll("button") ?? []),
      ].every(({ disabled }) => disabled),
    ).toBe(true);
    await act(async () => resolveReload(instructions(4, "Remote revision")));

    expect(textarea?.value).toBe("Remote revision");
    expect(container.textContent).not.toContain(
      "Another session saved revision",
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    act(() => root.unmount());
  });

  it("disables Reset to empty while an unsaved draft exists and preserves the draft", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const resetInstructions = vi.fn().mockResolvedValue(instructions(4, ""));
    const onDirtyChange = vi.fn();

    act(() =>
      root.render(
        <PersonalAgentInstructionsForm
          initialSettings={instructions(3, "Be helpful")}
          onDirtyChange={onDirtyChange}
          onReload={() => Promise.resolve(undefined)}
          updateInstructions={() => Promise.reject(new Error("not submitted"))}
          resetInstructions={resetInstructions}
        />,
      ),
    );

    const reset = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Reset to empty"),
    );
    // A clean form with a non-empty saved revision keeps reset available.
    expect(reset?.disabled).toBe(false);

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Unsaved draft I have not saved yet");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The guard fires the moment the draft becomes dirty, so the destructive
    // reset cannot wipe the draft or falsely report the form as clean.
    expect(reset?.disabled).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(textarea?.value).toBe("Unsaved draft I have not saved yet");
    expect(resetInstructions).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("resets the saved revision to empty from a clean state without dropping a draft", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const resetInstructions = vi.fn().mockResolvedValue(instructions(4, ""));
    const onDirtyChange = vi.fn();

    act(() =>
      root.render(
        <PersonalAgentInstructionsForm
          initialSettings={instructions(3, "Be helpful")}
          onDirtyChange={onDirtyChange}
          onReload={() => Promise.resolve(undefined)}
          updateInstructions={() => Promise.reject(new Error("not submitted"))}
          resetInstructions={resetInstructions}
        />,
      ),
    );

    const reset = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Reset to empty"),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(reset?.disabled).toBe(false);

    await act(async () => reset?.click());

    expect(resetInstructions).toHaveBeenCalledWith(3);
    expect(textarea?.value).toBe("");
    expect(container.textContent).toContain("Revision 4");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    // The saved revision is now empty, so reset stays disabled.
    expect(reset?.disabled).toBe(true);

    act(() => root.unmount());
  });
});
