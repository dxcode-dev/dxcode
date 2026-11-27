import { presentableToolPart } from "./claude-code-tools.js";
import type { ToolPart } from "./transcript-activity-projection.js";

export type SubagentStatus = "running" | "finished" | "failed" | "stopped";

/** One step of a subagent's work: prose, or a tool call shown as dx shows it. */
export type SubagentStep =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly part: ToolPart };

/**
 * A subagent as the transcript shows it, whichever agent ran it. Claude
 * Code's Agent and Task calls are the source today; a Flue subagent maps to
 * the same view.
 */
export interface SubagentView {
  readonly id: string;
  /** The subagent's type, such as general-purpose. */
  readonly type: string;
  /** The short task the caller gave it. */
  readonly description: string;
  readonly prompt: string;
  readonly status: SubagentStatus;
  readonly report?: string;
  /** Why a failed or stopped subagent ended. */
  readonly error?: string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly steps: ReadonlyArray<SubagentStep>;
}

/** Claude Code's tools that run a subagent. */
const CLAUDE_CODE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);

export const isSubagentPart = (part: ToolPart) =>
  CLAUDE_CODE_SUBAGENT_TOOLS.has(part.toolName);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A step Claude Code recorded, as a transcript tool part. */
const claudeStep = (
  value: unknown,
  parent: string,
  index: number,
): SubagentStep | undefined => {
  const step = record(value);
  const id = `${parent}:${index}`;
  if (step.type === "text") return { kind: "text", id, text: text(step.text) };
  if (step.type !== "tool") return undefined;
  const base = {
    type: "dynamic-tool" as const,
    toolName: text(step.name),
    toolCallId: text(step.id) || id,
    input: record(step.input),
  };
  const part = (
    step.output === undefined
      ? { ...base, state: "input-available" }
      : step.isError === true
        ? { ...base, state: "output-error", errorText: text(step.output) }
        : { ...base, state: "output-available", output: text(step.output) }
  ) as ToolPart;
  return { kind: "tool", id, part: presentableToolPart(part) };
};

const views = new WeakMap<ToolPart, SubagentView>();

/** The subagent a Claude Code Agent or Task call ran. */
export const subagentView = (part: ToolPart): SubagentView | undefined => {
  if (!isSubagentPart(part)) return undefined;
  const cached = views.get(part);
  if (cached !== undefined) return cached;
  const input = record(part.input);
  // Threads recorded before subagents were captured hold the report alone.
  const output =
    part.state === "output-available"
      ? typeof part.output === "string"
        ? { report: part.output }
        : record(part.output)
      : {};
  const steps = Array.isArray(output.steps)
    ? output.steps.flatMap((step, index) => {
        const mapped = claudeStep(step, part.toolCallId, index);
        return mapped === undefined ? [] : [mapped];
      })
    : [];
  const view: SubagentView = {
    id: part.toolCallId,
    type: text(input.subagent_type) || text(output.agentType) || "agent",
    description: text(input.description),
    prompt: text(input.prompt),
    status:
      part.state === "output-available"
        ? "finished"
        : part.state === "output-error"
          ? // Stop and Flue's abort and interruption repair; a run that
            // ended on its own fails.
            /\b(stopped|aborted|interrupted)\b/i.test(part.errorText ?? "")
            ? "stopped"
            : "failed"
          : "running",
    ...(text(output.report) === "" ? {} : { report: text(output.report) }),
    ...(part.state === "output-error" && text(part.errorText) !== ""
      ? { error: text(part.errorText) }
      : {}),
    ...(text(output.model) === "" ? {} : { model: text(output.model) }),
    ...(typeof output.durationMs === "number"
      ? { durationMs: output.durationMs }
      : {}),
    steps,
  };
  views.set(part, view);
  return view;
};
