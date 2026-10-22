import type { SkillWithVersion } from "@dx/domain";

const MAX_THREAD_SKILLS = 20;
const MAX_THREAD_INSTRUCTION_BYTES = 65_536;

/**
 * The skills a new Thread loads from its candidates (ordered by name, the
 * personal skill first). Each name loads once, so a personal skill replaces
 * the workspace skill with the same name. A candidate that cannot load,
 * because `canLoad` rejects it or it would pass the Thread's skill or
 * instruction limits, leaves its name to the next candidate.
 */
export const threadSkills = (
  candidates: ReadonlyArray<SkillWithVersion>,
  canLoad: (skill: SkillWithVersion) => boolean,
): ReadonlyArray<SkillWithVersion> => {
  const loaded: SkillWithVersion[] = [];
  const names = new Set<string>();
  let instructionBytes = 0;
  for (const candidate of candidates) {
    if (
      names.has(candidate.skill.name) ||
      loaded.length >= MAX_THREAD_SKILLS ||
      !canLoad(candidate)
    ) {
      continue;
    }
    const bytes = new TextEncoder().encode(
      candidate.active.instructions,
    ).byteLength;
    if (instructionBytes + bytes > MAX_THREAD_INSTRUCTION_BYTES) continue;
    instructionBytes += bytes;
    names.add(candidate.skill.name);
    loaded.push(candidate);
  }
  return loaded;
};
