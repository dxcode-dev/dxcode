import { THREAD_SANDBOX_WORKSPACE_ROOT, ThreadSandboxFilePath } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import * as React from "react";
import {
  MarkdownFileLinkContext,
  MarkdownImageSourceContext,
} from "../../../shared/ui/markdown-file-link-context.js";
import { RichMarkdown } from "../../../shared/ui/rich-markdown.js";
import {
  absolutePathFor,
  sandboxFileUrl,
  type ThreadFileTarget,
} from "../transcript-file-link.js";
import {
  columnName,
  delimiterFor,
  type FilePreviewKind,
  parseDelimited,
} from "./file-preview-model.js";

const scheme = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a reference a document makes to another sandbox file. Relative
 * references follow the document's folder; a leading `/` in a repository
 * file means the repository root, as it does on code hosts.
 */
const referencedFile = (location: ThreadFileTarget, reference: string) => {
  const value = reference.trim();
  if (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    scheme.test(value)
  )
    return undefined;
  const document = absolutePathFor(location);
  if (document === undefined) return undefined;
  try {
    const url =
      location.kind === "workspace" && value.startsWith("/")
        ? new URL(`file://${THREAD_SANDBOX_WORKSPACE_ROOT}${value}`)
        : new URL(value, `file://${document}`);
    if (url.search !== "") return undefined;
    const path = Schema.decodeUnknownOption(ThreadSandboxFilePath)(
      decodeURIComponent(url.pathname),
    );
    return Option.isSome(path)
      ? { path: path.value, fileUrl: `file://${url.pathname}${url.hash}` }
      : undefined;
  } catch {
    return undefined;
  }
};

const DocumentReferences = ({
  threadId,
  location,
  children,
}: {
  readonly threadId: ThreadId;
  readonly location: ThreadFileTarget;
  readonly children: React.ReactNode;
}) => {
  const resolveWorkspaceLink = React.useContext(MarkdownFileLinkContext);
  const resolveImage = React.useCallback(
    (src: string) => {
      const file = referencedFile(location, src);
      return file === undefined
        ? undefined
        : sandboxFileUrl(threadId, file.path);
    },
    [location, threadId],
  );
  const resolveLink = React.useMemo(
    () =>
      resolveWorkspaceLink === undefined
        ? undefined
        : (href: string) =>
            resolveWorkspaceLink(
              referencedFile(location, href)?.fileUrl ?? href,
            ),
    [location, resolveWorkspaceLink],
  );
  return (
    <MarkdownImageSourceContext value={resolveImage}>
      <MarkdownFileLinkContext value={resolveLink}>
        {children}
      </MarkdownFileLinkContext>
    </MarkdownImageSourceContext>
  );
};

/** Rows past this stay in Source; the DOM would only slow the pane down. */
const TABLE_ROW_LIMIT = 1_000;

const DelimitedTable = ({
  path,
  content,
}: {
  readonly path: string;
  readonly content: string;
}) => {
  const rows = React.useMemo(
    () => parseDelimited(content, delimiterFor(path, content)),
    [content, path],
  );
  if (rows.length === 0)
    return (
      <div className="thread-files-state" role="status">
        This table is empty.
      </div>
    );
  const [header, ...body] = rows;
  const columns = Array.from(
    { length: Math.max(...rows.map((row) => row.cells.length)) },
    (_, index) => columnName(index),
  );
  const shown = body.slice(0, TABLE_ROW_LIMIT);
  return (
    <div className="thread-file-table">
      <section
        className="thread-file-table-scroll"
        aria-label={`Table ${path}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table must scroll from the keyboard.
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th aria-label="Row" scope="col" />
              {columns.map((column, index) => (
                <th key={column} scope="col">
                  {header?.cells[index] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={row.line}>
                <th scope="row">{rowIndex + 1}</th>
                {columns.map((column, index) => (
                  <td key={column}>{row.cells[index] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <footer role="status">
        {body.length > shown.length
          ? `Showing ${shown.length.toLocaleString()} of ${body.length.toLocaleString()} rows. Source shows every row.`
          : `${body.length.toLocaleString()} ${body.length === 1 ? "row" : "rows"} × ${columns.length.toLocaleString()} ${columns.length === 1 ? "column" : "columns"}`}
      </footer>
    </div>
  );
};

/** A Markdown document or a CSV/TSV table, rendered for reading. */
export function FilePreview({
  kind,
  path,
  content,
  references,
}: {
  readonly kind: FilePreviewKind;
  readonly path: string;
  readonly content: string;
  /** Where the document lives, so its relative images and links resolve. */
  readonly references?: {
    readonly threadId: ThreadId;
    readonly location: ThreadFileTarget;
  };
}) {
  if (kind === "table")
    return (
      <div className="thread-file-table-host">
        <DelimitedTable content={content} path={path} />
      </div>
    );
  const markdown = <RichMarkdown document>{content}</RichMarkdown>;
  return (
    <article className="thread-file-preview">
      {references === undefined ? (
        markdown
      ) : (
        <DocumentReferences
          location={references.location}
          threadId={references.threadId}
        >
          {markdown}
        </DocumentReferences>
      )}
    </article>
  );
}
