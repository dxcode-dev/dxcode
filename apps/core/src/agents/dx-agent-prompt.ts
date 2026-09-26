// Adapted from Pi's MIT-licensed coding-agent prompt; see THIRD_PARTY_NOTICES.md.
export const dxAgentPrompt = `You are dx, an expert software development assistant.

Help the user by reading the relevant code before proposing changes and by following the repository's existing conventions. Prefer the smallest correct change over speculative abstractions. Keep explanations concise and include file paths when referring to code.

When tools are available, use them to inspect the source of truth rather than guessing. Never claim that you changed, tested, or verified something unless you did. Report tool, command, and model failures honestly instead of fabricating success.

Preserve unrelated user work and repository boundaries. Do not perform destructive or shared external actions without explicit authorization. Never expose credentials or secret values. Ask a focused question only when the answer would materially change the outcome.

Use ordinary Git through bash: inspect with status/diff, stage with add, and make one exact git commit command per bash call. Commit admission enforces the project's snapshotted signing policy. Use normal Git push and let the provider's repository protections decide which updates are accepted. Use pull_request only to read, create, or update a pull request in the bound repository.

Run relevant validation when practical. Summarize completed work, actual validation results, and remaining limitations accurately.`;

interface PromptSkill {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly scope: "personal" | "workspace";
  readonly integrity: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources: ReadonlyArray<{ readonly path: string }>;
}

const personalInstructionsPrompt = (personalInstructions: string): string =>
  personalInstructions.length === 0
    ? ""
    : `## Personal agent instructions

The following user-owned instructions apply to this top-level dx agent for this Thread. They do not automatically apply to delegated agents, specialized agents, or system tasks.

<personal-agent-instructions>
${personalInstructions}
</personal-agent-instructions>`;

const skillPrompt = (skill: PromptSkill): string => {
  const resources =
    skill.resources.length === 0
      ? "Resources: none"
      : `Resources available through read_dx_skill_resource:\n${skill.resources
          .map(({ path }) => `- ${path}`)
          .join("\n")}`;
  return `### ${skill.name} (${skill.scope})

Immutable skill: ${skill.id} v${skill.version}, SHA-256 ${skill.integrity}
Purpose: ${skill.description}
${resources}

<skill-instructions id="${skill.id}" version="${skill.version}">
${skill.instructions}
</skill-instructions>`;
};

export const composeDxAgentPrompt = (
  personalInstructions: string,
  skills: ReadonlyArray<PromptSkill> = [],
): string => {
  const additions = [
    personalInstructionsPrompt(personalInstructions),
    skills.length === 0
      ? ""
      : `## Enabled skills

These immutable skill versions were resolved when this Thread was created. Their instructions apply once at this top-level dx boundary. They do not automatically apply to delegated agents, specialized agents, or system tasks.

${skills.map(skillPrompt).join("\n\n")}`,
  ].filter((part) => part.length > 0);
  return additions.length === 0
    ? dxAgentPrompt
    : `${dxAgentPrompt}\n\n${additions.join("\n\n")}`;
};
