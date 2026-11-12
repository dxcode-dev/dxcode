import {
  isClaudeCodeModel,
  MODE_IDS,
  type ModeId,
  type PluginBundleCode,
  type ThinkingLevel,
  type ThreadModelSelection,
} from "@dx/domain";

/**
 * A plugin agent as dx validates it (`dx.createAgent`): what a Thread
 * running it gets on top of dx's own agent. dx checks every definition it
 * receives from plugin code against the install's grants here, on the way
 * in, whether it came from `agent.run`, a registered mode, or a stored row.
 */

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,23}$/;
export const MAX_AGENT_INSTRUCTIONS = 16_000;
export const MAX_AGENT_DESCRIPTION = 300;
const MAX_AGENT_TOOLS = 128;
const TOOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,95}\*?$/;

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AgentToolSelection {
  /** Absent: every tool. */
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}

export interface PluginAgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools: AgentToolSelection;
  readonly display?: { readonly label: string; readonly color?: string };
}

const isMode = (value: string): value is ModeId =>
  (MODE_IDS as ReadonlyArray<string>).includes(value);

const toolNames = (value: unknown, field: string) => {
  if (!Array.isArray(value) || value.length > MAX_AGENT_TOOLS)
    throw new Error(
      `${field} is a list of at most ${MAX_AGENT_TOOLS} tool names.`,
    );
  for (const name of value)
    if (typeof name !== "string" || !TOOL_PATTERN.test(name))
      throw new Error(
        `${field} lists ${JSON.stringify(name)}, which is not a tool name; end a name with * to match its start.`,
      );
  return [...new Set(value as ReadonlyArray<string>)];
};

const toolSelectionOf = (value: unknown): AgentToolSelection => {
  if (value === undefined || value === "all") return {};
  if (Array.isArray(value)) return { include: toolNames(value, "tools") };
  if (value === null || typeof value !== "object")
    throw new Error(
      'tools is "all", a list of tool names, or { include, exclude }.',
    );
  const { include, exclude, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0)
    throw new Error(
      `tools takes include and exclude, not ${Object.keys(rest).join(", ")}.`,
    );
  return {
    ...(include === undefined || include === "all"
      ? {}
      : { include: toolNames(include, "tools.include") }),
    ...(exclude === undefined
      ? {}
      : { exclude: toolNames(exclude, "tools.exclude") }),
  };
};

/**
 * Whether the install may choose `model`: its manifest lists it in
 * `permissions.models`. A Claude Pro/Max plan model is never a plugin's
 * choice for a one-off model call; an agent may name one, since its Thread
 * then runs Claude Code itself on the owner's plan.
 */
export const modelGranted = (code: PluginBundleCode, model: string) =>
  (code.permissions.models ?? []).includes(model);

