import {
  elementScroll,
  measureElement as measureObservedElement,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { MessageImageTiles } from "./message-attachments-ui.js";
import { TranscriptRowContent } from "./message-parts.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import {
  MessageAuthorLabel,
  useMessageAuthor,
} from "./sharing/message-authors.js";
import {
  AutomationMessage,
  ThreadSourceMessage,
} from "./thread-source-message.js";
import { TranscriptOutline } from "./transcript-outline.js";
import {
  sameTranscriptRow,
  type TranscriptOutlineAnchor,
  type TranscriptRow,
  type TranscriptRowId,
  type TranscriptViewModel,
  transcriptRowsByTurn,
} from "./transcript-view-model.js";
import { TranscriptTurn } from "./transcript-work.js";
import { useThreadPresentation } from "./use-thread-presentation.js";
import { useTranscriptVirtualizer } from "./use-transcript-virtualizer.js";

const ROW_ESTIMATE_PX = 56;
/** Message IDs the panel gives messages other Threads sent, not yet joined. */
export const INBOUND_MESSAGE_PREFIX = "inbound:";
const LIVE_EDGE_THRESHOLD_PX = 24;

interface TranscriptPosition {
  offset: number;
  margin?: number;
  width: number;
  atEnd: boolean;
  lastRead?: TranscriptRowId;
  measurements: VirtualItem[];
  anchor?: { key: VirtualItem["key"]; within: number };
}

/**
 * The scroll position a remounted transcript restores. Scrolling writes it
 * without notifying anyone: only the next mount reads it.
 */
interface TranscriptPositionStore {
  readonly saved: () => TranscriptPosition | undefined;
  readonly save: (position: TranscriptPosition) => void;
  readonly setWidth: (width: number) => void;
}

const createTranscriptPositionStore = (): TranscriptPositionStore => {
  let saved: TranscriptPosition | undefined;
  return {
    saved: () => saved,
    save: (position) => {
      saved = position;
    },
    setWidth: (width) => {
      if (saved !== undefined) saved.width = width;
    },
  };
};

/** Turn sizes measured at the current width, seeded from the restore. */
const measuredTurnSizes = (
  sizes: React.RefObject<Map<VirtualItem["key"], number> | undefined>,
  restored: TranscriptPosition | undefined,
) => {
  if (sizes.current === undefined)
    sizes.current = new Map(
      restored?.measurements.map((item) => [item.key, item.size]),
    );
  return sizes.current;
};

interface TranscriptRowShellProps {
  readonly measureElement: (element: HTMLElement | null) => void;
  readonly row: TranscriptRow;
}

/** Unchanged rows of a re-rendering turn skip render (and Markdown parsing). */
export const TranscriptRowShell = React.memo(
  TranscriptRowShellContent,
  (previous: TranscriptRowShellProps, next: TranscriptRowShellProps) =>
    previous.measureElement === next.measureElement &&
    sameTranscriptRow(previous.row, next.row),
);

// Turns are measured as a whole; rows need no measurement callback.
const measureNothing = () => {};
// Module-level so memoized turns can compare it by identity.
const renderTranscriptRow = (row: TranscriptRow) => (
  <TranscriptRowShell key={row.id} row={row} measureElement={measureNothing} />
);

function TranscriptRowShellContent({
  measureElement,
  row,
}: TranscriptRowShellProps) {
  const user = row.kind === "user-prompt";
  const fromThread = user ? row.sourceThreadId : undefined;
  const automation = user ? row.automation : undefined;
  const author = useMessageAuthor(
    user ? row.author : undefined,
    user ? row.admitted : true,
    user ? row.sentAt : undefined,
  );
  if (fromThread !== undefined && row.kind === "user-prompt")
    return (
      <article
        id={row.id}
        data-row-id={row.id}
        data-row-kind={row.kind}
        data-source-thread=""
        ref={measureElement}
        tabIndex={-1}
        className="transcript-row conversation-message thread-source-row"
      >
        <ThreadSourceMessage
          sourceThreadId={fromThread}
          text={row.text}
          pending={!row.admitted}
        />
      </article>
    );
  if (automation !== undefined && row.kind === "user-prompt")
    return (
      <article
        id={row.id}
        data-row-id={row.id}
        data-row-kind={row.kind}
        data-automation={automation}
        ref={measureElement}
        tabIndex={-1}
        className="transcript-row conversation-message thread-source-row"
      >
        <AutomationMessage
          automation={automation}
          text={row.text}
          pending={!row.admitted}
        />
      </article>
    );
  return (
    <article
      id={row.id}
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-author={
        user && author !== undefined && !author.mine ? "other" : undefined
      }
      data-continued={user && row.continued ? "" : undefined}
      ref={measureElement}
      tabIndex={-1}
      className={`transcript-row conversation-message ${user ? "user-message" : "agent-message"}`}
    >
      {user && author !== undefined && row.continued !== true ? (
        <MessageAuthorLabel author={author} />
      ) : null}
      {user ? <MessageImageTiles attachments={row.attachments ?? []} /> : null}
      <div className="message-content">
        <TranscriptRowContent row={row} />
      </div>
    </article>
  );
}

