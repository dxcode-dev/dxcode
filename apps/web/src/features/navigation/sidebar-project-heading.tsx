import type { ProjectId } from "@dx/domain";
import { ChevronDown, FolderGit2, Plus } from "lucide-react";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { Button } from "../../shared/ui/button.js";

/**
 * A Project section's heading in the sidebar: its name toggles the section,
 * and on hover New thread opens the composer in the Project. The count and
 * chevron sit outside the toggle so New thread can come before them; the
 * toggle's ::after still covers the whole row.
 */
export function SidebarProjectHeading({
  projectId,
  label,
  threadCount,
  collapsed,
  onToggle,
  onNavigate,
}: {
  readonly projectId: ProjectId;
  readonly label: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Called before the composer opens, as the sidebar's New thread does. */
  readonly onNavigate: () => void;
}) {
  const { openNewThread } = useNewThreadSurface();
  return (
    <div
      className="thread-group-heading-row thread-group-project-heading"
      data-collapsed={collapsed || undefined}
    >
      <button
        className="thread-group-heading"
        data-collapsed={collapsed || undefined}
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <FolderGit2 className="thread-group-icon" aria-hidden="true" />
        <span>{label}</span>
        <i />
      </button>
      <span className="thread-group-meta">
        <Button
          variant="subtle"
          size="icon-2xs"
          type="button"
          className="thread-group-new-thread"
          aria-label={`New thread in ${label}`}
          title="New thread"
          onClick={() => {
            onNavigate();
            openNewThread(projectId);
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
        <small>{threadCount}</small>
        {collapsed ? null : <ChevronDown aria-hidden="true" />}
      </span>
    </div>
  );
}
