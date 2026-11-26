import { submitNewThread as submitClientNewThread } from "@dx/client";
import type { useNavigate } from "@tanstack/react-router";

export { NEW_THREAD_STALL_AFTER_MS } from "@dx/client";

/**
 * Starts a Thread from the web's composer: `submitNewThread` in `@dx/client`,
 * which opens the created Thread by navigating to its page.
 */
export const submitNewThread = ({
  navigate,
  ...options
}: Omit<Parameters<typeof submitClientNewThread>[0], "open"> & {
  readonly navigate: ReturnType<typeof useNavigate>;
}) =>
  submitClientNewThread({
    ...options,
    open: (threadId) =>
      navigate({ to: "/threads/$threadId", params: { threadId } }),
  });
