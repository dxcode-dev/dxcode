import type { FlueConversationPart } from "@flue/react";
import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";
import { AgentMentions, UserMessageText } from "./sharing/message-authors.js";
import { presentTool } from "./tool-presentation.js";
import {
  TranscriptAttachment,
  TranscriptMarkdown,
} from "./transcript-markdown.js";
import type { TranscriptRow } from "./transcript-view-model.js";

type ToolPart = Extract<FlueConversationPart, { type: "dynamic-tool" }>;

const serialize = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

export function TranscriptRowContent({ row }: { readonly row: TranscriptRow }) {
  // People write plain text; only the agent's replies are Markdown.
  if (row.kind === "user-prompt")
    return <UserMessageText text={row.text} mentions={row.mentions} />;
  if (row.kind === "assistant-prose" || row.kind === "final-answer") {
    return (
      <div className="message-text">
        <AgentMentions>
          <TranscriptMarkdown
            streaming={row.kind === "assistant-prose" && row.streaming}
          >
            {row.text}
          </TranscriptMarkdown>
        </AgentMentions>
      </div>
    );
  }
  if (row.kind === "attachment") return <FilePart part={row.attachment} />;
  if (!("part" in row)) return null;
  if (row.part.type === "dynamic-tool") return <ToolEvent part={row.part} />;
  if (row.part.type === "reasoning") {
    return (
      <div className="work-reasoning">
        <span>Reasoning</span>
        <TranscriptMarkdown streaming={row.part.state === "streaming"}>
          {row.part.text}
        </TranscriptMarkdown>
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
