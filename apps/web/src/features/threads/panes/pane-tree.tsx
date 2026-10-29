import type {
  ThreadPane,
  ThreadPaneLayout,
  ThreadPaneNode,
  ThreadPaneSplit,
  ThreadPaneTab,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Menu } from "@base-ui/react/menu";
import { Ellipsis, RefreshCw, X } from "lucide-react";
import * as React from "react";
import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import { absolutePathFor, sandboxFileUrl } from "../transcript-file-link.js";
import {
  currentPaneDrag,
  dropIndexFor,
  dropPreviewBox,
  type DropZone,
  dropZoneFor,
  endPaneDrag,
  PANE_DRAG_MIME,
  startPaneDrag,
  usePaneDrag,
} from "./pane-drag.js";
import {
  PANE_MIN_SHARE,
  type PaneLayoutAction,
  paneTabDomId,
  panelDomId,
  tabId,
  tabLabel,
} from "./pane-layout.js";
import { OpenTabMenuButton, PaneTabContextMenu } from "./pane-menus.js";
import { PaneToolbarSlotContext } from "./pane-toolbar-slot-context.js";
import {
  PANE_VIEWS,
  type PaneContents,
  renderPaneContent,
} from "./pane-views.js";
import "./panes.css";

type Dispatch = (action: PaneLayoutAction) => void;

/** Resizes the two children around a divider from pointer moves. */
function PaneDivider({
  direction,
  split,
  index,
  dispatch,
}: {
  readonly direction: ThreadPaneSplit["direction"];
  readonly split: ThreadPaneSplit;
  readonly index: number;
  readonly dispatch: Dispatch;
}) {
  const [resizing, setResizing] = React.useState(false);
  const horizontal = direction === "row";
  const sizes = split.sizes;
  const resizeBy = (fraction: number) => {
    const before = sizes[index] ?? 0;
    const after = sizes[index + 1] ?? 0;
    const pair = before + after;
    const minimum = Math.min(PANE_MIN_SHARE, pair / 2);
    const nextBefore = Math.min(
      Math.max(before + fraction, minimum),
      pair - minimum,
    );
    const next = [...sizes];
    next[index] = nextBefore;
    next[index + 1] = pair - nextBefore;
    dispatch({ type: "resize", split: split.id, sizes: next });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that resizes is a slider for assistive tech.
    <div
      className="pane-divider"
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={
        horizontal ? "Resize panes horizontally" : "Resize panes vertically"
      }
      aria-valuenow={Math.round((sizes[index] ?? 0) * 100)}
      aria-valuemin={Math.round(PANE_MIN_SHARE * 100)}
      aria-valuemax={100 - Math.round(PANE_MIN_SHARE * 100)}
      tabIndex={0}
      data-resizing={resizing || undefined}
      onKeyDown={(event) => {
        const shrink = horizontal ? "ArrowLeft" : "ArrowUp";
        const grow = horizontal ? "ArrowRight" : "ArrowDown";
        if (event.key !== shrink && event.key !== grow) return;
        event.preventDefault();
        resizeBy(event.key === grow ? 0.02 : -0.02);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const divider = event.currentTarget;
        const before = divider.previousElementSibling as HTMLElement | null;
        const after = divider.nextElementSibling as HTMLElement | null;
        const container = divider.parentElement;
        if (before === null || after === null || container === null) return;
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        const measure = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return horizontal ? rect.width : rect.height;
        };
        const containerSize = measure(container);
        const startBefore = measure(before);
        const startAfter = measure(after);
        const pairPx = startBefore + startAfter;
        const pairShare = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
        const minimumPx = Math.min(PANE_MIN_SHARE * containerSize, pairPx / 2);
        const start = horizontal ? event.clientX : event.clientY;
        let beforePx = startBefore;
        const apply = (clientX: number, clientY: number) => {
          const delta = (horizontal ? clientX : clientY) - start;
          beforePx = Math.min(
            Math.max(startBefore + delta, minimumPx),
            pairPx - minimumPx,
          );
          const beforeShare = (pairShare * beforePx) / pairPx;
          before.style.flex = `${beforeShare} 1 0%`;
          after.style.flex = `${pairShare - beforeShare} 1 0%`;
        };
        const finish = () => {
          divider.removeEventListener("pointermove", onMove);
          divider.removeEventListener("pointerup", finish);
          divider.removeEventListener("pointercancel", finish);
          if (divider.hasPointerCapture(event.pointerId))
            divider.releasePointerCapture(event.pointerId);
          setResizing(false);
          const beforeShare = (pairShare * beforePx) / pairPx;
          const next = [...sizes];
          next[index] = beforeShare;
          next[index + 1] = pairShare - beforeShare;
          dispatch({ type: "resize", split: split.id, sizes: next });
        };
        const onMove = (move: PointerEvent) =>
          apply(move.clientX, move.clientY);
        divider.addEventListener("pointermove", onMove);
        divider.addEventListener("pointerup", finish);
        divider.addEventListener("pointercancel", finish);
        setResizing(true);
      }}
    />
  );
}

