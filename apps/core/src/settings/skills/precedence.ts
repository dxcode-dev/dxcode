import { MAX_SKILLS_PER_SCOPE, type SkillWithVersion } from "@dx/domain";

/** A personal and a workspace scope, each full. */
const MAX_THREAD_SKILLS = MAX_SKILLS_PER_SCOPE * 2;

/**
 * The skills a new Thread loads from its candidates (ordered by name, the
 * personal skill first). Each name loads once, so a personal skill replaces
 * the workspace skill with the same name. A candidate `canLoad` rejects
 * leaves its name to the next candidate. A skill's size never keeps it out:
 * the agent reads its SKILL.md only when it uses the skill.
 */
export const threadSkills = (
  candidates: ReadonlyArray<SkillWithVersion>,
  canLoad: (skill: SkillWithVersion) => boolean,
): ReadonlyArray<SkillWithVersion> => {
  const loaded: SkillWithVersion[] = [];
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (
      names.has(candidate.skill.name) ||
      loaded.length >= MAX_THREAD_SKILLS ||
      !canLoad(candidate)
    ) {
      continue;
    }
    names.add(candidate.skill.name);
    loaded.push(candidate);
  }
  return loaded;
};
