import { Menu } from "@base-ui/react/menu";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Building2, Check, ChevronDown, UserRound } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { MenuItemText } from "../../../shared/ui/menu-item-text.js";
import { projectsQueryOptions } from "../../projects/project-queries.js";
import type { McpServerData, ProjectData } from "./mcp-queries.js";
import type { McpRun } from "./mcp-server-sheet.js";

type ProjectId = McpServerData["projectIds"][number];
type Scope = "all" | "only";

const SCOPE_COPY = {
  all: {
    label: "All projects",
    detail: "Every project's Threads, including new projects.",
  },
  only: {
    label: "Only these",
    detail: "Only Threads in the projects you pick.",
  },
} as const;

/**
 * The projects a server can be limited to. A personal server reaches the
 * person's projects and their workspace's; a workspace server only the
 * workspace's. Core enforces the grants; this only offers the choices.
 */
const choicesFor = (
  server: McpServerData,
  projects: ReadonlyArray<ProjectData>,
) =>
  server.scope === "workspace"
    ? projects.filter((project) => project.workspaceId !== undefined)
    : projects;

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const other = new Set(b);
  return a.length === other.size && a.every((id) => other.has(id));
};

function ScopeMenu({
  value,
  disabled,
  onChoose,
}: {
  readonly value: Scope;
  readonly disabled: boolean;
  readonly onChoose: (scope: Scope) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className="mcp-projects-scope"
            aria-label={`Projects: ${SCOPE_COPY[value].label}`}
          />
        }
      >
        {SCOPE_COPY[value].label}
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup mcp-menu-popup">
            <Menu.RadioGroup
              value={value}
              onValueChange={(next) => onChoose(next as Scope)}
            >
              {(["all", "only"] as const).map((scope) => (
                <Menu.RadioItem
                  key={scope}
                  value={scope}
                  className="thread-menu-item mcp-menu-radio"
                >
                  <Menu.RadioItemIndicator className="mcp-menu-indicator">
                    <Check />
                  </Menu.RadioItemIndicator>
                  <MenuItemText
                    title={SCOPE_COPY[scope].label}
                    description={SCOPE_COPY[scope].detail}
                  />
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Which projects' Threads can use the server. All projects (no grants) is
 * one row; Only these opens a searchable checklist that saves with its own
 * Save. Members who cannot edit the server see the choice without changing
 * it.
 */
export function McpServerProjects({
  server,
  canMutate,
  busy,
  run,
}: {
  readonly server: McpServerData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: McpRun;
}) {
  const { identity } = useAuthenticatedIdentity();
  const projects = useInfiniteQuery(projectsQueryOptions(identity.id));
  // Only these, chosen but not saved yet.
  const [choosing, setChoosing] = React.useState(false);
  // Ticks not saved yet.
  const [draft, setDraft] = React.useState<ReadonlySet<ProjectId>>();
  // Grants on their way to the server, shown until it answers.
  const [pending, setPending] = React.useState<ReadonlyArray<ProjectId>>();
  const [query, setQuery] = React.useState("");
  const choices = choicesFor(
    server,
    projects.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const more = projects.hasNextPage;
  const offered = new Set<string>(choices.map((project) => project.id));
  // Grants on project pages not loaded yet are kept; a deleted project can
  // no longer be granted, so it drops out on save.
  const unlisted = more
    ? server.projectIds.filter((id) => !offered.has(id))
    : [];
  const current = pending ?? server.projectIds;
  const scope: Scope = choosing || current.length > 0 ? "only" : "all";
  const ticked = draft ?? new Set(current);
  const picks = [
    ...choices.flatMap((project) =>
      ticked.has(project.id) ? [project.id] : [],
    ),
    ...unlisted,
  ];
  const dirty = draft !== undefined && !sameIds(picks, current);
  const needle = query.trim().toLowerCase();
  const shown = choices.filter((project) =>
    project.name.toLowerCase().includes(needle),
  );
  const disabled = !canMutate || busy;
  const reset = () => {
    setChoosing(false);
    setDraft(undefined);
    setQuery("");
  };
  const save = async (projectIds: ReadonlyArray<ProjectId>) => {
    setPending(projectIds);
    reset();
    // On failure the page shows the error and the saved grants return.
    await run(
      { type: "update", serverId: server.id, input: { projectIds } },
      `${server.name} projects saved.`,
    );
    setPending(undefined);
  };
  return (
    <section
      className="mcp-tools mcp-projects"
      aria-label="Projects"
      data-open={scope === "only" || undefined}
    >
      <div className="mcp-tools-header">
        <strong className="mcp-projects-title">Projects</strong>
        <ScopeMenu
          value={scope}
          disabled={disabled}
          onChoose={(next) => {
            if (next === scope) return;
            if (next === "only") {
              setChoosing(true);
              return;
            }
            if (current.length === 0) reset();
            else void save([]);
          }}
        />
      </div>
      {scope === "only" ? (
        <>
          {choices.length > 6 || needle !== "" ? (
            <input
              className="additional-repositories-search mcp-projects-search"
              type="search"
              placeholder="Search projects"
              aria-label="Search projects"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <ul className="mcp-projects-list">
            {shown.map((project) => {
              const checked = ticked.has(project.id);
              return (
                <li key={project.id}>
                  <label className="mcp-project-option">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => {
                        const next = new Set(ticked);
                        if (checked) next.delete(project.id);
                        else next.add(project.id);
                        setDraft(next);
                      }}
                    />
                    <span
                      className="repository-checkbox"
                      data-checked={checked ? "" : undefined}
                      aria-hidden="true"
                    >
                      {checked ? <Check /> : null}
                    </span>
                    <span>{project.name}</span>
                    {project.workspaceId === undefined ? (
                      <UserRound aria-label="Personal project" />
                    ) : (
                      <Building2 aria-label="Workspace project" />
                    )}
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="mcp-projects-empty">
                {projects.isPending
                  ? "Loading projects…"
                  : choices.length === 0
                    ? "No projects yet."
                    : "No matches."}
              </li>
            ) : null}
          </ul>
          {more ? (
            <div className="mcp-projects-more">
              <Button
                size="xs"
                variant="ghost"
                type="button"
                onClick={() => void projects.fetchNextPage()}
              >
                Load more projects
              </Button>
            </div>
          ) : null}
          {dirty || (choosing && current.length === 0) ? (
            <footer className="mcp-dialog-actions mcp-projects-actions">
              <Button size="xs" variant="ghost" type="button" onClick={reset}>
                Cancel
              </Button>
              <Button
                size="xs"
                type="button"
                disabled={busy || picks.length === 0 || !dirty}
                onClick={() => void save(picks)}
              >
                Save
              </Button>
            </footer>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
