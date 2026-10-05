import { ChevronRight, FileSymlink } from "lucide-react";
import * as React from "react";
import { FileContextMenu } from "../../shared/ui/file-context-menu.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import {
  parseShellResult,
  shellCommandOperations,
} from "./shell-command-operation.js";
import { ThreadFileNavigationContext } from "./thread-file-navigation.js";
import { presentTool } from "./tool-presentation.js";
import {
  categoryForPart,
  projectTranscriptActivities,
  type ToolCategory,
  type ToolPart,
  toolPart,
  type WorkRow,
} from "./transcript-activity-projection.js";
import {
  activitySummary,
  commandFor,
  isSearch,
  pathFor,
  record,
  stringField,
} from "./transcript-activity-summary.js";
import {
  TranscriptCodePreview,
  TranscriptEditDiff,
} from "./transcript-code-preview.js";
import {
  isPatchOutput,
  transcriptEditSource,
} from "./transcript-code-preview-model.js";
import { resolveTranscriptFileLink } from "./transcript-file-link.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";
import type { TranscriptRow } from "./transcript-view-model.js";

const numberField = (value: unknown, ...names: ReadonlyArray<string>) => {
  const fields = record(value);
  for (const name of names) {
    const candidate = fields?.[name];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.round(candidate));
    }
  }
  return undefined;
};

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const failureCount = (rows: ReadonlyArray<WorkRow>) =>
  rows.filter((row) => toolPart(row)?.state === "output-error").length;

const serialize = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const outputFor = (part: ToolPart) => {
  if (part.state === "output-error") return part.errorText.trim();
  if (part.state !== "output-available") return undefined;
  const output = serialize(part.output).trim();
  return output.length > 0 && output !== "undefined" ? output : undefined;
};

const textualOutputFor = (part: ToolPart) => {
  if (part.state !== "output-available") return undefined;
  if (typeof part.output === "string") return part.output;
  const content = record(part.output)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
};

const lineRange = (part: ToolPart) => {
  const start = numberField(part.input, "startLine", "start_line", "offset");
  const end = numberField(part.input, "endLine", "end_line");
  const limit = numberField(part.input, "limit");
  if (start === undefined) return undefined;
  const normalizedStart = Math.max(1, start);
  const normalizedEnd =
    end ?? (limit === undefined ? undefined : normalizedStart + limit - 1);
  return normalizedEnd === undefined
    ? `L${normalizedStart}`
    : `L${normalizedStart}-${Math.max(normalizedStart, normalizedEnd)}`;
};

const diffStats = (part: ToolPart) => {
  if (part.state !== "output-available") return {};
  return {
    added: numberField(
      part.output,
      "added",
      "additions",
      "linesAdded",
      "lines_added",
    ),
    removed: numberField(
      part.output,
      "removed",
      "deletions",
      "linesRemoved",
      "lines_removed",
    ),
  };
};

