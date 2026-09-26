import type {
  FailedSend,
  FlueConversationMessage,
  FlueConversationPart,
} from "@flue/react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  LoaderCircle,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import { presentTool } from "./tool-presentation.js";
import {
  TranscriptAttachment,
  TranscriptMarkdown,
} from "./transcript-markdown.js";
import type { TranscriptRow } from "./transcript-view-model.js";

type ToolPart = Extract<FlueConversationPart, { type: "dynamic-tool" }>;
type WorkPart = Exclude<FlueConversationPart, { type: "text" | "file" }>;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const serialize = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const keyedParts = <Part extends FlueConversationPart>(
  parts: ReadonlyArray<Part>,
) => {
  const occurrences = new Map<string, number>();
  return parts.map((part) => {
    const identity =
      part.type === "dynamic-tool"
        ? `tool:${part.toolCallId}`
        : part.type === "file"
          ? `file:${part.id ?? part.url ?? part.filename ?? part.mediaType}`
          : part.type;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { key: `${identity}:${occurrence}`, part };
  });
};

const messageTimestamp = (message: FlueConversationMessage) => {
  const timestamp = message.metadata?.timestamp;
  if (typeof timestamp !== "string") return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return timestampFormatter.format(date);
};

const workIsRunning = (parts: ReadonlyArray<WorkPart>) =>
  parts.some(
    (part) =>
      (part.type === "reasoning" && part.state === "streaming") ||
      (part.type === "dynamic-tool" && part.state === "input-available"),
  );

const workHasFailed = (parts: ReadonlyArray<WorkPart>) =>
  parts.some(
    (part) => part.type === "dynamic-tool" && part.state === "output-error",
  );

