import type { ThreadId } from "@dx/domain";
import { OrbDiskNotice } from "./orb-disk/orb-disk-notice.js";
import { OrbMemoryNotice } from "./orb-memory/orb-memory-notice.js";

/**
 * The Orb's disk and memory cards above the composer. They show only while
 * the Orb runs short, so the Thread page loads them after it first paints.
 */
export function OrbNotices({
  threadId,
  onAskAgent,
  onOpenTerminal,
}: {
  readonly threadId: ThreadId;
  readonly onAskAgent: (message: string) => void;
  readonly onOpenTerminal: (() => void) | undefined;
}) {
  return (
    <>
      <OrbDiskNotice
        threadId={threadId}
        onAskAgent={onAskAgent}
        onOpenTerminal={onOpenTerminal}
      />
      <OrbMemoryNotice threadId={threadId} />
    </>
  );
}
