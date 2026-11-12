import { parseBoard } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Shapes } from "lucide-react";
import { createPortal } from "react-dom";
import { artifactOptions } from "../artifact-document-queries.js";
import { BoardPreview } from "../board/board-preview.js";
import type {
  ArtifactEmbedFrame,
  ArtifactLink,
} from "./artifact-embed-links.js";

/** One embedded artifact: a board's preview, or nothing for other types. */
function ArtifactEmbed({ link }: { readonly link: ArtifactLink }) {
  const query = useQuery(artifactOptions(link.threadId, link.artifactId));
  const navigate = useNavigate();
  const document = query.data;
  if (document === undefined || document.artifact.kind !== "board")
    return query.isError ? (
      <p className="artifact-embed-missing">
        This board is gone, or you can't open it.
      </p>
    ) : null;
  const board = parseBoard(document.markdown);
  const open = () =>
    void navigate({
      to: "/threads/$threadId",
      params: { threadId: link.threadId },
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        artifact: link.artifactId,
      }),
    });
  return (
    <button
      type="button"
      className="artifact-embed-board"
      aria-label={`Open board ${document.artifact.title}`}
      onClick={open}
    >
      {board.ok ? (
        <BoardPreview
          className="artifact-embed-preview"
          board={board.board}
          label={`Preview of ${document.artifact.title}`}
        />
      ) : null}
      <span className="artifact-embed-bar">
        <Shapes aria-hidden="true" />
        <span className="artifact-embed-title">{document.artifact.title}</span>
        <span className="artifact-embed-open">Open board</span>
      </span>
    </button>
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