function ExploreOperationLabel({ part }: { readonly part: ToolPart }) {
  const name = part.toolName.toLowerCase();
  if (name === "web_search")
    return <>Web search “{stringField(part.input, "objective")}”</>;
  if (name === "read_web_page")
    return (
      <>Read {stringField(part.input, "url")?.replace(/^https?:\/\//, "")}</>
    );
  if (name === "tool_search")
    return stringField(part.input, "query") ? (
      <>Searched tools “{stringField(part.input, "query")}”</>
    ) : (
      <>Listed tools</>
    );
  const operations =
    name === "shell_command"
      ? shellCommandOperations(commandFor(part) ?? "")
      : undefined;
  if (operations)
    return (
      <>
        {operations.map((op, index) => (
          <React.Fragment key={JSON.stringify(operations.slice(0, index + 1))}>
            {index ? ", " : ""}
            {op.kind === "read" ? (
              <>
                {index && operations[index - 1]?.kind === "read" ? "" : "Read "}
                {basename(op.path)}
                {op.range ? <small>{op.range}</small> : null}
              </>
            ) : op.kind === "search" ? (
              <>
                Grep “{op.pattern}”{op.path ? ` ${op.path}` : ""}
              </>
            ) : (
              <>List {op.path ?? "."}</>
            )}
          </React.Fragment>
        ))}
      </>
    );
  const path = pathFor(part);
  const pattern = stringField(part.input, "query", "pattern");
  if (isSearch(part)) {
    const verb =
      name.includes("list") || name.includes("glob") ? "List" : "Grep";
    return (
      <>
        {verb} {path ?? pattern ?? part.toolName}
        {path && pattern ? ` “${pattern}”` : null}
      </>
    );
  }
  return (
    <>
      Read {path ? basename(path) : part.toolName}
      {lineRange(part) ? <small>{lineRange(part)}</small> : null}
    </>
  );
}

function ToolLabel({
  category,
  part,
}: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  const failed =
    part.state === "output-error" ||
    (parseShellResult(textualOutputFor(part) ?? "").exitCode ?? 0) !== 0;
  if (category === "explore") return <ExploreOperationLabel part={part} />;
  if (category === "command") {
    return (
      <span className="transcript-command-label">
        <span className={failed ? "is-failed" : undefined}>$</span>
        <code>{commandFor(part) ?? part.toolName}</code>
      </span>
    );
  }
  if (category === "check") {
    return <>Checked on {commandFor(part) ?? part.toolName}</>;
  }
  if (category === "edit") {
    const path = pathFor(part);
    const { added, removed } = diffStats(part);
    return (
      <>
        {part.toolName === "create_file" ? "Created" : "Edited"}{" "}
        <strong>{path ? basename(path) : part.toolName}</strong>
        {added === undefined ? null : (
          <span className="diff-added">+{added}</span>
        )}
        {removed === undefined ? null : (
          <span className="diff-removed">-{removed}</span>
        )}
      </>
    );
  }
  const presentation = presentTool(part.toolName, part.input, false);
  return (
    <>
      {presentation.title}
      {presentation.detail ? ` ${presentation.detail}` : null}
    </>
  );
}

function ToolOutput({
  category,
  part,
}: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  const output =
    part.toolName === "edit_file" || part.toolName.startsWith("shell_command")
      ? (textualOutputFor(part) ?? outputFor(part))
      : outputFor(part);
  if (output === undefined) return null;
  if (part.toolName.startsWith("shell_command")) {
    const result = parseShellResult(output);
    const operations =
      part.toolName === "shell_command"
        ? shellCommandOperations(commandFor(part) ?? "")
        : undefined;
    const only = operations?.length === 1 ? operations[0] : undefined;
    return (
      <div className="transcript-command-output">
        {category === "command" || category === "check" ? (
          <div className="transcript-command-output-title">
            $ {commandFor(part) ?? part.toolName}
            {stringField(part.input, "workdir")
              ? ` (${stringField(part.input, "workdir")})`
              : ""}
          </div>
        ) : null}
        {only?.kind === "read" ? (
          <TranscriptCodePreview
            path={only.path}
            contents={result.output}
            kind="file"
          />
        ) : (
          <pre>{result.output}</pre>
        )}
        {result.exitCode ? (
          <small className="is-failed">Exit code {result.exitCode}</small>
        ) : null}
        {result.running ? (
          <small>still running (pid {result.pid})</small>
        ) : null}
      </div>
    );
  }
  if (part.toolName === "read_web_page")
    return (
      <TranscriptMarkdown>
        {textualOutputFor(part) ?? output}
      </TranscriptMarkdown>
    );
  if (part.toolName === "code_exec")
    return (
      <>
        <TranscriptCodePreview
          path="code.js"
          contents={stringField(part.input, "code") ?? ""}
          kind="file"
        />
        <pre>{output}</pre>
      </>
    );
  if (part.toolName === "web_search") {
    let results: unknown =
      part.state === "output-available" ? part.output : undefined;
    if (typeof results === "string") {
      try {
        results = JSON.parse(results);
      } catch {
        /* Unknown outputs remain readable. */
      }
    }
    if (
      Array.isArray(results) &&
      results.every(
        (item) =>
          typeof record(item)?.title === "string" &&
          typeof record(item)?.url === "string" &&
          Array.isArray(record(item)?.excerpts),
      )
    )
      return (
        <div>
          {results.map((item) => {
            const value = record(item);
            return (
              <div key={String(value?.url)}>
                <a href={String(value?.url)} target="_blank" rel="noreferrer">
                  {String(value?.title)}
                </a>
                <small>{String(value?.url)}</small>
                {((value?.excerpts ?? []) as unknown[]).map((excerpt) => (
                  <p key={String(excerpt)}>{String(excerpt)}</p>
                ))}
              </div>
            );
          })}
        </div>
      );
  }
  if (category === "command" || category === "check") {
    return (
      <div className="transcript-command-output">
        <div className="transcript-command-output-title">
          $ {commandFor(part) ?? part.toolName}
          {stringField(part.input, "workdir")
            ? ` (${stringField(part.input, "workdir")})`
            : ""}
        </div>
        <pre
          className={
            part.state === "output-error" ? "work-error-output" : undefined
          }
        >
          {output}
        </pre>
      </div>
    );
  }
  if (category === "edit") {
    const source = transcriptEditSource(part.toolName, part.input);
    const resultPath = pathFor(part);
    if (
      part.toolName === "edit_file" &&
      part.state === "output-available" &&
      resultPath !== undefined &&
      isPatchOutput(output)
    )
      return (
        <TranscriptCodePreview
          path={resultPath}
          contents={output}
          kind="patch"
        />
      );
    if (source !== undefined && part.state === "output-available")
      return <TranscriptEditDiff source={source} />;
    const path = pathFor(part);
    if (path !== undefined && isPatchOutput(output)) {
      return (
        <TranscriptCodePreview path={path} contents={output} kind="patch" />
      );
    }
    return <pre className="transcript-edit-output">{output}</pre>;
  }
  const path = pathFor(part);
  if (category === "explore" && path !== undefined && !isSearch(part)) {
    return (
      <TranscriptCodePreview
        path={path}
        contents={textualOutputFor(part) ?? output}
        kind="file"
      />
    );
  }
  return <pre className="transcript-read-output">{output}</pre>;
}

/**
 * Open an edited file in the workspace with the chunk the agent wrote
 * highlighted. Rendered beside the row summary so the diff stays expandable.
 */
function EditedFileOpener({ part }: { readonly part: ToolPart }) {
  const navigation = React.useContext(ThreadFileNavigationContext);
  const path = pathFor(part);
  const resolved =
    path === undefined ? undefined : resolveTranscriptFileLink(path);
  if (navigation === undefined || resolved === undefined) return null;
  const written = transcriptEditSource(part.toolName, part.input)?.after;
  const open = () =>
    navigation.open(
      resolved.target,
      written === undefined || written.length === 0
        ? undefined
        : { kind: "text", text: written },
    );
  const downloadUrl = navigation.downloadUrl(resolved.target);
  return (
    <FileContextMenu
      trigger={
        <button
          aria-label={`Open ${path} at the edit`}
          className="transcript-activity-open"
          title="Open file at this edit"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            open();
          }}
        />
      }
      onOpen={open}
      {...(downloadUrl === undefined ? {} : { downloadUrl })}
    >
      <FileSymlink aria-hidden="true" />
    </FileContextMenu>
  );
}

