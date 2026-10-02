import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import { Check, Copy, WrapText } from "lucide-react";
import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { FileContextMenu } from "./file-context-menu.js";
import { settledMarkdownBlocks } from "./markdown-blocks.js";
import {
  MarkdownFileLinkContext,
  type MarkdownFileLinkResolver,
} from "./markdown-file-link-context.js";

const accessibleName = (value: string | undefined, fallback: string) =>
  value?.trim() || fallback;

const safeUrl = (url: string) => defaultUrlTransform(url);
// `README.md:12` looks like a URL scheme to react-markdown; keep file:line
// references whose "scheme" contains a dot and whose suffix is a line number.
const fileLineReference = /^[\w-]+\.[\w.-]+:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;

const nodeText = (node: React.ReactNode): string =>
  React.Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : React.isValidElement<{ children?: React.ReactNode }>(child)
          ? nodeText(child.props.children)
          : "",
    )
    .join("");

function CopyButton({
  text,
  label,
  subject = "Code",
}: {
  readonly text: string | (() => string);
  readonly label: string;
  readonly subject?: string;
}) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const button = React.useRef<HTMLButtonElement | null>(null);
  const attach = React.useCallback((element: HTMLButtonElement | null) => {
    button.current = element;
    return () => {
      button.current = null;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    clearTimeout(timer.current);
    setStatus("idle");
    let result: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(
        typeof text === "function" ? text() : text,
      );
      result = "copied";
    } catch {
      result = "failed";
    }
    if (!button.current) return;
    clearTimeout(timer.current);
    setStatus(result);
    timer.current = setTimeout(() => setStatus("idle"), 2000);
  };
  if (typeof navigator === "undefined" || navigator.clipboard === undefined)
    return null;
  return (
    <button
      ref={attach}
      type="button"
      className="transcript-copy"
      aria-label={
        status === "copied"
          ? `${subject} copied`
          : status === "failed"
            ? `Copy ${subject.toLowerCase()} failed`
            : label
      }
      onClick={copy}
    >
      {status === "copied" ? (
        <Check aria-hidden="true" />
      ) : (
        <Copy aria-hidden="true" />
      )}
      <span className="visually-hidden" role="status">
        {status === "copied"
          ? `${subject} copied to clipboard.`
          : status === "failed"
            ? `${subject} could not be copied.`
            : ""}
      </span>
    </button>
  );
}

function CodeBlock({ content }: { readonly content: React.ReactNode }) {
  const [wrap, setWrap] = React.useState(false);
  const text = nodeText(content).replace(/\n$/, "");
  const child = React.Children.toArray(content).find(React.isValidElement);
  const diagram =
    React.isValidElement<{ className?: string }>(child) &&
    child.props.className?.split(" ").includes("language-diagram");
  return (
    <div
      className={`transcript-code-block${diagram ? " markdown-diagram" : ""}`}
      data-wrap={wrap || undefined}
    >
      <CopyButton text={text} label={diagram ? "Copy diagram" : "Copy code"} />
      {!diagram && (
        <button
          type="button"
          className="markdown-wrap"
          aria-label="Toggle line wrap"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText aria-hidden="true" />
        </button>
      )}
      <pre>
        {diagram ? (
          <code className="language-diagram">
            {Array.from(
              text.matchAll(
                /[\u2500-\u257f→←↑↓]+|[▼▶◀▲]+|[^\u2500-\u257f→←↑↓▼▶◀▲]+/gu,
              ),
            ).map((match) => {
              const part = match[0];
              return (
                <React.Fragment key={match.index}>
                  {/^[▼▶◀▲]+$/u.test(part) ? (
                    <span className="diagram-accent">{part}</span>
                  ) : /^[\u2500-\u257f→←↑↓]+$/u.test(part) ? (
                    <span className="diagram-structure">{part}</span>
                  ) : (
                    part
                  )}
                </React.Fragment>
              );
            })}
          </code>
        ) : (
          content
        )}
      </pre>
    </div>
  );
}

