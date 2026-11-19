import { defineTool, type ToolDefinition } from "@flue/runtime";
import { Effect, Result } from "effect";
import * as v from "valibot";
import type { ThreadToolsContext } from "../../threads/agent-tools.js";
import { readSkillResources } from "./execution.js";

/**
 * `read_skill_file`: a Space's agent has no Orb, so its skills' files are
 * not on any disk it can read. This reads one from the Thread's skill
 * snapshot, checked against its integrity, in both dx and Claude Code mode
 * (through the dx tool bridge). Scripts can be read, not run.
 */

export interface SkillFileToolSkill {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly resources: ReadonlyArray<{ readonly path: string }>;
}

export const SKILL_FILE_TOOL = "read_skill_file";

/** The line a Space skill's instructions start with: its files and the tool. */
export const spaceSkillFilesNote = (skill: SkillFileToolSkill) => {
  if (skill.resources.length === 0) return "";
  const listed = skill.resources.slice(0, 60).map(({ path }) => path);
  const more =
    skill.resources.length > listed.length
      ? ` and ${skill.resources.length - listed.length} more`
      : "";
  return `This skill's files are not on a disk here. Read one with ${SKILL_FILE_TOOL} (skill: "${skill.name}", path). Scripts cannot run in a Space; to run one, start a Thread. Files: ${listed.join(", ")}${more}.\n\n`;
};

const MAX_LINES = 2_000;

export const createSkillFileTool = (
  threadId: string,
  getContext: () => ThreadToolsContext,
  skills: ReadonlyArray<SkillFileToolSkill>,
): ToolDefinition =>
  defineTool({
    name: SKILL_FILE_TOOL,
    description: `Read one of your skills' files: SKILL.md for its instructions, or a script or reference they name. Returns up to ${MAX_LINES.toLocaleString("en-US")} lines; pass offset to read on.`,
    input: v.object({
      skill: v.pipe(v.string(), v.description("The skill's name.")),
      path: v.pipe(
        v.string(),
        v.description(
          "The file's path in the skill's folder: SKILL.md, or one such as scripts/fill.py.",
        ),
      ),
      offset: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description("The line to start at, from 1."),
        ),
      ),
    }),
    run: async ({ data }) => {
      const skill = skills.find(({ name }) => name === data.skill);
      if (skill === undefined)
        throw new Error(
          `You have no skill named ${data.skill}. Your skills: ${skills.map(({ name }) => name).join(", ") || "none"}.`,
        );
      const instructions = data.path === "SKILL.md";
      if (
        !instructions &&
        !skill.resources.some(({ path }) => path === data.path)
      )
        throw new Error(
          `${data.skill} has no file ${data.path}. Its files: SKILL.md, ${skill.resources
            .slice(0, 60)
            .map(({ path }) => path)
            .join(", ")}.`,
        );
      const result = await Effect.runPromise(
        Effect.result(
          readSkillResources(
            getContext().bindings,
            threadId,
            skill.id,
            skill.version,
            instructions ? [] : [data.path],
          ),
        ),
      );
      const file = !Result.isSuccess(result)
        ? undefined
        : instructions
          ? { path: "SKILL.md", content: result.success.instructions }
          : result.success.files[0];
      if (file === undefined)
        throw new Error(`${data.path} could not be read. Try again.`);
      const lines = file.content.split("\n");
      const start = (data.offset ?? 1) - 1;
      const shown = lines.slice(start, start + MAX_LINES);
      return {
        output: {
          path: file.path,
          lines: lines.length,
          from: start + 1,
          to: start + shown.length,
          content: shown.join("\n"),
        },
      };
    },
  });