const observeTranscriptResize = (
  elements: readonly Element[],
  onResize: () => void,
) => {
  const observer = new ResizeObserver(onResize);
  for (const element of elements) observer.observe(element);
  return () => observer.disconnect();
};

const observeOlderHistory = (
  viewport: HTMLDivElement,
  sentinel: HTMLDivElement,
  notify: () => void,
) => {
  const observer = new IntersectionObserver(notify, { root: viewport });
  const resizeObserver = new ResizeObserver(notify);
  observer.observe(sentinel);
  resizeObserver.observe(viewport);
  resizeObserver.observe(sentinel);
  return () => {
    observer.disconnect();
    resizeObserver.disconnect();
  };
};

function useOlderHistoryDrain({
  active,
  historyReady,
  oldestTurnId,
  hasMore,
  loadingOlder,
  olderError,
  loadOlder,
}: {
  readonly active: boolean;
  readonly historyReady: boolean;
  readonly oldestTurnId?: string;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly olderError?: Error;
  readonly loadOlder?: () => Promise<void>;
}) {
  interface DrainConfiguration {
    readonly active: boolean;
    readonly historyReady: boolean;
    readonly oldestTurnId?: string;
    readonly hasMore: boolean;
    readonly loadingOlder: boolean;
    readonly olderError?: Error;
    readonly loadOlder?: () => Promise<void>;
  }
  const state = React.useRef<{
    configuration?: DrainConfiguration;
    viewport?: HTMLDivElement;
    sentinel?: HTMLDivElement;
    releaseObservers?: () => void;
    frame?: number;
    retryTimer?: number;
    retryOldestTurnId?: string;
    retryAttempt: number;
    restored: boolean;
    generation: number;
  }>({ restored: false, generation: 0, retryAttempt: 0 });
  const disconnect = () => {
    state.current.generation += 1;
    state.current.releaseObservers?.();
    state.current.releaseObservers = undefined;
    if (state.current.frame !== undefined)
      cancelAnimationFrame(state.current.frame);
    state.current.frame = undefined;
    if (state.current.retryTimer !== undefined)
      window.clearTimeout(state.current.retryTimer);
    state.current.retryTimer = undefined;
  };
  const schedule = () => {
    if (state.current.frame !== undefined) return;
    const generation = state.current.generation;
    state.current.frame = requestAnimationFrame(() => {
      state.current.frame = undefined;
      const current = state.current;
      const options = current.configuration;
      if (
        generation !== current.generation ||
        options === undefined ||
        !current.restored ||
        !options.active ||
        !options.historyReady ||
        !options.hasMore ||
        options.loadingOlder ||
        options.loadOlder === undefined ||
        current.viewport === undefined ||
        current.sentinel === undefined ||
        !current.viewport.isConnected ||
        !current.sentinel.isConnected ||
        current.viewport.hidden ||
        current.viewport.clientHeight === 0
      )
        return;
      const viewport = current.viewport.getBoundingClientRect();
      const sentinel = current.sentinel.getBoundingClientRect();
      if (sentinel.bottom <= viewport.top || sentinel.top >= viewport.bottom)
        return;
      if (options.olderError !== undefined) {
        if (current.retryTimer !== undefined) return;
        if (current.retryOldestTurnId !== options.oldestTurnId) {
          current.retryOldestTurnId = options.oldestTurnId;
          current.retryAttempt = 0;
        }
        const error = options.olderError;
        const delay = Math.min(1_000 * 2 ** current.retryAttempt, 8_000);
        current.retryTimer = window.setTimeout(() => {
          current.retryTimer = undefined;
          const latest = current.configuration;
          if (
            generation !== current.generation ||
            latest === undefined ||
            latest.olderError !== error ||
            !latest.active ||
            !latest.hasMore ||
            latest.loadingOlder ||
            latest.loadOlder === undefined ||
            current.viewport === undefined ||
            current.sentinel === undefined ||
            !current.viewport.isConnected ||
            !current.sentinel.isConnected ||
            current.viewport.hidden ||
            current.viewport.clientHeight === 0
          )
            return;
          const latestViewport = current.viewport.getBoundingClientRect();
          const latestSentinel = current.sentinel.getBoundingClientRect();
          if (
            latestSentinel.bottom <= latestViewport.top ||
            latestSentinel.top >= latestViewport.bottom
          )
            return;
          current.retryAttempt += 1;
          void latest.loadOlder();
        }, delay);
        return;
      }
      if (current.retryOldestTurnId !== options.oldestTurnId) {
        current.retryOldestTurnId = options.oldestTurnId;
        current.retryAttempt = 0;
      }
      void options.loadOlder();
    });
  };
  const reconnect = () => {
    disconnect();
    const current = state.current;
    if (
      !current.configuration?.active ||
      current.viewport === undefined ||
      current.sentinel === undefined
    )
      return disconnect;
    current.releaseObservers = observeOlderHistory(
      current.viewport,
      current.sentinel,
      schedule,
    );
    schedule();
    return disconnect;
  };
  const viewportRef = (element: HTMLDivElement | null) => {
    if (element === null) return;
    if (state.current.viewport !== element) state.current.restored = false;
    state.current.viewport = element;
    const releaseObservers = reconnect();
    return () => {
      if (state.current.viewport !== element) return;
      releaseObservers();
      state.current.viewport = undefined;
      state.current.restored = false;
    };
  };
  const sentinelRef = (element: HTMLDivElement | null) => {
    if (element === null) return;
    // Commit the render's eligibility together with the sentinel. React 19
    // cleans up the previous callback ref before installing this one, so a
    // discarded render can never alter an active observer's configuration.
    state.current.configuration = {
      active,
      historyReady,
      oldestTurnId,
      hasMore,
      loadingOlder,
      olderError,
      loadOlder,
    };
    state.current.sentinel = element;
    const releaseObservers = reconnect();
    return () => {
      if (state.current.sentinel !== element) return;
      releaseObservers();
      state.current.sentinel = undefined;
      state.current.configuration = undefined;
    };
  };
  const markRestored = () => {
    state.current.restored = true;
    schedule();
  };
  return { viewportRef, sentinelRef, schedule, markRestored };
}

