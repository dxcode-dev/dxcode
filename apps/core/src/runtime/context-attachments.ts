import type { SelectContextAttachments } from "@flue/runtime";

/**
 * Image bytes a dx-mode model call may hold. Each image is held as bytes,
 * as base64, and again in the provider request, all inside a Durable
 * Object's 128 MB. view_media sends images of up to about 1.5 MB, so a call
 * keeps the newest three to five of those.
 */
export const CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024;
/** Most images a call may hold: providers refuse requests with too many. */
export const CONTEXT_IMAGES = 40;

/**
 * Where the kept images start: past a budget, the oldest are dropped in
 * steps of a third of it, so the cut moves, and with it the request prefix
 * a provider's prompt cache keys on, once per third of a budget of new
 * images rather than with every image. Sizes come from the conversation,
 * so every rebuild and live trim cuts in the same place.
 */
const keptFrom = (sizes: ReadonlyArray<number>, budget: number) => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return 0;
  const step = budget / 3;
  const cut = Math.ceil((total - budget) / step) * step;
  let start = 0;
  for (const [index, size] of sizes.entries()) {
    if (start >= cut) return index;
    start += size;
  }
  return sizes.length;
};

/**
 * The context images a dx-mode model call carries: the latest turn's user
 * input, and the newest images within {@link CONTEXT_IMAGE_BYTES} and
 * {@link CONTEXT_IMAGES}. Every older image stays in the Thread's attachment
 * store, where the transcript shows it, and reaches the model as `[image]`;
 * the model can view it again.
 */
export const dxContextAttachments: SelectContextAttachments = (
  messages,
  attachmentBytes,
) => {
  const lastUser = messages.findLastIndex(({ role }) => role === "user");
  const turnStart = messages.findLastIndex(
    ({ role }, index) => role === "assistant" && index < lastUser,
  );
  const withImages = attachmentBytes.flatMap((size, index) =>
    size > 0 ? [index] : [],
  );
  const counts = withImages.map((index) => {
    const content = messages[index]?.content;
    return Array.isArray(content)
      ? content.filter(({ type }) => type === "image").length
      : 0;
  });
  const from = Math.min(
    Math.max(
      keptFrom(
        withImages.map((index) => attachmentBytes[index] ?? 0),
        CONTEXT_IMAGE_BYTES,
      ),
      keptFrom(counts, CONTEXT_IMAGES),
    ),
    // The newest image always reaches the model.
    withImages.length - 1,
  );
  const kept = new Set(withImages.slice(from));
  return messages.map(
    ({ role }, index) =>
      kept.has(index) || (role === "user" && index > turnStart),
  );
};