/** Reads and checks a definition plugin code sent; throws why it is refused. */
export const pluginAgentDefinitionOf = (
  code: PluginBundleCode,
  value: unknown,
): PluginAgentDefinition => {
  if (value === null || typeof value !== "object")
    throw new Error("An agent definition is an object from dx.createAgent.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !AGENT_NAME.test(raw.name))
    throw new Error(
      "An agent's name is 1 to 24 lowercase letters, digits, and hyphens, starting with a letter.",
    );
  const name = raw.name;
  if (typeof raw.instructions !== "string" || raw.instructions.trim() === "")
    throw new Error(`The agent ${name} needs instructions.`);
  if (raw.instructions.length > MAX_AGENT_INSTRUCTIONS)
    throw new Error(
      `The agent ${name}'s instructions are longer than ${MAX_AGENT_INSTRUCTIONS.toLocaleString("en-US")} characters.`,
    );
  if (
    raw.description !== undefined &&
    (typeof raw.description !== "string" ||
      raw.description.length > MAX_AGENT_DESCRIPTION)
  )
    throw new Error(
      `The agent ${name}'s description is text of at most ${MAX_AGENT_DESCRIPTION} characters.`,
    );
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string")
      throw new Error(`The agent ${name}'s model is text.`);
    if (!modelGranted(code, raw.model))
      throw new Error(
        `The agent ${name} asks for the model ${raw.model}, which the plugin's permissions.models does not list.`,
      );
  }
  if (
    raw.reasoningEffort !== undefined &&
    !(REASONING_EFFORTS as ReadonlyArray<unknown>).includes(raw.reasoningEffort)
  )
    throw new Error(
      `The agent ${name}'s reasoningEffort is one of ${REASONING_EFFORTS.join(", ")}.`,
    );
  let display: PluginAgentDefinition["display"];
  if (raw.display !== undefined) {
    const shown = raw.display as Record<string, unknown> | null;
    if (
      shown === null ||
      typeof shown !== "object" ||
      typeof shown.label !== "string" ||
      shown.label.trim() === "" ||
      shown.label.trim().length > 24 ||
      (shown.color !== undefined &&
        (typeof shown.color !== "string" ||
          !/^#[0-9a-fA-F]{6}$/.test(shown.color)))
    )
      throw new Error(
        `The agent ${name}'s display is { label } of at most 24 characters, with an optional #rrggbb color.`,
      );
    display = {
      label: shown.label.trim(),
      ...(shown.color === undefined ? {} : { color: shown.color as string }),
    };
  }
  return {
    name,
    ...(raw.description === undefined
      ? {}
      : { description: raw.description as string }),
    instructions: raw.instructions.trim(),
    ...(raw.model === undefined ? {} : { model: raw.model as string }),
    ...(raw.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: raw.reasoningEffort as ReasoningEffort }),
    tools: toolSelectionOf(raw.tools),
    ...(display === undefined ? {} : { display }),
  };
};

export const thinkingOf = (effort: ReasoningEffort): ThinkingLevel =>
  effort === "none" ? "off" : effort;

/**
 * The Thread selection a model choice makes: a dx mode keeps the owner's
 * profile, so the owner's own mode settings decide the model; a
 * `provider/model` ID pins that model at the given effort.
 */
export const selectionForModel = (
  model: string,
  effort: ReasoningEffort | undefined,
): ThreadModelSelection =>
  isMode(model)
    ? ({ kind: "mode", profileId: "default", mode: model } as const)
    : ({
        kind: "model",
        model,
        ...(effort === undefined ? {} : { thinking: thinkingOf(effort) }),
      } as ThreadModelSelection);

/** A Thread's selection for the agent, or the caller's when it names none. */
export const agentSelection = (
  definition: PluginAgentDefinition,
  caller: ThreadModelSelection | undefined,
): ThreadModelSelection | undefined =>
  definition.model === undefined
    ? caller
    : selectionForModel(definition.model, definition.reasoningEffort);

export const runsOnClaudePlan = (model: string | undefined) =>
  model !== undefined && isClaudeCodeModel(model);

const matches = (patterns: ReadonlyArray<string>, name: string) =>
  patterns.some((pattern) =>
    pattern.endsWith("*")
      ? name.startsWith(pattern.slice(0, -1))
      : pattern === name,
  );

/** Whether the agent keeps a tool of this name. */
export const agentKeepsTool = (tools: AgentToolSelection, name: string) =>
  (tools.include === undefined || matches(tools.include, name)) &&
  !matches(tools.exclude ?? [], name);

/** The section the agent's Thread adds to dx's system prompt. */
export const agentPromptSection = (agent: {
  readonly definition: PluginAgentDefinition;
  readonly pluginDisplayName: string;
}) => {
  const label = agent.definition.display?.label ?? agent.definition.name;
  return `# You are the ${label} agent\n\nThis Thread runs the ${agent.definition.name} agent from the ${agent.pluginDisplayName} plugin. Its instructions below decide how you work in this Thread; where they differ from dx's instructions above, follow them, except that dx's rules on safety, secrets, and asking the owner still apply.\n\n${agent.definition.instructions}`;
};
