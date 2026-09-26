import { FLUE_MAX_IMAGE_DATA_LENGTH, MAX_IMAGES_PER_MESSAGE } from "@dx/api";
import type { DeliveredAttachment } from "@flue/sdk";

export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
export const MAX_IMAGE_COUNT = MAX_IMAGES_PER_MESSAGE;
export const MAX_ENCODED_IMAGE_SIZE = FLUE_MAX_IMAGE_DATA_LENGTH;
const MAX_RAW_IMAGE_SIZE = Math.floor(MAX_ENCODED_IMAGE_SIZE / 4) * 3;
const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface PendingImage extends Omit<DeliveredAttachment, "mimeType"> {
  readonly id: string;
  readonly mimeType: ImageMimeType;
  readonly previewUrl: string;
  readonly disposePreview: () => void;
}

const signatures: ReadonlyArray<
  readonly [ImageMimeType, ReadonlyArray<number>]
> = [
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46]],
];

const actualMime = (bytes: Uint8Array): ImageMimeType | undefined => {
  for (const [mime, signature] of signatures) {
    if (
      bytes.length < signature.length ||
      !signature.every((value, index) => bytes[index] === value)
    )
      continue;
    if (
      mime !== "image/webp" ||
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    )
      return mime;
  }
  return undefined;
};

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
};

const imageIdentity = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

const allocatePreview = (file: File) => {
  const { createObjectURL, revokeObjectURL } = URL;
  const previewUrl = createObjectURL(file);
  return {
    previewUrl,
    disposePreview: () => revokeObjectURL(previewUrl),
  };
};

export async function readImage(file: File): Promise<PendingImage> {
  if (file.size > MAX_RAW_IMAGE_SIZE)
    throw new Error(
      `${file.name || "Image"} exceeds the 14 MiB encoded limit.`,
    );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name || "Image"} could not be read.`);
  }
  const mimeType = actualMime(bytes);
  if (mimeType === undefined) {
    throw new Error(
      `${file.name || "Image"} is not a valid JPEG, PNG, GIF, or WebP image.`,
    );
  }
  const data = base64(bytes);
  if (data.length > MAX_ENCODED_IMAGE_SIZE) {
    throw new Error(
      `${file.name || "Image"} exceeds the 14 MiB encoded limit.`,
    );
  }
  const id = await imageIdentity(bytes);
  const preview = allocatePreview(file);
  return {
    id,
    type: "image",
    data,
    mimeType,
    filename: file.name || "image",
    ...preview,
  };
}

export async function readSelectedImages(
  files: ReadonlyArray<File>,
  current: ReadonlyArray<PendingImage>,
) {
  if (current.length + files.length > MAX_IMAGE_COUNT)
    throw new Error(`Attach no more than ${MAX_IMAGE_COUNT} images.`);
  const read: PendingImage[] = [];
  try {
    const identities = new Set(current.map(({ id }) => id));
    for (const file of files) {
      const image = await readImage(file);
      if (identities.has(image.id)) {
        image.disposePreview();
        throw new Error(`${file.name} is already attached.`);
      }
      identities.add(image.id);
      read.push(image);
    }
    return read;
  } catch (cause) {
    disposeImages(read);
    throw cause;
  }
}

export const deliveredImages = (images: ReadonlyArray<PendingImage>) =>
  images.map(({ data, filename, mimeType, type }) => ({
    data,
    filename,
    mimeType,
    type,
  }));

export const disposeImages = (images: ReadonlyArray<PendingImage>) => {
  for (const image of images) image.disposePreview();
};

export interface PendingImageCollection {
  readonly addFiles: (
    files: ReadonlyArray<File>,
  ) => Promise<ReadonlyArray<PendingImage>>;
  readonly addImage: (image: PendingImage) => ReadonlyArray<PendingImage>;
  readonly addGenerated: (
    create: () => Promise<PendingImage>,
  ) => Promise<ReadonlyArray<PendingImage>>;
  readonly remove: (id: string) => ReadonlyArray<PendingImage>;
  readonly take: () => ReadonlyArray<PendingImage>;
  readonly restore: (
    images: ReadonlyArray<PendingImage>,
  ) => ReadonlyArray<PendingImage>;
  readonly settle: () => Promise<void>;
  readonly dispose: () => void;
}

export const createPendingImageCollection = (): PendingImageCollection => {
  let images: ReadonlyArray<PendingImage> = [];
  let queue: Promise<void> = Promise.resolve();

  const append = (next: ReadonlyArray<PendingImage>) => {
    if (images.length + next.length > MAX_IMAGE_COUNT) {
      disposeImages(next);
      throw new Error(`Attach no more than ${MAX_IMAGE_COUNT} images.`);
    }
    const identities = new Set(images.map(({ id }) => id));
    const duplicate = next.find(({ id }) => identities.has(id));
    if (duplicate !== undefined) {
      disposeImages(next);
      throw new Error(`${duplicate.filename} is already attached.`);
    }
    images = [...images, ...next];
    return images;
  };
  const enqueue = <A>(operation: () => Promise<A>) => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    addFiles: (files) =>
      enqueue(async () => append(await readSelectedImages(files, images))),
    addImage: (image) => append([image]),
    addGenerated: (create) =>
      enqueue(async () => {
        if (images.length >= MAX_IMAGE_COUNT)
          throw new Error(`Attach no more than ${MAX_IMAGE_COUNT} images.`);
        return append([await create()]);
      }),
    remove: (id) => {
      const removed = images.find((image) => image.id === id);
      if (removed !== undefined) removed.disposePreview();
      images = images.filter((image) => image.id !== id);
      return images;
    },
    take: () => {
      const taken = images;
      images = [];
      return taken;
    },
    restore: (restored) => {
      images = restored;
      return images;
    },
    settle: () => queue,
    dispose: () => {
      disposeImages(images);
      images = [];
    },
  };
};

export async function captureScreenshot(): Promise<PendingImage> {
  if (navigator.mediaDevices?.getDisplayMedia === undefined)
    throw new Error("Screenshot capture is not supported by this browser.");
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("No screen was selected.");
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (video.videoWidth === 0 || video.videoHeight === 0)
      throw new Error("The selected screen could not be captured.");
    const scale = Math.min(
      1,
      1920 / video.videoWidth,
      1080 / video.videoHeight,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas
      .getContext("2d")
      ?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value === null
            ? reject(new Error("The screenshot could not be encoded."))
            : resolve(value),
        "image/png",
      ),
    );
    return readImage(
      new File([blob], `Screenshot ${new Date().toISOString()}.png`, {
        type: "image/png",
        lastModified: Date.now(),
      }),
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotAllowedError")
      throw new Error("Screenshot capture was cancelled or denied.");
    throw cause instanceof Error
      ? cause
      : new Error("The screenshot could not be captured.");
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}
