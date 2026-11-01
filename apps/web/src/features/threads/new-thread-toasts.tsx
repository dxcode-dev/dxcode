import type { ThreadId } from "@dx/domain";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import type { NewThreadDraftSnapshot } from "./new-thread-draft-store.js";

const DRAFT_WARNINGS: Record<
  NonNullable<NewThreadDraftSnapshot["warning"]>,
  string
> = {
  "too-large":
    "This prompt is over the 64 KiB draft limit. It remains open but is not saved.",
  "storage-unavailable":
    "This draft could not be saved in this browser. It remains available while this composer stays open.",
};

/**
 * A toast raised when this element mounts and dismissed when it unmounts, for
 * a composer condition that lasts; key it by what it says.
 */
function NewThreadConditionToast({
  message,
  kind,
  action,
}: {
  readonly message: string;
  readonly kind: "error" | "warning" | "info";
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  useMountEffect(() => {
    const options = {
      duration: Number.POSITIVE_INFINITY,
      ...(action === undefined ? {} : { action }),
    };
    const id =
      kind === "error"
        ? toast.error(message, options)
        : kind === "warning"
          ? toast.warning(message, options)
          : toast.info(message, options);
    return () => {
      toast.dismiss(id);
    };
  });
  return null;
}

/**
 * A composer error as a toast, raised when it mounts and dismissed when the
 * error clears; key it by the error so a new one raises a new toast.
 */
function NewThreadErrorToast({
  message,
  acceptedThreadId,
  onAccepted,
}: {
  readonly message: string;
  readonly acceptedThreadId?: ThreadId;
  readonly onAccepted: () => void;
}) {
  const navigate = useNavigate();
  useMountEffect(() => {
    const id = toast.error(message, {
      duration: Number.POSITIVE_INFINITY,
      ...(acceptedThreadId === undefined
        ? {}
        : {
            action: {
              label: "Open created thread",
              onClick: () => {
                void navigate({
                  to: "/threads/$threadId",
                  params: { threadId: acceptedThreadId },
                }).then(onAccepted, () => {
                  toast.error(
                    "Thread was created, but still could not be opened.",
                  );
                });
              },
            },
          }),
    });
    return () => {
      toast.dismiss(id);
    };
  });
  return null;
}

/**
 * The new-thread composer's conditions and errors. They show as toasts, never
 * in the composer.
 */
export function NewThreadToasts({
  warning,
  onRetryStalled,
  projectsFailure,
  error,
  acceptedThreadId,
  onAccepted,
}: {
  readonly warning: NewThreadDraftSnapshot["warning"];
  /** Set while a send is stalled and can be retried. */
  readonly onRetryStalled?: () => void;
  /** Set when the first page of Projects failed to load. */
  readonly projectsFailure?: {
    readonly count: number;
    readonly retry: () => void;
  };
  readonly error?: string;
  readonly acceptedThreadId?: ThreadId;
  readonly onAccepted: () => void;
}) {
  return (
    <>
      {warning === undefined ? null : (
        <NewThreadConditionToast
          key={warning}
          kind="warning"
          message={DRAFT_WARNINGS[warning]}
        />
      )}
      {onRetryStalled === undefined ? null : (
        <NewThreadConditionToast
          kind="info"
          message="Still creating…"
          action={{ label: "Retry", onClick: onRetryStalled }}
        />
      )}
      {projectsFailure === undefined ? null : (
        <NewThreadConditionToast
          key={projectsFailure.count}
          kind="error"
          message="Projects could not be loaded."
          action={{ label: "Retry", onClick: projectsFailure.retry }}
        />
      )}
      {error === undefined ? null : (
        <NewThreadErrorToast
          key={`${error}:${acceptedThreadId ?? ""}`}
          message={error}
          acceptedThreadId={acceptedThreadId}
          onAccepted={onAccepted}
        />
      )}
    </>
  );
}
