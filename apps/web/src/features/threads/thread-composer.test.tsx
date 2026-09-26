// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadComposer } from "./thread-composer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => document.body.replaceChildren());

const mountComposer = async (options?: {
  busy?: boolean;
  attachment?: boolean;
  dictationAvailable?: boolean;
}) => {
  const onAbort = vi.fn();
  const onRemoveAttachment = vi.fn();
  const onSubmit = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    const [draft, setDraft] = React.useState("");
    return (
      <ThreadComposer
        attachments={
          options?.attachment
            ? [{ id: "image-1", filename: "one.png", previewUrl: "one" }]
            : []
        }
        busy={options?.busy ?? false}
        dictationAvailable={options?.dictationAvailable}
        draft={draft}
        onAbort={onAbort}
        onAttachmentsSelected={vi.fn()}
        onDraftChange={setDraft}
        onRemoveAttachment={onRemoveAttachment}
        onSubmit={onSubmit}
      />
    );
  }

  const queryClient = new QueryClient();
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  return { container, onAbort, onRemoveAttachment, onSubmit, root };
};

const type = async (textarea: HTMLTextAreaElement, value: string) => {
  await React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("ThreadComposer", () => {
  it("only renders dictation when Sarvam is available", async () => {
    const absent = await mountComposer();
    expect(
      absent.container.querySelector('[aria-label="Start dictation"]'),
    ).toBeNull();

    const configured = await mountComposer({ dictationAvailable: true });
    expect(
      configured.container.querySelector('[aria-label="Start dictation"]'),
    ).not.toBeNull();
  });

  it("submits Enter, preserves Shift+Enter, and ignores composing Enter", async () => {
    const mounted = await mountComposer();
    const textarea = mounted.container.querySelector("textarea");
    if (textarea === null) throw new Error("Expected composer editor.");
    await type(textarea, "hello");

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
        shiftKey: true,
      }),
    );
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        isComposing: true,
        key: "Enter",
      }),
    );
    expect(mounted.onSubmit).not.toHaveBeenCalled();

    await React.act(() =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );
    expect(mounted.onSubmit).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea);
  });

  it("gates empty send, retains send and stop while busy, and supports attachment removal", async () => {
    const idle = await mountComposer({ attachment: true });
    expect(idle.container.querySelector("textarea")?.placeholder).toBe("");
    expect(
      idle.container.querySelector<HTMLButtonElement>(
        '[aria-label="Send message"]',
      )?.disabled,
    ).toBe(false);
    const remove = idle.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove one.png"]',
    );
    remove?.click();
    expect(idle.onRemoveAttachment).toHaveBeenCalledWith("image-1");
    expect(document.activeElement).toBe(
      idle.container.querySelector("textarea"),
    );

    await React.act(() =>
      idle.container
        .querySelector<HTMLButtonElement>('[aria-label="Preview one.png"]')
        ?.click(),
    );
    expect(
      document.querySelector('[aria-label="Close image preview"]'),
    ).not.toBeNull();
    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')
        ?.click(),
    );
    expect(
      document.querySelector('[aria-label="Close image preview"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(
      idle.container.querySelector('[aria-label="Preview one.png"]'),
    );

    const busy = await mountComposer({ busy: true });
    const busyTextarea = busy.container.querySelector("textarea");
    const busySend = busy.container.querySelector<HTMLButtonElement>(
      '[aria-label="Send message during active run"]',
    );
    expect(busySend?.disabled).toBe(true);
    if (busyTextarea === null)
      throw new Error("Expected busy composer editor.");
    await type(busyTextarea, "Additional direction");
    expect(busySend?.disabled).toBe(false);
    busySend?.click();
    expect(busy.onSubmit).toHaveBeenCalledOnce();
    busy.container
      .querySelector<HTMLButtonElement>('[aria-label="Stop agent"]')
      ?.click();
    expect(busy.onAbort).toHaveBeenCalledOnce();
  });
});
