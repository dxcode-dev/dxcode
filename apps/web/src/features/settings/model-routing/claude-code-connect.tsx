import type { ConnectionData } from "@dx/api";
import { CLAUDE_CODE_PROVIDER_ID } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { Button } from "../../../shared/ui/button.js";
import { ClaudeIcon } from "../../../shared/ui/claude-icon.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { getBrowserClaudeCodeNoticeStore } from "./claude-code-notice-store.js";
import {
  apiMessage,
  connectionMutationOptions,
  fieldErrorsOf,
} from "./model-routing-mutations.js";

const SETUP_COMMAND = "claude setup-token";
const INSTALL_URL = "https://code.claude.com/docs/en/setup";

const CLAUDE_PLAN_COPY =
  "The Claude Code mode in dx uses your Claude Pro/Max plan. Use of dx's own modes (low, medium, high, ultra) and raw models is not covered by your Claude plan.";

/** One-time Model Routing notice; dismissal is remembered on this device. */
export const ClaudeCodeNotice = ({
  onConnect,
}: {
  readonly onConnect: () => void;
}) => {
  const store = getBrowserClaudeCodeNoticeStore();
  const dismissed = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  if (dismissed) return null;
  return (
    <section
      className="claude-code-notice"
      aria-labelledby="claude-code-notice-title"
    >
      <div className="claude-code-notice-head">
        <ClaudeIcon className="claude-code-notice-icon" />
        <h2 id="claude-code-notice-title">Connect Your Claude Subscription</h2>
        <button
          type="button"
          className="claude-code-notice-dismiss"
          aria-label="Dismiss Claude subscription notice"
          onClick={store.dismiss}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <p>{CLAUDE_PLAN_COPY}</p>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        className="claude-code-connect-button"
        onClick={onConnect}
      >
        <ClaudeIcon aria-hidden="true" />
        Connect Claude Pro/Max
      </Button>
    </section>
  );
};

/** Paste-a-token flow for `claude setup-token`; dx checks it with Anthropic. */
export const ClaudeConnectDialog = ({
  target,
  connection,
  name,
  onClose,
}: {
  readonly target: ModelRoutingTarget;
  /** Set to replace this connection's token instead of connecting. */
  readonly connection?: ConnectionData | undefined;
  /** The new connection's name. */
  readonly name: string;
  readonly onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const options = connectionMutationOptions(queryClient, target);
  const create = useMutation(options.create);
  const update = useMutation(options.update);
  const failure = create.error ?? update.error;
  const fieldErrors = failure === null ? {} : fieldErrorsOf(failure);
  const tokenError = fieldErrors.apiKey;
  // A field error other than the token's (a name in use, the connection
  // limit) says more than the request's generic message.
  const error =
    failure === null
      ? undefined
      : (Object.entries(fieldErrors).find(
          ([field]) => field !== "apiKey",
        )?.[1] ?? apiMessage(failure));
  const busy = create.isPending || update.isPending;
  const replacing = connection !== undefined;
  const onSubmit = (apiKey: string) => {
    if (connection !== undefined)
      update.mutate(
        { connectionId: connection.id, patch: { apiKey } },
        { onSuccess: onClose },
      );
    else
      create.mutate(
        {
          name,
          kind: "provider",
          providerId: CLAUDE_CODE_PROVIDER_ID,
          fields: {},
          headers: [],
          apiKey,
          enabled: true,
        },
        { onSuccess: onClose },
      );
  };
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const trimmed = token.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed !== "") onSubmit(trimmed);
  };
  const copy = () => {
    void navigator.clipboard
      ?.writeText(SETUP_COMMAND)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <DialogRoot open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="model-routing-dialog claude-code-dialog">
        <DialogTitle>
          {replacing
            ? "Replace Your Claude Token"
            : "Connect Your Claude Subscription"}
        </DialogTitle>
        <DialogDescription>
          Use your Claude Pro or Max subscription for Claude Code threads in dx.
          dx's own modes do not use it. dx checks the token with Anthropic
          before saving it.
        </DialogDescription>
        <form onSubmit={submit}>
          <ol className="claude-code-steps">
            <li>
              <span className="claude-code-step-number" aria-hidden="true">
                1
              </span>
              <div>
                <p>In a terminal on your own computer, run:</p>
                <div className="claude-code-command">
                  <code>{SETUP_COMMAND}</code>
                  <button
                    type="button"
                    className="claude-code-copy"
                    aria-label={copied ? "Copied" : "Copy command"}
                    onClick={copy}
                  >
                    {copied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                  </button>
                </div>
                <p className="claude-code-step-hint">
                  This needs Claude Code.{" "}
                  <a href={INSTALL_URL} target="_blank" rel="noreferrer">
                    Install Claude Code
                    <ExternalLink aria-hidden="true" />
                  </a>
                </p>
              </div>
            </li>
            <li>
              <span className="claude-code-step-number" aria-hidden="true">
                2
              </span>
              <p>
                A browser window opens. Sign in with your Claude Pro or Max
                account and approve access.
              </p>
            </li>
            <li>
              <span className="claude-code-step-number" aria-hidden="true">
                3
              </span>
              <div>
                <label htmlFor="claude-code-token">
                  Paste the token that the command prints
                </label>
                <Input
                  id="claude-code-token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-oat..."
                  value={token}
                  aria-invalid={tokenError === undefined ? undefined : true}
                  aria-describedby="claude-code-token-hint"
                  onChange={(event) => setToken(event.target.value)}
                />
                <p
                  id="claude-code-token-hint"
                  className="claude-code-step-hint"
                >
                  The token is valid for one year.
                </p>
                {tokenError === undefined ? null : (
                  <p className="model-routing-field-error" role="alert">
                    {tokenError}
                  </p>
                )}
              </div>
            </li>
          </ol>
          {error === undefined || tokenError !== undefined ? null : (
            <p className="model-routing-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="model-routing-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || trimmed === ""}>
              {busy
                ? "Checking token…"
                : replacing
                  ? "Replace Token"
                  : "Connect Subscription"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
};
