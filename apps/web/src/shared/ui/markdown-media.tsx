import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import * as React from "react";
import type { MarkdownMediaSource } from "./markdown-file-link-context.js";
import type { GalleryItem } from "./markdown-galleries.js";
import { useMarkdownMediaSource } from "./markdown-media-source.js";
import { MediaViewer, type ViewerMedia } from "./media-viewer.js";

const viewerMedia = (
  source: MarkdownMediaSource,
  name: string,
  key: string,
): ViewerMedia | undefined =>
  source.kind === "audio"
    ? undefined
    : {
        key,
        url: source.url,
        name,
        kind: source.kind,
        ...(source.downloadUrl === undefined
          ? {}
          : { downloadUrl: source.downloadUrl }),
      };

/**
 * Consecutive images and videos in a message, shown one at a time with
 * arrows, a position, and a full-window viewer. The items must all resolve
 * to images or videos (for example files in Thread storage); otherwise the
 * Markdown renders as written.
 */
export function MarkdownMediaGallery({
  items,
  children,
}: {
  readonly items: ReadonlyArray<GalleryItem>;
  readonly children?: React.ReactNode;
}) {
  const resolve = useMarkdownMediaSource();
  const [index, setIndex] = React.useState(0);
  const [viewing, setViewing] = React.useState<number>();
  const media = items.flatMap((item, position): ViewerMedia[] => {
    const source = item.src === "" ? undefined : resolve(item.src);
    const name =
      item.alt.trim() ||
      `${source?.kind === "video" ? "Video" : "Image"} ${position + 1}`;
    const shown =
      source === undefined
        ? undefined
        : viewerMedia(source, name, `${position}`);
    return shown === undefined ? [] : [shown];
  });
  if (media.length < 2 || media.length !== items.length) return children;
  const shown = Math.min(index, media.length - 1);
  const current = media[shown] as ViewerMedia;
  const step = (offset: number) =>
    setIndex((shown + offset + media.length) % media.length);
  return (
    <figure
      className="markdown-gallery"
      aria-roledescription="carousel"
      aria-label={`Gallery, ${media.length} items`}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
      }}
    >
      <div className="markdown-gallery-stage">
        {current.kind === "image" ? (
          <button
            type="button"
            className="markdown-gallery-open"
            aria-label={`View ${current.name} full screen`}
            onClick={() => setViewing(shown)}
          >
            <img
              src={current.url}
              alt={current.name}
              title={items[shown]?.title || undefined}
              key={current.key}
            />
          </button>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: agent-made media has no caption track; the alt text names it.
          <video
            className="markdown-gallery-video"
            src={current.url}
            aria-label={current.name}
            key={current.key}
            controls
            playsInline
            preload="metadata"
          />
        )}
        <button
          type="button"
          className="markdown-gallery-step"
          data-direction="previous"
          aria-label="Previous"
          title="Previous"
          onClick={() => step(-1)}
        >
          <ChevronLeft />
        </button>
        <button
          type="button"
          className="markdown-gallery-step"
          data-direction="next"
          aria-label="Next"
          title="Next"
          onClick={() => step(1)}
        >
          <ChevronRight />
        </button>
        <button
          type="button"
          className="markdown-gallery-expand"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={() => setViewing(shown)}
        >
          <Maximize2 />
        </button>
      </div>
      <figcaption className="markdown-gallery-caption">
        <span className="markdown-gallery-name">{current.name}</span>
        <span className="markdown-gallery-count">
          {shown + 1} / {media.length}
        </span>
      </figcaption>
      {viewing === undefined ? null : (
        <MediaViewer
          items={media}
          index={viewing}
          onIndexChange={(next) => {
            setViewing(next);
            setIndex(next);
          }}
          onClose={() => setViewing(undefined)}
        />
      )}
    </figure>
  );
}

/** One image in a message: inline, and full window when clicked. */
export function MarkdownImageOpener({
  source,
  name,
  title,
}: {
  readonly source: MarkdownMediaSource;
  readonly name: string;
  readonly title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const media = viewerMedia(source, name, "0");
  return (
    <>
      <button
        type="button"
        className="markdown-image-open"
        aria-label={`View ${name} full screen`}
        onClick={() => setOpen(true)}
      >
        <img src={source.url} alt={name} title={title} loading="lazy" />
      </button>
      {open && media !== undefined ? (
        <MediaViewer
          items={[media]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
