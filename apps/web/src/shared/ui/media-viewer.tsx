import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";

/** One image or video the viewer shows, by a same-origin URL. */
export interface ViewerMedia {
  /** Stable identity within the set. */
  readonly key: string;
  readonly url: string;
  readonly name: string;
  readonly kind: "image" | "video";
  /** Same-origin URL that downloads the file, when it can be downloaded. */
  readonly downloadUrl?: string;
}

/**
 * A full-window viewer for a set of images and videos: one at a time,
 * stepped with the arrows or the keyboard, never automatically. A video
 * plays with its own controls, including the browser's full screen.
 */
export function MediaViewer({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  readonly items: ReadonlyArray<ViewerMedia>;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}) {
  const [zoomed, setZoomed] = React.useState(false);
  const item = items[index];
  if (item === undefined) return null;
  const step = (offset: number) => {
    setZoomed(false);
    onIndexChange((index + offset + items.length) % items.length);
  };
  const several = items.length > 1;
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="image-viewer-backdrop" />
        <Dialog.Popup
          className="image-viewer"
          aria-label={item.name}
          onKeyDown={(event) => {
            if (!several) return;
            if (event.key === "ArrowRight") step(1);
            else if (event.key === "ArrowLeft") step(-1);
          }}
        >
          <div className="image-viewer-bar">
            <span className="image-viewer-count">
              {several ? `${index + 1} / ${items.length}` : ""}
            </span>
            <div className="image-viewer-actions">
              {item.kind === "image" ? (
                <button
                  type="button"
                  aria-label={zoomed ? "Fit to window" : "Actual size"}
                  title={zoomed ? "Fit to window" : "Actual size"}
                  onClick={() => setZoomed((value) => !value)}
                >
                  {zoomed ? <ZoomOut /> : <ZoomIn />}
                </button>
              ) : null}
              <a
                href={item.url}
                target="_blank"
                rel="noopener"
                aria-label={`Open ${item.name} in a new tab`}
                title="Open in a new tab"
              >
                <ExternalLink />
              </a>
              {item.downloadUrl === undefined ? null : (
                <a
                  href={item.downloadUrl}
                  download={item.name}
                  aria-label={`Download ${item.name}`}
                  title="Download"
                >
                  <Download />
                </a>
              )}
              <Dialog.Close aria-label="Close viewer" title="Close">
                <X />
              </Dialog.Close>
            </div>
          </div>
          <div
            className="image-viewer-stage"
            data-zoomed={zoomed ? "" : undefined}
          >
            {item.kind === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: agent-made and user-supplied media has no caption track; the name labels it.
              <video
                src={item.url}
                aria-label={item.name}
                key={item.key}
                controls
                playsInline
              />
            ) : (
              <img src={item.url} alt={item.name} key={item.key} />
            )}
          </div>
          {several ? (
            <>
              <button
                type="button"
                className="image-viewer-step"
                data-direction="previous"
                aria-label="Previous"
                onClick={() => step(-1)}
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="image-viewer-step"
                data-direction="next"
                aria-label="Next"
                onClick={() => step(1)}
              >
                <ChevronRight />
              </button>
            </>
          ) : null}
          <span className="image-viewer-name">{item.name}</span>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
