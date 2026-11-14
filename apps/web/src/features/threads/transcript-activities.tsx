import { lazyRouteComponent } from "@tanstack/react-router";
import { ChevronRight, FileSymlink, Sparkles } from "lucide-react";
import * as React from "react";
import { FileContextMenu } from "../../shared/ui/file-context-menu.js";
import { ArtifactToolCard } from "./artifact-tool-card.js";
import { ArtifactToolLabel } from "./artifact-tool-label.js";
import {
  ARTIFACT_TOOL_NAME,
  isArtifactCardPart,
} from "./artifact-tool-part.js";
import { isMcpAppPart, mcpAppCardSet } from "./mcp-app-part.js";
import { PluginToolIcon } from "./plugin-ui/lazy-plugin-ui-icons.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import {
  parseShellResult,
  shellCommandOperations,
} from "./shell-command-operation.js";
import {
  type SkillActivation,
  skillActivation,
  skillActivationLabel,
} from "./skill-activation.js";
import { SubagentActivity } from "./subagent-activity.js";
import { ThreadFileNavigationContext } from "./thread-file-navigation.js";
import { ThreadToolDetail, ThreadToolLabel } from "./thread-tool-activity.js";
import { ToolOutputImages, useToolImages } from "./tool-output-media.js";
import {
  toolContentBlocks,
  toolContentText,
} from "./tool-output-media-model.js";
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

/** A call that Stop ended, rather than one that failed. */
const stopped = (part: ToolPart) =>
  part.state === "output-error" &&
  /\b(?:stopped|aborted)\b/i.test(part.errorText);

const failureCount = (rows: ReadonlyArray<WorkRow>) =>
  rows.filter((row) => {
    const part = toolPart(row);
    return part?.state === "output-error" && !stopped(part);
  }).length;

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
  return toolContentText(part.output);
};

/** Whether a finished call returned an image, stored or not. */
const returnedImage = (part: ToolPart) =>
  part.state === "output-available" &&
  (toolContentBlocks(part.output) ?? []).some(
    (block) => block.type === "image",
  );

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

/** A tool row's label; a plugin's tool leads with the plugin's icon. */
function ToolLabel(props: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  return (
    <>
      <PluginToolIcon toolName={props.part.toolName} />
      <ToolLabelText {...props} />
    </>
  );
}

function ToolLabelText({
  category,
  part,
}: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  const failed =
    (part.state === "output-error" && !stopped(part)) ||
    (parseShellResult(textualOutputFor(part) ?? "").exitCode ?? 0) !== 0;
  if (part.toolName === ARTIFACT_TOOL_NAME)
    return <ArtifactToolLabel part={part} />;
  if (category === "explore") return <ExploreOperationLabel part={part} />;
  if (category === "thread") return <ThreadToolLabel part={part} />;
  if (category === "command") {
    return (
      <span className="transcript-command-label">
        <span className={failed ? "is-failed" : undefined}>$</span>
        <code>{commandFor(part) ?? part.toolName}</code>
        {stopped(part) ? <small>Stopped</small> : null}
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
  const images = useToolImages(part);
  const output =
    part.toolName === "edit_file" || part.toolName.startsWith("shell_command")
      ? (textualOutputFor(part) ?? outputFor(part))
      : outputFor(part);
  if (output === undefined) return null;
  // What view_media saw or answered, as prose, with the image it returned.
  if (part.toolName === "view_media" && part.state === "output-available") {
    const text = textualOutputFor(part);
    return (
      <div className="transcript-media-output">
        {text === undefined ? null : (
          <TranscriptMarkdown>{text}</TranscriptMarkdown>
        )}
        <ToolOutputImages images={images} />
      </div>
    );
  }
  // Any other call that returned an image, such as Claude Code's Read of one.
  if (returnedImage(part)) {
    const text = textualOutputFor(part);
    return (
      <div className="transcript-media-output">
        {text === undefined ? null : (
          <pre className="transcript-read-output">{text}</pre>
        )}
        <ToolOutputImages images={images} />
      </div>
    );
  }
  if (category === "thread")
    return <ThreadToolDetail part={part} output={output} />;
  if (category === "skill")
    return (
      <pre className="transcript-read-output">
        {textualOutputFor(part) ?? output}
      </pre>
    );
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
  const part = toolPart(row);
  return part === undefined ? null : (
    <ToolPartRow category={category} part={part} />
  );
}

/**
 * A skill activation on its own row, named and with its outcome, and the
 * loaded instructions behind a disclosure.
 */
function SkillActivationRow({
  activation,
  part,
}: {
  readonly activation: SkillActivation;
  readonly part: ToolPart;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const label = (
    <>
      <Sparkles aria-hidden="true" className="transcript-skill-icon" />
      <span className="transcript-activity-label">
        {skillActivationLabel(activation)}
      </span>
    </>
  );
  const attributes = {
    className: "transcript-activity-row transcript-skill-activation",
    "data-tool-category": "skill",
    "data-skill-state": activation.state,
  };
  if (outputFor(part) === undefined) return <div {...attributes}>{label}</div>;
  return (
    <details
      {...attributes}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {label}
        <ChevronRight className="transcript-activity-chevron" />
      </summary>
      {expanded ? <ToolOutput category="skill" part={part} /> : null}
    </details>
  );
}

/** One tool call: its label, and its output behind a disclosure. */
function ToolPartRow({
  category,
  part,
}: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  if (category === "skill")
    return (
      <SkillActivationRow activation={skillActivation(part)} part={part} />
    );
  if (isArtifactCardPart(part)) return <ArtifactToolCard part={part} />;
  if (isMcpAppPart(part)) return <McpAppToolRow part={part} />;
  return <GenericToolPartRow category={category} part={part} />;
}

/** The cards and their query load with the first call that showed any. */
const McpAppCards = lazyRouteComponent(
  () => import("./mcp-app-cards.js"),
  "McpAppCards",
);

/** A `code_exec` call that showed MCP App cards: its row, then the cards. */
function McpAppToolRow({ part }: { readonly part: ToolPart }) {
  const cardSetId = mcpAppCardSet(part);
  return (
    <div className="transcript-mcp-app">
      <GenericToolPartRow category={categoryForPart(part)} part={part} />
      <React.Suspense fallback={<div className="markdown-view-pending" />}>
        {cardSetId === undefined ? null : <McpAppCards cardSetId={cardSetId} />}
      </React.Suspense>
    </div>
  );
}

function GenericToolPartRow({
  category,
  part,
}: {
  readonly category: ToolCategory;
  readonly part: ToolPart;
}) {
  const [expanded, setExpanded] = React.useState(false);
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

const renderSubagentStep = (part: ToolPart, key: string) => (
  <ToolPartRow category={categoryForPart(part)} key={key} part={part} />
);

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
        ) : activity.kind === "subagent" ? (
          <SubagentActivity
            key={activity.row.id}
            view={activity.view}
            renderStep={renderSubagentStep}
          />
        ) : activity.kind === "artifact" ? (
          <ArtifactToolCard key={activity.row.id} part={activity.part} />
        ) : activity.kind === "mcp-app" ? (
          <McpAppToolRow key={activity.row.id} part={activity.part} />
        ) : activity.kind === "skill" ? (
          <SkillActivationRow
            activation={activity.activation}
            key={activity.row.id}
            part={activity.part}
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
