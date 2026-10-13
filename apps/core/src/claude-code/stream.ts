import type { ClaudePlanReading } from "@dx/domain";
import { claudePlanReadingFromEvent } from "./plan.js";

/**
 * Reads the Claude Code CLI's `--output-format stream-json` events and
 * projects them onto Flue's agent loop. Flue sees one assistant message per
 * *segment*: every top-level Claude response up to and including the first
 * one that calls tools, or up to the run's `result`. Claude runs the tools
 * itself; their results arrive as `tool_result` events that the mirror
 * tools in `tools.ts` hand back to Flue. Subagent traffic
 * (`parent_tool_use_id` set) stays inside Claude's Task result.
 */

/** Written by the runner after the last line of each full chunk file. */
export const CHUNK_END_LINE = '{"type":"dx_chunk_end"}';

/**
 * Workspace reads replace each secret value with one NUL byte, which JSON
 * forbids. Inside a string it becomes an escaped NUL, the redaction marker
 * dx shows everywhere; anywhere else it becomes `null`.
 */
const withJsonSafeRedactions = (line: string) => {
  if (!line.includes("\0")) return line;
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of line) {
    if (character === "\0") {
      output += inString ? "\\u0000" : "null";
      escaped = false;
      continue;
    }
    output += character;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = inString;
    else if (character === '"') inString = !inString;
  }
  return output;
};

export type ClaudeCodeBlock =
  | { readonly type: "text"; text: string }
  | { readonly type: "thinking"; thinking: string; signature?: string }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      json: string;
      input?: Record<string, unknown>;
      complete: boolean;
    };

export interface ClaudeCodeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ClaudeCodeSegment {
  readonly blocks: ClaudeCodeBlock[];
  readonly usage: ClaudeCodeUsage;
  /** `toolUse`: Claude is running tools; `stop`: the run ended. */
  stopReason: "toolUse" | "stop" | "error" | undefined;
  errorMessage?: string;
}

/** What Claude Code reports for a finished subagent (Agent or Task). */
export interface ClaudeCodeSubagentResult {
  readonly status: string;
  readonly agentType: string;
  /** The subagent's final report, without Claude Code's hand-back note. */
  readonly report: string;
  readonly model?: string;
  readonly durationMs?: number;
}

export interface ClaudeCodeToolResult {
  readonly text: string;
  readonly isError: boolean;
  readonly subagent?: ClaudeCodeSubagentResult;
}

/** One step of a subagent's own conversation. */
export type ClaudeCodeSubagentStep =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    };

/** A subagent keeps at most this many steps, each output this long. */
const SUBAGENT_MAX_STEPS = 200;
const SUBAGENT_MAX_OUTPUT = 4_000;

export interface ClaudeCodeRunResult {
  readonly isError: boolean;
  readonly text: string;
}

const emptyUsage = (): ClaudeCodeUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const emptySegment = (): ClaudeCodeSegment => ({
  blocks: [],
  usage: emptyUsage(),
  stopReason: undefined,
});

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const text = (value: unknown) => (typeof value === "string" ? value : "");

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Tool result content is a string or Anthropic content blocks. */
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = record(block);
      if (item?.type === "text") return text(item.text);
      if (item?.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
};

const subagentResult = (
  value: unknown,
): ClaudeCodeSubagentResult | undefined => {
  const result = record(value);
  if (result === undefined || typeof result.agentType !== "string")
    return undefined;
  return {
    status: text(result.status) || "completed",
    agentType: result.agentType,
    report: toolResultText(result.content),
    ...(typeof result.resolvedModel === "string"
      ? { model: result.resolvedModel }
      : {}),
    ...(typeof result.totalDurationMs === "number"
      ? { durationMs: result.totalDurationMs }
      : {}),
  };
};

const parseToolInput = (json: string): Record<string, unknown> => {
  if (json.trim() === "") return {};
  try {
    return record(JSON.parse(json)) ?? {};
  } catch {
    return {};
  }
};

export class ClaudeCodeStream {
  sessionId: string | undefined;
  readonly segments: ClaudeCodeSegment[] = [emptySegment()];
  readonly toolResults = new Map<string, ClaudeCodeToolResult>();
  /** Each subagent's steps, by the tool_use id of the call that started it. */
  readonly subagents = new Map<string, ClaudeCodeSubagentStep[]>();
  result: ClaudeCodeRunResult | undefined;
  /** The plan's limits from the latest `rate_limit_event`. */
  planReading: ClaudePlanReading | undefined;
  /** When dx read `planReading` (epoch seconds). */
  planReadingAt = 0;
  /** Blocks of the response being streamed, by Anthropic block index. */
  #response = new Map<number, ClaudeCodeBlock>();
  #responseCallsTools = false;
  #responseUsage = emptyUsage();
  /** A streamed response that has started and not reached message_stop. */
  #responseOpen = false;
  /** Responses that streamed; their complete messages add nothing. */
  readonly #streamedIds = new Set<string>();
  /** A response that arrived only as a complete message calls tools. */
  #fallbackCallsTools = false;

