import {
  getModelInvocationContext,
  type SandboxFactory,
  setProvider,
} from "@flue/runtime";
import { createClaudeCodeProvider } from "./provider.js";
import { claudeCodeSandbox } from "./runs.js";

/**
 * Registers the `claude-code` provider. The OAuth token comes from the
 * Thread's credential coordinator for the pinned Claude Code route only; the
 * workspace comes from the agent's own execution factory.
 */
export const registerClaudeCodeProvider = (input: {
  readonly coordinator: DurableObjectNamespace;
  readonly execution: () => SandboxFactory;
}) => {
  setProvider(
    createClaudeCodeProvider({
      invocation: getModelInvocationContext,
      sandbox: (threadId) =>
        claudeCodeSandbox(threadId, () =>
          input.execution().createSandbox({ id: threadId }),
        ),
      token: async (threadId, submissionId, canonical) => {
        const response = await input.coordinator
          .get(input.coordinator.idFromName(`byok-${threadId}`))
          .fetch("https://dx-byok.invalid/claude-code-credential", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId, submissionId, canonical }),
          });
        if (!response.ok) {
          const { code } = await response
            .json<{ code?: string }>()
            .catch(() => ({ code: undefined }));
          throw new Error(
            code === "CONNECTION_REMOVED"
              ? "The Claude Pro/Max connection was removed. Connect it again in Settings → Model Routing."
              : `Claude Pro/Max credential unavailable (${code ?? response.status}).`,
          );
        }
        return (await response.json<{ token: string }>()).token;
      },
    }),
  );
};
