import * as React from "react";
import { addScreenshot, type PendingAttachment } from "./image-attachments.js";
import type { NewThreadDraftStore } from "./new-thread-draft-store.js";

const updatePendingImages = async (
  load: () => Promise<ReadonlyArray<PendingAttachment>>,
  fallbackError: string,
  setImages: (images: ReadonlyArray<PendingAttachment>) => void,
  setError: (error?: string) => void,
) => {
  setError(undefined);
  try {
    setImages(await load());
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : fallbackError);
  }
};

/**
 * The new-thread draft's attached files. The draft store keeps them when the
 * composer closes, as it keeps the prompt.
 */
export const useDraftImages = (
  draftStore: NewThreadDraftStore,
  setError: (error?: string) => void,
) => {
  const imageCollection = draftStore.images;
  const images = React.useSyncExternalStore(
    draftStore.subscribe,
    draftStore.getImages,
    draftStore.getImages,
  );
  const setImages = draftStore.setImages;
  const addFiles = (files: ReadonlyArray<File>) =>
    updatePendingImages(
      () => imageCollection.addFiles(files),
      "Files could not be attached.",
      setImages,
      setError,
    );
  // Never sets the composer's error notice: an uncaptured screenshot is not
  // an error. See addScreenshot.
  const takeScreenshot = async () => {
    setImages(await addScreenshot(imageCollection));
  };
  return { imageCollection, images, setImages, addFiles, takeScreenshot };
};
