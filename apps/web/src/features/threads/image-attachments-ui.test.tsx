// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PendingImage } from "./image-attachments.js";
import { AttachmentMenu, ImagePreviews } from "./image-attachments-ui.js";

const image = (disposePreview: () => void) =>
  ({
    id: "image-id",
    type: "image",
    data: "data",
    mimeType: "image/png",
    filename: "image.png",
    previewUrl: "blob:preview",
    disposePreview,
  }) as PendingImage;

describe("image attachment controls", () => {
  it("does not revoke previews merely because their UI unmounts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const dispose = vi.fn();
    await React.act(() =>
      root.render(
        <ImagePreviews images={[image(dispose)]} onRemove={() => {}} />,
      ),
    );
    await React.act(() =>
      root.render(<ImagePreviews images={[]} onRemove={() => {}} />),
    );
    expect(dispose).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("opens a thumbnail preview without treating it as the remove control", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onRemove = vi.fn();
    await React.act(() =>
      root.render(
        <ImagePreviews images={[image(vi.fn())]} onRemove={onRemove} />,
      ),
    );

    const preview = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview image.png"]',
    );
    expect(preview?.className).toBe("composer-attachment-preview");
    await React.act(() => preview?.click());
    expect(
      document.querySelector('[aria-label="Close image preview"]'),
    ).not.toBeNull();
    expect(onRemove).not.toHaveBeenCalled();

    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')
        ?.click(),
    );
    expect(
      document.querySelector('[aria-label="Close image preview"]'),
    ).toBeNull();
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove image.png"]')
        ?.click(),
    );
    expect(onRemove).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
    container.remove();
  });

  it("closes and disables every attachment action when submission locks", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onFiles = vi.fn();
    const onScreenshot = vi.fn();
    await React.act(() =>
      root.render(
        <AttachmentMenu onFiles={onFiles} onScreenshot={onScreenshot} />,
      ),
    );
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Add Images & Files"]')
        ?.click(),
    );
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    await React.act(() =>
      document
        .querySelector('[role="menu"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Add Images & Files"]')
        ?.click(),
    );
    await React.act(() =>
      root.render(
        <AttachmentMenu
          disabled
          onFiles={onFiles}
          onScreenshot={onScreenshot}
        />,
      ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector("input")?.disabled).toBe(true);
    await React.act(() => root.unmount());
    container.remove();
  });
});
