import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import * as React from "react";
import { Button } from "./button.js";
import type { ViewerMedia } from "./image-viewer.js";
import { LazyImageViewer as ImageViewer } from "./lazy-image-viewer.js";
import type { MarkdownMediaSource } from "./markdown-file-link-context.js";
import type { GalleryItem } from "./markdown-galleries.js";
import { useMarkdownMediaSource } from "./markdown-media-source.js";
import {
  applyPlayback,
  type MediaPlayback,
  readPlayback,
} from "./media-playback.js";

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
  // The shown video, when the shown item is one: the viewer takes over from
  // it and hands back to it.
  const video = React.useRef<HTMLVideoElement>(null);
  const [handedOff, setHandedOff] = React.useState<MediaPlayback>();
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
  const open = () => {
    const playing = video.current;
    if (playing !== null) {
      setHandedOff(readPlayback(playing));
      playing.pause();
    } else setHandedOff(undefined);
    setViewing(shown);
  };
  return (
    <figure
      className="markdown-gallery"
      aria-roledescription="carousel"
      aria-label={`Gallery, ${media.length} items`}
      onKeyDown={(event) => {
        // The viewer's keys reach here through its portal; it steps itself.
        // A focused player seeks with the arrows.
        if (
          !event.currentTarget.contains(event.target as Node) ||
          event.target instanceof HTMLMediaElement
        )
          return;
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
            onClick={open}
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
            ref={video}
            controls
            playsInline
            preload="metadata"
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="markdown-gallery-step"
          data-direction="previous"
          aria-label="Previous"
          title="Previous"
          onClick={() => step(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="markdown-gallery-step"
          data-direction="next"
          aria-label="Next"
          title="Next"
          onClick={() => step(1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="markdown-gallery-expand"
          aria-label="Open full screen"
          title="Open full screen"
          onClick={open}
        >
          <Maximize2 />
        </Button>
      </div>
      <figcaption className="markdown-gallery-caption">
        <span className="markdown-gallery-name">{current.name}</span>
        <span className="markdown-gallery-count">
          {shown + 1} / {media.length}
        </span>
      </figcaption>
      {viewing === undefined ? null : (
        <ImageViewer
          items={media}
          index={viewing}
          playback={handedOff}
          onIndexChange={(next) => {
            setViewing(next);
            setIndex(next);
          }}
          onClose={(playback) => {
            setViewing(undefined);
            if (playback !== undefined && video.current !== null)
              applyPlayback(video.current, playback);
          }}
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
        <ImageViewer
          items={[media]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
