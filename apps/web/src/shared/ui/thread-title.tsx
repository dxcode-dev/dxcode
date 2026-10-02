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
}: {
  readonly thread: Pick<ThreadData, "title" | "titlePending">;
}) {
  return thread.titlePending === true ? <PendingThreadTitle /> : thread.title;
}