const formatWorkDuration = (parts: ReadonlyArray<WorkPart>) => {
  const durationMs = parts.reduce(
    (total, part) =>
      total +
      (part.type === "dynamic-tool" && part.durationMs !== undefined
        ? part.durationMs
        : 0),
    0,
  );
  if (durationMs < 1_000) return undefined;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

function ToolEvent({ part }: { readonly part: ToolPart }) {
  const running = part.state === "input-available";
  const failed = part.state === "output-error";
  const presentation = presentTool(part.toolName, part.input, running);
  return (
    <details className={`work-tool ${failed ? "work-tool-failed" : ""}`}>
      <summary>
        {running ? (
          <LoaderCircle className="spin" />
        ) : failed ? (
          <X />
        ) : (
          <Check />
        )}
        <span>{presentation.title}</span>
        {presentation.detail ? <code>{presentation.detail}</code> : null}
        <ChevronRight className="work-chevron" />
      </summary>
      <div className="work-tool-detail">
        <span>Input</span>
        <pre>{serialize(part.input)}</pre>
        {part.state === "output-available" ? (
          <>
            <span>Output</span>
            <pre>{serialize(part.output)}</pre>
          </>
        ) : null}
        {failed ? (
          <pre className="work-error-output">{part.errorText}</pre>
        ) : null}
      </div>
    </details>
  );
}

function WorkDisclosure({
  parts,
}: {
  readonly parts: ReadonlyArray<WorkPart>;
}) {
  const running = workIsRunning(parts);
  const failed = workHasFailed(parts);
  const duration = formatWorkDuration(parts);
  const label = running
    ? "Working…"
    : failed
      ? "Work failed"
      : duration
        ? `Worked for ${duration}`
        : "Show Work";

  return (
    <details
      className={`work-disclosure ${failed ? "work-disclosure-failed" : ""}`}
      open={running || failed || undefined}
    >
      <summary>
        {running ? <LoaderCircle className="spin" /> : <ChevronRight />}
        <span>{label}</span>
      </summary>
      <div className="work-content">
        {keyedParts(parts).map(({ key, part }) => {
          if (part.type === "reasoning") {
            if (!part.text.trim()) return null;
            return (
              <div className="work-reasoning" key={key}>
                <span>Reasoning</span>
                <TranscriptMarkdown>{part.text}</TranscriptMarkdown>
              </div>
            );
          }
          if (part.type === "dynamic-tool") {
            return <ToolEvent part={part} key={key} />;
          }
          return (
            <details className="work-data" key={key}>
              <summary>{part.type.slice(5).replaceAll("-", " ")}</summary>
              <pre>{serialize(part.data)}</pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}

function FilePart({
  part,
}: {
  readonly part: Extract<FlueConversationPart, { type: "file" }>;
}) {
  return (
    <TranscriptAttachment
      filename={part.filename}
      mediaType={part.mediaType}
      url={part.url}
    />
  );
}

function MessageBody({
  message,
}: {
  readonly message: FlueConversationMessage;
}) {
  const workParts = message.parts.filter(
    (part): part is WorkPart => part.type !== "text" && part.type !== "file",
  );
  const visibleParts = message.parts.filter(
    (part): part is Extract<FlueConversationPart, { type: "text" | "file" }> =>
      part.type === "text" || part.type === "file",
  );

  return (
    <>
      {workParts.length > 0 ? <WorkDisclosure parts={workParts} /> : null}
      {keyedParts(visibleParts).map(({ key, part }) =>
        part.type === "text" ? (
          <div className="message-text" key={key}>
            <TranscriptMarkdown>{part.text}</TranscriptMarkdown>
          </div>
        ) : (
          <FilePart part={part} key={key} />
        ),
      )}
    </>
  );
}

function SettlementMessage({
  message,
}: {
  readonly message: FlueConversationMessage;
}) {
  const failed = message.settlement?.outcome === "failed";
  const text = message.parts.find((part) => part.type === "text");
  return (
    <div
      className={`turn-settlement ${failed ? "turn-failed" : "turn-aborted"}`}
    >
      {failed ? <AlertCircle /> : <SquareTerminal />}
      <span>
        <strong>
          {failed ? "Agent stopped with an error" : "Agent stopped"}
        </strong>
        {text?.text}
      </span>
    </div>
  );
}

export function TranscriptRowContent({ row }: { readonly row: TranscriptRow }) {
  if (
    row.kind === "user-prompt" ||
    row.kind === "assistant-prose" ||
    row.kind === "final-answer"
  ) {
    return (
      <div className="message-text">
        <TranscriptMarkdown>{row.text}</TranscriptMarkdown>
      </div>
    );
  }
  if (row.kind === "attachment") return <FilePart part={row.attachment} />;
  if (row.kind === "failure") {
    const failed = row.outcome === "failed";
    return (
      <div
        className={`turn-settlement ${failed ? "turn-failed" : "turn-aborted"}`}
      >
        {failed ? <AlertCircle /> : <SquareTerminal />}
        <span>
          <strong>
            {failed ? "Agent stopped with an error" : "Agent aborted"}
          </strong>
          {row.detail}
        </span>
      </div>
    );
  }
  if (!("part" in row)) return null;
  if (row.part.type === "dynamic-tool") return <ToolEvent part={row.part} />;
  if (row.part.type === "reasoning") {
    return (
      <div className="work-reasoning">
        <span>Reasoning</span>
        <TranscriptMarkdown>{row.part.text}</TranscriptMarkdown>
      </div>
    );
  }
  return (
    <details className="work-data">
      <summary>{row.part.type.slice(5).replaceAll("-", " ")}</summary>
      <pre>{serialize(row.part.data)}</pre>
    </details>
  );
}

function ConversationMessage({
  failedSend,
  message,
  onRetry,
}: {
  readonly failedSend?: FailedSend;
  readonly message: FlueConversationMessage;
  readonly onRetry: (failedSend: FailedSend) => void;
}) {
  if (message.settlement !== undefined) {
    return <SettlementMessage message={message} />;
  }
  if (message.display !== "visible") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;

  const user = message.role === "user";
  const timestamp = messageTimestamp(message);
  return (
    <article
      className={`conversation-message ${user ? "user-message" : "agent-message"}`}
    >
      {timestamp ? (
        <time dateTime={String(message.metadata?.timestamp)}>{timestamp}</time>
      ) : null}
      <div className="message-content">
        <MessageBody message={message} />
      </div>
      {failedSend ? (
        <div className="failed-send">
          <AlertCircle />
          <span>{failedSend.error.message}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onRetry(failedSend)}
          >
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : null}
    </article>
  );
}
