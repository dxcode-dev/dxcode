import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import type { SpaceArtifactItem, SpaceData, SpaceThreadItem } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  Ellipsis,
  FileText,
  FolderGit2,
  Headphones,
  Link2,
  ListTree,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  PanelRightClose,
  Pencil,
  Trash2,
  UsersRound,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { requestThreadView } from "../../shared/commands/thread-open-view-event.js";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import { HuddleSlot } from "../../shared/huddle/huddle-slot.js";
import type { ThreadAutomationView } from "../../shared/thread-automations-slot.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import { copyThreadUrl } from "../../shared/thread-copy.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { threadQueryOptions } from "../threads/thread-queries.js";
import { SpaceCommentsTab } from "./comments/space-comments-tab.js";
import { SpaceProgressChart } from "./progress/space-progress-chart.js";
import { useOpenSpaceArtifact } from "./space-artifact.js";
import { SpaceAutomationsContext } from "./space-automations-context.js";
import {
  compactAge,
  epochOf,
  groupSpaceArtifacts,
  groupSpaceThreads,
  spaceProject,
  spaceStatusText,
  threadSelectionChip,
} from "./space-format.js";
import {
  spaceArtifactsQueryOptions,
  spaceThreadsQueryOptions,
  useSetSpaceJoined,
} from "./space-queries.js";
import { useOpenSpaceThread } from "./use-open-space-thread.js";

// What the Space's own Thread runs on and its cost: the rows a Thread's
// More Actions lists, from the chunk it loads them from, so they stay out
// of the Space page's first load. They load at the first sign of reaching
// for Space Actions.
const loadThreadDetails = () => import("../threads/thread-menu-chunk.js");
const preloadThreadDetails = () => void loadThreadDetails();
const ThreadDetailRows = React.lazy(loadThreadDetails);
const ThreadUsageDialog = React.lazy(() =>
  loadThreadDetails().then((module) => ({
    default: module.ThreadUsageDialogLoader,
  })),
);
const menuParts = { Item: Menu.Item, Separator: Menu.Separator };

function ThreadRowAge({ thread }: { readonly thread: SpaceThreadItem }) {
  const at = epochOf(thread.lastActivityAt);
  return (
    <span className="space-thread-age">
      {useTimeText((now) => compactAge(at, now))}
    </span>
  );
}

