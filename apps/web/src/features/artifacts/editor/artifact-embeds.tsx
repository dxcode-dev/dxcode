import { parseBoard } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Shapes } from "lucide-react";
import { createPortal } from "react-dom";
import { artifactOptions } from "../artifact-document-queries.js";
import { type ArtifactScope, scopeOf } from "../artifact-scope.js";
import { BoardPreview } from "../board/board-preview.js";
import { artifactLibraryItemOptions } from "../library/artifact-library-queries.js";
import {
  type ArtifactEmbedFrame,
  type ArtifactLink,
  documentExcerpt,
} from "./artifact-embed-links.js";

/** The preview once the artifact's Thread is known. */
function EmbedPreview({
  threadId,
  artifactId,
}: {
  readonly threadId: ArtifactScope;
  readonly artifactId: string;
}) {
  const query = useQuery(artifactOptions(threadId, artifactId));
  const navigate = useNavigate();
  const document = query.data;
  if (document === undefined)
    return query.isError ? (
      <p className="artifact-embed-missing">
        This artifact is gone, or you can't open it.
      </p>
    ) : null;
  const open = () =>
    void navigate({ to: "/artifacts/$artifactId", params: { artifactId } });
  const title = document.artifact.title;
  if (document.artifact.kind === "board") {
    const board = parseBoard(document.markdown);
    return (
      <button
        type="button"
        className="artifact-embed-board"
        aria-label={`Open board ${title}`}
        onClick={open}
      >
        {board.ok ? (
          <BoardPreview
            className="artifact-embed-preview"
            board={board.board}
            label={`Preview of ${title}`}
          />
        ) : null}
        <span className="artifact-embed-bar">
          <Shapes aria-hidden="true" />
          <span className="artifact-embed-title">{title}</span>
          <span className="artifact-embed-open">Open board</span>
        </span>
      </button>
    );
  }
  const lines = documentExcerpt(document.markdown);
  return (
    <button
      type="button"
      className="artifact-embed-board artifact-embed-document"
      aria-label={`Open document ${title}`}
      onClick={open}
    >
      <span className="artifact-embed-excerpt" aria-hidden={lines.length === 0}>
        {lines.length === 0 ? (
          <span className="artifact-embed-empty">Empty document</span>
        ) : (
          lines.map((line) => <span key={line.key}>{line.text}</span>)
        )}
      </span>
      <span className="artifact-embed-bar">
        <FileText aria-hidden="true" />
        <span className="artifact-embed-title">{title}</span>
        <span className="artifact-embed-open">Open document</span>
      </span>
    </button>
  );
}

/** An `/artifacts/<id>` link: where the artifact lives, then its preview. */
function LibraryEmbed({ artifactId }: { readonly artifactId: string }) {
  const found = useQuery(artifactLibraryItemOptions(artifactId));
  if (found.data === undefined)
    return found.isError ? (
      <p className="artifact-embed-missing">
        This artifact is gone, or you can't open it.
      </p>
    ) : null;
  return (
    <EmbedPreview threadId={scopeOf(found.data)} artifactId={artifactId} />
  );
}

/** One embedded artifact: a board's drawing or a document's opening lines. */
function ArtifactEmbed({ link }: { readonly link: ArtifactLink }) {
  return link.threadId === undefined ? (
    <LibraryEmbed artifactId={link.artifactId} />
  ) : (
    <EmbedPreview threadId={link.threadId} artifactId={link.artifactId} />
  );
}

/** Every embed on screen, each drawn into its widget. */
export function ArtifactEmbeds({
  embeds,
}: {
  readonly embeds: ReadonlyArray<ArtifactEmbedFrame>;
}) {
  return (
    <>
      {embeds.map((frame) =>
        createPortal(
          <ArtifactEmbed link={frame.link} />,
          frame.container,
          String(frame.id),
        ),
      )}
    </>
  );
}
