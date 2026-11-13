import type { ArtifactLibraryItem, ArtifactSharing } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  FileText,
  Globe,
  Link2,
  Lock,
  MessageSquare,
  Shapes,
} from "lucide-react";
import type * as React from "react";
import { toast } from "sonner";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import {
  MenuGroup,
  MenuItem,
  MenuItemText,
  MenuLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { artifactOptions } from "../artifact-document-queries.js";
import { OpenArtifact } from "../artifacts-view.js";
import { ArtifactHostProvider } from "../editor/artifact-host.js";
import {
  artifactLibraryItemOptions,
  forgetLibraryArtifact,
  shareArtifactMutation,
} from "./artifact-library-queries.js";
import "./artifact-library.css";

/** The shareable link to an artifact, on this deployment's origin. */
const absoluteArtifactUrl = (artifactId: string) =>
  new URL(`/artifacts/${artifactId}`, window.location.href).toString();

const copyLink = async (artifactId: string) => {
  try {
    await navigator.clipboard.writeText(absoluteArtifactUrl(artifactId));
    toast.success("Link copied. People who can open it will see it.");
  } catch {
    toast.error("Could not copy the link.");
  }
};

const SHARING: ReadonlyArray<{
  readonly value: ArtifactSharing;
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "private", label: "Private", detail: "Only you can open it." },
  {
    value: "view",
    label: "Workspace can view",
    detail: "Everyone in your workspace can read it.",
  },
  {
    value: "edit",
    label: "Workspace can edit",
    detail: "Everyone in your workspace can edit and comment.",
  },
];

/** Who besides its owner opens a standalone artifact; the owner changes it. */
function ShareControl({ item }: { readonly item: ArtifactLibraryItem }) {
  const queryClient = useQueryClient();
  const share = useMutation(shareArtifactMutation(queryClient, item.id));
  const current = SHARING.find((option) => option.value === item.sharing);
  const Icon = item.sharing === "private" ? Lock : Globe;
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            variant={item.sharing === "private" ? "outline" : "secondary"}
            size="xs"
            className="library-artifact-share"
            aria-label={`Share: ${current?.label ?? "Private"}`}
            disabled={share.isPending}
          >
            <Icon aria-hidden="true" />
            <span className="library-artifact-share-label">
              {item.sharing === "private" ? "Share" : "Shared"}
            </span>
          </Button>
        }
      />
      <MenuPopup
        align="end"
        className="library-share-menu"
        aria-label="Share artifact"
      >
        <MenuGroup>
          <MenuLabel>Who can open it</MenuLabel>
          <MenuRadioGroup
            value={item.sharing}
            onValueChange={(value: ArtifactSharing) => share.mutate(value)}
          >
            {SHARING.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                <MenuItemText
                  title={option.label}
                  description={option.detail}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void copyLink(item.id)}>
          <Link2 aria-hidden="true" />
          <span>Copy link</span>
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

/** The header's start: back to the library, the title, and its menu. */
function LibraryArtifactHeader({
  item,
  extra,
}: {
  readonly item: ArtifactLibraryItem;
  readonly extra?: React.ReactNode;
}) {
  const Icon = item.kind === "board" ? Shapes : FileText;
  // The open artifact's own query follows renames as they save.
  const title =
    useQuery(artifactOptions(item.threadId, item.id)).data?.artifact.title ??
    item.title;
  return (
    <>
      <Link
        to="/artifacts"
        className={`${buttonVariants({ variant: "subtle", size: "icon-xs" })} artifact-icon-button`}
        aria-label="Back to Artifacts"
        title="Back to Artifacts"
      >
        <ArrowLeft aria-hidden="true" />
      </Link>
      <MenuRoot>
        <MenuTrigger
          className="artifact-switcher"
          aria-label="Artifact actions"
        >
          <Icon aria-hidden="true" />
          <span>{title}</span>
          <ChevronDown aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="start" className="artifact-switcher-menu">
          <MenuItem onClick={() => void copyLink(item.id)}>
            <Link2 aria-hidden="true" />
            <span>Copy link</span>
          </MenuItem>
          {item.source.kind === "standalone" ? null : (
            <MenuItem
              render={
                <Link
                  to="/threads/$threadId"
                  params={{ threadId: item.threadId }}
                />
              }
            >
              <MessageSquare aria-hidden="true" />
              <span>
                Open in {item.source.kind === "space" ? "Space" : "Thread"}
              </span>
            </MenuItem>
          )}
          {extra === undefined ? null : <MenuSeparator />}
          {extra}
        </MenuPopup>
      </MenuRoot>
      {item.source.kind === "standalone" ? null : (
        <small className="library-artifact-source" title={item.source.title}>
          in {item.source.title}
        </small>
      )}
      {item.access === "view" ? (
        <small className="artifact-library-badge">View only</small>
      ) : null}
      {item.access === "owner" && item.source.kind === "standalone" ? (
        <ShareControl item={item} />
      ) : (
        <Button
          variant="subtle"
          size="icon-xs"
          className="artifact-icon-button"
          aria-label="Copy link"
          title="Copy link"
          onClick={() => void copyLink(item.id)}
        >
          <Link2 aria-hidden="true" />
        </Button>
      )}
    </>
  );
}

/**
 * `/artifacts/<id>`: any artifact the person may open, in the full editor,
 * wherever it lives. Someone who may not open it learns only that it is
 * not there. `presence` joins the artifact's Thread for live edits. No
 * Thread composer is here, and a standalone artifact's home has no agent,
 * so the editor offers neither Send to Thread nor, for one, the agent.
 */
export function LibraryArtifactPage({
  artifactId,
  presence,
}: {
  readonly artifactId: string;
  readonly presence: (threadId: ThreadId) => React.ReactNode;
}) {
  const found = useQuery(artifactLibraryItemOptions(artifactId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (found.data === undefined)
    return (
      <section className="library-artifact-page">
        {found.isError ? (
          <EmptyState
            className="library-artifact-missing"
            icon={<Lock />}
            title="This artifact isn't here, or you can't open it"
            description="Ask its owner to share it with your workspace."
            action={
              <Link
                to="/artifacts"
                className={buttonVariants({ size: "xs", variant: "outline" })}
              >
                Go to Artifacts
              </Link>
            }
          />
        ) : (
          <EmptyState title="Opening…" busy role="status" />
        )}
      </section>
    );
  const item = found.data;
  const standalone = item.source.kind === "standalone";
  return (
    <section className="library-artifact-page" data-kind={item.kind}>
      {presence(item.threadId)}
      <ArtifactHostProvider
        value={{
          agent: !standalone,
          composer: false,
          inThread: !standalone,
          onDeleted: () => {
            forgetLibraryArtifact(queryClient, item.id);
            void navigate({ to: "/artifacts" });
          },
        }}
      >
        <OpenArtifact
          key={`${item.id}:${item.access}`}
          threadId={item.threadId}
          artifactId={item.id}
          active
          readOnly={item.access === "view"}
          switcher={(extra) => (
            <LibraryArtifactHeader item={item} extra={extra} />
          )}
          dictation={undefined}
        />
      </ArtifactHostProvider>
    </section>
  );
}
