import type { ThreadPaneLayout, ThreadPaneTab } from "@dx/api";
import { X } from "lucide-react";
import * as React from "react";
import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import {
  flattenPaneTabs,
  focusedTab,
  type PaneLayoutAction,
  type PaneViewKind,
  tabId,
  tabLabel,
} from "./pane-layout.js";
import { PaneToolbarSlotContext } from "./pane-toolbar-slot-context.js";
import {
  PANE_VIEWS,
  type PaneContents,
  renderPaneContent,
} from "./pane-views.js";

type Dispatch = (action: PaneLayoutAction) => void;

/** The phone order: the conversation, what it changed, then the views. */
const STACKED_VIEW_ORDER: ReadonlyArray<PaneViewKind> = [
  "changes",
  "portal",
  "files",
  "terminal",
  "desktop",
];

const rowId = (id: string) =>
  `thread-stacked-tab-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
const panelId = (id: string) =>
  `thread-stacked-panel-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * Scrolls a newly chosen entry fully into view after layout, from an
 * intersection report, so choosing one never forces a layout of the view it
 * shows; an entry already in full view stays put.
 */
const revealSelected = (node: HTMLElement | null) => {
  if (node === null) return;
  const observer = new IntersectionObserver(
    ([entry]) => {
      observer.disconnect();
      if (entry !== undefined && entry.intersectionRatio < 1)
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    { root: node.closest('[role="tablist"]'), threshold: 1 },
  );
  observer.observe(node);
  return () => observer.disconnect();
};

type RowEntry =
  | {
      readonly kind: "open";
      readonly tab: ThreadPaneTab;
      readonly pane: string;
    }
  | { readonly kind: "closed"; readonly view: PaneViewKind };

/** Agent, then each view (open or not) in phone order, then open files. */
const rowEntries = (
  layout: ThreadPaneLayout,
  contents: PaneContents,
): ReadonlyArray<RowEntry> => {
  const open = flattenPaneTabs(layout);
  const byKind = new Map(open.map((entry) => [entry.tab.kind, entry]));
  const agent = byKind.get("agent");
  const entries: RowEntry[] = [];
  if (agent !== undefined)
    entries.push({ kind: "open", tab: agent.tab, pane: agent.pane });
  for (const view of STACKED_VIEW_ORDER) {
    if (contents.views[view] === undefined) continue;
    const located = byKind.get(view);
    entries.push(
      located === undefined
        ? { kind: "closed", view }
        : { kind: "open", tab: located.tab, pane: located.pane },
    );
  }
  for (const entry of open)
    if (entry.tab.kind === "file")
      entries.push({ kind: "open", tab: entry.tab, pane: entry.pane });
  return entries;
};

function RowButton({
  entry,
  selected,
  dirty,
  dispatch,
}: {
  readonly entry: RowEntry;
  readonly selected: boolean;
  readonly dirty: boolean;
  readonly dispatch: Dispatch;
}) {
  if (entry.kind === "closed") {
    const { label, Icon } = PANE_VIEWS[entry.view];
    return (
      <div className="stacked-tab" role="presentation" data-kind={entry.view}>
        <button
          type="button"
          role="tab"
          className="stacked-tab-trigger"
          aria-selected={false}
          aria-label={label}
          onClick={() =>
            React.startTransition(() =>
              dispatch({ type: "open-view", view: entry.view }),
            )
          }
        >
          <Icon aria-hidden="true" />
          <span className="stacked-tab-label">{label}</span>
        </button>
      </div>
    );
  }
  const { tab, pane } = entry;
  const id = tabId(tab);
  const label = tabLabel(tab);
  const Icon =
    tab.kind === "agent"
      ? OrbIcon
      : tab.kind === "file"
        ? null
        : PANE_VIEWS[tab.kind].Icon;
  return (
    <div
      className="stacked-tab"
      role="presentation"
      data-kind={tab.kind}
      data-active={selected || undefined}
    >
      <button
        id={rowId(id)}
        ref={selected ? revealSelected : undefined}
        type="button"
        role="tab"
        className="stacked-tab-trigger"
        aria-selected={selected}
        aria-controls={panelId(id)}
        aria-label={`${tab.kind === "file" ? tab.target.path : label}${dirty ? " (unsaved)" : ""}`}
        onClick={() =>
          // Showing a view can render a whole hidden transcript; a
          // transition lets that render yield to input.
          React.startTransition(() =>
            dispatch({ type: "activate", pane, tab: id }),
          )
        }
      >
        {Icon === null ? null : <Icon aria-hidden="true" />}
        <span className="stacked-tab-label">{label}</span>
        {dirty ? <span className="pane-tab-dirty" aria-hidden="true" /> : null}
      </button>
      {tab.kind === "agent" ? null : (
        <button
          type="button"
          className="stacked-tab-close"
          aria-label={`Close ${label}`}
          onClick={() => {
            if (
              dirty &&
              !window.confirm(`Discard unsaved changes to ${label}?`)
            )
              return;
            dispatch({ type: "close", tab: id });
          }}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The phone and portrait-tablet layout: one scrolling row of views above a
 * single shown view. It reads the same layout as the panes; the shown view
 * is the focused pane's active tab.
 */
export function ThreadStackedLayout({
  layout,
  contents,
  dispatch,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly dispatch: Dispatch;
}) {
  const [toolbarSlot, setToolbarSlot] = React.useState<HTMLDivElement | null>(
    null,
  );
  const shown = focusedTab(layout);
  const shownId = shown === undefined ? "agent" : tabId(shown);
  const entries = rowEntries(layout, contents);
  const open = flattenPaneTabs(layout);
  return (
    <>
      <div className="stacked-view-row">
        <div className="stacked-tabs" role="tablist" aria-label="Thread views">
          {entries.map((entry) => {
            const key =
              entry.kind === "closed"
                ? `closed:${entry.view}`
                : tabId(entry.tab);
            const id = entry.kind === "closed" ? undefined : tabId(entry.tab);
            return (
              <RowButton
                key={key}
                entry={entry}
                selected={id === shownId}
                dirty={id !== undefined && contents.dirtyTabs.has(id)}
                dispatch={dispatch}
              />
            );
          })}
        </div>
        <div
          className="pane-strip-actions stacked-row-actions"
          ref={setToolbarSlot}
        />
      </div>
      <main className="mobile-pane-content stacked-body">
        {open.map(({ tab, id }) => {
          const active = id === shownId;
          const content =
            tab.kind === "agent"
              ? renderPaneContent(contents.agent, active)
              : tab.kind === "file"
                ? contents.file(tab.target, active)
                : renderPaneContent(contents.views[tab.kind], active);
          return (
            <section
              key={id}
              id={panelId(id)}
              className="stacked-panel"
              role="tabpanel"
              aria-labelledby={rowId(id)}
              aria-label={tabLabel(tab)}
              data-kind={tab.kind}
              hidden={!active}
              inert={!active}
            >
              <PaneToolbarSlotContext value={active ? toolbarSlot : null}>
                {content}
              </PaneToolbarSlotContext>
            </section>
          );
        })}
      </main>
    </>
  );
}
