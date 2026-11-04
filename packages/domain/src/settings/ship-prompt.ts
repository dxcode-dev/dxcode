import type { ProjectConfiguration } from "./project-defaults.js";

/**
 * The prompt the Changes pane's main action sends, as if the person typed
 * it. `baseBranch` is the branch the Thread's checkout started from; without
 * one the prompt names the repository's default branch.
 */
export const builtInShipPrompt = (
  action: "ship" | "push",
  baseBranch?: string,
) => {
  const base =
    baseBranch === undefined ? "the base branch" : `\`${baseBranch}\``;
  const upstream =
    baseBranch === undefined
      ? "origin's default branch"
      : `\`origin/${baseBranch}\``;
  if (action === "push")
    return [
      "Push this Thread's changes to a feature branch:",
      "",
      "1. Commit any uncommitted changes.",
      `2. If the current branch is ${base}, first create a branch with a short descriptive name.`,
      "3. Push the branch to origin.",
      "4. If the repository is on GitHub, report the URL that opens a pull request for the branch.",
      "",
      `Do not push to ${base} and do not merge.`,
    ].join("\n");
  return [
    `Ship this Thread's changes to ${base}:`,
    "",
    "1. Commit any uncommitted changes.",
    `2. Fetch origin and rebase onto ${upstream}.`,
    "3. Run the full test suite.",
    `4. Push to ${base}.`,
    `5. If the push is rejected because ${base} moved, rebase again, resolve conflicts, and push.`,
    "",
    `If a rebase produces a substantive conflict, resolve it and check with me before continuing. Ignore a failing test only after confirming it also fails on ${base} without these changes. Report the commit you pushed.`,
  ].join("\n");
};

/** What the project's Ship Behavior sends from a Thread on `baseBranch`. */
export const shipPromptFor = (
  configuration: Pick<ProjectConfiguration, "shipAction" | "shipPrompt">,
  baseBranch?: string,
) =>
  configuration.shipAction === "custom" &&
  configuration.shipPrompt !== undefined
    ? configuration.shipPrompt
    : builtInShipPrompt(
        configuration.shipAction === "push" ? "push" : "ship",
        baseBranch,
      );