const FOCUS_HIGHLIGHT_MS = 2_400;
const FOCUS_STEADY_FRAMES = 6;
const FOCUS_MAX_FRAMES = 240;
const MAX_FOCUS_PAGES = 40;
const MAX_FOCUS_LOAD_RETRIES = 3;

/**
 * A request to open the transcript at a message (dx's message id). Each
 * navigation has its own `requestKey`, so opening the same message again is a
 * new request.
 */
export interface TranscriptFocus {
  readonly messageId: string;
  readonly requestKey: string;
}

/**
 * Opens the transcript at the message a notification links to: scrolls to
 * its turn, loading older history until the message arrives or history
 * ends, then marks it briefly. It runs from a commit-time ref, once per
 * request, and stops as soon as its anchor leaves the page or the person
 * scrolls.
 */
function useMessageFocus({
  focus,
  model,
  virtualizer,
  historyReady,
  hasMore,
  loadingOlder,
  olderError,
  loadOlder,
  onHandled,
}: {
  readonly focus?: TranscriptFocus;
  readonly model: TranscriptViewModel;
  readonly virtualizer: {
    scrollToIndex: (
      index: number,
      options: { align: "center" | "start"; behavior: "auto" },
    ) => void;
  };
  readonly historyReady: boolean;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly olderError?: Error;
  readonly loadOlder?: () => Promise<void>;
  readonly onHandled?: () => void;
}) {
  const state = React.useRef<{
    requestKey?: string;
    handled: boolean;
    pages: number;
    retries: number;
    retriedError?: Error;
  }>({ handled: false, pages: 0, retries: 0 });
  const messageId = focus?.messageId;
  const requestKey = focus?.requestKey;
  const target =
    messageId === undefined
      ? undefined
      : model.rows.find(
          (row) => row.kind === "user-prompt" && row.dxMessageId === messageId,
        );
  const targetIndex =
    target === undefined
      ? -1
      : model.turns.findIndex((turn) => turn.id === target.turnId);
  const targetRowId = target?.id;
  return (anchor: HTMLSpanElement | null) => {
    if (anchor === null || requestKey === undefined) return;
    if (state.current.requestKey !== requestKey)
      state.current = { requestKey, handled: false, pages: 0, retries: 0 };
    const current = state.current;
    if (current.handled) return;
    if (!historyReady) return;
    // The request ended: the person left the Thread or opened another.
    const live = () =>
      anchor.isConnected && state.current.requestKey === requestKey;
    if (targetRowId !== undefined && targetIndex >= 0) {
      current.handled = true;
      // The list anchors to its end and measures turns as they render, so
      // one scroll does not stick: keep the row in view until it stays.
      let frames = 0;
      let steady = 0;
      let interrupted = false;
      let viewport: Element | undefined;
      const interrupt = () => {
        interrupted = true;
      };
      const finish = (row: HTMLElement | null) => {
        viewport?.removeEventListener("wheel", interrupt);
        viewport?.removeEventListener("touchstart", interrupt);
        viewport?.removeEventListener("keydown", interrupt);
        if (!live()) return;
        if (row !== null) {
          row.focus({ preventScroll: true });
          row.setAttribute("data-notification-target", "");
          window.setTimeout(
            () => row.removeAttribute("data-notification-target"),
            FOCUS_HIGHLIGHT_MS,
          );
        }
        onHandled?.();
      };
      const settle = () => {
        if (!live()) return finish(null);
        frames += 1;
        const row = document.getElementById(targetRowId);
        const view = row?.closest(".transcript-viewport") ?? undefined;
        if (row === null || view === undefined) {
          virtualizer.scrollToIndex(targetIndex, {
            align: "center",
            behavior: "auto",
          });
        } else {
          if (viewport === undefined) {
            // Scrolling by hand ends the request where the person is.
            viewport = view;
            const options = { passive: true } as const;
            view.addEventListener("wheel", interrupt, options);
            view.addEventListener("touchstart", interrupt, options);
            view.addEventListener("keydown", interrupt, options);
          }
          if (interrupted) return finish(row);
          const rowRect = row.getBoundingClientRect();
          const viewRect = view.getBoundingClientRect();
          // A row taller than the transcript is shown from its top.
          const tall = rowRect.height > viewRect.height;
          const inView = tall
            ? rowRect.top >= viewRect.top - 1 &&
              rowRect.top <= viewRect.top + 64
            : rowRect.top >= viewRect.top - 1 &&
              rowRect.bottom <= viewRect.bottom + 1;
          steady = inView ? steady + 1 : 0;
          if (!inView) row.scrollIntoView({ block: tall ? "start" : "center" });
          if (steady >= FOCUS_STEADY_FRAMES || frames >= FOCUS_MAX_FRAMES)
            return finish(row);
        }
        if (frames < FOCUS_MAX_FRAMES) requestAnimationFrame(settle);
        else finish(null);
      };
      requestAnimationFrame(settle);
      return;
    }
    if (loadingOlder) return;
    const canLoad = hasMore && loadOlder !== undefined;
    if (canLoad && olderError !== undefined) {
      // This failure already has a retry scheduled or in flight.
      if (current.retriedError === olderError) return;
      // A failed page is retried a few times with backoff, then the
      // request gives up rather than hammering history.
      current.retriedError = olderError;
      if (current.retries < MAX_FOCUS_LOAD_RETRIES) {
        const delay = 1_000 * 2 ** current.retries;
        current.retries += 1;
        window.setTimeout(() => {
          if (live() && !state.current.handled) void loadOlder?.();
        }, delay);
        return;
      }
    } else if (canLoad && current.pages < MAX_FOCUS_PAGES) {
      current.pages += 1;
      void loadOlder?.();
      return;
    }
    current.handled = true;
    onHandled?.();
  };
}

