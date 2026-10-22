import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import { splitMentions } from "@dx/api";
import type { VIEW_LANGUAGE as ViewLanguage } from "@dx/api/views/view-frame.mjs";
import { Check, Code, Copy, Image, LoaderCircle, WrapText } from "lucide-react";
import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useTheme } from "../theme/theme-provider.js";
import {
  codeLanguage,
  type HighlightedLines,
  type HighlightNode,
  highlightClosedCode,
  highlightCode,
  highlightStreamingCode,
} from "./code-highlight.js";
import { FileContextMenu } from "./file-context-menu.js";
import { codeFenceBlock, settledMarkdownBlocks } from "./markdown-blocks.js";
import {
  MarkdownFileLinkContext,
  type MarkdownFileLinkResolver,
  MarkdownImageSourceContext,
} from "./markdown-file-link-context.js";
import { loadKatex, normalizeMathDelimiters } from "./markdown-math.js";
import {
  MarkdownMentionContext,
  type MarkdownMentions,
} from "./markdown-mention-context.js";
import {
  mermaidRender,
  requestMermaid,
  subscribeMermaid,
} from "./markdown-mermaid.js";
import { MarkdownView } from "./markdown-view.js";

/**
 * The view fence's language. Typed by the view contract, so the two cannot
 * drift, and not imported: views and their contract load with the first view.
 */
const VIEW_LANGUAGE: typeof ViewLanguage = "dx-view";

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
  const attach = (element: HTMLButtonElement | null) => {
    button.current = element;
    return () => {
      button.current = null;
      clearTimeout(timer.current);
    };
  };
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

const codeLanguages = (content: React.ReactNode) => {
  const child = React.Children.toArray(content).find(React.isValidElement);
  return React.isValidElement<{ className?: string }>(child)
    ? (child.props.className?.split(" ") ?? [])
    : [];
};

