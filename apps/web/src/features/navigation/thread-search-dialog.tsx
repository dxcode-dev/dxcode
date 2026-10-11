import type { SearchThreadsItem } from "@dx/api";
import type { UserId } from "@dx/domain";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Lock, Search } from "lucide-react";
import * as React from "react";
import { Avatar } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import { CommandSurfaceDialog } from "../../shared/ui/command-surface-dialog.js";
import { formatRelativeTime } from "../../shared/utils.js";
import { threadSearchQueryOptions } from "../threads/thread-queries.js";

/** Typing pauses this long before a search runs. */
const SEARCH_DEBOUNCE_MS = 250;
/** With nothing typed, the dialog lists recent active Threads. */
const EMPTY_QUERY = "archived:false";

const FILTERS = [
  { key: "project:", hint: "Limit results to a project" },
  { key: "author:", hint: "Threads by a person, or author:me" },
  { key: "visibility:", hint: "private or workspace" },
  { key: "repo:", hint: "Threads on a repository" },
  { key: "pinned:", hint: "true or false" },
  { key: "archived:", hint: "true or false" },
  { key: "color:", hint: "A Thread color, or auto" },
  { key: "id:", hint: "One exact Thread" },
  { key: "parent:", hint: "A Thread's child Threads" },
  { key: "after:", hint: "Active since 7d, 2w, or a date" },
  { key: "before:", hint: "Last active before a date" },
  { key: "updated_after:", hint: "Same as after:" },
  { key: "updated_before:", hint: "Same as before:" },
] as const;

const EXAMPLES = [
  {
    title: "Your Threads",
    description: "Filter to your Threads and match words.",
    query: 'author:me "thread search"',
  },
  {
    title: "Mentions a file",
    description: "Find Threads that mention a file by its name.",
    query: '"agent-tools.ts"',
  },
  {
    title: "Your archived Threads",
    description: "Only show your archived Threads.",
    query: "author:me archived:true",
  },
  {
    title: "Shared with you",
    description: "Threads your workspace shared.",
    query: "visibility:workspace",
  },
  {
    title: "Project and date range",
    description: "Narrow to one project and the last two weeks.",
    query: "project:dx after:14d",
  },
  {
    title: "Inactive Threads",
    description: "Threads with no activity in the last week.",
    query: "updated_before:7d",
  },
] as const;

function SearchSyntax({
  onExample,
}: {
  readonly onExample: (query: string) => void;
}) {
  return (
    <section className="thread-search-syntax" aria-label="Search syntax">
      <p>
        Words must all appear, matched by their stem; quotes group words.{" "}
        <code>author:</code> matches usernames, names, or emails,{" "}
        <code>project:</code> narrows to one project by name or ID, and{" "}
        <code>id:thr_…</code> finds one Thread. <code>visibility:private</code>{" "}
        or <code>visibility:workspace</code> only narrows Threads you can
        already open. <code>archived:</code> and <code>pinned:</code> take{" "}
        <code>true</code> or <code>false</code>, and <code>color:auto</code>{" "}
        finds Threads without a color. <code>after:</code> and{" "}
        <code>before:</code> take <code>7d</code>, <code>2w</code>, or{" "}
        <code>2026-03-01</code> and use the last activity, as do{" "}
        <code>updated_after:</code> and <code>updated_before:</code>.
      </p>
      <div className="thread-search-examples">
        {EXAMPLES.map((example) => (
          <button
            key={example.title}
            type="button"
            className="thread-search-example"
            onClick={() => onExample(example.query)}
          >
            <strong>{example.title}</strong>
            <span>{example.description}</span>
            <code>{example.query}</code>
          </button>
        ))}
      </div>
    </section>
  );
}

function ThreadSearchResult({
  item,
  active,
  id,
  onSelect,
  onPointerMove,
}: {
  readonly item: SearchThreadsItem;
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
        <strong>{item.title}</strong>
        <small className="thread-search-result-meta">
          <Avatar
            name={item.ownerName}
            seed={item.ownerUserId}
            className="thread-search-avatar"
          />
          {item.ownerName}
          <span aria-hidden="true">·</span>
          {formatRelativeTime({
            epochMilliseconds: Date.parse(item.lastActivityAt),
          })}
          <span className="thread-search-badge">
            {item.visibility === "private" ? (
              <>
                <Lock aria-hidden="true" /> Private
              </>
            ) : (
              "Workspace"
            )}
          </span>
          {item.archived ? (
            <span className="thread-search-badge">Archived</span>
          ) : item.state === "working" ? (
            <span className="thread-search-badge" data-active="">
              Active
            </span>
          ) : null}
        </small>
        {item.matchedSearchText === undefined ? null : (
          <span className="thread-search-snippet">
            {item.matchedSearchText}
          </span>
        )}
      </span>
      <span className="thread-search-project">{item.projectName}</span>
    </button>
  );
}

