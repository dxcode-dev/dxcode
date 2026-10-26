import type { OrbFolder, ThreadOrbDiskData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  HardDrive,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { After } from "../orb-memory/orb-memory-notice.js";
import {
  deleteRefusal,
  threadOrbDiskQueryOptions,
  threadOrbFoldersQueryOptions,
  useDeleteOrbFolder,
} from "./orb-disk-queries.js";
import "../orb-memory/orb-memory.css";
import "./orb-disk.css";

/** Below the pressure line this long before the card says all is well. */
const ORB_DISK_SETTLE_MS = 2_500;
/** How long the all-clear stays before the card goes away. */
const ORB_DISK_ALL_CLEAR_MS = 4_000;

const GIB = 1_024 ** 3;
const MIB = 1_024 ** 2;

const formatSize = (bytes: number) =>
  bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MIB))} MB`;

/** The size people know their Orb by: `20 GB`. */
const formatTotal = (bytes: number) =>
  bytes >= 10 * GIB ? `${Math.round(bytes / GIB)} GB` : formatSize(bytes);

type Disk = NonNullable<ThreadOrbDiskData["disk"]>;

const percentUsed = (disk: Disk) =>
  Math.floor((disk.usedBytes / disk.totalBytes) * 100);

const usage = (disk: Disk) =>
  `${String(percentUsed(disk))}% full (${(disk.usedBytes / GIB).toFixed(1)} of ${formatTotal(disk.totalBytes)})`;

/** Sent by "Ask the agent to free space", as if the person typed it. */
const freeSpaceRequest = (disk: Disk) =>
  `My Orb's disk is ${usage(disk)}. Please free up space: find the largest folders and delete build outputs, dependency folders, and caches that can be rebuilt (never source files or uncommitted work), then tell me how much you freed.`;

/**
 * `open` while the disk is filling up (and while it settles below the
 * line), `recovered` for the all-clear, `dismissed` until the episode ends.
 */
type Phase = "hidden" | "open" | "recovered" | "dismissed";

function OrbFolderRow({
  threadId,
  folder,
}: {
  readonly threadId: ThreadId;
  readonly folder: OrbFolder;
}) {
  const remove = useDeleteOrbFolder(threadId);
  const refused = deleteRefusal(remove.error);
  return (
    <li
      className="orb-disk-folder"
      data-state={
        remove.isSuccess ? "deleted" : remove.isPending ? "deleting" : "listed"
      }
    >
      <span className="orb-disk-folder-path" title={`~/${folder.path}`}>
        ~/{folder.path}
      </span>
      <span className="orb-disk-folder-size">{formatSize(folder.bytes)}</span>
      <span className="orb-disk-folder-action">
        {remove.isSuccess ? (
          <span className="orb-disk-folder-status">
            <CircleCheck aria-hidden="true" /> Deleted
          </span>
        ) : remove.isPending ? (
          <span className="orb-disk-folder-status" aria-live="polite">
            <span className="processing-dot" aria-hidden="true" /> Deleting…
          </span>
        ) : folder.rebuildable ? (
          <>
            {refused === undefined ? null : (
              <span className="orb-disk-folder-refused">{refused}</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Delete ~/${folder.path} (it can be rebuilt)`}
              onClick={() => remove.mutate(folder.path)}
            >
              Delete
            </Button>
          </>
        ) : null}
      </span>
    </li>
  );
}

function OrbFolders({ threadId }: { readonly threadId: ThreadId }) {
  const { data, isPending } = useQuery(threadOrbFoldersQueryOptions(threadId));
  const folders = data?.folders;
  if (folders === undefined)
    return isPending ? (
      <span className="orb-disk-empty" aria-live="polite">
        Measuring the largest folders…
      </span>
    ) : null;
  if (folders.length === 0)
    return (
      <span className="orb-disk-empty">No single folder takes much of it.</span>
    );
  return (
    <ul className="orb-disk-folders" aria-label="Largest folders">
      {folders.map((folder) => (
        <OrbFolderRow key={folder.path} threadId={threadId} folder={folder} />
      ))}
    </ul>
  );
}

/**
 * Above the composer while the Thread's Orb disk is filling up: how full it
 * is, the largest folders with a Delete for those that can be rebuilt, and
 * ways to free the rest (ask the agent, or the Terminal). From 90% it warns
 * that work is about to stop. Once usage stays below the line for a moment,
 * it says so and goes away by itself.
 */
export function OrbDiskNotice({
  threadId,
  onAskAgent,
  onOpenTerminal,
}: {
  readonly threadId: ThreadId;
  /** Sends the agent a ready-made request to free space. */
  readonly onAskAgent?: (message: string) => void;
  readonly onOpenTerminal?: () => void;
}) {
  const { data } = useQuery(threadOrbDiskQueryOptions(threadId));
  const disk = data?.disk;
  const pressure = disk?.pressure === true;
  const [phase, setPhase] = React.useState<Phase>("hidden");
  // Each reading moves the episode: pressure opens the card (again), and
  // the end of pressure lets a dismissed card come back next time.
  if (pressure && (phase === "hidden" || phase === "recovered"))
    setPhase("open");
  if (!pressure && phase === "dismissed") setPhase("hidden");
  if (phase === "hidden" || phase === "dismissed" || disk === undefined)
    return null;

  if (phase === "recovered")
    return (
      <div className="orb-memory-row">
        <After
          key="all-clear"
          ms={ORB_DISK_ALL_CLEAR_MS}
          onElapsed={() => setPhase("hidden")}
        />
        <aside
          className="orb-memory-card orb-disk-card"
          data-phase="recovered"
          aria-live="polite"
        >
          <CircleCheck aria-hidden="true" />
          <div className="orb-memory-copy">
            <strong>Your Orb’s disk has room again</strong>
            <span>It is {usage(disk)}.</span>
          </div>
        </aside>
      </div>
    );

  const warning = disk.warning;
  return (
    <div className="orb-memory-row">
      {pressure ? null : (
        <After
          key="settle"
          ms={ORB_DISK_SETTLE_MS}
          onElapsed={() => setPhase("recovered")}
        />
      )}
      <aside
        className="orb-memory-card orb-disk-card"
        data-phase={!pressure ? "settling" : warning ? "warning" : "pressure"}
        aria-label="Orb disk"
      >
        <HardDrive aria-hidden="true" />
        <div className="orb-memory-copy">
          <strong>
            {pressure
              ? `Your Orb’s disk is ${usage(disk)}`
              : "Disk space is freeing up…"}
          </strong>
          <span>
            {!pressure
              ? "Hang on a moment."
              : warning
                ? "When it fills up, installs, builds, and the agent stop working. Free space now."
                : "Free space before large installs or builds fill it up."}
          </span>
          {pressure ? <OrbFolders threadId={threadId} /> : null}
          {pressure &&
          (onAskAgent !== undefined || onOpenTerminal !== undefined) ? (
            <div className="orb-disk-actions">
              {onAskAgent === undefined ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onAskAgent(freeSpaceRequest(disk))}
                >
                  <Sparkles aria-hidden="true" /> Ask the agent to free space
                </Button>
              )}
              {onOpenTerminal === undefined ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={onOpenTerminal}
                >
                  <SquareTerminal aria-hidden="true" /> Open Terminal
                </Button>
              )}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="orb-memory-dismiss"
          aria-label="Hide disk notice"
          onClick={() => setPhase("dismissed")}
        >
          <X />
        </Button>
      </aside>
    </div>
  );
}
