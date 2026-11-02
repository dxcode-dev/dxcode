import type { Sandbox as E2BSandbox } from "e2b";
import { executionWorkspaceLogger } from "../../logging.js";

/**
 * The binaries a new Orb's source activation runs first: Node for the asset
 * check and the source program, then git, gh, and git-lfs.
 */
export const GUEST_PREFETCH_FILES = [
  "/usr/local/bin/node",
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-http",
  "/usr/bin/gh",
  "/usr/bin/git-lfs",
] as const;

const CHUNK_BYTES = 4 * 1024 * 1024;
const PREFETCH_TIMEOUT_MS = 30_000;

/**
 * Reads each file once, every 4 MiB chunk in its own reader. A new E2B
 * sandbox loads its disk lazily, and a process that faults its binary in
 * one page at a time waits on each load in turn: Node's first start takes
 * about 2.4 s that way. Parallel readers bring the same bytes in several
 * times faster, so the first commands find them in the page cache. A
 * missing file is skipped.
 */
export const guestPrefetchCommand = (
  files: ReadonlyArray<string> = GUEST_PREFETCH_FILES,
) =>
  `for f in ${files.join(" ")}; do f=$(readlink -f "$f") || continue; size=$(stat -c %s "$f" 2>/dev/null) || continue; i=0; while [ $((i * ${CHUNK_BYTES})) -lt "$size" ]; do dd if="$f" of=/dev/null bs=${CHUNK_BYTES} skip=$i count=1 status=none & i=$((i + 1)); done; done; wait`;

/**
 * Starts the prefetch on a sandbox that was just created, beside the rest of
 * its open. Never fails: a prefetch that does not finish only leaves the
 * first commands as slow as without it.
 */
export const prefetchGuestBinaries = (
  sandbox: E2BSandbox,
  threadId: string,
): Promise<void> => {
  const startedAt = Date.now();
  return sandbox.commands
    .run(guestPrefetchCommand(), { timeoutMs: PREFETCH_TIMEOUT_MS })
    .then(
      () => {
        executionWorkspaceLogger.info("E2B guest prefetch finished.", {
          event: "e2b_guest_prefetch",
          threadId,
          outcome: "success",
          durationMs: Date.now() - startedAt,
        });
      },
      (cause: unknown) => {
        executionWorkspaceLogger.warn("E2B guest prefetch did not finish.", {
          event: "e2b_guest_prefetch",
          threadId,
          outcome: "error",
          durationMs: Date.now() - startedAt,
          error: cause instanceof Error ? cause.name : "unknown",
        });
      },
    );
};