function useTranscriptViewport({
  active = true,
  model,
  historyReady = false,
  hasMore = false,
  loadingOlder = false,
  olderError,
  loadOlder,
}: {
  readonly active?: boolean;
  readonly defaultWorkExpanded?: boolean;
  readonly model: TranscriptViewModel;
  readonly header?: React.ReactNode;
  readonly pinnedContent?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly showProcessingIndicator?: boolean;
  readonly historyReady?: boolean;
  readonly hasMore?: boolean;
  readonly loadingOlder?: boolean;
  readonly olderError?: Error;
  readonly loadOlder?: () => Promise<void>;
  /** Open at this message, as a notification links. */
  readonly focus?: TranscriptFocus;
  /** The transcript is hidden and must come forward to show the message. */
  readonly onFocusRequested?: () => void;
  /** The focus was applied, or the message is not in this Thread. */
  readonly onFocusHandled?: () => void;
}) {
  const [position] = useThreadPresentation(
    "transcriptPosition",
    createTranscriptPositionStore,
  );
  const [restored] = React.useState(() => position.saved());
  const [scrollMargin, setScrollMargin] = React.useState(restored?.margin ?? 0);
  const [scrollElement, setScrollElement] =
    React.useState<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = React.useState(restored?.atEnd ?? true);
  const [visiblePromptRows, setVisiblePromptRows] = React.useState<
    ReadonlySet<TranscriptRowId>
  >(new Set());
  const {
    viewportRef: historyViewportRef,
    sentinelRef: historySentinelRef,
    schedule: scheduleHistoryDrain,
    markRestored: markHistoryRestored,
  } = useOlderHistoryDrain({
    active,
    historyReady,
    oldestTurnId: model.turns[0]?.id,
    hasMore,
    loadingOlder,
    olderError,
    loadOlder,
  });
  const [initialLastRead] = React.useState(
    () => restored?.lastRead ?? model.rows.at(-1)?.id,
  );
  // The last row seen at the live edge, and its value when the reader last
  // left the edge, which is all the unread marker renders.
  const lastReadRef = React.useRef(initialLastRead);
  const [readBeforeLeaving, setReadBeforeLeaving] =
    React.useState(initialLastRead);
  const turnSizesRef = React.useRef<Map<VirtualItem["key"], number>>(undefined);
  // Whether the viewport has attached before: it attaches again each time a
  // hidden transcript is shown.
  const attachedRef = React.useRef(false);

  const refreshVisiblePromptRows = () => {
    const nextVisible = new Set<TranscriptRowId>();
    const viewportRect = scrollElement?.getBoundingClientRect();
    if (viewportRect !== undefined) {
      for (const anchor of model.outline) {
        const prompt = document.getElementById(anchor.rowId);
        const promptRect = prompt?.getBoundingClientRect();
        if (
          promptRect !== undefined &&
          promptRect.bottom > viewportRect.top &&
          promptRect.top < viewportRect.bottom
        ) {
          nextVisible.add(anchor.rowId);
        }
      }
    }
    setVisiblePromptRows((current) =>
      current.size === nextVisible.size &&
      [...current].every((id) => nextVisible.has(id))
        ? current
        : nextVisible,
    );
  };

  const { virtualizer, virtualItems, totalSize } = useTranscriptVirtualizer({
    count: model.turns.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => model.turns[index]?.id ?? index,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 6,
    scrollMargin,
    initialMeasurementsCache: restored?.measurements,
    initialOffset: restored?.offset,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: LIVE_EDGE_THRESHOLD_PX,
    scrollToFn: (offset, options, instance) => {
      // Native anchoring writes its target before notifying React about new
      // measurements. Grow the sizer first so the browser cannot clamp that
      // correct target to the previous page's scroll range.
      const list = instance.scrollElement?.querySelector<HTMLElement>(
        ".transcript-virtual-list",
      );
      if (list !== null && list !== undefined)
        list.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
      const element = instance.scrollElement;
      const target = offset + (options.adjustments ?? 0);
      // A short transcript can still make the requested prepend adjustment
      // unreachable after the sizer grows. Browsers do not emit `scroll` when
      // that write clamps to the element's existing position, so explicitly
      // let the virtualizer observe the reachable offset instead of retaining
      // a logical offset that leaves loaded rows as an unscrollable blank.
      if (
        element !== null &&
        options.behavior !== "smooth" &&
        Math.abs(element.scrollTop - target) > 1
      )
        element.dispatchEvent(new Event("scroll"));
    },
    measureElement: (element, entry, instance) => {
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      // Never cache an estimate as a measurement: native prepend anchoring
      // distinguishes the first measurement from later row resizes.
      const cached = measuredTurnSizes(turnSizesRef, restored).get(key);
      if (
        entry === undefined &&
        cached !== undefined &&
        (restored === undefined ||
          restored.width === instance.scrollElement?.clientWidth)
      )
        return cached;
      const size = measureObservedElement(element, entry, instance);
      measuredTurnSizes(turnSizesRef, restored).set(key, size);
      return size;
    },
    onChange: (instance) => {
      const nextAtEnd = instance.isAtEnd();
      setAtEnd((current) => (current === nextAtEnd ? current : nextAtEnd));
      if (nextAtEnd) lastReadRef.current = model.rows.at(-1)?.id;
      else setReadBeforeLeaving(lastReadRef.current);
      const element = instance.scrollElement;
      const saved = position.saved();
      if (
        element !== null &&
        (saved === undefined || saved.width === element.clientWidth)
      ) {
        const offset = instance.scrollOffset ?? element.scrollTop;
        const anchor = instance
          .getVirtualItems()
          .find((item) => item.end > offset);
        position.save({
          offset,
          margin: scrollMargin,
          width: element.clientWidth,
          atEnd: nextAtEnd,
          lastRead: lastReadRef.current,
          measurements: instance.takeSnapshot(),
          anchor:
            anchor === undefined
              ? undefined
              : { key: anchor.key, within: offset - anchor.start },
        });
      }
      refreshVisiblePromptRows();
      scheduleHistoryDrain();
    },
  });

  const measureTurn = (element: HTMLDivElement | null) => {
    // Native resize anchoring synchronously commits grown transforms with
    // its scroll adjustment. Register outside React's commit so that flush
    // is allowed, including the first measurement of a prepended turn.
    if (element !== null)
      queueMicrotask(() => {
        if (element.isConnected) {
          virtualizer.measureElement(element);
          scheduleHistoryDrain();
        }
      });
    else virtualizer.measureElement(null);
  };

  const listRef = (element: HTMLDivElement | null) => {
    if (element === null) return;
    const viewport = element.closest<HTMLElement>(".transcript-viewport");
    if (viewport === null) return;
    const measureMargin = () => {
      setScrollMargin(
        element.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop,
      );
      scheduleHistoryDrain();
    };
    // Shown again, the margin is unchanged; the observer's first report,
    // after the browser lays out, confirms it without forcing a layout.
    if (!attachedRef.current) measureMargin();
    return observeTranscriptResize([element, viewport], measureMargin);
  };

  const hasUnread = !atEnd && model.rows.at(-1)?.id !== readBeforeLeaving;
  const viewportRef = (element: HTMLDivElement | null) => {
    setScrollElement(element);
    if (element !== null) {
      const reappeared = attachedRef.current;
      attachedRef.current = true;
      // Read before the virtualizer measures what arrived while hidden.
      const followEnd = position.saved()?.atEnd ?? true;
      const releaseHistoryViewport = historyViewportRef(element);
      let frame = 0;
      let width = reappeared
        ? element.clientWidth
        : (restored?.width ?? element.clientWidth);
      const restoreAnchor = (saved: TranscriptPosition) => {
        cancelAnimationFrame(frame);
        if (saved.atEnd) {
          position.setWidth(element.clientWidth);
          virtualizer.scrollToEnd();
          markHistoryRestored();
          return;
        }
        const index = Array.from(
          { length: virtualizer.options.count },
          (_, index) => index,
        ).find(
          (index) =>
            virtualizer.options.getItemKey(index) === saved.anchor?.key,
        );
        if (index === undefined) {
          element.scrollTo({ top: saved.offset });
          markHistoryRestored();
          return;
        }
        virtualizer.scrollToIndex(index, {
          align: "start",
          behavior: "auto",
        });
        frame = requestAnimationFrame(() => {
          const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
          if (offset !== undefined)
            virtualizer.scrollToOffset(offset + (saved.anchor?.within ?? 0));
          position.setWidth(element.clientWidth);
          markHistoryRestored();
        });
      };
      const disconnect = observeTranscriptResize([element], () => {
        if (width === element.clientWidth || element.clientWidth === 0) return;
        const saved = position.saved() ?? restored;
        width = element.clientWidth;
        measuredTurnSizes(turnSizesRef, restored).clear();
        if (saved !== undefined) restoreAnchor(saved);
      });
      frame = requestAnimationFrame(() => {
        // Shown again: the browser kept the scroll offset and the turns
        // stayed mounted. Follow what streamed in while it was hidden.
        if (reappeared) {
          if (followEnd) virtualizer.scrollToEnd();
          markHistoryRestored();
        } else if (restored === undefined || restored.atEnd) {
          virtualizer.scrollToEnd();
          markHistoryRestored();
        } else {
          restoreAnchor(restored);
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        disconnect();
        releaseHistoryViewport?.();
      };
    }
  };
  // Stable, so the jump control re-renders only when what it shows changes.
  const [jumpToEnd] = React.useState(
    () => (lastRowId: TranscriptRowId | undefined) => {
      virtualizer.scrollToEnd({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      setAtEnd(true);
      lastReadRef.current = lastRowId;
    },
  );
  // The virtualizer keeps its identity, so navigation never changes and the
  // outline need not re-render while a reply streams.
  const [navigateToRow] = React.useState(
    () => (anchor: TranscriptOutlineAnchor) => {
      const index = Array.from(
        { length: virtualizer.options.count },
        (_, index) => index,
      ).find(
        (index) => virtualizer.options.getItemKey(index) === anchor.turnId,
      );
      if (index === undefined) return;
      virtualizer.scrollToIndex(index, {
        align: "start",
        behavior: "auto",
      });
      window.requestAnimationFrame(() => {
        document.getElementById(anchor.rowId)?.focus({ preventScroll: true });
      });
    },
  );
  return {
    viewportRef,
    listRef,
    measureTurn,
    virtualizer,
    virtualItems,
    totalSize,
    scrollMargin,
    atEnd,
    hasUnread,
    visiblePromptRows,
    refreshVisiblePromptRows,
    historySentinelRef,
    scheduleHistoryDrain,
    jumpToEnd,
    navigateToRow,
  };
}

interface TranscriptJumpControlProps {
  readonly atEnd: boolean;
  readonly hasUnread: boolean;
  readonly lastRowId: TranscriptRowId | undefined;
  readonly onJump: (lastRowId: TranscriptRowId | undefined) => void;
}

/** Changes when the reader leaves or reaches the end, or a row arrives. */
function TranscriptJumpControl({
  atEnd,
  hasUnread,
  lastRowId,
  onJump,
}: TranscriptJumpControlProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={`transcript-control transcript-jump ${hasUnread ? "has-unread" : ""}`}
      data-visible={!atEnd || undefined}
      aria-hidden={atEnd}
      aria-label={hasUnread ? "Jump to new messages" : "Jump to bottom"}
      disabled={atEnd}
      tabIndex={atEnd ? -1 : 0}
      onClick={() => onJump(lastRowId)}
    >
      <ArrowDown />
      {hasUnread ? <span className="unread-dot" /> : null}
    </Button>
  );
}

export function TranscriptViewport(
  props: Parameters<typeof useTranscriptViewport>[0],
) {
  const {
    model,
    header,
    pinnedContent,
    footer,
    defaultWorkExpanded = false,
    showProcessingIndicator = true,
    loadingOlder = false,
    loadOlder,
    historyReady = false,
    hasMore = false,
    olderError,
    focus,
    onFocusHandled,
  } = props;
  const {
    viewportRef,
    listRef,
    measureTurn,
    virtualizer,
    virtualItems,
    totalSize,
    scrollMargin,
    atEnd,
    hasUnread,
    visiblePromptRows,
    refreshVisiblePromptRows,
    historySentinelRef,
    jumpToEnd,
    navigateToRow,
  } = useTranscriptViewport(props);
  const focusRef = useMessageFocus({
    focus,
    model,
    virtualizer,
    historyReady,
    hasMore,
    loadingOlder,
    olderError,
    loadOlder,
    onHandled: onFocusHandled,
  });
  // A message another Thread sent that has not joined yet is its own
  // turn; the work in progress is the turn before it.
  const rowsByTurn = transcriptRowsByTurn(model);
  const processingTurnId = model.turns.findLast((turn) => {
    if (turn.status !== "active") return false;
    const rows = rowsByTurn.get(turn.id) ?? [];
    return !(
      rows.length > 0 &&
      rows.every((row) => row.messageId.startsWith(INBOUND_MESSAGE_PREFIX))
    );
  })?.id;
  return (
    <>
      <section
        className="pane-scroll agent-scroll transcript-viewport"
        ref={viewportRef}
        aria-label="Thread transcript"
        aria-live="polite"
        style={{ overflowAnchor: "none" }}
        onScroll={refreshVisiblePromptRows}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the independently scrollable transcript must be keyboard-focusable.
        tabIndex={0}
      >
        <div className="agent-transcript">
          {header}
          {pinnedContent}
          {loadOlder !== undefined ? (
            <div className="transcript-history-boundary">
              <div
                ref={historySentinelRef}
                className="transcript-history-sentinel"
                aria-hidden="true"
              />
              <div className="transcript-history-status" aria-live="polite">
                {loadingOlder || props.olderError !== undefined ? (
                  <ProcessingIndicator accessibleLabel="Loading older prompts" />
                ) : null}
              </div>
            </div>
          ) : null}
          <div
            ref={listRef}
            className="transcript-virtual-list"
            data-transcript-entry-list=""
            style={{
              height: `${totalSize}px`,
              transitionProperty: "none",
            }}
          >
            {virtualItems.map((item) => {
              const turn = model.turns[item.index];
              if (turn === undefined) return null;
              const rows = rowsByTurn.get(turn.id) ?? [];
              return (
                <div
                  className="transcript-virtual-item"
                  data-index={item.index}
                  key={item.key}
                  style={{
                    transform: `translateY(${item.start - scrollMargin}px)`,
                    transitionProperty: "none",
                  }}
                >
                  <div ref={measureTurn} data-index={item.index}>
                    <TranscriptTurn
                      defaultWorkExpanded={defaultWorkExpanded}
                      turn={turn}
                      rows={rows}
                      processing={
                        showProcessingIndicator && turn.id === processingTurnId
                      }
                      renderRow={renderTranscriptRow}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      </section>
      <div className="transcript-controls">
        <TranscriptOutline
          anchors={model.outline}
          visibleRowIds={visiblePromptRows}
          onNavigate={navigateToRow}
          onOpen={refreshVisiblePromptRows}
        />
        <TranscriptJumpControl
          atEnd={atEnd}
          hasUnread={hasUnread}
          lastRowId={model.rows.at(-1)?.id}
          onJump={jumpToEnd}
        />
      </div>
      {focus === undefined ? null : <span hidden ref={focusRef} />}
    </>
  );
}

/**
 * Hidden behind another tab, the transcript asks once to come forward to show
 * the message a notification links to.
 */
function TranscriptFocusRequest({
  onRequested,
}: {
  readonly onRequested?: () => void;
}) {
  const requested = React.useRef(false);
  return (
    <span
      hidden
      ref={(node) => {
        if (node === null || requested.current) return;
        requested.current = true;
        onRequested?.();
      }}
    />
  );
}

/**
 * A hidden transcript keeps its turns mounted and its scroll offset, so
 * showing it again re-parses nothing and keeps the reading position. While
 * hidden it keeps the element it was hidden with: streamed updates do no work
 * until it is shown, then render once.
 */
export function ThreadTranscript(
  props: React.ComponentProps<typeof TranscriptViewport>,
) {
  const active = props.active ?? true;
  const viewport = <TranscriptViewport {...props} />;
  const [hiddenViewport, setHiddenViewport] =
    React.useState<React.ReactElement>();
  if (active && hiddenViewport !== undefined) setHiddenViewport(undefined);
  if (!active && hiddenViewport === undefined) setHiddenViewport(viewport);
  return (
    <>
      <React.Activity mode={active ? "visible" : "hidden"}>
        {active ? viewport : (hiddenViewport ?? viewport)}
      </React.Activity>
      {active || props.focus === undefined ? null : (
        <TranscriptFocusRequest
          key={props.focus.requestKey}
          onRequested={props.onFocusRequested}
        />
      )}
    </>
  );
}
