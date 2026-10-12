import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentUpload } from "./attachment-upload.js";
import {
  captureScreenshot,
  createPendingAttachmentCollection,
  messageWithAttachments,
  readAttachment,
} from "./image-attachments.js";

const png = (name = "image.png") =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: "image/png",
  });

const uploaded = (file: File, cancel = vi.fn()): AttachmentUpload => {
  const attachment = {
    id: `att_${"0".repeat(32)}`,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    url: `https://dx.example/v1/attachments/att_${"0".repeat(32)}/${file.name}`,
  };
  return {
    getSnapshot: () => ({ status: "ready", attachment }),
    subscribe: () => () => {},
    settled: Promise.resolve(attachment),
    cancel,
  };
};

afterEach(() => vi.restoreAllMocks());

describe("file attachments", () => {
  it("sends only the uploaded files' references with the message", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const attachment = readAttachment(png(), (file) => uploaded(file));
    await expect(messageWithAttachments("Look", [attachment])).resolves.toBe(
      `Look\n\n<dx_attachments>\n<dx_attachment id="att_${"0".repeat(32)}" name="image.png" type="image/png" size="4" url="https://dx.example/v1/attachments/att_${"0".repeat(32)}/image.png" />\n</dx_attachments>`,
    );
    attachment.disposePreview();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  it("fails the message with the first failed upload", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const failed = readAttachment(png("broken.png"), () => ({
      getSnapshot: () => ({ status: "failed", error: "Network" }),
      subscribe: () => () => {},
      settled: Promise.reject(new Error("broken.png: Network")),
      cancel: vi.fn(),
    }));
    await expect(messageWithAttachments("", [failed])).rejects.toThrow(
      "broken.png: Network",
    );
  });

  it("serializes concurrent selections and limits a message to ten files", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const collection = createPendingAttachmentCollection((file) =>
      uploaded(file),
    );
    const first = collection.addFiles(
      Array.from({ length: 10 }, (_, index) => png(`${index}.png`)),
    );
    const second = collection.addFiles([png("next.png")]);
    await expect(first).resolves.toHaveLength(10);
    await expect(second).rejects.toThrow("no more than 10 files");
  });

  it("limits generated files and keeps uploads across retry", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const cancel = vi.fn();
    const collection = createPendingAttachmentCollection((file) =>
      uploaded(file, cancel),
    );
    await collection.addFiles(
      Array.from({ length: 10 }, (_, index) => png(`${index}.png`)),
    );
    const create = vi.fn(async () => png("screenshot.png"));
    await expect(collection.addGenerated(create)).rejects.toThrow(
      "no more than 10 files",
    );
    expect(create).not.toHaveBeenCalled();
    const submitted = collection.take();
    expect(collection.restore(submitted)).toHaveLength(10);
    expect(revoke).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects empty files and files over 500 MB before uploading", () => {
    const upload = vi.fn();
    const large = png("large.mp4");
    Object.defineProperty(large, "size", { value: 500 * 1024 * 1024 + 1 });
    expect(() => readAttachment(large, upload)).toThrow("500 MB limit");
    expect(() => readAttachment(new File([], "empty.txt"), upload)).toThrow(
      "is empty",
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("discards files read before a later file in the selection fails", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const cancel = vi.fn();
    const collection = createPendingAttachmentCollection((file) =>
      uploaded(file, cancel),
    );
    await expect(
      collection.addFiles([png("first.png"), new File([], "empty.txt")]),
    ).rejects.toThrow("is empty");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:first");
    expect(cancel).toHaveBeenCalledOnce();
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
