import type { OrbProcess, ThreadOrbMemoryData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, MemoryStick, X } from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { Button } from "../../../shared/ui/button.js";
import {
  stopRefusal,
  threadOrbMemoryQueryOptions,
  useStopOrbProcess,
} from "./orb-memory-queries.js";
import "./orb-memory.css";

/** Below the pressure line this long before the card says all is well. */
const ORB_MEMORY_SETTLE_MS = 2_500;
/** How long the all-clear stays before the card goes away. */
const ORB_MEMORY_ALL_CLEAR_MS = 4_000;

const GIB = 1_024 ** 3;
const MIB = 1_024 ** 2;

const formatMemory = (bytes: number) =>
  bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MIB))} MB`;

const percentUsed = (memory: NonNullable<ThreadOrbMemoryData["memory"]>) =>
  Math.round((memory.usedBytes / memory.totalBytes) * 100);

/**
 * `open` while the Orb is under pressure (and while it settles below the
 * line), `recovered` for the all-clear, `dismissed` until the episode ends.
 */
type Phase = "hidden" | "open" | "recovered" | "dismissed";

/**
 * Calls `onElapsed` once, `ms` after it mounts, unless it unmounts first.
 * Give each use its own `key`: React would otherwise reuse a spent timer.
 */
function After({
  ms,
  onElapsed,
}: {
  readonly ms: number;
  readonly onElapsed: () => void;
}) {
  useMountEffect(() => {
    const timer = setTimeout(onElapsed, ms);
    return () => clearTimeout(timer);
  });
  return null;
}

function OrbProcessRow({
  threadId,
  process,
}: {
  readonly threadId: ThreadId;
  readonly process: OrbProcess;
}) {
  const stop = useStopOrbProcess(threadId);
  const refused = stopRefusal(stop.error);
  const state =
    process.state === "running" && stop.isPending ? "stopping" : process.state;
  return (
    <li className="orb-memory-process" data-state={state}>
      <span className="orb-memory-process-name" title={process.command}>
        <strong>{process.name}</strong>
        <span>{process.command}</span>
      </span>
      <span className="orb-memory-process-size">
        {formatMemory(process.memoryBytes)}
      </span>
      <span className="orb-memory-process-action">
        {state === "stopped" ? (
          <span className="orb-memory-process-status">
            <CircleCheck aria-hidden="true" /> Stopped
          </span>
        ) : state === "stopping" ? (
          <span className="orb-memory-process-status" aria-live="polite">
            <span className="processing-dot" aria-hidden="true" /> Stopping…
          </span>
        ) : (
          <>
            {refused === undefined ? null : (
              <span className="orb-memory-process-refused">{refused}</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Stop ${process.name} (process ${String(process.pid)})`}
              onClick={() => stop.mutate(process.id)}
            >
              Stop
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

/**
 * Above the composer while the Thread's Orb is low on memory: how much is
 * in use, the largest processes, and a Stop for each. It never pauses the
 * agent. Once memory stays below the line for a moment, it says so and goes
 * away by itself.
 */
export function OrbMemoryNotice({ threadId }: { readonly threadId: ThreadId }) {
  const { data } = useQuery(threadOrbMemoryQueryOptions(threadId));
  const memory = data?.memory;
  const pressure = memory?.pressure === true;
  const [phase, setPhase] = React.useState<Phase>("hidden");
  // Each reading moves the episode: pressure opens the card (again), and
  // the end of pressure lets a dismissed card come back next time.
  if (pressure && (phase === "hidden" || phase === "recovered"))
    setPhase("open");
  if (!pressure && phase === "dismissed") setPhase("hidden");
  if (phase === "hidden" || phase === "dismissed" || memory === undefined)
    return null;

  const used = `${String(percentUsed(memory))}% of ${formatMemory(memory.totalBytes)} in use.`;
  if (phase === "recovered")
    return (
      <div className="orb-memory-row">
        <After
          key="all-clear"
          ms={ORB_MEMORY_ALL_CLEAR_MS}
          onElapsed={() => setPhase("hidden")}
        />
        <aside
          className="orb-memory-card"
          data-phase="recovered"
          aria-live="polite"
        >
          <CircleCheck aria-hidden="true" />
          <div className="orb-memory-copy">
            <strong>Your Orb’s memory is healthy again</strong>
            <span>{used} Everything keeps running as usual.</span>
          </div>
        </aside>
      </div>
    );

  const processes = data?.processes ?? [];
  return (
    <div className="orb-memory-row">
      {pressure ? null : (
        <After
          key="settle"
          ms={ORB_MEMORY_SETTLE_MS}
          onElapsed={() => setPhase("recovered")}
        />
      )}
      <aside
        className="orb-memory-card"
        data-phase={pressure ? "pressure" : "settling"}
        aria-label="Orb memory"
      >
        <MemoryStick aria-hidden="true" />
        <div className="orb-memory-copy">
          <strong>
            {pressure
              ? "Your Orb is running low on memory"
              : "Memory is freeing up…"}
          </strong>
          <span>
            {used}{" "}
            {pressure
              ? "Stopping something you don’t need keeps your work running smoothly."
              : "Hang on a moment."}
          </span>
          {processes.length === 0 ? (
            <span className="orb-memory-empty">
              None of your processes is using much of it.
            </span>
          ) : (
            <ul className="orb-memory-processes">
              {processes.map((process) => (
                <OrbProcessRow
                  key={process.id}
                  threadId={threadId}
                  process={process}
                />
              ))}
            </ul>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="orb-memory-dismiss"
          aria-label="Hide memory notice"
          onClick={() => setPhase("dismissed")}
        >
          <X />
        </Button>
      </aside>
    </div>
  );
}
