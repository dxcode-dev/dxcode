import type { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleCheck,
  DollarSign,
  FolderGit2,
  Gauge,
  Info,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { threadOrbMemoryQueryOptions } from "./orb-memory/orb-memory-queries.js";
import { threadArchiveInFlight, threadKeys } from "./thread-queries.js";
import { threadSelectionSummary } from "./thread-selection-summary.js";
import { formatUsd } from "./thread-usage/thread-usage-format.js";
import { threadUsageQueryOptions } from "./thread-usage/thread-usage-queries.js";

/** The menu's parts, passed in so this chunk shares none with the Thread page. */
const LazyThreadUsageDialog = React.lazy(() =>
  import("./thread-usage/thread-usage-dialog.js").then((module) => ({
    default: module.ThreadUsageDialog,
  })),
);

/**
 * The Thread Usage dialog, loaded the first time it opens. The menu renders
 * it outside itself, so it stays open after the menu closes.
 */
export function ThreadUsageDialogLoader(
  props: React.ComponentProps<typeof LazyThreadUsageDialog>,
) {
  return (
    <React.Suspense fallback={null}>
      <LazyThreadUsageDialog {...props} />
    </React.Suspense>
  );
}

export type MenuParts = Pick<typeof BaseMenu, "Item" | "Separator">;

// More Actions' Orb and cost rows (#1406). They read the Orb and the
// Thread's usage once the menu opens, so the menu loads this module then,
// not with the Thread page.

/**
 * The Orb's state and the Thread's cost, each after a separator; on a phone
 * (`layout="phone"`), what the Thread runs on, its Orb, Project, and cost.
 */
export default function ThreadMenuDetails({
  Menu,
  thread,
  project,
  layout,
  onOpenUsage,
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly layout?: "phone";
  /** Opens the Thread's Cost & Usage. */
  readonly onOpenUsage: () => void;
}) {
  if (layout === "phone")
    return (
      <ThreadDetailItems
        Menu={Menu}
        thread={thread}
        project={project}
        onOpenUsage={onOpenUsage}
      />
    );
  const own = thread.access === undefined || thread.access === "owner";
  return (
    <>
      {canUseOrb(thread) ? (
        <>
          <Menu.Separator className="thread-menu-separator" />
          <OrbMenuItem Menu={Menu} threadId={thread.id} />
        </>
      ) : null}
      {own ? (
        <>
          <Menu.Separator className="thread-menu-separator" />
          <ThreadCostMenuItems
            Menu={Menu}
            thread={thread}
            onOpenUsage={onOpenUsage}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * What the Thread runs on, and its Project. The owner opens the Project from
 * here; members of a shared Thread cannot read the owner's Project.
 */
function ThreadDetailItems({
  Menu,
  thread,
  project,
  onOpenUsage,
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly onOpenUsage: () => void;
}) {
  const selection = threadSelectionSummary(
    thread.agentInitialization.selection,
  );
  const own = thread.access === undefined || thread.access === "owner";
  const projectName = project?.name ?? thread.projectName ?? "No project";
  return (
    <>
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className="thread-menu-item thread-menu-detail-item"
        title={selection.title}
      >
        {selection.kind === "claude-code" ? (
          <ClaudeIcon />
        ) : selection.kind === "mode" ? (
          <Gauge />
        ) : (
          <Sparkles />
        )}
        <span className="thread-menu-detail-label">{selection.label}</span>
        {selection.detail === undefined ? null : (
          <span className="thread-menu-detail-value">{selection.detail}</span>
        )}
      </Menu.Item>
      {canUseOrb(thread) ? (
        <OrbMenuItem Menu={Menu} threadId={thread.id} />
      ) : null}
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className="thread-menu-item"
        title={projectName}
        render={
          own ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId: thread.projectId }}
            />
          ) : undefined
        }
      >
        <FolderGit2 />
        <span>{projectName}</span>
      </Menu.Item>
      {own ? (
        <ThreadCostMenuItems
          Menu={Menu}
          thread={thread}
          onOpenUsage={onOpenUsage}
        />
      ) : null}
    </>
  );
}

/**
 * The Orb's state is for those who may open its Terminal: the owner and
 * contributors, while the Thread is active (archiving stops the Orb), once
 * its Orb was first prepared, as the Thread's views are.
 */
const canUseOrb = (thread: ThreadDetailData) =>
  (thread.access === undefined ||
    thread.access === "owner" ||
    thread.access === "contribute") &&
  thread.lifecycleState === "active" &&
  thread.executionWorkspace.ready;

/** Orb memory answers `unavailable` when no daemon serves this Thread. */
const ORB_STATE_LABELS = {
  running: "Running",
  paused: "Paused",
  unavailable: "Not running",
} as const;

/**
 * The Orb's state, from the Orb memory read the Thread page already polls,
 * which never wakes it. The reference's Orb submenu (its size and
 * resources, Memory and CPU Usage, Copy Sync CLI Command, and Network
 * Routing) waits on backend support (#1155).
 */
function OrbMenuItem({
  Menu,
  threadId,
}: {
  readonly Menu: MenuParts;
  readonly threadId: ThreadDetailData["id"];
}) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const orb = useQuery({
    ...threadOrbMemoryQueryOptions(threadId),
    // An archived Thread's Orb answers no reads, nor one whose archive or
    // restore the server has not answered yet.
    enabled: () =>
      client.isMutating(threadArchiveInFlight(identity.id, threadId)) === 0 &&
      client.getQueryData<ThreadDetailData>(
        threadKeys.detail(identity.id, threadId),
      )?.lifecycleState !== "archived",
  });
  const workspace = orb.data?.workspace;
  const state =
    workspace !== undefined
      ? ORB_STATE_LABELS[workspace]
      : orb.isError
        ? ORB_STATE_LABELS.unavailable
        : "Checking…";
  return (
    <Menu.Item className="thread-menu-item thread-menu-detail-item">
      <OrbIcon reducedMotion />
      <span className="thread-menu-detail-label">Orb</span>
      <span className="thread-menu-detail-value">{state}</span>
    </Menu.Item>
  );
}

/**
 * The Thread's cost and who paid it, which opens its Cost & Usage. Claude
 * Code runs on the person's own plan, outside dx's usage, so a Claude Code
 * Thread also says its model costs are not tracked.
 */
function ThreadCostMenuItems({
  Menu,
  thread,
  onOpenUsage,
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
  readonly onOpenUsage: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const usage = useQuery(threadUsageQueryOptions(identity.id, thread.id));
  const claudeCode =
    threadSelectionSummary(thread.agentInitialization.selection).kind ===
    "claude-code";
  const label =
    usage.data !== undefined
      ? formatUsd(usage.data.totalMicros)
      : usage.isError
        ? "Cost unavailable"
        : "Estimating cost…";
  const coverage =
    usage.data === undefined
      ? undefined
      : usage.data.creditsMicros > 0
        ? "Credits"
        : usage.data.totalMicros > 0
          ? "Deployment"
          : undefined;
  return (
    <>
      <Menu.Item className="thread-menu-item" onClick={onOpenUsage}>
        <DollarSign />
        <span>{label}</span>
        {coverage === undefined ? null : (
          <span
            className="thread-menu-detail-value thread-menu-cost-coverage"
            data-credits={coverage === "Credits" || undefined}
          >
            {coverage === "Credits" ? <CircleCheck /> : null}
            {coverage}
          </span>
        )}
      </Menu.Item>
      {claudeCode ? (
        <Menu.Item className="thread-menu-item" disabled>
          <Info />
          <span>Claude Code Costs Not Tracked</span>
        </Menu.Item>
      ) : null}
    </>
  );
}
