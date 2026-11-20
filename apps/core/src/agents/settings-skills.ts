import { isSafeSkillFilePath } from "@dx/domain";
import { defineSkill } from "@flue/runtime";
import { builtInSkillsLogger } from "../logging.js";
import { readThreadSkillResources } from "../settings/skills/execution.js";
import {
  SKILL_FILE_TOOL,
  spaceSkillFilesNote,
} from "../settings/skills/skill-file-tool.js";
import { RESERVED_SKILL_NAMES } from "./built-in-skill-names.js";
import {
  installSkillFiles,
  type SkillFile,
  type SkillInstallTarget,
  sha256,
} from "./built-in-skills.js";

/**
 * A Thread's personal and workspace skills, from its skill snapshot. In a
 * Thread with an Orb each is a skill directory in `~/.agents/skills`,
 * written from storage before Flue discovers skills, SKILL.md included:
 * the dx agent's catalog lists its name and description, and activating it
 * reads its SKILL.md then; Claude Code mode links it into `~/.claude/skills`.
 * So a skill's size costs nothing until it is used. dx's own skills and the
 * repository's win a shared name. A Space has no Orb: its dx agent mounts
 * each with `useSkill`, pointing at `read_skill_file`.
 */

interface SettingsSkill {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly integrity: string;
  readonly description: string;
  readonly resources: ReadonlyArray<{ readonly path: string }>;
}

// The installer writes these as paths, so anything else is skipped. A skill
// imported from a plugin keeps its folder's layout (`references/`,
// `scripts/`), so a resource may sit anywhere under the skill but never
// replace its SKILL.md, start a segment with a dot, or climb out.
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const safeResourcePath = (path: string) =>
  path !== "SKILL.md" && isSafeSkillFilePath(path);

const installable = (skills: ReadonlyArray<SettingsSkill>) =>
  skills.filter(({ name }) => safeName.test(name));

// Flue rejects a blank description, which would fail the Thread.
const descriptionOf = (skill: SettingsSkill) =>
  skill.description.trim() || skill.name;

/**
 * Flue definitions for a Space's dx agent, which has no Orb: each says to
 * read the skill's SKILL.md with `read_skill_file`. Skills named like one of
 * dx's own are left out.
 */
export const spaceSkillDefinitions = (skills: ReadonlyArray<SettingsSkill>) =>
  installable(skills)
    .filter(({ name }) => !RESERVED_SKILL_NAMES.has(name))
    .map((skill) =>
      defineSkill({
        name: skill.name,
        description: descriptionOf(skill),
        instructions: `${spaceSkillFilesNote(skill)}Read this skill's instructions now: call ${SKILL_FILE_TOOL} with skill "${skill.name}" and path "SKILL.md", then follow them.`,
      }),
    );

const skillMarkdown = (
  skill: SettingsSkill,
  instructions: string,
  where: "orb" | "space",
) =>
  `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(descriptionOf(skill))}\n---\n\n${where === "space" ? spaceSkillFilesNote(skill) : ""}${instructions}\n`;

const skillFiles = async (
  threadId: string,
  skills: ReadonlyArray<SettingsSkill>,
  where: "orb" | "space",
) => {
  let complete = true;
  const files: ReadonlyArray<SkillFile> = (
    await Promise.all(
      skills.map(async (skill) => {
        const stored = await readThreadSkillResources(
          threadId,
          skill.id,
          skill.version,
        );
        if (stored === undefined) {
          // Without its SKILL.md the skill cannot be used; the next turn
          // tries again.
          complete = false;
          builtInSkillsLogger.error("A settings skill could not be read.", {
            skillId: skill.id,
            version: skill.version,
          });
          return [];
        }
        const resources = skill.resources.map(({ path }) => {
          if (!safeResourcePath(path)) return [];
          const content = stored.files.get(path);
          if (content !== undefined)
            return [{ path: `${skill.name}/${path}`, content }];
          complete = false;
          builtInSkillsLogger.error(
            "A settings skill resource could not be read.",
            { skillId: skill.id, version: skill.version, path },
          );
          return [];
        });
        return [
          {
            path: `${skill.name}/SKILL.md`,
            content: skillMarkdown(skill, stored.instructions, where),
          },
          ...resources.flat(),
        ];
      }),
    )
  ).flat();
  return { files, complete };
};

/**
 * Writes the Thread's settings skills into `~/.agents/skills` unless the copy
 * there is already these versions, leaving out any named like one of dx's
 * own skills or one in `taken` (such as a repository plugin's), which win.
 * A failure is logged, not thrown: the Thread runs without those skills.
 */
export const installSettingsSkills = async (
  target: SkillInstallTarget,
  threadId: string,
  skills: ReadonlyArray<SettingsSkill>,
  /** A Space's Claude Code reads files with `read_skill_file`, not from disk. */
  where: "orb" | "space" = "orb",
  taken: ReadonlySet<string> = new Set(),
) => {
  const included = installable(skills).filter(
    ({ name }) => !RESERVED_SKILL_NAMES.has(name) && !taken.has(name),
  );
  try {
    await installSkillFiles(
      target,
      "settings",
      await sha256(
        JSON.stringify([
          where,
          ...included.map(({ name, id, version, integrity }) => [
            name,
            id,
            version,
            integrity,
          ]),
        ]),
      ),
      () => skillFiles(threadId, included, where),
      // A built-in skill may take a name a settings skill had.
      [...RESERVED_SKILL_NAMES],
    );
  } catch (error) {
    builtInSkillsLogger.error("Settings skills could not be installed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
