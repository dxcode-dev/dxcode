import type { ProjectData, ThreadData } from "@dx/api";
import { Lock, Search } from "lucide-react";
import * as React from "react";
import { shortThreadName } from "../../shared/thread-label.js";
import { Button } from "../../shared/ui/button.js";
import { CommandSurfaceDialog } from "../../shared/ui/command-surface-dialog.js";

export interface ThreadSearchResultRow {
  readonly projectName: string;
  readonly thread: ThreadData;
}

const activityFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const formatActivity = (value: ThreadData["lastActivityAt"]) =>
  activityFormatter.format(new Date(value.epochMilliseconds));

function ThreadSearchResult({
  row,
  active,
  id,
  onSelect,
  onPointerMove,
}: {
  readonly row: ThreadSearchResultRow;
  readonly active: boolean;
  readonly id: string;
  readonly onSelect: () => void;
  readonly onPointerMove: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      className="thread-search-result"
      data-active={active || undefined}
      onClick={onSelect}
      onPointerMove={onPointerMove}
    >
      <span className="thread-search-result-copy">
        <strong>{shortThreadName(row.thread)}</strong>
        <small>
          {row.projectName}
          <span aria-hidden="true"> · </span>
          {formatActivity(row.thread.lastActivityAt)}
          <span aria-hidden="true"> · </span>
          {row.thread.lifecycleState === "archived"
            ? "archived"
            : row.thread.activityStatus}
        </small>
      </span>
      {row.thread.visibility === "private" ? (
        <span className="thread-search-privacy">
          <Lock aria-hidden="true" /> Private
        </span>
      ) : (
        <span className="thread-search-privacy">Workspace</span>
      )}
    </button>
  );
}

export function ThreadSearchDialog({
  open,
  projects,
  threads,
  hasMore,
  loading,
  error,
  finalFocus,
  onLoadMore,
  onOpenChange,
  onSelectThread,
}: {
  readonly open: boolean;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly threads: ReadonlyArray<ThreadData>;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
  readonly onLoadMore: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectThread: (thread: ThreadData) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const focusCombobox = React.useCallback(
    (node: HTMLInputElement | null) => node?.focus(),
    [],
  );
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = threads.flatMap((thread) => {
    const projectName = projectNames.get(thread.projectId) ?? "Unknown project";
    return normalizedQuery.length === 0 ||
      `${shortThreadName(thread)} ${projectName}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
      ? [{ thread, projectName }]
      : [];
  });
  const selectedIndex = Math.min(activeIndex, Math.max(results.length - 1, 0));
  const activeId =
    results.length === 0 ? undefined : `thread-search-${selectedIndex}`;
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setActiveIndex(0);
    }
    onOpenChange(nextOpen);
  };
  const select = (thread: ThreadData) => {
    changeOpen(false);
    onSelectThread(thread);
  };

  return (
    <CommandSurfaceDialog
      open={open}
      onOpenChange={changeOpen}
      title="Search Threads"
      description="Search the workspace Threads currently loaded on this device."
      className="thread-search-dialog"
      finalFocus={finalFocus}
      pending={loading}
      error={error}
      primary={
        <div className="thread-search-input-wrap">
          <Search aria-hidden="true" />
          <input
            ref={focusCombobox}
            role="combobox"
            aria-label="Search workspace threads"
            aria-autocomplete="list"
            aria-controls="thread-search-results"
            aria-expanded="true"
            aria-activedescendant={activeId}
            value={query}
            placeholder="Search workspace threads…"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (results.length === 0) return;
              if (event.key === "ArrowDown")
                setActiveIndex((selectedIndex + 1) % results.length);
              else if (event.key === "ArrowUp")
                setActiveIndex(
                  (selectedIndex - 1 + results.length) % results.length,
                );
              else if (event.key === "Home") setActiveIndex(0);
              else if (event.key === "End") setActiveIndex(results.length - 1);
              else if (event.key === "Enter")
                select(results[selectedIndex].thread);
              else return;
              event.preventDefault();
            }}
          />
        </div>
      }
      footer={
        hasMore ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loading}
          >
            {loading ? "Loading more Threads…" : "Load more Threads"}
          </Button>
        ) : undefined
      }
    >
      <div
        id="thread-search-results"
        role="listbox"
        aria-label="Thread results"
      >
        {loading && threads.length === 0 ? (
          <p className="thread-search-state">Loading Threads…</p>
        ) : results.length === 0 ? (
          <p className="thread-search-state">
            {normalizedQuery.length === 0
              ? "No loaded Threads yet."
              : "No loaded Threads match your search."}
          </p>
        ) : (
          results.map((row, index) => (
            <ThreadSearchResult
              key={row.thread.id}
              id={`thread-search-${index}`}
              row={row}
              active={index === selectedIndex}
              onPointerMove={() => setActiveIndex(index)}
              onSelect={() => select(row.thread)}
            />
          ))
        )}
        {loading && threads.length > 0 ? (
          <p className="thread-search-state">Loading more Threads…</p>
        ) : null}
      </div>
    </CommandSurfaceDialog>
  );
}
