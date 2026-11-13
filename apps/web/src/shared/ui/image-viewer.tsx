import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileIcon,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";
import { Button } from "./button.js";
import { buttonVariants } from "./button-variants.js";
import "./image-viewer.css";

/** One image, video, or other file the viewer shows, by a same-origin URL. */
export interface ViewerMedia {
  /** Stable identity within the set. */
  readonly key: string;
  readonly url: string;
  readonly name: string;
  /** `file` shows an icon in place of a preview. */
  readonly kind: "image" | "video" | "file";
  /** Same-origin URL that downloads the file, when it can be downloaded. */
  readonly downloadUrl?: string;
  /** A short line after the name, such as its type and size. */
  readonly detail?: string;
}

/**
 * dx's full-window viewer for one image or a gallery: one item at a time,
 * stepped with the arrows or the keyboard, never automatically. A video
 * plays with its own controls. Images zoom between fit and actual size.
 * `actions` adds buttons for the shown item, such as Remove, beside Open,
 * Download, and Close. Mount it while open; closing calls `onClose`.
 */
export function ImageViewer({
  items,
  index = 0,
  onIndexChange,
  onClose,
  actions,
  closeLabel = "Close viewer",
  showOpenInTab = true,
}: {
  readonly items: ReadonlyArray<ViewerMedia>;
  readonly index?: number;
  readonly onIndexChange?: (index: number) => void;
  readonly onClose: () => void;
  readonly actions?: (item: ViewerMedia) => React.ReactNode;
  readonly closeLabel?: string;
  /** Open in a new tab; off for a file only this page can read, such as a blob. */
  readonly showOpenInTab?: boolean;
}) {
  const [zoomed, setZoomed] = React.useState(false);
  const item = items[index];
  if (item === undefined) return null;
  const several = items.length > 1 && onIndexChange !== undefined;
  const step = (offset: number) => {
    setZoomed(false);
    onIndexChange?.((index + offset + items.length) % items.length);
  };
  const action = buttonVariants({ variant: "subtle", size: "icon-sm" });
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dx-image-viewer-backdrop" />
        <Dialog.Popup
          className="dx-image-viewer"
          aria-label={item.name}
          onKeyDown={(event) => {
            if (!several) return;
            if (event.key === "ArrowRight") step(1);
            else if (event.key === "ArrowLeft") step(-1);
          }}
        >
          <div className="dx-image-viewer-bar">
            <span className="dx-image-viewer-count">
              {several ? `${index + 1} / ${items.length}` : ""}
            </span>
            <div className="dx-image-viewer-actions">
              {item.kind === "image" ? (
                <Button
                  variant="subtle"
                  size="icon-sm"
                  aria-label={zoomed ? "Fit to window" : "Actual size"}
                  title={zoomed ? "Fit to window" : "Actual size"}
                  onClick={() => setZoomed((value) => !value)}
                >
                  {zoomed ? <ZoomOut /> : <ZoomIn />}
                </Button>
              ) : null}
              {showOpenInTab ? (
                <a
                  className={action}
                  href={item.url}
                  target="_blank"
                  rel="noopener"
                  aria-label={`Open ${item.name} in a new tab`}
                  title="Open in a new tab"
                >
                  <ExternalLink />
                </a>
              ) : null}
              {item.downloadUrl === undefined ? null : (
                <a
                  className={action}
                  href={item.downloadUrl}
                  download={item.name}
                  aria-label={`Download ${item.name}`}
                  title="Download"
                >
                  <Download />
                </a>
              )}
              {actions?.(item)}
              <Dialog.Close
                className={action}
                aria-label={closeLabel}
                title="Close"
              >
                <X />
              </Dialog.Close>
            </div>
          </div>
          <div
            className="dx-image-viewer-stage"
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
                preload="metadata"
              />
            ) : item.kind === "image" ? (
              <img src={item.url} alt={item.name} key={item.key} />
            ) : (
              <FileIcon className="dx-image-viewer-file" aria-hidden="true" />
            )}
          </div>
          {several ? (
            <>
              <Button
                variant="subtle"
                size="icon"
                className="dx-image-viewer-step"
                data-direction="previous"
                aria-label="Previous"
                onClick={() => step(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="subtle"
                size="icon"
                className="dx-image-viewer-step"
                data-direction="next"
                aria-label="Next"
                onClick={() => step(1)}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}
          <p className="dx-image-viewer-caption">
            <span className="dx-image-viewer-name">{item.name}</span>
            {item.detail === undefined ? null : (
              <span className="dx-image-viewer-detail">{item.detail}</span>
            )}
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
