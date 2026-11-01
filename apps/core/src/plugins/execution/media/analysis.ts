/**
 * `view_media`'s analysis subagent. With an objective, or for a PDF, the
 * calling agent gets a text answer instead of an image block. The
 * answer comes from one model call on the Thread's own route at low effort,
 * through the credential coordinator's `/complete`, with this system prompt.
 */

export const MEDIA_ANALYSIS_SYSTEM_PROMPT = `You analyze one media file for a coding agent that cannot see it. The agent gives you the file and an objective. Answer the objective from the file alone.

- Quote visible text exactly, including labels, numbers, and error messages.
- Describe layout, colors, sizes, and positions when the objective depends on them.
- When the objective states an expected result, begin with a verdict: "Matches" or "Does not match", then the evidence.
- When the file cannot answer the objective, say what is missing. Never describe content you cannot see.

Reply in plain text, as briefly as the objective allows.`;

/** Used when the agent asks about a PDF without an objective. */
export const DEFAULT_MEDIA_OBJECTIVE =
  "Describe this file in detail, quoting its visible text.";

const MAX_ANSWER_TOKENS = 4_096;
const REQUEST_TIMEOUT_MS = 100_000;

export interface MediaAttachment {
  readonly data: string;
  readonly mimeType: string;
}

/** Asks the analysis subagent; resolves to its answer or throws why not. */
export type AnalyzeMedia = (
  objective: string,
  attachment: MediaAttachment,
) => Promise<string>;

const FAILURES: Record<string, string> = {
  MODEL_CANNOT_READ_MEDIA:
    "This Thread's model cannot read images, so view_media cannot analyze this file.",
  MODEL_CANNOT_READ_PDF:
    "This Thread's model cannot read PDFs. Convert the pages you need to PNG (for example with pdftoppm -png) and view those.",
};

/** The analysis subagent on a Thread's own model route. */
export const analyzeOnThreadRoute =
  (input: {
    readonly coordinator: DurableObjectNamespace;
    readonly thread: () => Promise<{
      readonly threadId: string;
      readonly ownerUserId: string;
      readonly selection: unknown;
    }>;
  }): AnalyzeMedia =>
  async (objective, attachment) => {
    const thread = await input.thread();
    const response = await input.coordinator
      .get(input.coordinator.idFromName(`byok-${thread.threadId}`))
      .fetch("https://dx-byok.invalid/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread.threadId,
          ownerUserId: thread.ownerUserId,
          selection: thread.selection,
          systemPrompt: MEDIA_ANALYSIS_SYSTEM_PROMPT,
          message: objective,
          maxTokens: MAX_ANSWER_TOKENS,
          attachments: [attachment],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    const body = await response
      .json<{ text?: string; code?: string; message?: string }>()
      .catch(() => ({}) as { text?: string; code?: string; message?: string });
    if (response.ok && typeof body.text === "string" && body.text.trim() !== "")
      return body.text.trim();
    const code = body.code ?? `HTTP_${response.status}`;
    throw new Error(
      FAILURES[code] ??
        `The media analysis model call failed (${code}${body.message === undefined ? "" : `: ${body.message}`}).`,
    );
  };
