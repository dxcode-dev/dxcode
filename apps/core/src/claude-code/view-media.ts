import type { Sandbox, ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import {
  type AnalyzeMedia,
  MEDIA_ANALYSIS_SYSTEM_PROMPT,
} from "../plugins/execution/media/analysis.js";
import {
  VIEW_MEDIA_DESCRIPTION,
  VIEW_MEDIA_PARAMETERS,
  type ViewMediaDeps,
  viewMedia,
} from "../plugins/execution/media/view-media.js";
import { CLAUDE_CODE_SMALL_MODEL } from "../settings/model-routing/claude-code-token.js";
import { showClaudeCodeToolImage } from "./dx-tools.js";
import { claudeCodeAnswer } from "./workspace-run.js";

const { properties } = VIEW_MEDIA_PARAMETERS;

const ViewMediaInput = v.object({
  path: v.pipe(v.string(), v.description(properties.path.description)),
  objective: v.optional(
    v.pipe(v.string(), v.description(properties.objective.description)),
  ),
  resolution: v.optional(
    v.pipe(
      v.picklist(["high", "original"]),
      v.description(properties.resolution.description),
    ),
  ),
  found_on: v.optional(
    v.pipe(v.string(), v.description(properties.found_on.description)),
  ),
});

/**
 * The analysis subagent in Claude Code mode: one `claude -p` answer on the
 * owner's Claude plan, with the media as a content block and the analysis
 * prompt appended to Claude Code's own.
 */
const analyzeWithClaudeCode =
  (sandbox: Sandbox, token: () => Promise<string>): AnalyzeMedia =>
  async (objective, attachment) => {
    const block =
      attachment.mimeType === "application/pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: attachment.data,
            },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: attachment.data,
            },
          };
    const answer = await claudeCodeAnswer(sandbox, {
      model: CLAUDE_CODE_SMALL_MODEL,
      token: await token(),
      inputFormat: "stream-json",
      appendSystemPrompt: MEDIA_ANALYSIS_SYSTEM_PROMPT,
      input: `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [block, { type: "text", text: objective }],
        },
      })}\n`,
    });
    if (answer.text === undefined || answer.text.trim() === "")
      throw new Error("The media analysis by Claude Code returned no answer.");
    return answer.text.trim();
  };

/**
 * `view_media` for Claude Code mode, served through the dx MCP server. An
 * image reaches Claude as an MCP image block; Flue records only the text.
 */
export const createClaudeCodeViewMediaTool = (input: {
  readonly deps: Omit<ViewMediaDeps, "analyze">;
  /** The owner's Claude plan token for this submission's route. */
  readonly token: () => Promise<string>;
}): ToolDefinition =>
  ({
    name: "view_media",
    description: VIEW_MEDIA_DESCRIPTION,
    input: ViewMediaInput,
    output: undefined,
    harness: true,
    run: async (context: {
      readonly data: v.InferOutput<typeof ViewMediaInput>;
      readonly toolCallId: string;
      readonly signal?: AbortSignal;
      readonly harness: { readonly sandbox: unknown };
    }) => {
      const sandbox = context.harness.sandbox as Sandbox;
      const result = await viewMedia(
        sandbox,
        context.data,
        {
          ...input.deps,
          analyze: analyzeWithClaudeCode(sandbox, input.token),
        },
        context.signal,
      );
      if (result.image !== undefined)
        showClaudeCodeToolImage(context.toolCallId, result.image);
      return result.text;
    },
  }) as unknown as ToolDefinition;
