import type { ThreadData, ThreadListItem } from "@dx/api";
import { FolderGit2 } from "lucide-react";
import { createPortal } from "react-dom";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { ThreadTitleText } from "../../shared/ui/thread-title.js";
import { formatRelativeTime } from "../../shared/utils.js";

export interface ThreadPreviewAnchor {
  readonly right: number;
  readonly top: number;
}

export function ThreadHoverPreview({
  anchor,
  projectName,
  thread,
  onPointerEnter,
  onPointerLeave,
}: {
  readonly anchor: ThreadPreviewAnchor;
  readonly projectName: string;
  readonly thread: ThreadData &
    Partial<Pick<ThreadListItem, "mode" | "changes">>;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}) {
  const currentThread = thread;
  const mode = thread.mode;
  const changes = thread.changes;
  const environmentState =
    currentThread.lifecycleState === "archived"
      ? "paused"
      : currentThread.activityStatus === "working"
        ? "working"
        : "idle";
  const activityStatus =
    currentThread.lifecycleState === "archived"
      ? "idle"
      : currentThread.activityStatus;
  const changeTotals = [
    changes?.additions
      ? {
          className: "thread-preview-additions",
          value: `+${changes.additions}`,
        }
      : undefined,
    changes?.deletions
      ? {
          className: "thread-preview-deletions",
          value: `-${changes.deletions}`,
        }
      : undefined,
    changes?.files
      ? { title: "Changed files", value: `~${changes.files}` }
      : undefined,
  ].filter((total) => total !== undefined);
  const width = 328;
  const viewportWidth =
    typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? 800 : window.innerHeight;
  const left = Math.min(anchor.right + 8, viewportWidth - width - 10);
  const top = Math.max(10, Math.min(anchor.top, viewportHeight - 180));

  return createPortal(
    <aside
      className="thread-hover-preview"
      style={{ left, top, width }}
      aria-label={`Preview ${projectName} thread`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="thread-preview-header">
        <div>
          <strong>
            <ThreadTitleText thread={currentThread} />
          </strong>
          <span>
            Created {formatRelativeTime(currentThread.createdAt)}, updated{" "}
            {formatRelativeTime(currentThread.updatedAt)}
          </span>
        </div>
        <span
          className="thread-preview-environment"
          data-activity-status={activityStatus}
          title={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} ${environmentState}`}
        >
          <OrbIcon
            activityStatus={activityStatus}
            aria-hidden="false"
            aria-label={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} ${environmentState}`}
          />
        </span>
      </header>
      {changeTotals.length === 0 ? null : (
        <fieldset className="thread-preview-change-totals">
          <legend className="visually-hidden">Change totals</legend>
          {changeTotals.map((total) => (
            <span
              className={total.className}
              title={total.title}
              key={total.value}
            >
              {total.value}
            </span>
          ))}
        </fieldset>
      )}
      <dl className="thread-preview-metadata">
        <div>
          <dt>Mode</dt>
          <dd>{mode ?? "—"}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>
            <FolderGit2 aria-hidden="true" />
            {projectName}
          </dd>
        </div>
      </dl>
    </aside>,
    document.body,
  );
}
