import {
  AnswerPluginPromptResponseSchema,
  PluginThreadUiErrorResponseSchema,
  RunPluginCommandResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { request } from "../../../shared/api/client.js";
import { invalidatePluginUi } from "../thread-queries.js";

/** Answering plugins' prompts and running their commands in a Thread. */

export const answerPluginPrompt = async (
  client: QueryClient,
  threadId: ThreadId,
  promptId: string,
  answer: null | boolean | string | Readonly<Record<string, string>>,
) => {
  try {
    const response = await request(
      `/v1/threads/${encodeURIComponent(threadId)}/plugin-ui/prompts/${encodeURIComponent(promptId)}`,
      AnswerPluginPromptResponseSchema,
      { method: "POST", body: JSON.stringify({ answer }) },
      PluginThreadUiErrorResponseSchema,
    );
    return response.data;
  } finally {
    await invalidatePluginUi(client, threadId);
  }
};

/** Runs a plugin's palette command in the Thread; a failure shows a toast. */
export const runPluginCommand = async (
  threadId: ThreadId,
  command: string,
  title: string,
) => {
  try {
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/plugin-ui/commands`,
      RunPluginCommandResponseSchema,
      { method: "POST", body: JSON.stringify({ command }) },
      PluginThreadUiErrorResponseSchema,
    );
  } catch (error) {
    const detail =
      error !== null &&
      typeof error === "object" &&
      "data" in error &&
      typeof (error as { data?: { detail?: unknown } }).data?.detail ===
        "string"
        ? (error as { data: { detail: string } }).data.detail
        : error instanceof Error
          ? error.message
          : undefined;
    toast.error(`${title} failed`, { description: detail });
  }
};
