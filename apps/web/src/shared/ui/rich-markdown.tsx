import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import { Check, Copy, WrapText } from "lucide-react";
import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { MarkdownFileLinkContext } from "./markdown-file-link-context.js";

const accessibleName = (value: string | undefined, fallback: string) =>
  value?.trim() || fallback;

const safeUrl = (url: string) => defaultUrlTransform(url);

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

export function RichMarkdown({ children }: { readonly children: string }) {
  const openFile = React.useContext(MarkdownFileLinkContext);
  return (
    <div className="markdown transcript-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
        ]}
        skipHtml
        urlTransform={(url) =>
          url.startsWith("file:///") ? url : safeUrl(url)
        }
        components={{
          a: ({ children: content, href }) =>
            href?.startsWith("file:///") ? (
              openFile ? (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    openFile(href);
                  }}
                >
                  {content}
                </a>
              ) : (
                <span title="File links are available in the thread workspace">
                  {content}
                </span>
              )
            ) : (
              <a
                href={href}
                target={href?.startsWith("#") ? undefined : "_blank"}
                rel="noopener noreferrer"
              >
                {content}
              </a>
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
