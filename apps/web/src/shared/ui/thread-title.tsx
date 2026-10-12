import type { ThreadData } from "@dx/api";

/** Shown while a Thread's title is still being generated. */
export function PendingThreadTitle() {
  return (
    <span
      className="thread-title-pending"
      role="status"
      aria-label="Generating thread title"
    >
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}

/** The Thread title, or the loading dots until DxTitleAgent settles it. */
export function ThreadTitleText({
  thread,
  maxCharacters,
}: {
  readonly thread: Pick<ThreadData, "title" | "titlePending">;
  /** Longer titles end in an ellipsis after this many characters. */
  readonly maxCharacters?: number;
}) {
  if (thread.titlePending === true) return <PendingThreadTitle />;
  const characters = Array.from(thread.title);
  return maxCharacters === undefined || characters.length <= maxCharacters
    ? thread.title
    : `${characters.slice(0, maxCharacters).join("").trimEnd()}…`;
}
