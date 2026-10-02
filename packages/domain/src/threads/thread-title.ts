import { Schema } from "effect";

export const THREAD_TITLE_MAX_LENGTH = 80;
export const UNTITLED_THREAD_TITLE = "Untitled thread";
/** Longest a generated title may show as loading; the fallback applies after. */
export const THREAD_TITLE_PENDING_MS = 40_000;

export const ThreadTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_TITLE_MAX_LENGTH),
);

export type ThreadTitle = typeof ThreadTitle.Type;

export const generateThreadTitle = (prompt: string): ThreadTitle => {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return UNTITLED_THREAD_TITLE;
  if (normalized.length <= THREAD_TITLE_MAX_LENGTH) return normalized;
  let truncated = "";
  for (const character of normalized) {
    if (`${truncated}${character}…`.length > THREAD_TITLE_MAX_LENGTH) break;
    truncated += character;
  }
  return `${truncated.trimEnd()}…`;
};
