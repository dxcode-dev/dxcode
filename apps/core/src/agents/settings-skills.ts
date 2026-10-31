import { defineSkill, type Sandbox } from "@flue/runtime";
import { builtInSkillsLogger } from "../logging.js";
import { readThreadSkillResource } from "../settings/skills/execution.js";
import {
  installSkillFiles,
  type SkillFile,
  sha256,
} from "./built-in-skills.js";

/**
 * A Thread's personal and workspace skills, from its skill snapshot. They are
 * installed and offered exactly like dx's built-in skills: each is a skill
 * directory in the workspace, the dx agent mounts it with Flue's `useSkill`,
 * and Claude Code mode links it into `~/.claude/skills`. A settings skill
 * replaces a built-in or repository skill of the same name.
 */
export const SETTINGS_SKILLS_DIRECTORY =
  "/home/user/.local/share/dx/settings-skills";

interface SettingsSkill {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly integrity: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources: ReadonlyArray<{ readonly path: string }>;
}

// The installer writes these as paths, so anything else is skipped. A skill
// imported from a plugin keeps its folder's layout (`references/`,
// `scripts/`), so a resource may sit anywhere under the skill but never
// replace its SKILL.md, start a segment with a dot, or climb out.
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const safeResourcePath =
  /^(?!SKILL\.md$)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

const installable = (skills: ReadonlyArray<SettingsSkill>) =>
  skills.filter(({ name }) => safeName.test(name));

// Flue rejects a blank description, which would fail the Thread.
const descriptionOf = (skill: SettingsSkill) =>
  skill.description.trim() || skill.name;

/** Flue definitions for the dx agent, shaped like `builtInSkillDefinitions`. */
export const settingsSkillDefinitions = (
  skills: ReadonlyArray<SettingsSkill>,
) =>
  installable(skills).map((skill) =>
    defineSkill({
      name: skill.name,
      description: descriptionOf(skill),
      instructions: `This skill's directory is \`${SETTINGS_SKILLS_DIRECTORY}/${skill.name}/\`; resolve relative paths in these instructions from there.\n\n${skill.instructions}`,
    }),
  );

const skillMarkdown = (skill: SettingsSkill) =>
  `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(descriptionOf(skill))}\n---\n\n${skill.instructions}\n`;

const skillFiles = async (
  threadId: string,
  skills: ReadonlyArray<SettingsSkill>,
) => {
  let complete = true;
  const files: ReadonlyArray<SkillFile> = (
    await Promise.all(
      skills.map(async (skill) => {
        const resources = await Promise.all(
          skill.resources.map(async ({ path }) => {
            if (!safeResourcePath.test(path)) return [];
            const content = await readThreadSkillResource(
              threadId,
              skill.id,
              skill.version,
              path,
            );
            if (content !== undefined)
              return [{ path: `${skill.name}/${path}`, content }];
            complete = false;
            builtInSkillsLogger.error(
              "A settings skill resource could not be read.",
              { skillId: skill.id, version: skill.version, path },
            );
            return [];
          }),
        );
        return [
          { path: `${skill.name}/SKILL.md`, content: skillMarkdown(skill) },
          ...resources.flat(),
        ];
      }),
    )
  ).flat();
  return { files, complete };
};

/**
 * Writes the Thread's settings skills into the workspace unless the copy
 * there is already these versions. A failure is logged, not thrown, as for
 * the built-in skills: the instructions still load, only their resource
 * files are missing.
 */
export const installSettingsSkills = async (
  sandbox: Sandbox,
  threadId: string,
  skills: ReadonlyArray<SettingsSkill>,
) => {
  const included = installable(skills);
  try {
    await installSkillFiles(
      sandbox,
      "settings-skills",
      await sha256(
        JSON.stringify(
          included.map(({ name, id, version, integrity }) => [
            name,
            id,
            version,
            integrity,
          ]),
        ),
      ),
      () => skillFiles(threadId, included),
    );
  } catch (error) {
    builtInSkillsLogger.error("Settings skills could not be installed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
