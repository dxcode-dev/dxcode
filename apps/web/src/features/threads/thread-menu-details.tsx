import type { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DateTime } from "effect";
import { DollarSign, FolderGit2, Gauge, Info, Sparkles } from "lucide-react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { formatCost } from "../../shared/usage-cost.js";
import { threadOrbMemoryQueryOptions } from "./orb-memory/orb-memory-queries.js";
import { threadCostQueryOptions } from "./thread-cost-queries.js";
import { threadSelectionSummary } from "./thread-selection-summary.js";

/** The menu's parts, passed in so this chunk shares none with the Thread page. */
export type MenuParts = Pick<typeof BaseMenu, "Item" | "Separator">;

// More Actions' Orb and cost rows (#1406). They read the Orb and the
// owner's usage once the menu opens, so the menu loads this module then,
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
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly layout?: "phone";
}) {
  if (layout === "phone")
    return <ThreadDetailItems Menu={Menu} thread={thread} project={project} />;
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
          <ThreadCostMenuItems Menu={Menu} thread={thread} />
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
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
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
      {own ? <ThreadCostMenuItems Menu={Menu} thread={thread} /> : null}
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
  const orb = useQuery(threadOrbMemoryQueryOptions(threadId));
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
 * The Thread's estimated model cost, from the owner's usage, which opens
 * Usage settings. Claude Code runs on the person's own plan, outside dx's
 * usage, so a Claude Code Thread says its cost is not tracked.
 */
function ThreadCostMenuItems({
  Menu,
  thread,
}: {
  readonly Menu: MenuParts;
  readonly thread: ThreadDetailData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const cost = useQuery(
    threadCostQueryOptions(
      identity.id,
      thread.id,
      DateTime.toEpochMillis(thread.createdAt),
    ),
  );
  const claudeCode =
    threadSelectionSummary(thread.agentInitialization.selection).kind ===
    "claude-code";
  const label =
    cost.data !== undefined
      ? formatCost(cost.data.amountMicros)
      : cost.isError
        ? "Cost unavailable"
        : "Estimating cost…";
  const title =
    cost.data === undefined
      ? undefined
      : [
          `Estimated model cost${cost.data.since === undefined ? "" : ` since ${cost.data.since}`}`,
          cost.data.unknownEvents === 0
            ? undefined
            : `${cost.data.unknownEvents} model ${cost.data.unknownEvents === 1 ? "turn has" : "turns have"} no price`,
        ]
          .filter((part) => part !== undefined)
          .join("; ");
  return (
    <>
      <Menu.Item
        className="thread-menu-item"
        title={title}
        render={<Link to="/settings/$section" params={{ section: "usage" }} />}
      >
        <DollarSign />
        <span>{label}</span>
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