/**
 * Thread search over the server's query language: the signed-in person's
 * Threads and Threads shared with them, newest activity first.
 */
export function ThreadSearchDialog({
  open,
  userId,
  finalFocus,
  onOpenChange,
  onSelectThread,
}: {
  readonly open: boolean;
  readonly userId: UserId;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectThread: (threadId: string) => void;
}) {
  const [input, setInput] = React.useState("");
  const [submitted, setSubmitted] = React.useState("");
  const [syntaxOpen, setSyntaxOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [hint, setHint] = React.useState<string>(FILTERS[0].hint);
  const debounce = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const focusCombobox = React.useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.focus();
  }, []);
  const query = submitted.trim() === "" ? EMPTY_QUERY : submitted.trim();
  const search = useInfiniteQuery({
    ...threadSearchQueryOptions(userId, query),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const results = search.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedIndex = Math.min(activeIndex, Math.max(results.length - 1, 0));
  const activeId =
    results.length === 0 ? undefined : `thread-search-${selectedIndex}`;

  const updateQuery = (value: string, immediately = false) => {
    setInput(value);
    setActiveIndex(0);
    clearTimeout(debounce.current);
    if (immediately) setSubmitted(value);
    else
      debounce.current = setTimeout(
        () => setSubmitted(value),
        SEARCH_DEBOUNCE_MS,
      );
  };
  const insertFilter = (key: string) => {
    updateQuery(`${input.trimEnd()}${input.trim() === "" ? "" : " "}${key}`);
    inputRef.current?.focus();
  };
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      clearTimeout(debounce.current);
      setInput("");
      setSubmitted("");
      setSyntaxOpen(false);
      setActiveIndex(0);
    }
    onOpenChange(nextOpen);
  };
  const select = (item: SearchThreadsItem) => {
    changeOpen(false);
    onSelectThread(item.id);
  };

  return (
    <CommandSurfaceDialog
      open={open}
      onOpenChange={changeOpen}
      title="Search Threads"
      description="Search your Threads and Threads shared with your workspace."
      className="thread-search-dialog"
      finalFocus={finalFocus}
      pending={search.isFetching}
      error={search.error instanceof Error ? search.error.message : undefined}
      rightHeaderAction={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={syntaxOpen}
          onClick={() => setSyntaxOpen((current) => !current)}
        >
          Search Syntax
        </Button>
      }
      primary={
        <>
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
              value={input}
              placeholder="Search workspace threads…"
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && submitted !== input) {
                  updateQuery(input, true);
                  event.preventDefault();
                  return;
                }
                if (results.length === 0) return;
                if (event.key === "ArrowDown")
                  setActiveIndex((selectedIndex + 1) % results.length);
                else if (event.key === "ArrowUp")
                  setActiveIndex(
                    (selectedIndex - 1 + results.length) % results.length,
                  );
                else if (event.key === "Home") setActiveIndex(0);
                else if (event.key === "End")
                  setActiveIndex(results.length - 1);
                else if (event.key === "Enter") {
                  const item = results[selectedIndex];
                  if (item !== undefined) select(item);
                } else return;
                event.preventDefault();
              }}
            />
          </div>
          <div className="thread-search-filters">
            <div className="thread-search-filter-keys">
              {FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  className="thread-search-filter"
                  title={filter.hint}
                  onPointerEnter={() => setHint(filter.hint)}
                  onFocus={() => setHint(filter.hint)}
                  onClick={() => insertFilter(filter.key)}
                >
                  {filter.key}
                </button>
              ))}
            </div>
            <span className="thread-search-filter-hint">{hint}</span>
          </div>
        </>
      }
      footer={
        search.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void search.fetchNextPage()}
            disabled={search.isFetchingNextPage}
          >
            {search.isFetchingNextPage
              ? "Loading more Threads…"
              : "Load more Threads"}
          </Button>
        ) : undefined
      }
    >
      {syntaxOpen ? (
        <SearchSyntax
          onExample={(example) => {
            updateQuery(example, true);
            setSyntaxOpen(false);
            inputRef.current?.focus();
          }}
        />
      ) : null}
      <div
        id="thread-search-results"
        role="listbox"
        aria-label="Thread results"
      >
        <p className="thread-search-heading">Threads</p>
        {search.isPending ? (
          <p className="thread-search-state">Searching…</p>
        ) : results.length === 0 ? (
          <p className="thread-search-state">
            {search.isError ? "Search failed." : "No Threads match."}
          </p>
        ) : (
          results.map((item, index) => (
            <ThreadSearchResult
              key={item.id}
              id={`thread-search-${index}`}
              item={item}
              active={index === selectedIndex}
              onPointerMove={() => setActiveIndex(index)}
              onSelect={() => select(item)}
            />
          ))
        )}
      </div>
    </CommandSurfaceDialog>
  );
}
