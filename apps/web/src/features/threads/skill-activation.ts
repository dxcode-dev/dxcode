import type { ToolPart } from "./transcript-activity-projection.js";

/**
 * How a skill activation ended: `unavailable` when the agent's skill catalog
 * has no skill of that name, `failed` when the call itself errored.
 */
export type SkillActivationState =
  | "running"
  | "loaded"
  | "unavailable"
  | "failed";

export interface SkillActivation {
  readonly name: string;
  readonly state: SkillActivationState;
}

/**
 * The tools that load a skill: Flue's `activate_skill`, which loads every
 * skill the dx agent mounts (built-in, repository, personal, and workspace),
 * and Claude Code's `Skill`.
 */
export const isSkillActivationTool = (toolName: string) =>
  toolName === "activate_skill" || toolName === "Skill";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const outputText = (output: unknown) => {
  if (typeof output === "string") return output;
  const content = record(output)?.content;
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text = record(block)?.text;
          return typeof text === "string" ? [text] : [];
        })
        .join("\n")
    : "";
};

export const skillActivation = (part: ToolPart): SkillActivation => {
  const input = record(part.input);
  const field = [input?.name, input?.skill].find(
    (value) => typeof value === "string" && value.length > 0,
  );
  const name = typeof field === "string" ? field : "skill";
  if (part.state === "output-error") return { name, state: "failed" };
  if (part.state !== "output-available") return { name, state: "running" };
  // Flue answers a name outside the catalog with a successful result.
  return /^Skill ".*" is not available\./.test(outputText(part.output).trim())
    ? { name, state: "unavailable" }
    : { name, state: "loaded" };
};

export const skillActivationLabel = ({ name, state }: SkillActivation) =>
  state === "running"
    ? `Activating skill ${name}`
    : state === "loaded"
      ? `Activated skill ${name}`
      : state === "unavailable"
        ? `Skill ${name} not available`
        : `Skill ${name} failed to load`;
