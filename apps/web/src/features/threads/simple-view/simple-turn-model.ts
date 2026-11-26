import type { TranscriptRow, TranscriptTurn } from "@dx/client";
import {
  categoryForPart,
  isArtifactCardPart,
  isMcpAppPart,
  type ToolPart,
  type WorkRow,
} from "@dx/client";
import { pluginViewCardOf } from "../plugin-view-card-part.js";
import { toolContentText } from "../tool-output-media-model.js";

/**
 * The Simple thread view of one turn: what the person asked, what the agent
 * deliberately showed, and its answer. Tool calls, thinking, and the
 * agent's narration between them stay in the Thread (and in the model's
 * history) but are left out of the view, as a Space leaves its
 * coordinator's transcript out of its posts.
 */
export interface SimpleTurn {
  /** The person's messages that opened or steered the turn. */
  readonly prompts: ReadonlyArray<TranscriptRow>;
  /** Files the person sent with them. */
  readonly attachments: ReadonlyArray<TranscriptRow>;
  /**
   * What the agent showed on purpose before its answer, in order: artifact
   * cards, MCP App cards, plugin view cards, and any message carrying a
   * dx-view or media.
   */
  readonly shown: ReadonlyArray<TranscriptRow>;
  /** The answer, shown once the turn is over. */
  readonly answer: ReadonlyArray<TranscriptRow>;
  /** Tool calls whose images the turn produced, such as screenshots. */
  readonly mediaParts: ReadonlyArray<ToolPart>;
  /** Places the turn produced that its answer does not link. */
  readonly links: ReadonlyArray<SimpleLink>;
  /** What the agent is doing right now, in plain words. */
  readonly activity: SimpleActivity;
  readonly outcome: "working" | "done" | "stopped" | "failed";
  /** When the person's message was sent, to count a running turn's time. */
  readonly startedAt?: number;
  /** How long a finished turn took. */
  readonly durationMs?: number;
}

export interface SimpleLink {
  readonly url: string;
  readonly label: string;
  readonly kind: "pull-request" | "link";
}

/** A running turn's state, worded for someone who never reads tool calls. */
export type SimpleActivity =
  | "starting"
  | "thinking"
  | "exploring"
  | "searching-web"
  | "editing"
  | "running"
  | "waiting"
  | "coordinating"
  | "delegating"
  | "writing"
  | "working";

export const SIMPLE_ACTIVITY_TEXT: Readonly<Record<SimpleActivity, string>> = {
  starting: "Getting started",
  thinking: "Thinking",
  exploring: "Looking through the project",
  "searching-web": "Searching the web",
  editing: "Making changes",
  running: "Running commands",
  waiting: "Waiting for a step to finish",
  coordinating: "Checking in with other threads",
  delegating: "Working with a helper",
  writing: "Writing the reply",
  working: "Working",
};

const isWork = (row: TranscriptRow): row is WorkRow =>
  row.kind === "active-work" || row.kind === "settled-work";

const toolOf = (row: TranscriptRow): ToolPart | undefined =>
  isWork(row) && row.part.type === "dynamic-tool" ? row.part : undefined;

/** A fenced dx-view, or a Markdown image (which also plays video). */
const RICH_MARKDOWN = /```dx-view\b|!\[[^\]]*\]\([^)\s]+/;

/** A message the agent wrote to be seen: it carries a view or media. */
export const isShownProse = (row: TranscriptRow) =>
  (row.kind === "assistant-prose" || row.kind === "final-answer") &&
  RICH_MARKDOWN.test(row.text);

/**
 * A card the agent made for the person: an artifact, an MCP App, or a
 * plugin's view described as data that its tool's result names.
 */
export const isShownWork = (row: TranscriptRow) => {
  const part = toolOf(row);
  return (
    part !== undefined &&
    (isArtifactCardPart(part) ||
      isMcpAppPart(part) ||
      pluginViewCardOf(part) !== undefined)
  );
};

/**
 * A tool call whose images belong in the turn's gallery: what the agent
 * captured or made, such as a screenshot it looked at. Viewing a file the
 * person sent (a URL) shows them nothing new.
 */
const isMediaPart = (part: ToolPart) => {
  if (part.state !== "output-available") return false;
  if (part.toolName === "view_media") {
    const path = (part.input as { readonly path?: unknown } | undefined)?.path;
    return typeof path === "string" && !/^[a-z]+:\/\//i.test(path);
  }
  return /"type"\s*:\s*"image"/.test(JSON.stringify(part.output ?? null));
};

const activityOf = (rows: ReadonlyArray<TranscriptRow>): SimpleActivity => {
  const last = rows.findLast(
    (row) =>
      isWork(row) ||
      row.kind === "assistant-prose" ||
      row.kind === "final-answer",
  );
  if (last === undefined) return "starting";
  if (last.kind === "assistant-prose" || last.kind === "final-answer")
    return last.streaming ? "writing" : "thinking";
  if (!isWork(last)) return "working";
  if (last.part.type === "reasoning") return "thinking";
  const part = toolOf(last);
  if (part === undefined) return "working";
  const name = part.toolName.toLowerCase();
  if (name === "web_search" || name === "read_web_page") return "searching-web";
  switch (categoryForPart(part)) {
    case "explore":
      return "exploring";
    case "edit":
      return "editing";
    case "command":
      return "running";
    case "check":
      return "waiting";
    case "thread":
      return "coordinating";
    case "subagent":
      return "delegating";
    case "skill":
      return "thinking";
    default:
      return "working";
  }
};

const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const MARKDOWN_LINK = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()"'`\]]+/g;