function MarkdownTable({ content }: { readonly content: React.ReactNode }) {
  const ref = React.useRef<HTMLTableElement>(null);
  const tableText = () => {
    const rows = Array.from(ref.current?.rows ?? []).map((row) =>
      Array.from(row.cells).map((cell) =>
        (cell.textContent ?? "")
          .replaceAll("|", "\\|")
          .replaceAll("\n", "<br>"),
      ),
    );
    if (!rows.length) return "";
    return [rows[0], rows[0].map(() => "---"), ...rows.slice(1)]
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n");
  };
  return (
    <section className="transcript-table" aria-label="Table">
      <section
        className="markdown-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontal table scrolling must be keyboard-accessible.
        tabIndex={0}
        aria-label="Scrollable table"
      >
        <table ref={ref}>{content}</table>
      </section>
      <CopyButton
        text={tableText}
        label="Copy Markdown table"
        subject="Table"
      />
    </section>
  );
}

// Hrefs with a non-file scheme, a host, or only a fragment are web links.
const externalHref = (href: string) => {
  if (href.startsWith("#") || href.startsWith("//")) return true;
  if (fileLineReference.test(href)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== "file";
};

function MarkdownLink({
  href,
  resolveFile,
  children,
}: {
  readonly href: string | undefined;
  readonly resolveFile: MarkdownFileLinkResolver | undefined;
  readonly children: React.ReactNode;
}) {
  if (href === undefined || href === "" || externalHref(href))
    return (
      <a
        href={href}
        target={href?.startsWith("#") ? undefined : "_blank"}
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  const file = resolveFile?.(href);
  // A file path must never become a same-origin navigation that reloads dx.
  if (file === undefined)
    return (
      <span
        className="markdown-file-link-unavailable"
        title={
          resolveFile === undefined
            ? "File links are available in the thread workspace"
            : "This file cannot be opened"
        }
      >
        {children}
      </span>
    );
  return (
    <FileContextMenu
      trigger={
        <a
          className="markdown-file-link"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            file.open();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            file.open();
          }}
        />
      }
      onOpen={file.open}
      {...(file.downloadUrl === undefined
        ? {}
        : { downloadUrl: file.downloadUrl })}
    >
      {children}
    </FileContextMenu>
  );
}

// Stable across renders so react-markdown does not rebuild its processor
// configuration on every parse.
const remarkPlugins = [remarkGfm, remarkBreaks];
const rehypePlugins: React.ComponentProps<
  typeof ReactMarkdown
>["rehypePlugins"] = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
];
const urlTransform = (url: string) =>
  url.startsWith("file:///") || fileLineReference.test(url)
    ? url
    : safeUrl(url);

const markdownComponents = (
  resolveFile: MarkdownFileLinkResolver | undefined,
): React.ComponentProps<typeof ReactMarkdown>["components"] => ({
  a: ({ children: content, href }) => (
    <MarkdownLink href={href} resolveFile={resolveFile}>
      {content}
    </MarkdownLink>
  ),
  img: ({ alt, src, title }) => (
    <img
      src={src}
      alt={accessibleName(alt, "Markdown image")}
      title={title}
      loading="lazy"
    />
  ),
  input: ({ node: _node, ...props }) => (
    <input
      {...props}
      aria-label={props.checked ? "Completed task" : "Incomplete task"}
    />
  ),
  pre: ({ children: content }) => <CodeBlock content={content} />,
  table: ({ children: content }) => <MarkdownTable content={content} />,
});

/** One parsed Markdown document; memoized on its source text. */
const MarkdownDocument = React.memo(function MarkdownDocument({
  children,
}: {
  readonly children: string;
}) {
  const resolveFile = React.useContext(MarkdownFileLinkContext);
  const components = React.useMemo(
    () => markdownComponents(resolveFile),
    [resolveFile],
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml
      urlTransform={urlTransform}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
});

/**
 * Parsing and highlighting is the dominant transcript cost. Memoize on the
 * source text so a re-rendering parent never re-parses unchanged Markdown.
 * While text is still streaming, parse only its unsettled tail: settled
 * blocks keep their parsed output. Settled text renders as one document.
 */
export const RichMarkdown = React.memo(function RichMarkdown({
  children,
  streaming = false,
}: {
  readonly children: string;
  readonly streaming?: boolean;
}) {
  const blocks = streaming ? settledMarkdownBlocks(children) : [children];
  // Key each block by its source offset: settled blocks never move.
  let offset = 0;
  const keyed = blocks.map((block) => {
    const start = offset;
    offset += block.length + 1;
    return { start, block };
  });
  return (
    <div className="markdown transcript-markdown">
      {keyed.map(({ start, block }) => (
        <MarkdownDocument key={start}>{block}</MarkdownDocument>
      ))}
    </div>
  );
});
