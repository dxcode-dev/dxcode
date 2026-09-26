import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureScreenshot,
  createPendingImageCollection,
  deliveredImages,
  readImage,
  readSelectedImages,
} from "./image-attachments.js";

const png = (name = "image.png", lastModified = 1) =>
  new File(
    [
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...(lastModified === 1 ? [] : [lastModified % 256]),
      ]),
    ],
    name,
    { type: "image/png", lastModified },
  );

afterEach(() => vi.restoreAllMocks());

describe("image attachments", () => {
  it("uses detected MIME and exposes only Flue's image contract", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const image = await readImage(png());
    expect(image.mimeType).toBe("image/png");
    expect(deliveredImages([image])).toEqual([
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        filename: "image.png",
      },
    ]);
    image.disposePreview();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  it("accepts verified image bytes when the picker omits the MIME type", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const file = new File([await png().arrayBuffer()], "image.png");
    await expect(readImage(file)).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("rejects spoofed and duplicate selections", async () => {
    await expect(
      readImage(new File(["not png"], "bad.png", { type: "image/png" })),
    ).rejects.toThrow("not a valid");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const image = await readImage(png());
    await expect(readSelectedImages([png()], [image])).rejects.toThrow(
      "already attached",
    );
  });

  it("uses content identities instead of colliding file metadata", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const first = png("same.png", 1);
    const second = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])],
      "same.png",
      { type: "image/png", lastModified: 1 },
    );
    const images = await readSelectedImages([first, second], []);
    expect(images[0]?.id).not.toBe(images[1]?.id);
  });

  it("serializes concurrent selections and limits a message to ten images", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const collection = createPendingImageCollection();
    const first = collection.addFiles(
      Array.from({ length: 10 }, (_, index) => png(`${index}.png`, index)),
    );
    const second = collection.addFiles([png("next.png", 20)]);
    await expect(first).resolves.toHaveLength(10);
    await expect(second).rejects.toThrow("no more than 10 images");
  });

  it("limits generated images and preserves previews across retry", async () => {
    const collection = createPendingImageCollection();
    const makeImage = (index: number) => ({
      id: `image-${index}`,
      type: "image" as const,
      data: "data",
      mimeType: "image/png" as const,
      filename: `${index}.png`,
      previewUrl: `blob:${index}`,
      disposePreview: vi.fn(),
    });
    const attached = Array.from({ length: 10 }, (_, index) => makeImage(index));
    for (const image of attached) collection.addImage(image);
    const next = makeImage(10);
    expect(() => collection.addImage(next)).toThrow("no more than 10 images");
    expect(next.disposePreview).toHaveBeenCalledOnce();
    const create = vi.fn(async () => makeImage(11));
    await expect(collection.addGenerated(create)).rejects.toThrow(
      "no more than 10 images",
    );
    expect(create).not.toHaveBeenCalled();

    const submitted = collection.take();
    expect(collection.restore(submitted)).toHaveLength(10);
    expect(
      attached.every((image) => image.disposePreview.mock.calls.length === 0),
    ).toBe(true);
  });

  it("allows several individually valid images beyond the old aggregate limit", () => {
    const collection = createPendingImageCollection();
    const first = {
      id: "first",
      type: "image" as const,
      data: "a".repeat(8 * 1024 * 1024),
      mimeType: "image/png" as const,
      filename: "first.png",
      previewUrl: "blob:first",
      disposePreview: vi.fn(),
    };
    const second = {
      ...first,
      id: "second",
      data: "a".repeat(8 * 1024 * 1024),
      filename: "second.png",
      previewUrl: "blob:second",
      disposePreview: vi.fn(),
    };
    collection.addImage(first);
    expect(collection.addImage(second)).toHaveLength(2);
    expect(second.disposePreview).not.toHaveBeenCalled();
  });

  it("rejects oversized files before allocating their contents", async () => {
    const file = png();
    Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 });
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(readImage(file)).rejects.toThrow("encoded limit");
    expect(read).not.toHaveBeenCalled();
  });

  it("reports unsupported capture", async () => {
    vi.stubGlobal("navigator", {});
    await expect(captureScreenshot()).rejects.toThrow("not supported");
  });

  it("disposes previews allocated before a later selection fails", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first");
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    await expect(
      readSelectedImages(
        [png("first.png"), new File(["bad"], "bad.png", { type: "image/png" })],
        [],
      ),
    ).rejects.toThrow("not a valid");

    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:first");
  });

  it("reports denial and stops every acquired track", async () => {
    const stop = vi.fn();
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [{ stop }, { stop }],
    } as unknown as MediaStream;
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    await expect(captureScreenshot()).rejects.toThrow("No screen was selected");
    expect(stop).toHaveBeenCalledTimes(2);

    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    await expect(captureScreenshot()).rejects.toThrow("cancelled or denied");
  });
});
