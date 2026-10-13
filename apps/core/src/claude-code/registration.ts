import {
  getModelInvocationContext,
  type SandboxFactory,
  setProvider,
} from "@flue/runtime";
import type { ClaudePlanAccess } from "./plan.js";
import { createClaudeCodeProvider } from "./provider.js";
import { claudeCodeSandbox } from "./runs.js";

/**
 * Registers the `claude-code` provider. The OAuth token and the plan's extra
 * usage choice come from the Thread's credential coordinator for the pinned
 * Claude Code route only, which also records the plan limits a run reports;
 * the workspace comes from the agent's own execution factory.
 */
export const registerClaudeCodeProvider = (input: {
  readonly coordinator: DurableObjectNamespace;
  readonly execution: () => SandboxFactory;
}) => {
  const coordinator = (threadId: string) =>
    input.coordinator.get(input.coordinator.idFromName(`byok-${threadId}`));
  setProvider(
    createClaudeCodeProvider({
      invocation: getModelInvocationContext,
      sandbox: (threadId) =>
        claudeCodeSandbox(threadId, () =>
          input.execution().createSandbox({ id: threadId }),
        ),
      credential: async (threadId, submissionId, canonical) => {
        const response = await coordinator(threadId).fetch(
          "https://dx-byok.invalid/claude-code-credential",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId, submissionId, canonical }),
          },
        );
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
        return response.json<{ token: string; plan: ClaudePlanAccess }>();
      },
      recordUsage: async (
        threadId,
        submissionId,
        canonical,
        reading,
        observedAt,
      ) => {
        const response = await coordinator(threadId).fetch(
          "https://dx-byok.invalid/claude-code-usage",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              threadId,
              submissionId,
              canonical,
              reading,
              observedAt,
            }),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Claude plan usage not recorded (${response.status}).`,
          );
        }
        return (await response.json<{ plan: ClaudePlanAccess }>()).plan;
      },
    }),
  );
};
