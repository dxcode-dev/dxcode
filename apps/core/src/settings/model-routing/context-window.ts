/**
 * dx runs models below their advertised maximum context. OpenAI models stay
 * under the 272K-input long-context pricing tier; Anthropic models stay below
 * their 1M window. Flue compacts at the effective window minus its reserve.
 * Other model families keep their native window.
 */
export const OPENAI_CONTEXT_WINDOW = 270_000;
export const ANTHROPIC_CONTEXT_WINDOW = 872_000;

const anthropicModel = /claude/i;
const openAiModel =
  /^(?:openai|azure-openai-responses|openai-codex)\/|openai[./]|(?:^|[/.])gpt-/i;

/** The window dx gives Flue for a canonical `provider/model` id. */
export const effectiveContextWindow = (
  canonical: string,
  nativeWindow: number,
): number => {
  const cap = anthropicModel.test(canonical)
    ? ANTHROPIC_CONTEXT_WINDOW
    : openAiModel.test(canonical)
      ? OPENAI_CONTEXT_WINDOW
      : undefined;
  return cap === undefined ? nativeWindow : Math.min(nativeWindow, cap);
};
