import { newThreadStorageFileId } from "../thread-storage/store.js";
import { standaloneArtifactImageKey } from "./store.js";

/**
 * A standalone artifact's images: one R2 object each under the artifact's
 * prefix, read through `/v1/standalone-artifacts/:artifactId/images/…`
 * by whoever may open the artifact, and deleted with it. A Thread's
 * artifacts keep theirs in Thread storage instead.
 */

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const IMAGE_ID = /^tsf_[0-9a-f]{32}$/;
/** A stored name: the sanitized base and the extension its bytes called for. */
const IMAGE_NAME = /^[^/\\]{1,90}\.(png|jpg|gif|webp)$/;

/** The read route of an image, relative to dx's origin. */
export const standaloneImagePath = (
  artifactId: string,
  imageId: string,
  name: string,
) =>
  `/v1/standalone-artifacts/${artifactId}/images/${imageId}/${encodeURIComponent(name)}`;

export const putStandaloneImage = async (
  bucket: R2Bucket,
  input: {
    readonly artifactId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  },
) => {
  const id = newThreadStorageFileId();
  await bucket.put(
    standaloneArtifactImageKey(input.artifactId, id, input.name),
    input.bytes,
    { httpMetadata: { contentType: input.mimeType } },
  );
  return id;
};

/** The image's bytes and type; undefined when there is no such image. */
export const readStandaloneImage = async (
  bucket: R2Bucket,
  artifactId: string,
  imageId: string,
  name: string,
) => {
  const extension = IMAGE_NAME.exec(name)?.[1];
  if (!IMAGE_ID.test(imageId) || extension === undefined) return undefined;
  const object = await bucket.get(
    standaloneArtifactImageKey(artifactId, imageId, name),
  );
  if (object === null) return undefined;
  return {
    body: object.body,
    size: object.size,
    mimeType: MIME_TYPES[extension] ?? "application/octet-stream",
  };
};