/** A vertical wheel over the strip scrolls it sideways, as VS Code's does. */
const scrollStripWithWheel = (event: React.WheelEvent<HTMLDivElement>) => {
  const strip = event.currentTarget;
  if (event.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft += event.deltaY;
};

/**
 * Scrolls a newly shown tab fully into view after layout, from an
 * intersection report, so showing a tab never forces a layout; a tab already
 * in full view stays put.
 */
const revealTab = (node: HTMLDivElement | null) => {
  if (node === null) return;
  const strip = node.closest('[role="tablist"]');
  const observer = new IntersectionObserver(
    ([entry]) => {
      observer.disconnect();
      if (entry !== undefined && entry.intersectionRatio < 1)
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    { root: strip, threshold: 1 },
  );
  observer.observe(node);
  return () => observer.disconnect();
};

const fileLocationLabel = (tab: Extract<ThreadPaneTab, { kind: "file" }>) =>
  tab.target.kind === "sandbox"
    ? tab.target.path
    : tab.target.worktreeLabel === undefined
      ? tab.target.path
      : `${tab.target.worktreeLabel}: ${tab.target.path}`;

function TabIcon({ tab }: { readonly tab: ThreadPaneTab }) {
  if (tab.kind === "agent") return <OrbIcon aria-hidden="true" />;
  if (tab.kind === "file") return null;
  const { Icon } = PANE_VIEWS[tab.kind];
  return <Icon aria-hidden="true" />;
}

function PaneTab({
  pane,
  tab,
  tabs,
  active,
  dirty,
  threadId,
  dispatch,
}: {
  readonly pane: ThreadPane;
  readonly tab: ThreadPaneTab;
  readonly tabs: ReadonlyArray<ThreadPaneTab>;
  readonly active: boolean;
  readonly dirty: boolean;
  readonly threadId: ThreadId;
  readonly dispatch: Dispatch;
}) {
  const id = tabId(tab);
  const label = tabLabel(tab);
  const title = tab.kind === "file" ? fileLocationLabel(tab) : label;
  const close = () => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${label}?`))
      return;
    dispatch({ type: "close", tab: id });
  };
  const element = (
    // biome-ignore lint/a11y/noStaticElementInteractions: the tab button inside is the interactive element; the wrapper only hosts the drag source.
    <div
      className="pane-tab"
      ref={active ? revealTab : undefined}
      role="presentation"
      data-active={active || undefined}
      data-kind={tab.kind}
      data-tab={id}
      draggable={tab.kind !== "agent" || tabs.length > 1}
      onDragStart={(event) => {
        event.dataTransfer.setData(PANE_DRAG_MIME, id);
        event.dataTransfer.effectAllowed = "move";
        startPaneDrag({ tab: id, pane: pane.id });
      }}
      onDragEnd={endPaneDrag}
      onAuxClick={(event) => {
        if (event.button === 1 && tab.kind !== "agent") {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        id={paneTabDomId(id)}
        type="button"
        role="tab"
        className="pane-tab-trigger"
        aria-selected={active}
        aria-controls={panelDomId(id)}
        aria-label={`${label}${dirty ? " (unsaved)" : ""}`}
        title={title}
        tabIndex={active ? 0 : -1}
        onClick={() => dispatch({ type: "activate", pane: pane.id, tab: id })}
      >
        <TabIcon tab={tab} />
        <span className="pane-tab-label">{label}</span>
        {dirty ? <span className="pane-tab-dirty" aria-hidden="true" /> : null}
      </button>
      {tab.kind === "agent" ? null : (
        <button
          type="button"
          className="pane-tab-close"
          aria-label={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            close();
          }}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
  if (tab.kind === "agent") return element;
  const file =
    tab.kind === "file"
      ? (() => {
          const absolute = absolutePathFor(tab.target);
          return {
            path: tab.target.path,
            ...(absolute === undefined
              ? {}
              : { downloadUrl: sandboxFileUrl(threadId, absolute, true) }),
          };
        })()
      : undefined;
  return (
    <PaneTabContextMenu
      pane={pane.id}
      tab={tab}
      tabs={tabs}
      dispatch={dispatch}
      {...(file === undefined ? {} : { file })}
    >
      {element}
    </PaneTabContextMenu>
  );
}

function PaneTabStrip({
  pane,
  layout,
  contents,
  threadId,
  dispatch,
  dropIndex,
  onToolbarSlot,
}: {
  readonly pane: ThreadPane;
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly threadId: ThreadId;
  readonly dispatch: Dispatch;
  /** Where a dragged tab would land in this strip, while one hovers it. */
  readonly dropIndex: number | undefined;
  readonly onToolbarSlot: (node: HTMLDivElement | null) => void;
}) {
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = pane.tabs.length;
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (pane.active + 1) % count;
    else if (event.key === "ArrowLeft")
      next = (pane.active - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    const tab = next === undefined ? undefined : pane.tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    dispatch({ type: "activate", pane: pane.id, tab: tabId(tab) });
    requestAnimationFrame(() =>
      document.getElementById(paneTabDomId(tabId(tab)))?.focus(),
    );
  };
  return (
    <header className="pane-strip">
      <div
        className="pane-tabs"
        role="tablist"
        aria-label="Pane tabs"
        onKeyDown={moveFocus}
        onWheel={scrollStripWithWheel}
      >
        {pane.tabs.map((tab, index) => (
          <React.Fragment key={tabId(tab)}>
            {dropIndex === index ? (
              <span className="pane-tab-drop-marker" aria-hidden="true" />
            ) : null}
            <PaneTab
              pane={pane}
              tab={tab}
              tabs={pane.tabs}
              active={index === pane.active}
              dirty={contents.dirtyTabs.has(tabId(tab))}
              threadId={threadId}
              dispatch={dispatch}
            />
          </React.Fragment>
        ))}
        {dropIndex === pane.tabs.length ? (
          <span className="pane-tab-drop-marker" aria-hidden="true" />
        ) : null}
        <OpenTabMenuButton
          layout={layout}
          contents={contents}
          onOpen={(view) =>
            dispatch({ type: "open-view", view, pane: pane.id })
          }
        />
      </div>
      <div className="pane-strip-actions" ref={onToolbarSlot} />
    </header>
  );
}

function PaneTabPanel({
  tab,
  active,
  contents,
  toolbarSlot,
}: {
  readonly tab: ThreadPaneTab;
  readonly active: boolean;
  readonly contents: PaneContents;
  readonly toolbarSlot: HTMLDivElement | null;
}) {
  const id = tabId(tab);
  const content =
    tab.kind === "agent"
      ? renderPaneContent(contents.agent, active)
      : tab.kind === "file"
        ? contents.file(tab.target, active)
        : renderPaneContent(contents.views[tab.kind], active);
  return (
    <div
      id={panelDomId(id)}
      className="pane-panel"
      role="tabpanel"
      aria-labelledby={paneTabDomId(id)}
      aria-label={tabLabel(tab)}
      data-kind={tab.kind}
      hidden={!active}
      inert={!active}
    >
      <PaneToolbarSlotContext value={active ? toolbarSlot : null}>
        {tab.kind === "terminal" ? (
          <TerminalView>{content}</TerminalView>
        ) : (
          content
        )}
      </PaneToolbarSlotContext>
    </div>
  );
}

/** The Terminal with a floating `⋯` of Terminal actions at its top right. */
function TerminalView({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="pane-terminal-view">
      {children}
      <Menu.Root>
        <Menu.Trigger
          className="pane-terminal-actions"
          aria-label="Terminal Actions"
          title="Terminal Actions"
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup thread-actions-menu">
              <Menu.Item
                className="thread-menu-item"
                nativeButton
                render={
                  <button type="submit" form="thread-terminal-environment" />
                }
              >
                <RefreshCw aria-hidden="true" />
                <span>Refresh Environment</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

interface StripDrop {
  readonly kind: "strip";
  readonly index: number;
}
interface BodyDrop {
  readonly kind: "body";
  readonly zone: DropZone;
}
type DropTarget = StripDrop | BodyDrop;

/** A drag from a pane tab, by the module record or the event's own type. */
const acceptsDrag = (event: React.DragEvent) =>
  currentPaneDrag() !== undefined ||
  event.dataTransfer.types.includes(PANE_DRAG_MIME);

const sameDrop = (
  left: DropTarget | undefined,
  right: DropTarget | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.kind === right.kind &&
    (left.kind === "strip"
      ? left.index === (right as StripDrop).index
      : left.zone === (right as BodyDrop).zone));

function PaneView({
  pane,
  layout,
  contents,
  threadId,
  dispatch,
}: {
  readonly pane: ThreadPane;
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly threadId: ThreadId;
  readonly dispatch: Dispatch;
}) {
  const focused = layout.focused === pane.id;
  const drag = usePaneDrag();
  const [drop, setDrop] = React.useState<DropTarget | undefined>(undefined);
  const [toolbarSlot, setToolbarSlot] = React.useState<HTMLDivElement | null>(
    null,
  );
  // A drag that ended elsewhere leaves no preview behind.
  const shownDrop = drag === undefined ? undefined : drop;
  const updateDrop = (next: DropTarget | undefined) => {
    if (!sameDrop(drop, next)) setDrop(next);
  };
  const onDrop = (event: React.DragEvent, target: DropTarget) => {
    const current = currentPaneDrag();
    const tab = current?.tab ?? event.dataTransfer.getData(PANE_DRAG_MIME);
    event.preventDefault();
    setDrop(undefined);
    endPaneDrag();
    if (tab === "") return;
    if (target.kind === "strip")
      dispatch({
        type: "move",
        tab,
        to: { pane: pane.id, index: target.index },
      });
    else if (target.zone === "center")
      dispatch({ type: "move", tab, to: { pane: pane.id } });
    else
      dispatch({ type: "move", tab, to: { pane: pane.id, side: target.zone } });
  };
  const leave = (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    updateDrop(undefined);
  };
  const previewZone: DropZone | undefined =
    shownDrop === undefined
      ? undefined
      : shownDrop.kind === "body"
        ? shownDrop.zone
        : "center";
  const preview =
    previewZone === undefined ? undefined : dropPreviewBox(previewZone);
  return (
    <section
      className="thread-pane"
      aria-label={`Pane ${tabLabel(pane.tabs[pane.active] ?? pane.tabs[0] ?? { kind: "agent" })}`}
      data-pane={pane.id}
      data-focused={focused || undefined}
      data-drop-target={shownDrop === undefined ? undefined : ""}
      onPointerDownCapture={() => {
        if (!focused) dispatch({ type: "focus", pane: pane.id });
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragged tabs; the tabs inside stay the interactive elements. */}
      <div
        className="pane-strip-drop"
        onDragOver={(event) => {
          if (!acceptsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rects = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(".pane-tab"),
          ].map((element) => element.getBoundingClientRect());
          updateDrop({
            kind: "strip",
            index: dropIndexFor(rects, event.clientX),
          });
        }}
        onDragLeave={leave}
        onDrop={(event) =>
          onDrop(event, shownDrop ?? { kind: "strip", index: pane.tabs.length })
        }
      >
        <PaneTabStrip
          pane={pane}
          layout={layout}
          contents={contents}
          threadId={threadId}
          dispatch={dispatch}
          dropIndex={shownDrop?.kind === "strip" ? shownDrop.index : undefined}
          onToolbarSlot={setToolbarSlot}
        />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragged tabs; the content inside stays interactive. */}
      <div
        className="pane-body"
        onDragOver={(event) => {
          if (!acceptsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          updateDrop({
            kind: "body",
            zone: dropZoneFor(
              event.currentTarget.getBoundingClientRect(),
              event.clientX,
              event.clientY,
            ),
          });
        }}
        onDragLeave={leave}
        onDrop={(event) =>
          onDrop(event, shownDrop ?? { kind: "body", zone: "center" })
        }
      >
        {pane.tabs.map((tab, index) => (
          <PaneTabPanel
            key={tabId(tab)}
            tab={tab}
            active={index === pane.active}
            contents={contents}
            toolbarSlot={toolbarSlot}
          />
        ))}
        {preview === undefined ? null : (
          <div className="pane-drop-layer" aria-hidden="true">
            <div
              className="pane-drop-preview"
              data-zone={previewZone}
              style={
                {
                  "--x": `${preview.left}%`,
                  "--y": `${preview.top}%`,
                  "--w": `${preview.width}%`,
                  "--h": `${preview.height}%`,
                } as React.CSSProperties
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}

function PaneNodeView({
  node,
  layout,
  contents,
  threadId,
  dispatch,
}: {
  readonly node: ThreadPaneNode;
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly threadId: ThreadId;
  readonly dispatch: Dispatch;
}) {
  if (node.kind === "pane")
    return (
      <PaneView
        pane={node}
        layout={layout}
        contents={contents}
        threadId={threadId}
        dispatch={dispatch}
      />
    );
  return (
    <div
      className="pane-split"
      data-direction={node.direction}
      data-split={node.id}
    >
      {node.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index === 0 ? null : (
            <PaneDivider
              direction={node.direction}
              split={node}
              index={index - 1}
              dispatch={dispatch}
            />
          )}
          <div
            className="pane-split-child"
            style={{ flex: `${node.sizes[index] ?? 0} 1 0%` }}
          >
            <PaneNodeView
              node={child}
              layout={layout}
              contents={contents}
              threadId={threadId}
              dispatch={dispatch}
            />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

/** The Thread page's panes: a tree of splits and tabbed panes. */
export function ThreadPaneTree({
  layout,
  contents,
  threadId,
  dispatch,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly threadId: ThreadId;
  readonly dispatch: Dispatch;
}) {
  return (
    <div className="thread-pane-tree">
      <PaneNodeView
        node={layout.root}
        layout={layout}
        contents={contents}
        threadId={threadId}
        dispatch={dispatch}
      />
    </div>
  );
}
