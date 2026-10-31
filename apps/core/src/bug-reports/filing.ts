import type { BugReportDiagnosticKind, BugReportId } from "@dx/api";
import type { Bindings } from "../http/types.js";
import { bugReportLogger } from "../logging.js";
import { GLM_5_3_FLASH_MODEL_ID } from "../runtime/cloudflare-model-provider.js";
import {
  type BugReportFiling,
  connectBugReportRepository,
  type OpenIssue,
} from "./github.js";

const TITLE_MAX_LENGTH = 90;
const CANDIDATE_LIMIT = 100;
const MODEL_TIMEOUT_MS = 15_000;

const TRIAGE_PROMPT = `You triage bug reports for dx, a coding-agent web app. You get one new bug report and the repository's open issues. Decide whether an open issue already describes the same defect: the same broken behavior in the same part of the product, not merely the same area. Then write a short, specific issue title for the new report (at most 10 words, sentence case, no IDs or URLs). Answer with only one JSON object: {"duplicate": <issue number or null>, "title": "<title>"}.`;

export interface BugReportTriage {
  readonly duplicate?: OpenIssue;
  readonly title: string;
}

/** The first line of the message, cut to fit an issue title. */
export const fallbackBugReportTitle = (message: string) => {
  const line =
    message
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "Bug report";
  return line.length <= TITLE_MAX_LENGTH
    ? line
    : `${line.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
};

const modelText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result === null || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } })?.message
      ?.content;
    if (typeof content === "string") return content;
  }
  return "";
};

const lastJsonObject = (text: string): Record<string, unknown> | undefined => {
  const matches = text.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of matches.reverse()) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // The next candidate may parse.
    }
  }
  return undefined;
};

/**
 * Picks an open issue the report duplicates, if any, and a title, with one
 * Workers AI call. Without Workers AI, or when the call fails, nothing is a
 * duplicate and the title is the message's first line.
 */
export const triageBugReport = async (
  ai: Ai | undefined,
  message: string,
  open: ReadonlyArray<OpenIssue>,
): Promise<BugReportTriage> => {
  const fallback = { title: fallbackBugReportTitle(message) };
  if (ai === undefined) return fallback;
  const candidates = open.slice(0, CANDIDATE_LIMIT);
  const issues = candidates
    .map(
      (issue) =>
        `#${issue.number}: ${issue.title}\n${issue.body
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim()
          .slice(0, 400)}`,
    )
    .join("\n\n");
  try {
    const result = await Promise.race([
      (ai.run as (model: string, input: unknown) => Promise<unknown>)(
        GLM_5_3_FLASH_MODEL_ID,
        {
          messages: [
            { role: "system", content: TRIAGE_PROMPT },
            {
              role: "user",
              content: `<bug_report>\n${message.slice(0, 4_000)}\n</bug_report>\n\n<open_issues>\n${issues || "(none)"}\n</open_issues>`,
            },
          ],
          max_tokens: 2_048,
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Triage timed out.")),
          MODEL_TIMEOUT_MS,
        ),
      ),
    ]);
    const answer = lastJsonObject(modelText(result));
    if (answer === undefined) return fallback;
    const duplicate =
      typeof answer.duplicate === "number"
        ? candidates.find((issue) => issue.number === answer.duplicate)
        : undefined;
    const title =
      typeof answer.title === "string" &&
      answer.title.trim() !== "" &&
      answer.title.trim().length <= TITLE_MAX_LENGTH
        ? answer.title.trim()
        : fallback.title;
    return { title, ...(duplicate === undefined ? {} : { duplicate }) };
  } catch (cause) {
    bugReportLogger.warn("Bug report triage failed.", {
      event: "bug_report_triage_failed",
      errorName: cause instanceof Error ? cause.name : "UnknownError",
    });
    return fallback;
  }
};

const DIAGNOSTIC_LABELS: Record<BugReportDiagnosticKind, string> = {
  "thread-and-app": "Thread and App Diagnostics",
  changes: "Diff Diagnostics",
  dictation: "Dictation Diagnostics",
};

export interface FiledReport {
  readonly id: BugReportId;
  readonly threadId: string;
  readonly reporterUserId: string;
  readonly message: string;
  readonly diagnostics: ReadonlyArray<BugReportDiagnosticKind>;
  /** One line per diagnostic: what it holds, in counts only. */
  readonly summary: ReadonlyArray<string>;
  readonly imageCount: number;
}

/**
 * The issue body, or the comment on a duplicate, for one report. It carries
 * the message and counts only: the images and diagnostics stay in dx, behind
 * a link that needs a dx sign-in.
 */
export const bugReportIssueBody = (
  report: FiledReport,
  origin: string | undefined,
  duplicate: boolean,
) => {
  const base = origin?.replace(/\/$/, "");
  const thread =
    base === undefined
      ? `\`${report.threadId}\``
      : `[\`${report.threadId}\`](${base}/threads/${report.threadId})`;
  const attached = report.imageCount > 0 || report.diagnostics.length > 0;
  return [
    duplicate ? "Another report of this bug:\n" : undefined,
    report.message
      .split("\n")
      .map((line) => (duplicate ? `> ${line}` : line))
      .join("\n"),
    "",
    "### Report",
    "",
    `- Report: \`${report.id}\``,
    `- Thread: ${thread}`,
    `- Reporter: dx user \`${report.reporterUserId}\``,
    `- Images: ${report.imageCount}`,
    `- Diagnostics: ${
      report.diagnostics.length === 0
        ? "none"
        : report.diagnostics.map((kind) => DIAGNOSTIC_LABELS[kind]).join(", ")
    }`,
    ...report.summary.map((line) => `  - ${line}`),
    ...(attached && base !== undefined
      ? [
          "",
          `Images and diagnostics, secrets redacted, are in dx (sign in to open): ${base}/bug-reports/${report.id}`,
        ]
      : []),
    "",
    `<!-- dx-bug-report: ${report.id} -->`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
};

export type BugReportOutcome =
  | {
      readonly status: "filed" | "commented";
      readonly issue: { readonly number: number; readonly url: string };
    }
  | { readonly status: "failed" };

/**
 * Files one report: comments on the open issue it duplicates, or opens a
 * new issue with the deployment's labels.
 */
export const fileBugReport = async (input: {
  readonly bindings: Bindings;
  readonly filing: BugReportFiling;
  readonly report: FiledReport;
  readonly fetcher?: typeof fetch;
}): Promise<BugReportOutcome> => {
  const { bindings, filing, report } = input;
  try {
    const github = await connectBugReportRepository(filing, input.fetcher);
    const open = await github.openIssues(CANDIDATE_LIMIT);
    const triage = await triageBugReport(bindings.AI, report.message, open);
    const body = bugReportIssueBody(
      report,
      bindings.DX_AUTH_URL,
      triage.duplicate !== undefined,
    );
    if (triage.duplicate !== undefined)
      return {
        status: "commented",
        issue: await github.comment(triage.duplicate, body),
      };
    return {
      status: "filed",
      issue: await github.createIssue({ title: triage.title, body }),
    };
  } catch (cause) {
    bugReportLogger.error("Bug report filing failed.", {
      event: "bug_report_filing_failed",
      reportId: report.id,
      errorName: cause instanceof Error ? cause.name : "UnknownError",
      errorMessage:
        cause instanceof Error ? cause.message.slice(0, 300) : "unknown",
    });
    return { status: "failed" };
  }
};