function CodeBlock({
  content,
  source = nodeText(content),
}: {
  readonly content: React.ReactNode;
  /** The text of `content`, when the caller already has it. */
  readonly source?: string;
}) {
  const [wrap, setWrap] = React.useState(false);
  const text = source.replace(/\n$/, "");
  const diagram = codeLanguages(content).includes("language-diagram");
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

// The unsettled tail of a streaming message; its diagrams render once settled.
const UnsettledMarkdown = React.createContext(false);

/**
 * A ```mermaid fence as a diagram. The source block stays mounted while the
 * diagram renders and when it cannot, so its copy and wrap state survive.
 */
function MermaidBlock({
  content,
  text = nodeText(content),
}: {
  readonly content: React.ReactNode;
  readonly text?: string;
}) {
  const unsettled = React.useContext(UnsettledMarkdown);
  const { resolvedAppearance } = useTheme();
  const [showSource, setShowSource] = React.useState(false);
  const source = text.replace(/\n$/, "");
  const renders = !unsettled && source.trim() !== "";
  if (renders) requestMermaid(source, resolvedAppearance);
  const image = React.useSyncExternalStore(
    subscribeMermaid,
    () => (renders ? mermaidRender(source, resolvedAppearance) : null),
    () => null,
  );
  if (!image || showSource)
    return (
      <div className="markdown-mermaid-source">
        <CodeBlock content={content} source={text} />
        {image && (
          <button
            type="button"
            className="markdown-mermaid-toggle"
            aria-label="Show diagram"
            onClick={() => setShowSource(false)}
          >
            <Image aria-hidden="true" />
          </button>
        )}
      </div>
    );
  return (
    <figure className="markdown-mermaid" data-diagram-label={image.label}>
      <CopyButton text={source} label="Copy Mermaid source" subject="Diagram" />
      <button
        type="button"
        className="markdown-mermaid-toggle"
        aria-label="Show Mermaid source"
        onClick={() => setShowSource(true)}
      >
        <Code aria-hidden="true" />
      </button>
      <div className="markdown-mermaid-scroll">
        <img
          src={image.src}
          alt={image.label}
          width={image.width}
          height={image.height}
        />
      </div>
    </figure>
  );
}

/**
 * A ```dx-view fence as the view it describes, once its fence closes. Its
 * source stays one toggle away, and shows when the view kit cannot load.
 */
function ViewBlock({
  content,
  text = nodeText(content),
}: {
  readonly content: React.ReactNode;
  readonly text?: string;
}) {
  const unsettled = React.useContext(UnsettledMarkdown);
  const [showSource, setShowSource] = React.useState(false);
  const source = text.replace(/\n$/, "");
  if (unsettled)
    return (
      <div className="markdown-view-drawing" role="status">
        <LoaderCircle aria-hidden="true" />
        Drawing view, {Math.max(1, Math.round(source.length / 1024))} KB
      </div>
    );
  const sourceBlock = <CodeBlock content={content} source={text} />;
  const toggle = (
    <button
      type="button"
      className="markdown-view-action"
      aria-label={showSource ? "Show view" : "Show view source"}
      onClick={() => setShowSource(!showSource)}
    >
      {showSource ? <Image aria-hidden="true" /> : <Code aria-hidden="true" />}
    </button>
  );
  if (showSource || source.trim() === "")
    return (
      <div className="markdown-view-source">
        {sourceBlock}
        <div className="markdown-view-actions">{toggle}</div>
      </div>
    );
  return (
    <MarkdownView
      source={source}
      fallback={sourceBlock}
      actions={
        <>
          <CopyButton text={source} label="Copy view source" subject="View" />
          {toggle}
        </>
      }
    />
  );
}

function KatexFormula({
  source,
  display,
  children: fallback,
}: {
  readonly source: string;
  readonly display: boolean;
  readonly children: React.ReactNode;
}) {
  const katex = React.use(loadKatex());
  const unsettled = React.useContext(UnsettledMarkdown);
  // KaTeX writes into an element React leaves empty, so React never
  // reconciles its output.
  const render = (element: HTMLElement | null) => {
    if (element === null || katex === undefined) return;
    const options = {
      displayMode: display,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    } as const;
    try {
      katex.render(source, element, { ...options, throwOnError: true });
    } catch {
      // A formula still streaming is often incomplete; show its source
      // until it settles. Settled invalid TeX shows KaTeX's error.
      if (unsettled) element.textContent = source;
      else katex.render(source, element, { ...options, throwOnError: false });
    }
  };
  if (katex === undefined) return fallback;
  return display ? (
    <div className="markdown-math-display" ref={render} />
  ) : (
    <span className="markdown-math-inline" ref={render} />
  );
}

function MathFormula({
  source,
  display,
}: {
  readonly source: string;
  readonly display: boolean;
}) {
  const fallback = display ? (
    <pre className="markdown-math-source">
      <code>{source}</code>
    </pre>
  ) : (
    <code className="markdown-math-source">{source}</code>
  );
  return (
    <React.Suspense fallback={fallback}>
      <KatexFormula source={source} display={display}>
        {fallback}
      </KatexFormula>
    </React.Suspense>
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
        // Opens in the workspace; a button has no href that could navigate
        // and reload dx.
        <button
          type="button"
          className="markdown-file-link"
          title={href}
          onClick={() => file.open()}
          onAuxClick={(event) => {
            if (event.button === 1) file.open();
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

/**
 * Code, highlighted as rehype-highlight did with `detect: false`. Highlighting
 * here rather than in the syntax tree keeps react-markdown from walking and
 * converting every highlighted token.
 */
function MarkdownCode({
  node: _node,
  className,
  children: content,
  ...props
}: React.ComponentProps<"code"> & { readonly node?: unknown }) {
  if (className?.split(" ").includes("math-inline"))
    return <MathFormula source={nodeText(content)} display={false} />;
  const language = codeLanguage(className);
  if (!language)
    return (
      <code className={className} {...props}>
        {content}
      </code>
    );
  const highlighted =
    typeof content === "string" ? highlightCode(language, content) : undefined;
  return (
    <code className={`hljs ${className}`} {...props}>
      {highlighted === undefined || highlighted.length === 0
        ? content
        : highlightNodes(highlighted).elements}
    </code>
  );
}

function MarkdownPre({
  children: content,
  text,
}: {
  readonly children?: React.ReactNode;
  /** The text of `children`, when the caller already has it. */
  readonly text?: string;
}) {
  const languages = codeLanguages(content);
  if (languages.includes("math-display"))
    return (
      <MathFormula
        source={(text ?? nodeText(content)).replace(/\n$/, "")}
        display={true}
      />
    );
  if (languages.includes("language-mermaid"))
    return <MermaidBlock content={content} text={text} />;
  if (languages.includes(`language-${VIEW_LANGUAGE}`))
    return <ViewBlock content={content} text={text} />;
  return <CodeBlock content={content} source={text} />;
}

/** Highlighted spans, keyed by the code offset where each starts. */
const highlightNodes = (
  nodes: ReadonlyArray<HighlightNode>,
  start = 0,
): { readonly elements: React.ReactNode[]; readonly end: number } => {
  let offset = start;
  const elements = nodes.map((node) => {
    if (typeof node === "string") {
      offset += node.length;
      return node;
    }
    const at = offset;
    const children = highlightNodes(node.children, at);
    offset = children.end;
    return (
      <span key={at} className={node.className}>
        {children.elements}
      </span>
    );
  });
  return { elements, end: offset };
};

// biome-ignore lint/plugin: each chunk re-maps every run of the fence; memo skips the runs that kept their lines.
const HighlightedRun = React.memo(function HighlightedRun({
  lines,
}: {
  readonly lines: HighlightedLines;
}) {
  return highlightNodes(lines.nodes, lines.start).elements;
});

/**
 * A block that is one fenced code block while its reply streams, rendered as
 * react-markdown renders it without parsing it on every chunk. While open,
 * lines highlighted on an earlier chunk keep their output and only the
 * newest lines are highlighted again. Once closed it shows the exact
 * highlighting of settled Markdown, keeping the lines whose output did not
 * change, its wrap state, and its copy button.
 */
// biome-ignore lint/plugin: each chunk re-maps every block; memo skips fences above the streaming tail.
const StreamingCodeFence = React.memo(function StreamingCodeFence({
  language,
  code,
  closed,
}: {
  readonly language: string | undefined;
  readonly code: string;
  readonly closed: boolean;
}) {
  // remark-rehype ends non-empty code with a newline.
  const source = code === "" ? "" : `${code}\n`;
  const next = closed ? highlightClosedCode : highlightStreamingCode;
  const [highlight, setHighlight] = React.useState(() =>
    next(undefined, language, source),
  );
  let current = highlight;
  // Each chunk extends the previous highlight: adjust state during render.
  if (
    current.source !== source ||
    current.language !== language ||
    current.exact !== closed
  ) {
    current = next(current, language, source);
    setHighlight(current);
  }
  const runs = current.settled.map((lines) => (
    <HighlightedRun key={lines.start} lines={lines} />
  ));
  return (
    <UnsettledMarkdown value={!closed}>
      <MarkdownPre text={source}>
        <code
          className={
            language === undefined ? undefined : `hljs language-${language}`
          }
        >
          {runs}
          {highlightNodes(current.tail, current.settledLength).elements}
        </code>
      </MarkdownPre>
    </UnsettledMarkdown>
  );
});

// Stable across renders so react-markdown does not rebuild its processor
// configuration on every parse.
const remarkPlugins: React.ComponentProps<
  typeof ReactMarkdown
>["remarkPlugins"] = [
  remarkGfm,
  remarkBreaks,
  // Single dollars are prices more often than math; normalizeMathDelimiters
  // rewrites the math ones to double dollars.
  [remarkMath, { singleDollarTextMath: false }],
];
// A file is hard-wrapped prose: a single newline is a space, not a break.
const documentRemarkPlugins: React.ComponentProps<
  typeof ReactMarkdown
>["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const urlTransform = (url: string) =>
  url.startsWith("file:///") || fileLineReference.test(url)
    ? url
    : safeUrl(url);

/**
 * Rendering an image fetches it, so an agent-written remote image URL could
 * carry thread content to its host without a click. Only same-origin images
 * load; the rest render as links the reader can choose to open.
 */
const sameOriginImage = (src: string) => {
  const page =
    typeof window === "undefined"
      ? "https://dx.invalid/"
      : window.location.href;
  try {
    return new URL(src, page).origin === new URL(page).origin;
  } catch {
    return false;
  }
};

// A link inside a link is invalid HTML, and clicks would reach the inner one.
const InsideMarkdownLink = React.createContext(false);

function MarkdownImage({
  alt,
  src,
  title,
}: Pick<React.ComponentProps<"img">, "alt" | "src" | "title">) {
  const insideLink = React.useContext(InsideMarkdownLink);
  const resolveImage = React.useContext(MarkdownImageSourceContext);
  const name = accessibleName(alt, "Markdown image");
  const url = typeof src === "string" && src !== "" ? src : undefined;
  const media = url === undefined ? undefined : resolveImage?.(url);
  // Players are interactive, so a linked one stays an image or a label.
  if (media?.kind === "video" && !insideLink)
    return (
      // biome-ignore lint/a11y/useMediaCaption: agent-made media has no caption track; the alt text names it.
      <video
        className="markdown-media"
        src={media.url}
        title={title ?? name}
        aria-label={name}
        controls
        playsInline
        preload="metadata"
      />
    );
  if (media?.kind === "audio" && !insideLink)
    return (
      // biome-ignore lint/a11y/useMediaCaption: agent-made media has no caption track; the alt text names it.
      <audio
        className="markdown-media"
        src={media.url}
        title={title ?? name}
        aria-label={name}
        controls
        preload="metadata"
      />
    );
  if (media?.kind === "image")
    return <img src={media.url} alt={name} title={title} loading="lazy" />;
  if (media === undefined && url !== undefined && sameOriginImage(url))
    return <img src={url} alt={name} title={title} loading="lazy" />;
  const label = (
    <>
      <Image aria-hidden="true" />
      {name}
    </>
  );
  // The surrounding link keeps its own target; a URL the transform removed
  // has nothing to open. Either way the alt text stays visible.
  if (url === undefined || insideLink)
    return (
      <span className="markdown-remote-image" title={url}>
        {label}
      </span>
    );
  return (
    <a
      className="markdown-remote-image"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
    >
      {label}
    </a>
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
}

/**
 * Turns `@handle` in prose (not code or links) into `dx-mention` elements
 * for the handles given.
 */
const remarkMentions =
  (handles: ReadonlyArray<string>) => () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.children === undefined) return;
      if (node.type === "link" || node.type === "linkReference") return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== "text" || child.value === undefined) {
          visit(child);
          return [child];
        }
        return splitMentions(child.value, handles).map((part) =>
          part.handle === undefined
            ? { type: "text", value: part.text }
            : {
                type: "mention",
                data: {
                  hName: "dx-mention",
                  hProperties: { handle: part.handle },
                },
                children: [{ type: "text", value: part.text }],
              },
        );
      });
    };
    visit(tree);
  };

const markdownComponents = (
  resolveFile: MarkdownFileLinkResolver | undefined,
  mentions: MarkdownMentions | undefined,
): React.ComponentProps<typeof ReactMarkdown>["components"] => ({
  ...(mentions === undefined
    ? {}
    : {
        "dx-mention": ({
          handle,
          children: content,
        }: {
          readonly handle?: string;
          readonly children?: React.ReactNode;
        }) => mentions.render(handle ?? "", content),
      }),
  a: ({ children: content, href }) => (
    <MarkdownLink href={href} resolveFile={resolveFile}>
      <InsideMarkdownLink value={true}>{content}</InsideMarkdownLink>
    </MarkdownLink>
  ),
  img: MarkdownImage,
  input: ({ node: _node, ...props }) => (
    <input
      {...props}
      aria-label={props.checked ? "Completed task" : "Incomplete task"}
    />
  ),
  code: MarkdownCode,
  pre: MarkdownPre,
  table: ({ children: content }) => <MarkdownTable content={content} />,
});

/** One parsed Markdown document; memoized on its source text. */
// biome-ignore lint/plugin: streaming re-maps every block on each chunk; memo keeps settled blocks from re-parsing.
const MarkdownDocument = React.memo(function MarkdownDocument({
  children,
  unsettled,
  hardWrapped,
}: {
  readonly children: string;
  readonly unsettled: boolean;
  readonly hardWrapped: boolean;
}) {
  const resolveFile = React.useContext(MarkdownFileLinkContext);
  const mentions = React.useContext(MarkdownMentionContext);
  const components = markdownComponents(resolveFile, mentions);
  const handles = mentions?.handles;
  const base = hardWrapped ? documentRemarkPlugins : remarkPlugins;
  const plugins =
    handles === undefined || handles.length === 0
      ? base
      : [...(base ?? []), remarkMentions(handles)];
  return (
    <UnsettledMarkdown value={unsettled}>
      <ReactMarkdown
        remarkPlugins={plugins}
        skipHtml
        urlTransform={urlTransform}
        components={components}
      >
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </UnsettledMarkdown>
  );
});

// Key each block by its source offset: settled blocks never move.
const keyedBlocks = (blocks: ReadonlyArray<string>) => {
  let offset = 0;
  return blocks.map((block) => {
    const start = offset;
    offset += block.length + 1;
    return { start, block };
  });
};

/**
 * Parsing and highlighting is the dominant transcript cost. The compiler
 * caches the blocks on the source text, and each block is a memoized
 * document, so a re-rendering parent never re-parses unchanged Markdown.
 * While text is still streaming, parse only its unsettled tail: settled
 * blocks keep their parsed output. Settled text renders as one document.
 */
export function RichMarkdown({
  children,
  streaming = false,
  document = false,
}: {
  readonly children: string;
  readonly streaming?: boolean;
  /** A Markdown file rather than a message: soft line breaks are spaces. */
  readonly document?: boolean;
}) {
  const keyed = keyedBlocks(
    streaming ? settledMarkdownBlocks(children) : [children],
  );
  return (
    <div
      className={`markdown transcript-markdown${document ? " markdown-file" : ""}`}
    >
      {keyed.map(({ start, block }, index) => {
        const fence = streaming ? codeFenceBlock(block) : undefined;
        if (fence !== undefined)
          return (
            <StreamingCodeFence
              key={start}
              language={fence.language}
              code={fence.code}
              closed={fence.closed}
            />
          );
        return (
          <MarkdownDocument
            hardWrapped={document}
            key={start}
            unsettled={streaming && index === keyed.length - 1}
          >
            {block}
          </MarkdownDocument>
        );
      })}
    </div>
  );
}
