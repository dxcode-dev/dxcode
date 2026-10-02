import {
  elementScroll,
  measureElement as measureObservedElement,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { TranscriptRowContent } from "./message-parts.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import { TranscriptOutline } from "./transcript-outline.js";
import {
  sameTranscriptRow,
  type TranscriptRow,
  type TranscriptRowId,
  type TranscriptViewModel,
  transcriptRowsByTurn,
} from "./transcript-view-model.js";
import { TranscriptTurn } from "./transcript-work.js";
import { useThreadPresentation } from "./use-thread-presentation.js";

const ROW_ESTIMATE_PX = 56;
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
  return (
    <article
      id={row.id}
      data-row-id={row.id}
      data-row-kind={row.kind}
      ref={measureElement}
      tabIndex={-1}
      className={`transcript-row conversation-message ${user ? "user-message" : "agent-message"}`}
    >
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
  const disconnect = React.useCallback(() => {
    state.current.generation += 1;
    state.current.releaseObservers?.();
    state.current.releaseObservers = undefined;
    if (state.current.frame !== undefined)
      cancelAnimationFrame(state.current.frame);
    state.current.frame = undefined;
    if (state.current.retryTimer !== undefined)
      window.clearTimeout(state.current.retryTimer);
    state.current.retryTimer = undefined;
  }, []);
  const schedule = React.useCallback(() => {
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
  }, []);
  const reconnect = React.useCallback(() => {
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
  }, [disconnect, schedule]);
  const viewportRef = React.useCallback(
    (element: HTMLDivElement | null) => {
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
    },
    [reconnect],
  );
  const sentinelRef = React.useCallback(
    (element: HTMLDivElement | null) => {
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
    },
    [
      active,
      hasMore,
      historyReady,
      loadOlder,
      loadingOlder,
      oldestTurnId,
      olderError,
      reconnect,
    ],
  );
  const markRestored = React.useCallback(() => {
    state.current.restored = true;
    schedule();
  }, [schedule]);
  return { viewportRef, sentinelRef, schedule, markRestored };
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
}) {
  const [position] = useThreadPresentation<{ saved?: TranscriptPosition }>(
    "transcriptPosition",
    () => ({}),
  );
  const [restored] = React.useState(() => position.saved);
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
  const lastReadRef = React.useRef(restored?.lastRead ?? model.rows.at(-1)?.id);
  const [measuredTurnSizes] = React.useState(
    () =>
      new Map<VirtualItem["key"], number>(
        restored?.measurements.map((item) => [item.key, item.size]),
      ),
  );
  const refreshVisiblePromptRows = React.useCallback(() => {
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
  }, [model.outline, scrollElement]);

  const virtualizer = useVirtualizer({
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
      const cached = measuredTurnSizes.get(key);
      if (
        entry === undefined &&
        cached !== undefined &&
        (restored === undefined ||
          restored.width === instance.scrollElement?.clientWidth)
      )
        return cached;
      const size = measureObservedElement(element, entry, instance);
      measuredTurnSizes.set(key, size);
      return size;
    },
    onChange: (instance) => {
      const nextAtEnd = instance.isAtEnd();
      setAtEnd((current) => (current === nextAtEnd ? current : nextAtEnd));
      if (nextAtEnd) lastReadRef.current = model.rows.at(-1)?.id;
      const element = instance.scrollElement;
      if (
        element !== null &&
        (position.saved === undefined ||
          position.saved.width === element.clientWidth)
      ) {
        const offset = instance.scrollOffset ?? element.scrollTop;
        const anchor = instance
          .getVirtualItems()
          .find((item) => item.end > offset);
        position.saved = {
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
        };
      }
      refreshVisiblePromptRows();
      scheduleHistoryDrain();
    },
  });

  const measureTurn = React.useCallback(
    (element: HTMLDivElement | null) => {
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
    },
    [scheduleHistoryDrain, virtualizer],
  );

  const listRef = React.useCallback(
    (element: HTMLDivElement | null) => {
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
      measureMargin();
      return observeTranscriptResize([element, viewport], measureMargin);
    },
    [scheduleHistoryDrain],
  );

  const hasUnread = !atEnd && model.rows.at(-1)?.id !== lastReadRef.current;
  const viewportRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      setScrollElement(element);
      if (element !== null) {
        const releaseHistoryViewport = historyViewportRef(element);
        let frame = 0;
        let width = restored?.width ?? element.clientWidth;
        const restoreAnchor = (saved: TranscriptPosition) => {
          cancelAnimationFrame(frame);
          if (saved.atEnd) {
            if (position.saved !== undefined)
              position.saved.width = element.clientWidth;
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
            if (position.saved !== undefined)
              position.saved.width = element.clientWidth;
            markHistoryRestored();
          });
        };
        const disconnect = observeTranscriptResize([element], () => {
          if (width === element.clientWidth || element.clientWidth === 0)
            return;
          const saved = position.saved ?? restored;
          width = element.clientWidth;
          measuredTurnSizes.clear();
          if (saved !== undefined) restoreAnchor(saved);
        });
        frame = requestAnimationFrame(() => {
          if (restored === undefined || restored.atEnd) {
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
    },
    [
      historyViewportRef,
      markHistoryRestored,
      measuredTurnSizes,
      position,
      restored,
      virtualizer,
    ],
  );
  const jumpToEnd = () => {
    virtualizer.scrollToEnd({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    setAtEnd(true);
    lastReadRef.current = model.rows.at(-1)?.id;
  };
  const navigateToRow = (rowId: TranscriptRowId) => {
    const turnId = model.outline.find(
      (anchor) => anchor.rowId === rowId,
    )?.turnId;
    const index = model.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, {
      align: "start",
      behavior: "auto",
    });
    window.requestAnimationFrame(() => {
      document.getElementById(rowId)?.focus({ preventScroll: true });
    });
  };
  return {
    viewportRef,
    listRef,
    measureTurn,
    virtualizer,
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
  } = props;
  const {
    viewportRef,
    listRef,
    measureTurn,
    virtualizer,
    scrollMargin,
    atEnd,
    hasUnread,
    visiblePromptRows,
    refreshVisiblePromptRows,
    historySentinelRef,
    jumpToEnd,
    navigateToRow,
  } = useTranscriptViewport(props);
  const processingTurnId = model.turns.findLast(
    (turn) => turn.status === "active",
  )?.id;
  const rowsByTurn = React.useMemo(() => transcriptRowsByTurn(model), [model]);
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
              height: `${virtualizer.getTotalSize()}px`,
              transitionProperty: "none",
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
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
          onClick={jumpToEnd}
        >
          <ArrowDown />
          {hasUnread ? <span className="unread-dot" /> : null}
        </Button>
      </div>
    </>
  );
}

export function ThreadTranscript(
  props: React.ComponentProps<typeof TranscriptViewport>,
) {
  return <TranscriptViewport {...props} />;
}