const textOf = (value: unknown) =>
  typeof value === "string"
    ? value
    : (toolContentText(value) ?? JSON.stringify(value ?? null));

const trimUrl = (url: string) => url.replace(/[.,;:!?]+$/, "");

const linkLabel = (url: string): SimpleLink => {
  const pull = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  if (pull !== null)
    return { url, kind: "pull-request", label: `${pull[1]} #${pull[2]}` };
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const label = `${parsed.hostname}${path}`;
    return {
      url,
      kind: "link",
      label: label.length > 48 ? `${label.slice(0, 47)}…` : label,
    };
  } catch {
    return { url, kind: "link", label: url };
  }
};

/** At most this many links follow an answer. */
const LINK_LIMIT = 5;

/**
 * Links the person would want and could not otherwise find: pull requests
 * the turn's tools opened or read, and links the agent wrote in narration
 * the view hides. Links the answer or a shown message already carries, and
 * the turn's own Thread links, stay out.
 */
const linksOf = (
  hidden: ReadonlyArray<TranscriptRow>,
  visibleText: string,
): ReadonlyArray<SimpleLink> => {
  const found: string[] = [];
  for (const row of hidden) {
    if (row.kind === "assistant-prose") {
      for (const match of row.text.matchAll(MARKDOWN_LINK))
        found.push(match[1] ?? "");
      for (const match of row.text.matchAll(BARE_URL)) found.push(match[0]);
      continue;
    }
    const part = toolOf(row);
    if (part === undefined || part.state !== "output-available") continue;
    const text = `${textOf(part.input)}\n${textOf(part.output)}`;
    for (const match of text.matchAll(PULL_REQUEST)) found.push(match[0]);
  }
  const seen = new Set<string>();
  const links: SimpleLink[] = [];
  for (const raw of found) {
    const url = trimUrl(raw);
    if (url === "" || seen.has(url) || visibleText.includes(url)) continue;
    seen.add(url);
    links.push(linkLabel(url));
  }
  // Pull requests first: they are what a person acts on.
  return links
    .toSorted(
      (a, b) =>
        Number(b.kind === "pull-request") - Number(a.kind === "pull-request"),
    )
    .slice(0, LINK_LIMIT);
};

const timeOf = (row: TranscriptRow | undefined) => {
  const sentAt =
    row !== undefined && "sentAt" in row && typeof row.sentAt === "string"
      ? Date.parse(row.sentAt)
      : Number.NaN;
  return Number.isFinite(sentAt) ? sentAt : undefined;
};

/** One turn in the Simple thread view. */
export const simpleTurn = (
  turn: TranscriptTurn,
  rows: ReadonlyArray<TranscriptRow>,
  processing: boolean,
): SimpleTurn => {
  const working = processing || turn.status === "active";
  const intermediate = new Set(turn.intermediateRowIds);
  const prompts = rows.filter((row) => row.kind === "user-prompt");
  const attachments = rows.filter((row) => row.kind === "attachment");
  const body = rows.filter(
    (row) => row.kind !== "user-prompt" && row.kind !== "attachment",
  );
  const shown = body.filter(
    (row) =>
      isShownWork(row) || (intermediate.has(row.id) && isShownProse(row)),
  );
  const shownIds = new Set(shown.map((row) => row.id));
  // A running turn's last reply may still turn into narration, so its
  // answer waits for the turn to end, as a Space's post waits for `post`.
  const answer: TranscriptRow[] = working
    ? []
    : body.filter(
        (row) =>
          !intermediate.has(row.id) && !shownIds.has(row.id) && !isWork(row),
      );
  // A turn that ended early has no answer; its last words say why.
  if (!working && answer.length === 0 && turn.status !== "completed") {
    const last = body.findLast((row) => row.kind === "assistant-prose");
    if (last !== undefined && !shownIds.has(last.id)) answer.push(last);
  }
  const answerIds = new Set(answer.map((row) => row.id));
  const hidden = body.filter(
    (row) => !shownIds.has(row.id) && !answerIds.has(row.id),
  );
  const visibleText = [...shown, ...answer]
    .map((row) =>
      row.kind === "assistant-prose" || row.kind === "final-answer"
        ? row.text
        : "",
    )
    .join("\n");
  const mediaParts = body.flatMap((row) => {
    const part = toolOf(row);
    return part !== undefined && isMediaPart(part) ? [part] : [];
  });
  const startedAt = timeOf(prompts[0]);
  const endedAt = timeOf(answer.at(-1));
  const durationMs =
    turn.durationMs ??
    (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? endedAt - startedAt
      : undefined);
  return {
    prompts,
    attachments,
    shown,
    answer,
    mediaParts,
    links: working ? [] : linksOf(hidden, visibleText),
    activity: activityOf(body),
    outcome: working
      ? "working"
      : turn.status === "completed"
        ? "done"
        : turn.status === "aborted" &&
            turn.settlement?.provenance === "user-stop"
          ? "stopped"
          : "failed",
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
};