  /** The segment receiving content; complete ones are never reopened. */
  get #current(): ClaudeCodeSegment {
    const segment = this.segments.at(-1);
    if (segment === undefined) throw new Error("No Claude Code segment.");
    return segment;
  }

  get finished() {
    return this.result !== undefined;
  }

  /** Feeds one NDJSON line; malformed lines are skipped. */
  push(line: string) {
    if (line.trim() === "") return;
    let event: Json | undefined;
    try {
      event = record(JSON.parse(withJsonSafeRedactions(line)));
    } catch {
      return;
    }
    if (event === undefined) return;
    switch (event.type) {
      case "system":
        if (event.subtype === "init" && typeof event.session_id === "string")
          this.sessionId = event.session_id;
        return;
      case "stream_event":
        if (event.parent_tool_use_id == null)
          this.#streamEvent(record(event.event));
        return;
      case "assistant":
        if (typeof event.parent_tool_use_id === "string")
          this.#subagentMessage(
            event.parent_tool_use_id,
            record(event.message)?.content,
            "assistant",
          );
        else this.#completeMessage(record(event.message));
        return;
      case "user":
        if (event.parent_tool_use_id == null) this.#closeFallback();
        if (typeof event.parent_tool_use_id === "string")
          this.#subagentMessage(
            event.parent_tool_use_id,
            record(event.message)?.content,
            "user",
          );
        else
          this.#toolResults(
            record(event.message)?.content,
            subagentResult(event.tool_use_result),
          );
        return;
      case "result":
        this.#closeFallback();
        this.#finish(event);
        return;
      case "rate_limit_event": {
        const reading = claudePlanReadingFromEvent(event.rate_limit_info);
        if (reading === undefined) return;
        this.planReading = reading;
        this.planReadingAt = Math.floor(Date.now() / 1000);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Claude Code falls back to a non-streaming request when streaming fails;
   * that response arrives only as complete assistant messages, one or more
   * per response, and its tool calls end the segment once Claude runs them.
   */
  #completeMessage(message: Json | undefined) {
    if (message === undefined || this.finished) return;
    const id = text(message.id);
    if (id === "" || this.#streamedIds.has(id)) return;
    if (!Array.isArray(message.content)) return;
    const segment = this.#current;
    for (const value of message.content) {
      const block = record(value);
      if (block?.type === "text" && text(block.text) !== "")
        segment.blocks.push({ type: "text", text: text(block.text) });
      else if (block?.type === "thinking")
        segment.blocks.push({
          type: "thinking",
          thinking: text(block.thinking),
          ...(typeof block.signature === "string"
            ? { signature: block.signature }
            : {}),
        });
      else if (block?.type === "tool_use" && typeof block.id === "string") {
        const input = record(block.input) ?? {};
        segment.blocks.push({
          type: "toolCall",
          id: block.id,
          name: text(block.name),
          json: JSON.stringify(input),
          input,
          complete: true,
        });
        this.#fallbackCallsTools = true;
      }
    }
  }

  #closeFallback() {
    if (!this.#fallbackCallsTools) return;
    this.#fallbackCallsTools = false;
    this.#current.stopReason = "toolUse";
    this.segments.push(emptySegment());
  }

  #streamEvent(event: Json | undefined) {
    if (event === undefined || this.finished) return;
    const index = count(event.index);
    switch (event.type) {
      case "message_start": {
        this.#closeFallback();
        // A response that never reached message_stop failed mid-stream and
        // is being retried: its partial blocks are not part of the turn.
        if (this.#responseOpen) {
          const partial = new Set(this.#response.values());
          const blocks = this.#current.blocks;
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            if (block !== undefined && partial.has(block))
              blocks.splice(index, 1);
          }
        }
        this.#responseOpen = true;
        const id = text(record(event.message)?.id);
        if (id !== "") this.#streamedIds.add(id);
        this.#response = new Map();
        this.#responseCallsTools = false;
        const usage = record(record(event.message)?.usage);
        this.#responseUsage = {
          input: count(usage?.input_tokens),
          output: count(usage?.output_tokens),
          cacheRead: count(usage?.cache_read_input_tokens),
          cacheWrite: count(usage?.cache_creation_input_tokens),
        };
        return;
      }
      case "content_block_start": {
        const block = record(event.content_block);
        let next: ClaudeCodeBlock | undefined;
        if (block?.type === "text") next = { type: "text", text: "" };
        else if (block?.type === "thinking")
          next = { type: "thinking", thinking: "" };
        else if (block?.type === "tool_use") {
          next = {
            type: "toolCall",
            id: text(block.id),
            name: text(block.name),
            json: "",
            complete: false,
          };
          this.#responseCallsTools = true;
        }
        if (next === undefined) return;
        this.#response.set(index, next);
        this.#current.blocks.push(next);
        return;
      }
      case "content_block_delta": {
        const block = this.#response.get(index);
        const delta = record(event.delta);
        if (block === undefined || delta === undefined) return;
        if (block.type === "text" && delta.type === "text_delta")
          block.text += text(delta.text);
        else if (block.type === "thinking" && delta.type === "thinking_delta")
          block.thinking += text(delta.thinking);
        else if (block.type === "thinking" && delta.type === "signature_delta")
          block.signature = (block.signature ?? "") + text(delta.signature);
        else if (block.type === "toolCall" && delta.type === "input_json_delta")
          block.json += text(delta.partial_json);
        return;
      }
      case "content_block_stop": {
        const block = this.#response.get(index);
        if (block?.type === "toolCall") {
          block.input = parseToolInput(block.json);
          block.complete = true;
        }
        return;
      }
      case "message_delta": {
        const usage = record(event.usage);
        if (usage !== undefined)
          this.#responseUsage.output = count(usage.output_tokens);
        return;
      }
      case "message_stop": {
        const segment = this.#current;
        segment.usage.input += this.#responseUsage.input;
        segment.usage.output += this.#responseUsage.output;
        segment.usage.cacheRead += this.#responseUsage.cacheRead;
        segment.usage.cacheWrite += this.#responseUsage.cacheWrite;
        this.#responseUsage = emptyUsage();
        for (const block of this.#response.values())
          if (block.type === "toolCall" && !block.complete) {
            block.input = parseToolInput(block.json);
            block.complete = true;
          }
        this.#responseOpen = false;
        if (this.#responseCallsTools) {
          segment.stopReason = "toolUse";
          this.segments.push(emptySegment());
        }
        this.#response = new Map();
        return;
      }
      default:
        return;
    }
  }

  #toolResults(content: unknown, subagent?: ClaudeCodeSubagentResult) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const item = record(block);
      if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string")
        continue;
      this.toolResults.set(item.tool_use_id, {
        text: toolResultText(item.content),
        isError: item.is_error === true,
        ...(subagent === undefined ? {} : { subagent }),
      });
    }
  }

  /**
   * A subagent's complete messages arrive tagged with the call that started
   * it: its prompt, its text, its tool calls, and their results.
   */
  #subagentMessage(
    parent: string,
    content: unknown,
    role: "assistant" | "user",
  ) {
    if (!Array.isArray(content)) return;
    let steps = this.subagents.get(parent);
    if (steps === undefined) {
      steps = [];
      this.subagents.set(parent, steps);
    }
    for (const block of content) {
      const item = record(block);
      if (
        item?.type === "tool_result" &&
        typeof item.tool_use_id === "string"
      ) {
        const call = steps.find(
          (step) => step.type === "tool" && step.id === item.tool_use_id,
        );
        if (call?.type === "tool") {
          call.output = toolResultText(item.content).slice(
            0,
            SUBAGENT_MAX_OUTPUT,
          );
          call.isError = item.is_error === true;
        }
        continue;
      }
      if (steps.length >= SUBAGENT_MAX_STEPS) continue;
      if (item?.type === "tool_use" && typeof item.id === "string")
        steps.push({
          type: "tool",
          id: item.id,
          name: text(item.name),
          input: record(item.input) ?? {},
        });
      // The first user message is the prompt, which the call's input holds.
      else if (
        role === "assistant" &&
        item?.type === "text" &&
        text(item.text).trim() !== ""
      )
        steps.push({ type: "text", text: text(item.text) });
    }
  }

  #finish(event: Json) {
    const isError = event.is_error === true || event.subtype !== "success";
    const message =
      text(event.result) ||
      (Array.isArray(event.errors) ? event.errors.map(text).join("\n") : "") ||
      text(event.subtype);
    this.result = { isError, text: message };
    // The result settles whichever segment Flue is waiting on, including
    // one a crashed or interrupted response left open.
    const segment = this.#current;
    segment.stopReason = isError ? "error" : "stop";
    if (isError) segment.errorMessage = message || "Claude Code failed.";
  }
}