function ToolActivityRow({
  category,
  row,
}: {
  readonly category: ToolCategory;
  readonly row: WorkRow;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const part = toolPart(row);
  if (part === undefined) return null;
  const expandable = outputFor(part) !== undefined;
  const label = <ToolLabel category={category} part={part} />;
  const opener =
    category === "edit" && part.state === "output-available" ? (
      <EditedFileOpener part={part} />
    ) : null;
  if (!expandable) {
    return (
      <div className="transcript-activity-row" data-tool-category={category}>
        <span className="transcript-activity-label">{label}</span>
        {opener}
      </div>
    );
  }
  return (
    <details
      className="transcript-activity-row"
      data-tool-category={category}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="transcript-activity-label">{label}</span>
        {opener}
        <ChevronRight className="transcript-activity-chevron" />
      </summary>
      {expanded ? <ToolOutput category={category} part={part} /> : null}
    </details>
  );
}

function ActivityGroup({ rows }: { readonly rows: ReadonlyArray<WorkRow> }) {
  const only = rows.length === 1 ? rows[0] : undefined;
  const onlyPart = only === undefined ? undefined : toolPart(only);
  if (only !== undefined && onlyPart !== undefined)
    return <ToolActivityRow category={categoryForPart(onlyPart)} row={only} />;
  const failed = failureCount(rows);
  return (
    <details className="transcript-activity-group">
      <summary>
        <span>
          {activitySummary(rows)}
          {failed > 0 ? (
            <>
              {", "}
              <span className="activity-failure-count">{failed} failed</span>
            </>
          ) : null}
        </span>
        <ChevronRight className="transcript-activity-chevron" />
      </summary>
      <div className="transcript-activity-children">
        {rows.map((row) => {
          const part = toolPart(row);
          return part === undefined ? null : (
            <ToolActivityRow
              category={categoryForPart(part)}
              key={row.id}
              row={row}
            />
          );
        })}
      </div>
    </details>
  );
}

function ActivityRow({
  row,
  renderRow,
}: {
  readonly row: TranscriptRow;
  readonly renderRow: (row: TranscriptRow) => React.ReactNode;
}) {
  if (
    (row.kind === "active-work" || row.kind === "settled-work") &&
    row.part.type === "reasoning"
  ) {
    return (
      <div className="transcript-reasoning-prose" data-row-id={row.id}>
        <TranscriptMarkdown streaming={row.part.state === "streaming"}>
          {row.part.text}
        </TranscriptMarkdown>
      </div>
    );
  }
  return renderRow(row);
}

export function TranscriptActivityList({
  processing,
  renderRow,
  rows,
}: {
  readonly processing: boolean;
  readonly renderRow: (row: TranscriptRow) => React.ReactNode;
  readonly rows: ReadonlyArray<TranscriptRow>;
}) {
  return (
    <div
      className={`transcript-activity-list ${processing ? "is-processing" : ""}`}
    >
      {projectTranscriptActivities(rows).map((activity) =>
        activity.kind === "row" ? (
          <ActivityRow
            key={activity.row.id}
            renderRow={renderRow}
            row={activity.row}
          />
        ) : (
          <ActivityGroup
            key={`tools:${activity.rows[0]?.id}`}
            rows={activity.rows}
          />
        ),
      )}
      {processing ? (
        <ProcessingIndicator
          accessibleLabel="Agent is processing"
          className="transcript-turn-processing-indicator"
        />
      ) : null}
    </div>
  );
}
