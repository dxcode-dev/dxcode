import { ChevronRight, FileSymlink } from "lucide-react";
import * as React from "react";
import { FileContextMenu } from "../../shared/ui/file-context-menu.js";
import { ProcessingIndicator } from "./processing-indicator.js";
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

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, ...names: ReadonlyArray<string>) => {
  const fields = record(value);
  for (const name of names) {
    const candidate = fields?.[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
};

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

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const pathFor = (part: ToolPart) =>
  stringField(part.input, "path", "filePath", "file_path");
const commandFor = (part: ToolPart) =>
  stringField(part.input, "command", "cmd");

const isSearch = (part: ToolPart) => {
  const name = part.toolName.toLowerCase();
  return ["search", "grep", "find", "glob", "list"].some((token) =>
    name.includes(token),
  );
};

const isGuidance = (part: ToolPart) => {
  const name = part.toolName.toLowerCase();
  const path = pathFor(part)?.toLowerCase();
  return (
    name.includes("skill") ||
    path?.endsWith("agents.md") === true ||
    path?.endsWith("skill.md") === true
  );
};

type SummaryKind =
  | "command"
  | "edit"
  | "read"
  | "guidance"
  | "search"
  | "check"
  | "generic";

const summaryKind = (category: ToolCategory, part: ToolPart): SummaryKind => {
  if (category !== "explore") return category;
  if (isSearch(part)) return "search";
  return isGuidance(part) ? "guidance" : "read";
};

const summaryPhrase = (kind: SummaryKind, count: number) => {
  switch (kind) {
    case "command":
      return `ran ${plural(count, "command")}`;
    case "edit":
      return `edited ${plural(count, "file")}`;
    case "read":
      return `read ${plural(count, "file")}`;
    case "guidance":
      return `read ${plural(count, "guidance file")}`;
    case "search":
      return `searched ${plural(count, "time")}`;
    case "check":
      return `checked on ${plural(count, "command")}`;
    case "generic":
      return `used ${plural(count, "tool")}`;
  }
};

/**
 * Summarize a run of tool calls by kind, in order of first appearance:
 * "Ran 2 commands, edited 3 files". Edits and reads count distinct files.
 */
export const activitySummary = (rows: ReadonlyArray<WorkRow>) => {
  const kinds = new Map<SummaryKind, Set<string>>();
  for (const row of rows) {
    const part = toolPart(row);
    if (part === undefined) continue;
    const kind = summaryKind(categoryForPart(part), part);
    const path = pathFor(part);
    const identity =
      (kind === "edit" || kind === "read" || kind === "guidance") &&
      path !== undefined
        ? `path:${path}`
        : `call:${part.toolCallId}`;
    const identities = kinds.get(kind) ?? new Set<string>();
    identities.add(identity);
    kinds.set(kind, identities);
  }
  const label = [...kinds]
    .map(([kind, identities]) => summaryPhrase(kind, identities.size))
    .join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

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
  const failed = part.state === "output-error";
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
        Edited <strong>{path ? basename(path) : part.toolName}</strong>
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
  const output = outputFor(part);
  if (output === undefined) return null;
  if (category === "command" || category === "check") {
    return (
      <div className="transcript-command-output">
        <div className="transcript-command-output-title">
          $ {commandFor(part) ?? part.toolName}
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
