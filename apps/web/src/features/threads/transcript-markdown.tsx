import { File } from "lucide-react";
import { defaultUrlTransform } from "react-markdown";

export { RichMarkdown as TranscriptMarkdown } from "../../shared/ui/rich-markdown.js";

const accessibleName = (value: string | undefined, fallback: string) =>
  value?.trim() || fallback;

const safeUrl = defaultUrlTransform;

export interface TranscriptAttachmentProps {
  readonly filename?: string;
  readonly mediaType: string;
  readonly url?: string;
}

export function TranscriptAttachment({
  filename,
  mediaType,
  url,
}: TranscriptAttachmentProps) {
  const name = accessibleName(filename, "Attachment");
  const transformedUrl = url === undefined ? undefined : safeUrl(url);
  const href = transformedUrl || undefined;
  const image = mediaType.toLowerCase().startsWith("image/");
  if (image && href !== undefined) {
    return (
      <figure className="transcript-attachment transcript-attachment-image">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${name}`}
        >
          <img src={href} alt={name} loading="lazy" />
        </a>
        {filename ? <figcaption>{filename}</figcaption> : null}
      </figure>
    );
  }
  const sameOriginDownload =
    href !== undefined &&
    (() => {
      const target = new URL(href, window.location.href);
      return (
        target.origin === window.location.origin ||
        target.protocol === "blob:" ||
        target.protocol === "data:"
      );
    })();
  return (
    <div className="transcript-attachment transcript-attachment-file">
      <File aria-hidden="true" />
      {href !== undefined ? (
        <a
          href={href}
          download={sameOriginDownload ? filename : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${sameOriginDownload ? "Download" : "Open"} ${name}`}
        >
          {name}
        </a>
      ) : (
        <span>{name}</span>
      )}
    </div>
  );
}