/** One thread the Space started: status, title, what it does, who asked. */
function SpaceThreadRow({
  thread,
  active,
  onOpen,
}: {
  readonly thread: SpaceThreadItem;
  readonly active: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  // Opening a thread is seeing it, so the open one is never unread.
  const unread = thread.unread === true && !active;
  return (
    <li>
      <button
        type="button"
        className="space-thread-row"
        aria-current={active ? "true" : undefined}
        data-state={thread.state}
        onClick={() => onOpen(thread.id)}
        {...threadColorAttributes(thread)}
      >
        <span className="space-thread-status">
          <OrbIcon
            activityStatus={thread.state === "working" ? "working" : "idle"}
            unread={unread}
            aria-hidden="false"
            aria-label={unread ? "Unread" : thread.state}
          />
        </span>
        <span className="space-thread-text">
          <strong>{thread.title}</strong>
          {thread.statusLine === null ? null : (
            <small>{thread.statusLine}</small>
          )}
        </span>
        {thread.requestedBy === null ? null : (
          <span
            className="space-thread-requester"
            title={`Requested by ${thread.requestedBy.name}`}
          >
            <Avatar
              name={thread.requestedBy.name}
              image={thread.requestedBy.avatarUrl}
              seed={thread.requestedBy.userId}
            />
          </span>
        )}
        <ThreadRowAge thread={thread} />
      </button>
    </li>
  );
}

/** The Threads tab: the Space's threads by state, each state collapsible. */
function SpaceThreadSections({
  threads,
  activeThreadId,
  onOpenThread,
}: {
  readonly threads: ReadonlyArray<SpaceThreadItem> | undefined;
  readonly activeThreadId: ThreadId | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (threads === undefined)
    return <div className="space-panel-loading" aria-busy="true" />;
  if (threads.length === 0)
    return (
      <div className="space-panel-empty">
        <ListTree aria-hidden="true" />
        <strong>No Threads Yet</strong>
        <p>
          Ask this Space to take something on. The threads it starts show up
          here.
        </p>
      </div>
    );
  return (
    <div className="space-thread-sections">
      {groupSpaceThreads(threads).map((section) => {
        const collapsed = section.collapsed !== toggled.has(section.state);
        return (
          <section
            key={section.state}
            className="space-thread-section"
            aria-label={section.label}
          >
            <button
              type="button"
              className="thread-group-heading space-thread-section-heading"
              data-collapsed={collapsed || undefined}
              aria-expanded={!collapsed}
              onClick={() =>
                setToggled((current) => {
                  const next = new Set(current);
                  if (next.has(section.state)) next.delete(section.state);
                  else next.add(section.state);
                  return next;
                })
              }
            >
              <span>{section.label}</span>
              <ChevronDown
                className="space-thread-section-chevron"
                aria-hidden="true"
              />
              <i />
              <small>{section.items.length}</small>
            </button>
            {collapsed ? null : (
              <ul className="space-thread-list">
                {section.items.map((thread) => (
                  <SpaceThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    onOpen={onOpenThread}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** One artifact's row: its title, folder, and when it was last saved. */
function SpaceArtifactRow({
  artifact,
  onOpen,
}: {
  readonly artifact: SpaceArtifactItem;
  readonly onOpen: (artifact: SpaceArtifactItem) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="space-thread-row"
        onClick={() => onOpen(artifact)}
      >
        <span className="space-thread-status">
          <FileText aria-hidden="true" />
        </span>
        <span className="space-thread-text">
          <strong>{artifact.title}</strong>
          <small>{artifact.folder === "" ? "Artifact" : artifact.folder}</small>
        </span>
        <span className="space-thread-age">
          <ArtifactAge at={artifact.updatedAt} />
        </span>
      </button>
    </li>
  );
}

/**
 * The Artifacts tab: the artifacts of the Space and of the threads it
 * started, by thread, the Space's own first. The Space's own open full
 * screen over the page; a thread's open that thread's tab on the artifact.
 */
function SpaceArtifactsTab({
  spaceThreadId,
  onOpened,
}: {
  readonly spaceThreadId: ThreadId;
  readonly onOpened?: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const artifacts = useQuery(
    spaceArtifactsQueryOptions(identity.id, spaceThreadId),
  );
  const openOwn = useOpenSpaceArtifact();
  const openThread = useOpenSpaceThread();
  const navigate = useNavigate();
  const open = (artifact: SpaceArtifactItem) => {
    onOpened?.();
    if (artifact.thread.id === spaceThreadId) return openOwn(artifact.id);
    requestThreadView(artifact.thread.id, "artifacts");
    if (!openThread(artifact.thread.id, { artifact: artifact.id }))
      void navigate({
        to: "/threads/$threadId",
        params: { threadId: artifact.thread.id },
        search: { artifact: artifact.id },
      });
  };
  if (artifacts.isError)
    return (
      <div className="space-panel-empty" role="alert">
        <p>Could not load artifacts.</p>
      </div>
    );
  if (artifacts.data === undefined)
    return <div className="space-panel-loading" aria-busy="true" />;
  if (artifacts.data.length === 0)
    return (
      <div className="space-panel-empty">
        <FileText aria-hidden="true" />
        <strong>No Artifacts Yet</strong>
        <p>Plans and notes the Space and its threads write show up here.</p>
      </div>
    );
  const groups = groupSpaceArtifacts(artifacts.data, spaceThreadId);
  // With only the Space's own artifacts, a heading would only repeat its name.
  if (groups.length === 1 && groups[0]?.thread.id === spaceThreadId)
    return (
      <ul className="space-thread-list space-artifact-list">
        {groups[0].items.map((artifact) => (
          <SpaceArtifactRow
            key={artifact.id}
            artifact={artifact}
            onOpen={open}
          />
        ))}
      </ul>
    );
  return (
    <div className="space-thread-sections">
      {groups.map((group) => (
        <section
          key={group.thread.id}
          className="space-thread-section"
          aria-label={group.thread.title}
        >
          <h3 className="thread-group-heading space-thread-section-heading space-artifact-heading">
            <span>{group.thread.title}</span>
            {group.thread.archived ? (
              <em className="space-artifact-archived">Archived</em>
            ) : null}
            <i />
            <small>{group.items.length}</small>
          </h3>
          <ul className="space-thread-list space-artifact-list">
            {group.items.map((artifact) => (
              <SpaceArtifactRow
                key={artifact.id}
                artifact={artifact}
                onOpen={open}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ArtifactAge({ at }: { readonly at: number }) {
  return useTimeText((now) => compactAge(at, now));
}

/**
 * The panel's More Actions: Edit Space…, Copy Space URL, Archive, then
 * what the Space's agent runs on and its cost (which opens Cost & Usage),
 * Leave Space, and Delete Space….
 */
export function SpacePanelMenu({
  space,
  userId,
  onEdit,
  onDelete,
  onArchive,
  automations = false,
}: {
  readonly space: SpaceData;
  readonly userId: UserId;
  /**
   * Lists the Space's issues, pull requests, CI, and listeners, for a bar
   * with no room for their chips, each opening its sheet.
   */
  readonly automations?: boolean;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
  readonly onArchive?: () => void;
}) {
  const leave = useSetSpaceJoined(userId);
  const member = space.access !== "owner" && space.joined;
  // The Space's own Thread: what its agent runs on and what it cost, as a
  // Thread's More Actions lists them.
  const thread = useQuery(threadQueryOptions(userId, space.threadId)).data;
  const [usageOpen, setUsageOpen] = React.useState(false);
  const { MenuItems, Sheet } = React.use(SpaceAutomationsContext);
  const [sheet, setSheet] = React.useState<ThreadAutomationView>();
  const own = space.access === "owner";
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="space-icon-button"
          aria-label="Space Actions"
          title="Space Actions"
          onPointerEnter={preloadThreadDetails}
          onPointerDown={preloadThreadDetails}
          onFocus={preloadThreadDetails}
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup thread-actions-menu thread-actions-menu-details">
              {onEdit === undefined ? null : (
                <Menu.Item className="thread-menu-item" onClick={onEdit}>
                  <Pencil />
                  <span>Edit Space…</span>
                </Menu.Item>
              )}
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void copyThreadUrl(space.threadId)}
              >
                <Link2 />
                <span>Copy Space URL</span>
              </Menu.Item>
              {onArchive === undefined ? null : (
                <Menu.Item className="thread-menu-item" onClick={onArchive}>
                  <Archive />
                  <span>Archive Space</span>
                </Menu.Item>
              )}
              {automations && own ? (
                <MenuItems threadId={space.threadId} onOpen={setSheet} />
              ) : null}
              {thread === undefined ? null : (
                <React.Suspense fallback={null}>
                  <ThreadDetailRows
                    Menu={menuParts}
                    thread={thread}
                    onOpenUsage={() => setUsageOpen(true)}
                  />
                </React.Suspense>
              )}
              {member ? (
                <>
                  <Menu.Separator className="thread-menu-separator" />
                  <Menu.Item
                    className="thread-menu-item"
                    disabled={leave.isPending}
                    onClick={() =>
                      leave.mutate({ threadId: space.threadId, joined: false })
                    }
                  >
                    <LogOut />
                    <span>Leave Space</span>
                  </Menu.Item>
                </>
              ) : null}
              {onDelete === undefined ? null : (
                <>
                  <Menu.Separator className="thread-menu-separator" />
                  <Menu.Item className="thread-menu-item" onClick={onDelete}>
                    <Trash2 />
                    <span>Delete Space…</span>
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {usageOpen && thread !== undefined ? (
        <React.Suspense fallback={null}>
          <ThreadUsageDialog
            thread={thread}
            onClose={() => setUsageOpen(false)}
          />
        </React.Suspense>
      ) : null}
      {sheet === undefined ? null : (
        <Sheet
          threadId={space.threadId}
          view={sheet}
          onClose={() => setSheet(undefined)}
        />
      )}
    </>
  );
}

/**
 * The Space's issues, pull requests, CI, and schedule and GitHub listeners,
 * as chips that open their lists, as a Thread's title bar shows them. Only
 * the owner reads them.
 */
export function SpaceAutomationChips({ space }: { readonly space: SpaceData }) {
  const { Chips } = React.use(SpaceAutomationsContext);
  return space.access === "owner" ? <Chips threadId={space.threadId} /> : null;
}

/** The Space's automation chips on their own row of Space Details. */
function SpaceAutomationsRow({ space }: { readonly space: SpaceData }) {
  return (
    <div className="space-panel-automations">
      <SpaceAutomationChips space={space} />
    </div>
  );
}

/**
 * What the Space's agent runs on, as a Thread's title bar shows its mode or
 * model, with the model and effort in its tooltip.
 */
export function SpaceAgentChip({ space }: { readonly space: SpaceData }) {
  const { identity } = useAuthenticatedIdentity();
  const thread = useQuery(threadQueryOptions(identity.id, space.threadId)).data;
  if (thread === undefined) return null;
  const chip = threadSelectionChip(thread.agentInitialization.selection);
  return (
    <span className="space-tab-mode space-agent-chip" title={chip.title}>
      {chip.label}
    </span>
  );
}

type SpacePanelTab = "threads" | "comments" | "artifacts";

/**
 * The goal, clamped to a few lines; when it runs longer Show More shows all
 * of it, and Show Less clamps it again. The text is always the same
 * paragraph: swapping it for another element as it measures would change
 * what it measures (WebKit does not clamp a button), and the two would
 * swap back and forth on every frame.
 */
function SpaceGoal({ goal }: { readonly goal: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const [overflows, setOverflows] = React.useState(false);
  // React calls a ref that returns cleanup with the node alone; the
  // observer reports at once, then on every resize, Show More and Show Less
  // included. Expanded, the toggle stays whatever it measures.
  const measure = (node: HTMLElement | null) => {
    const observer = new ResizeObserver(() => {
      if (node !== null)
        setOverflows(node.scrollHeight > node.clientHeight + 1);
    });
    if (node !== null) observer.observe(node);
    return () => observer.disconnect();
  };
  return (
    <div className="space-goal" data-expanded={expanded ? "" : undefined}>
      <p ref={measure} className="space-goal-text">
        {goal}
      </p>
      {expanded || overflows ? (
        <button
          type="button"
          className="space-goal-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      ) : null}
    </div>
  );
}

/** The Space's Project; absent when the Space has none. */
export function SpaceProjectChip({ space }: { readonly space: SpaceData }) {
  const project = spaceProject(space);
  if (project === undefined) return null;
  return (
    <span className="space-project-chip" title={`Project ${project.name}`}>
      <FolderGit2 aria-hidden="true" />
      <span>{project.name}</span>
    </span>
  );
}

/**
 * Huddle's place (voice is not built in dx yet) and who the Space is shared
 * with; the owner's opens Edit Space.
 */
/** The Huddle button while Huddle is off for this person. */
const HUDDLE_OFF = (
  <button
    type="button"
    className="space-icon-button"
    aria-label="Huddle"
    title="Huddle is not available yet"
    disabled
  >
    <Headphones aria-hidden="true" />
  </button>
);

export function SpaceCallAndSharing({
  space,
  onShare,
}: {
  readonly space: SpaceData;
  readonly onShare?: () => void;
}) {
  const sharing =
    space.sharing === "private"
      ? "Private: only you"
      : `Shared with your workspace: ${space.members.map(({ name }) => name).join(", ")}`;
  const Huddle = React.use(HuddleSlot);
  return (
    <>
      {Huddle === undefined ? (
        HUDDLE_OFF
      ) : (
        <Huddle
          kind="space"
          threadId={space.threadId}
          name={space.name}
          fallback={HUDDLE_OFF}
        />
      )}
      <button
        type="button"
        className="space-icon-button"
        aria-label="Sharing"
        title={sharing}
        disabled={onShare === undefined}
        data-sharing={space.sharing}
        onClick={onShare}
      >
        {space.sharing === "private" ? (
          <LockKeyhole aria-hidden="true" />
        ) : (
          <UsersRound aria-hidden="true" />
        )}
      </button>
    </>
  );
}

/**
 * Space Details: the name with its actions and Hide Space Details, the goal,
 * the Project, Huddle and sharing, the 30-day chart, and tabs for the
 * Space's threads (by state), comments, and artifacts. A right column on a
 * wide page, a bottom sheet on a narrow one.
 */
export function SpacePanel({
  space,
  activeThreadId,
  onOpenThread,
  onOpenComments,
  onOpened,
  onEdit,
  onDelete,
  onArchive,
  onHide,
}: {
  readonly space: SpaceData;
  readonly activeThreadId: ThreadId | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Brings the Space chat, where a message's comments open, to the front. */
  readonly onOpenComments: () => void;
  /** Runs as an artifact or comments row opens: the sheet closes itself. */
  readonly onOpened?: () => void;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
  readonly onArchive?: () => void;
  /** Hide Space Details; absent in the sheet, which closes itself. */
  readonly onHide?: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const threads = useQuery(
    spaceThreadsQueryOptions(identity.id, space.threadId),
  ).data;
  const unread =
    threads?.some(
      (thread) => thread.unread === true && thread.id !== activeThreadId,
    ) === true;
  const [tab, setTab] = React.useState<SpacePanelTab>("threads");
  const status = spaceStatusText(space);
  return (
    <div
      className="space-panel"
      {...threadColorAttributes({ id: space.threadId, color: space.color })}
    >
      <header className="space-panel-header">
        <div className="space-panel-title">
          <h2 title={space.name}>{space.name}</h2>
          <SpacePanelMenu
            space={space}
            userId={identity.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onArchive={onArchive}
          />
          {onHide === undefined ? null : (
            <button
              type="button"
              className="space-icon-button"
              aria-label="Hide Space Details"
              title="Hide Space Details"
              onClick={onHide}
            >
              <PanelRightClose aria-hidden="true" />
            </button>
          )}
        </div>
        {status === undefined ? null : (
          <p
            className="space-panel-status"
            data-waiting={space.waitingOnInput ? "" : undefined}
          >
            {status}
          </p>
        )}
        {space.goal === null ? null : (
          <SpaceGoal key={space.goal} goal={space.goal} />
        )}
        <div className="space-panel-meta">
          <SpaceProjectChip space={space} />
          <SpaceAgentChip space={space} />
          <span className="space-panel-meta-spacer" />
          <SpaceCallAndSharing space={space} onShare={onEdit} />
        </div>
        <SpaceAutomationsRow space={space} />
      </header>
      <SpaceProgressChart spaceThreadId={space.threadId} />
      <Tabs.Root
        className="space-panel-tabs"
        value={tab}
        onValueChange={(value) => setTab(value as SpacePanelTab)}
      >
        <Tabs.List className="space-panel-tab-list" aria-label="Space panel">
          <Tabs.Tab className="space-panel-tab" value="threads">
            <span className="space-panel-tab-icon">
              <ListTree aria-hidden="true" />
              {unread ? <span className="space-unread-dot" /> : null}
            </span>
            Threads
          </Tabs.Tab>
          <Tabs.Tab className="space-panel-tab" value="comments">
            <span className="space-panel-tab-icon">
              <MessagesSquare aria-hidden="true" />
            </span>
            Comments
          </Tabs.Tab>
          <Tabs.Tab className="space-panel-tab" value="artifacts">
            <span className="space-panel-tab-icon">
              <FileText aria-hidden="true" />
            </span>
            Artifacts
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className="space-panel-tab-panel" value="threads">
          <SpaceThreadSections
            threads={threads}
            activeThreadId={activeThreadId}
            onOpenThread={onOpenThread}
          />
        </Tabs.Panel>
        <Tabs.Panel className="space-panel-tab-panel" value="comments">
          <SpaceCommentsTab
            spaceThreadId={space.threadId}
            onOpen={() => {
              onOpened?.();
              onOpenComments();
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel className="space-panel-tab-panel" value="artifacts">
          <SpaceArtifactsTab
            spaceThreadId={space.threadId}
            onOpened={onOpened}
          />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
