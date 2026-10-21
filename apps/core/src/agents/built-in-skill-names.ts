/** dx's own workspace skill, mounted from `dx-agent-prompt.ts`. */
export const DX_WORKSPACE_SKILL = "dx-workspace";

/** The built-in skills, one directory each under `built-in-skills/`. */
export const BUILT_IN_SKILL_NAMES = [
  "browser-use",
  "building-skills",
  "explaining-code",
  "orb-setup",
  "proving-changes",
  "using-agent-browser",
  "writing-prompts",
] as const;

export type BuiltInSkillName = (typeof BUILT_IN_SKILL_NAMES)[number];

/**
 * Names a repository skill may not reuse: every skill dx mounts itself. Flue
 * fails a Thread whose repository skill shares a mounted skill's name, so
 * workspace discovery drops such a repository skill instead.
 */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  ...BUILT_IN_SKILL_NAMES,
  DX_WORKSPACE_SKILL,
]);
