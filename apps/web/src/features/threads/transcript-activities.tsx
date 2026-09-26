import { ChevronRight } from "lucide-react";
import * as React from "react";
import { ProcessingIndicator } from "./processing-indicator.js";
import { presentTool } from "./tool-presentation.js";
import {
  projectTranscriptActivities,
  type ToolCategory,
  type ToolPart,
  toolPart,
  type WorkRow,
} from "./transcript-activity-projection.js";
import { TranscriptCodePreview } from "./transcript-code-preview.js";
import { isPatchOutput } from "./transcript-code-preview-model.js";
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

const exploreLabel = (rows: ReadonlyArray<WorkRow>) => {
  let files = 0;
  let guidance = 0;
  let searches = 0;
  for (const row of rows) {
    const part = toolPart(row);
    if (part === undefined) continue;
    if (isSearch(part)) searches += 1;
    else if (isGuidance(part)) guidance += 1;
    else files += 1;
  }
  const counts = [
    files > 0 ? plural(files, "file") : undefined,
    guidance > 0 ? plural(guidance, "guidance file") : undefined,
    searches > 0 ? plural(searches, "search", "searches") : undefined,
  ].filter((value): value is string => value !== undefined);
  return `Explored ${counts.join(", ") || plural(rows.length, "item")}`;
};

const failureCount = (rows: ReadonlyArray<WorkRow>) =>
  rows.filter((row) => toolPart(row)?.state === "output-error").length;

const commandGroupLabel = (rows: ReadonlyArray<WorkRow>) => {
  return `Ran ${plural(rows.length, "command")}`;
};

const checkGroupLabel = (rows: ReadonlyArray<WorkRow>) =>
  `Checked on ${plural(rows.length, "command")}`;

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
  if (!expandable) {
    return (
      <div className="transcript-activity-row" data-tool-category={category}>
        <span className="transcript-activity-label">{label}</span>
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
        <ChevronRight className="transcript-activity-chevron" />
      </summary>
      {expanded ? <ToolOutput category={category} part={part} /> : null}
    </details>
  );
}

function ActivityGroup({
  category,
  rows,
}: {
  readonly category: ToolCategory;
  readonly rows: ReadonlyArray<WorkRow>;
}) {
  const grouped = category === "explore" || rows.length > 1;
  if (!grouped)
    return <ToolActivityRow category={category} row={rows[0] as WorkRow} />;
  const label =
    category === "explore"
      ? exploreLabel(rows)
      : category === "check"
        ? checkGroupLabel(rows)
        : commandGroupLabel(rows);
  const failed = failureCount(rows);
  return (
    <details
      className="transcript-activity-group"
      data-tool-category={category}
    >
      <summary>
        <span>
          {label}
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
        {rows.map((row) => (
          <ToolActivityRow category={category} key={row.id} row={row} />
        ))}
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
        <TranscriptMarkdown>{row.part.text}</TranscriptMarkdown>
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
            category={activity.category}
            key={`${activity.category}:${activity.rows[0]?.id}`}
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
