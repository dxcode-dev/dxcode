import type { PendingPersonalModelSubscriptionAuthorizationDataSchema } from "@dx/api";
import { useRef, useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import {
  beginCopilotAuthorization,
  pollCopilotAuthorization,
} from "./model-routing-mutations.js";

/** GitHub Copilot device-flow connect dialog. */
export const CopilotConnectDialog = ({
  open,
  onClose,
  onConnected,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) => {
  const [authorization, setAuthorization] =
    useState<
      typeof PendingPersonalModelSubscriptionAuthorizationDataSchema.Type
    >();
  const [phase, setPhase] = useState<
    "idle" | "starting" | "pending" | "connected" | "failed"
  >("idle");
  const [error, setError] = useState<string>();
  const cancelled = useRef(false);

  const poll = (authorizationId: string, delayMs: number) => {
    setTimeout(() => {
      if (cancelled.current) return;
      pollCopilotAuthorization(authorizationId)
        .then((result) => {
          if (cancelled.current) return;
          if (result.state === "connected") {
            setPhase("connected");
            onConnected();
            return;
          }
          if (result.state === "pending") {
            setAuthorization(result);
            poll(
              result.id,
              Math.max(0, result.nextPollAt.epochMilliseconds - Date.now()),
            );
            return;
          }
          setPhase("failed");
          setError(`Authorization ${result.state}.`);
        })
        .catch((pollError: unknown) => {
          if (cancelled.current) return;
          setPhase("failed");
          setError(
            pollError instanceof Error ? pollError.message : "Polling failed.",
          );
        });
    }, delayMs);
  };

  const begin = () => {
    cancelled.current = false;
    setPhase("starting");
    setError(undefined);
    beginCopilotAuthorization()
      .then((result) => {
        if (cancelled.current) return;
        setAuthorization(result);
        setPhase("pending");
        poll(
          result.id,
          Math.max(0, result.nextPollAt.epochMilliseconds - Date.now()),
        );
      })
      .catch((beginError: unknown) => {
        if (cancelled.current) return;
        setPhase("failed");
        setError(
          beginError instanceof Error
            ? beginError.message
            : "Could not start authorization.",
        );
      });
  };

  const close = () => {
    cancelled.current = true;
    setAuthorization(undefined);
    setPhase("idle");
    setError(undefined);
    onClose();
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="model-routing-dialog">
        <DialogTitle>Connect GitHub Copilot</DialogTitle>
        {phase === "pending" && authorization !== undefined ? (
          <div className="model-routing-copilot-flow">
            <p>
              Open{" "}
              <a
                href={authorization.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {authorization.verificationUrl}
              </a>{" "}
              and enter this code:
            </p>
            <code className="model-routing-copilot-code">
              {authorization.userCode}
            </code>
            <p>Waiting for GitHub to confirm…</p>
          </div>
        ) : phase === "connected" ? (
          <p>GitHub Copilot connected.</p>
        ) : (
          <p>
            Sign in with your GitHub Copilot subscription to serve its models.
            This is separate from your GitHub source-control connection.
          </p>
        )}
        {error === undefined ? null : (
          <p className="model-routing-field-error">{error}</p>
        )}
        <div className="model-routing-dialog-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {phase === "connected" ? "Close" : "Cancel"}
          </Button>
          {phase === "idle" || phase === "starting" || phase === "failed" ? (
            <Button
              type="button"
              onClick={begin}
              disabled={phase === "starting"}
            >
              {phase === "starting" ? "Starting…" : "Connect"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
};
