import type { FeedbackWidgetComment } from "@dx/domain";

/** `Website: <host>`, from the first comment's page. */
export const feedbackThreadTitle = (
  comments: ReadonlyArray<FeedbackWidgetComment>,
) =>
  `Website: ${new URL(comments[0]?.pageUrl ?? "https://unknown.invalid").host}`.slice(
    0,
    80,
  );

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Continuation lines of a list item line up under its text. */
const indented = (value: string) =>
  value
    .trim()
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? line : `   ${line}`))
    .join("\n");

/**
 * The first message of a Thread the Feedback Widget starts, as plain text
 * because the Thread shows a person's message as written. The person who
 * sends it wrote each change; the element fields come from their browser.
 */
export const feedbackThreadPrompt = (
  comments: ReadonlyArray<FeedbackWidgetComment>,
) => {
  const origins = [
    ...new Set(comments.map((comment) => new URL(comment.pageUrl).origin)),
  ];
  return [
    `I left ${comments.length === 1 ? "a comment" : `${comments.length} comments`} on ${origins.join(", ")} with the dx Feedback Widget.`,
    "",
    "Make each change in this Project's repository. You have a copy of the repository, not the live site: find the code that renders each element from its page, element, and text, and change it there. When a comment is unclear, say what you assumed.",
    "",
    feedbackItems(comments),
  ].join("\n");
};

/** Each comment as a numbered item with its page, element, and text. */
const feedbackItems = (comments: ReadonlyArray<FeedbackWidgetComment>) =>
  comments
    .map((comment, index) =>
      [
        `${index + 1}. ${indented(comment.comment)}`,
        `   Page: ${comment.pageUrl}`,
        ...(comment.selector === "" && comment.element === ""
          ? []
          : [
              `   Element: ${[
                oneLine(comment.selector),
                oneLine(comment.element),
              ]
                .filter((part) => part !== "")
                .join(" ")}`,
            ]),
        ...(comment.text === "" ? [] : [`   Text: "${oneLine(comment.text)}"`]),
      ].join("\n"),
    )
    .join("\n\n");

/**
 * The message the Feedback Widget delivers to the Thread whose Portal shows
 * the page. The page is served from this Thread's workspace, so the agent
 * changes the code it is running there.
 */
export const portalFeedbackPrompt = (
  comments: ReadonlyArray<FeedbackWidgetComment>,
  port: number,
) =>
  [
    `I left ${comments.length === 1 ? "a comment" : `${comments.length} comments`} on the page this Thread serves on port ${port}, through its Portal, with the dx Feedback Widget.`,
    "",
    "Find the code in this workspace that renders each element from its page, element, and text, and change it there. When a comment is unclear, say what you assumed.",
    "",
    feedbackItems(comments),
  ].join("\n");
