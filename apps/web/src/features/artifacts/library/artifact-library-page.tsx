import type {
  ArtifactLibraryFilter,
  ArtifactLibraryItem,
  ThreadArtifactKind,
} from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  FileText,
  Globe,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Shapes,
  Users,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import { Button } from "../../../shared/ui/button.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { Input } from "../../../shared/ui/input.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { SegmentedControl } from "../../../shared/ui/segmented-control.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { ARTIFACT_KIND_VIEWS } from "../kinds.js";
import {
  artifactLibraryOptions,
  createStandaloneArtifactMutation,
  matchesFilter,
  matchesQuery,
} from "./artifact-library-queries.js";
import "./artifact-library.css";

const FILTERS: ReadonlyArray<readonly [ArtifactLibraryFilter, string]> = [
  ["all", "All"],
  ["mine", "Mine"],
  ["shared", "Shared"],
  ["threads", "Threads"],
];

const FILTER_LABELS: Record<ArtifactLibraryFilter, string> = {
  all: "All artifacts",
  mine: "My standalone artifacts",
  shared: "Shared with me",
  threads: "From threads and Spaces",
};

const updatedText = (updatedAt: number) => (now: number) =>
  formatRelativeTime({ epochMilliseconds: updatedAt }, now);

/** Where an artifact lives and who can see it, in a few words. */
function SourceLabel({
  item,
  userId,
}: {
  readonly item: ArtifactLibraryItem;
  readonly userId: string;
}) {
  if (item.source.kind !== "standalone")
    return (
      <small className="artifact-library-source" title={item.source.title}>
        <MessageSquare aria-hidden="true" />
        <span>{item.source.title}</span>
      </small>
    );
  const SharingIcon = item.sharing === "private" ? Lock : Globe;
  return (
    <small className="artifact-library-source">
      <SharingIcon aria-hidden="true" />
      <span>
        {item.owner.userId === userId
          ? item.sharing === "private"
            ? "Private"
            : item.sharing === "edit"
              ? "Workspace can edit"
              : "Workspace can view"
          : (item.owner.name ?? "A former member")}
      </span>
    </small>
  );
}

function LibraryRow({
  item,
  userId,
}: {
  readonly item: ArtifactLibraryItem;
  readonly userId: string;
}) {
  const Icon = item.kind === "board" ? Shapes : FileText;
  return (
    <Link
      className="artifact-library-row"
      to="/artifacts/$artifactId"
      params={{ artifactId: item.id }}
      data-kind={item.kind}
    >
      <span className="artifact-library-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="artifact-library-row-content">
        <strong>{item.title}</strong>
        <span className="artifact-library-meta">
          <SourceLabel item={item} userId={userId} />
          {item.access === "view" ? (
            <small className="artifact-library-badge">View only</small>
          ) : null}
          <small>
            <TimeText text={updatedText(item.updatedAt)} />
          </small>
        </span>
      </span>
      <ChevronRight className="artifact-library-chevron" aria-hidden="true" />
    </Link>
  );
}

/**
 * `/artifacts`: every artifact the person may open, newest save first, with
 * title search, source filters, and New for a standalone document or board.
 */
export function ArtifactLibraryPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const library = useQuery(artifactLibraryOptions());
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<ArtifactLibraryFilter>("all");
  const create = useMutation(
    createStandaloneArtifactMutation(queryClient, (item) =>
      navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: item.id },
      }),
    ),
  );
  const items = library.data ?? [];
  const inFilter = items.filter((item) =>
    matchesFilter(item, filter, identity.id),
  );
  const visible = inFilter.filter((item) => matchesQuery(item, query));
  const startBlank = (kind: ThreadArtifactKind) =>
    create.mutate({
      title: kind === "board" ? "Untitled board" : "Untitled",
      kind,
    });

  return (
    <PageShell
      title={
        <div className="artifact-library-title">
          <strong>Artifacts</strong>
        </div>
      }
      actions={
        <MenuRoot>
          <MenuTrigger
            render={
              <Button
                size="sm"
                aria-label="New artifact"
                disabled={create.isPending}
              >
                <Plus aria-hidden="true" />
                New
              </Button>
            }
          />
          <MenuPopup align="end" aria-label="New artifact">
            {ARTIFACT_KIND_VIEWS.map((view) => (
              <MenuItem key={view.kind} onClick={() => startBlank(view.kind)}>
                <view.icon aria-hidden="true" />
                <span>{view.newLabel}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </MenuRoot>
      }
      contentClassName="artifact-library-content"
    >
      <aside className="artifact-library-pane" aria-label="Find artifacts">
        <div className="artifact-library-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title"
            aria-label="Search artifacts by title"
          />
        </div>
        <SegmentedControl
          className="artifact-library-filter"
          label="Show"
          value={filter}
          onValueChange={setFilter}
          options={FILTERS}
        />
        <p className="artifact-library-hint">
          <Users aria-hidden="true" />
          New artifacts are private until you share them with your workspace.
        </p>
      </aside>

      <section
        className="artifact-library-list"
        aria-label={FILTER_LABELS[filter]}
        aria-busy={library.isPending}
      >
        {create.isError ? (
          <p className="artifact-library-error" role="alert">
            {create.error instanceof Error
              ? create.error.message
              : "The artifact could not be created."}
          </p>
        ) : null}
        {library.isPending ? <DxLoading label="Loading artifacts…" /> : null}
        {library.isError && library.data === undefined ? (
          <EmptyState
            tone="error"
            title="Artifacts unavailable"
            description={
              library.error instanceof Error
                ? library.error.message
                : "Artifacts could not be loaded."
            }
            action={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void library.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : null}
        {library.data !== undefined && visible.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title={
              inFilter.length === 0
                ? filter === "shared"
                  ? "Nothing shared with you yet"
                  : "No artifacts yet"
                : "No artifacts match"
            }
            description={
              inFilter.length === 0
                ? "Start a document or a board with New, or ask an agent to write one."
                : "Try another title."
            }
          />
        ) : null}
        {visible.map((item) => (
          <LibraryRow key={item.id} item={item} userId={identity.id} />
        ))}
      </section>
    </PageShell>
  );
}
