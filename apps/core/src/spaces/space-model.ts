import type { Bindings } from "../http/types.js";
import { spaceLogger } from "../logging.js";

/**
 * The small, fast Workers AI text model Spaces write short text with: a
 * thread card's status line when a turn ends, and the catch-up card. The
 * same model writes the composer's quick replies (`reply-writer.ts`).
 */
export const SPACE_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash" as const;

const CALL_TIMEOUT_MS = 20_000;

/**
 * Whether Spaces may call Workers AI. Routine local development (`pnpm
 * dev`) and a deployment that turned Workers AI off never do: their callers
 * fall back to text dx writes itself.
 */
export const spaceModelAvailable = (bindings: Bindings) =>
  bindings.AI !== undefined &&
  bindings.DX_MODEL_WORKERS_AI_ENABLED !== "false" &&
  bindings.DX_RUNTIME_MODE !== "local";

/** The model's text: OpenAI-style choices, or Workers AI's `response`. */
const textOf = (response: unknown): string | undefined => {
  const value = response as {
    readonly choices?: ReadonlyArray<{
      readonly message?: { readonly content?: unknown };
    }>;
    readonly response?: unknown;
  } | null;
  const content = value?.choices?.[0]?.message?.content ?? value?.response;
  return typeof content === "string" ? content : undefined;
};

/**
 * One tool-free call without thinking. Undefined when Workers AI is not
 * available, fails, or does not answer in time; never rejects.
 */
export const runSpaceModel = async (
  bindings: Bindings,
  input: {
    readonly purpose: "status_line" | "catch_up";
    readonly system: string;
    readonly user: string;
    readonly maxTokens: number;
  },
): Promise<string | undefined> => {
  if (!spaceModelAvailable(bindings) || bindings.AI === undefined)
    return undefined;
  const run = bindings.AI.run as (
    model: string,
    input: unknown,
  ) => Promise<unknown>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      run.call(bindings.AI, SPACE_TEXT_MODEL, {
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        max_completion_tokens: input.maxTokens,
        temperature: 0.2,
        chat_template_kwargs: { enable_thinking: false },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The Space model did not answer in time.")),
          CALL_TIMEOUT_MS,
        );
      }),
    ]);
    return textOf(response);
  } catch (cause) {
    spaceLogger.warn("A Space model call failed.", {
      event: "space_model_call_failed",
      purpose: input.purpose,
      cause,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};
