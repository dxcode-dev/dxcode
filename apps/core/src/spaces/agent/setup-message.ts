import type { SpacePromptProject } from "./system-prompt.js";

/** What the setup message tells a new Space's main thread. */
export interface SpaceSetupMessageInput {
  readonly spaceName: string;
  readonly project: SpacePromptProject | null;
  /** The creator's display name. */
  readonly creatorName: string;
}

/**
 * The hidden first message of a new Space: it asks the Space's agent to post
 * a short welcome. People never see this message, only the welcome post.
 * The goal is in the system prompt's Space Goal section, so the message
 * points there instead of repeating it.
 */
export const buildSpaceSetupMessage = (
  input: SpaceSetupMessageInput,
): string => {
  const name = JSON.stringify(input.spaceName);
  const creator = input.creatorName;
  const created =
    input.project === null
      ? `${creator} has just made a new Space called ${name}, with no Project.`
      : `${creator} has just made a new Space called ${name} in the dx Project ${JSON.stringify(input.project.name)}.`;
  const repositories =
    input.project === null || input.project.repositories.length === 0
      ? ""
      : `\n\nProject repositories:\n${input.project.repositories.map((url) => `- ${url}`).join("\n")}`;
  const naming = input.project === null ? "" : ", naming the Project";
  const leaveOut =
    input.project === null
      ? "tasks unrelated to the goal, an explanation of your role, and narration of what you are doing"
      : "tasks unrelated to the goal, a list of the Project's contents, an explanation of your role, and narration of what you are doing";
  return `${created} Only you see this message.${repositories}

Write a single welcome post of two or three plain sentences. Say hello to ${creator} and welcome them to the ${name} Space${naming}, and restate the Space goal from your instructions, keeping its exact wording. If the Space has no goal yet, ask what it should work toward instead. Suggest a first step toward the goal only if one or two quick lookups reveal something concrete; if not, ask where they would like to begin. Leave out ${leaveOut}. ${name} names the Space, not you; you are dx. After posting, wait for ${creator} to write.

If they answer the welcome with a greeting, react to it with \`wave\` rather than greeting them a second time.`;
};
