import type { GitHubGrantData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  bitbucketAuthorizeMutationOptions,
  bitbucketConnectionQueryOptions,
  bitbucketDisconnectMutationOptions,
  bitbucketRefreshMutationOptions,
} from "./bitbucket-queries.js";
import {
  beginPersonalGitHubAuthorization,
  beginPersonalGitHubInstallation,
  githubDisconnectMutationOptions,
} from "./integration-mutations.js";
import { githubIntegrationQueryOptions } from "./integration-queries.js";
import type { McpServersTarget } from "./mcp-queries.js";
import { McpSection } from "./mcp-section.js";

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Request failed.";
function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"
      />
    </svg>
  );
}

function BitbucketIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2.4 3.2a1 1 0 0 0-1 1.16l2.77 16.8a1.35 1.35 0 0 0 1.32 1.13h13.27a1 1 0 0 0 1-.84l2.83-17.08a1 1 0 0 0-1-1.17H2.4Zm12.13 12.14H9.58L8.24 8.28h7.5l-1.21 7.06Z"
      />
    </svg>
  );
}

function BitbucketIntegration() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const connectionQuery = useQuery(
    bitbucketConnectionQueryOptions(identity.id),
  );
  const authorize = useMutation(bitbucketAuthorizeMutationOptions(identity.id));
  const refresh = useMutation(
    bitbucketRefreshMutationOptions(queryClient, identity.id),
  );
  const disconnect = useMutation(
    bitbucketDisconnectMutationOptions(queryClient, identity.id),
  );
  const [confirming, setConfirming] = React.useState(false);
  const finalFocus = React.useRef<HTMLElement>(null);
  const connection = connectionQuery.data?.connection;
  const configured = connectionQuery.data?.configured;
  const active = configured !== false && connection?.status === "active";
  const unavailable = connectionQuery.error !== null;
  const error = authorize.error ?? refresh.error ?? disconnect.error;
  const connect = async () => {
    try {
      const destination = await authorize.mutateAsync();
      window.location.assign(destination);
    } catch {
      // The mutation error is rendered below.
    }
  };
  const confirmDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      setConfirming(false);
    } catch {
      // The mutation error is rendered below; keep the confirmation open.
    }
  };
  return (
    <section className="github-integration" aria-label="Bitbucket integration">
      <div className="github-integration-identity">
        <span className="github-integration-icon bitbucket" aria-hidden="true">
          <BitbucketIcon />
        </span>
        <div>
          <h2>
            {active ? `${connection.accountName} on Bitbucket` : "Bitbucket"}
          </h2>
          <span className="github-integration-summary">
            {connectionQuery.isPending
              ? "Checking connection…"
              : unavailable
                ? "Connection status is unavailable."
                : configured === false
                  ? "Bitbucket is unavailable because it is not configured."
                  : active
                    ? "Connected for personal projects."
                    : connection?.status === "reauthorization-required"
                      ? "Authorization expired or was revoked. Reconnect to continue."
                      : "Connect Bitbucket for personal projects."}
          </span>
        </div>
      </div>
      <div className="github-integration-actions">
        {unavailable ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void connectionQuery.refetch()}
          >
            Retry
          </Button>
        ) : active ? (
          <Button
            size="xs"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? "Refreshing…" : "Refresh status"}
          </Button>
        ) : configured === false ? null : (
          <Button
            size="xs"
            disabled={connectionQuery.isPending || authorize.isPending}
            onClick={() => void connect()}
          >
            {connection === null || connection === undefined
              ? "Connect"
              : "Reconnect"}
          </Button>
        )}
        {connection === null || connection === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            onClick={(event) => {
              finalFocus.current = event.currentTarget;
              setConfirming(true);
            }}
          >
            Disconnect
          </Button>
        )}
      </div>
      {error instanceof Error ? <p role="alert">{error.message}</p> : null}
      {!confirming || connection === null || connection === undefined ? null : (
        <DialogRoot open onOpenChange={(open) => !open && setConfirming(false)}>
          <DialogContent finalFocus={finalFocus}>
            <DialogTitle>Disconnect {connection.accountName}?</DialogTitle>
            <DialogDescription>
              dx will immediately stop accessing Bitbucket and delete its local
              credentials. This does not revoke the OAuth authorization at
              Bitbucket.
            </DialogDescription>
            <p>
              <a
                href="https://bitbucket.org/account/settings/app-authorizations/"
                target="_blank"
                rel="noreferrer"
              >
                Revoke dx in Bitbucket app authorizations
              </a>{" "}
              if you also want to remove provider-side access.
            </p>
            <div className="integration-dialog-actions">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={disconnect.isPending}
                onClick={() => void confirmDisconnect()}
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </DialogContent>
        </DialogRoot>
      )}
    </section>
  );
}

function DisconnectConfirmation({
  grant,
  finalFocus,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly grant: GitHubGrantData;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
  readonly pending: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent finalFocus={finalFocus}>
        <DialogTitle>Disconnect @{grant.account.login}?</DialogTitle>
        <DialogDescription>
          dx will uninstall the GitHub App from this GitHub account and
          immediately stop using its repositories.
        </DialogDescription>
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="integration-dialog-actions">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export function IntegrationsSettings({
  onDirtyChange,
  settingsReturnTo,
  workspaceSlug,
}: SettingsSectionProps) {
  const [status, setStatus] = React.useState<string>();
  const target = React.useMemo<McpServersTarget>(
    () =>
      workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug },
    [workspaceSlug],
  );
  return (
    <div className="integrations-settings">
      <header className="integrations-page-heading">
        <h1>MCP &amp; Integrations</h1>
        <span aria-live="polite">{status}</span>
      </header>
      {workspaceSlug === undefined ? (
        <section aria-labelledby="integrations-section-title">
          <header className="integrations-section-heading">
            <h2 id="integrations-section-title">Integrations</h2>
          </header>
          <GitHubIntegration
            onDirtyChange={onDirtyChange}
            settingsReturnTo={settingsReturnTo}
          />
          <BitbucketIntegration />
        </section>
      ) : null}
      <McpSection
        target={target}
        onStatus={setStatus}
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

function GitHubIntegration({
  onDirtyChange,
  settingsReturnTo,
}: {
  readonly onDirtyChange: SettingsSectionProps["onDirtyChange"];
  readonly settingsReturnTo?: SettingsSectionProps["settingsReturnTo"];
}) {
  const { identity } = useAuthenticatedIdentity();
  const navigate = useNavigate();
  const grantsQuery = useQuery(githubIntegrationQueryOptions(identity.id));
  const [error, setError] = React.useState<string>();
  const configured = grantsQuery.data?.configured;
  const grants = grantsQuery.data?.grants ?? [];
  const redirect = async (operation: "connect" | "install") => {
    setError(undefined);
    try {
      const destination =
        operation === "connect"
          ? await beginPersonalGitHubAuthorization(settingsReturnTo)
          : await beginPersonalGitHubInstallation(settingsReturnTo);
      void navigate({
        href: destination,
        replace: true,
        reloadDocument: true,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const activeGrants = grants.filter(
    (grant) =>
      grant.status === "active" && grant.installationStatus === "active",
  );
  const summary = grantsQuery.isPending
    ? "Checking connection…"
    : grantsQuery.error !== null
      ? "Connection status is unavailable."
      : configured === false
        ? "GitHub is unavailable because it is not configured."
        : grants.length === 0
          ? "Connect GitHub for personal projects."
          : activeGrants.length === grants.length
            ? `${grants.length} connected installation${grants.length === 1 ? "" : "s"}.`
            : `${activeGrants.length} of ${grants.length} installations connected.`;
  return (
    <>
      <section
        className="github-integration github-installations"
        aria-label="GitHub integration"
      >
        <div className="github-integration-identity">
          <span className="github-integration-icon" aria-hidden="true">
            <GitHubIcon />
          </span>
          <div>
            <h2>GitHub</h2>
            <span className="github-integration-summary">{summary}</span>
          </div>
        </div>
        <div className="github-integration-actions">
          {grantsQuery.error !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void grantsQuery.refetch()}
            >
              Retry
            </Button>
          ) : configured === false ? (
            <Button size="xs" disabled>
              Connect
            </Button>
          ) : grants.length === 0 ? (
            <Button
              size="xs"
              disabled={grantsQuery.isPending}
              onClick={() => void redirect("connect")}
            >
              Connect
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void redirect("install")}
            >
              Connect another
            </Button>
          )}
        </div>
        {grants.length === 0 ? null : (
          <ul
            className="github-installation-list"
            aria-label="GitHub installations"
          >
            {grants.map((grant) => (
              <GitHubInstallation
                key={grant.id}
                grant={grant}
                onDirtyChange={onDirtyChange}
                onRedirect={redirect}
              />
            ))}
          </ul>
        )}
      </section>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </>
  );
}

function GitHubInstallation({
  grant,
  onDirtyChange,
  onRedirect,
}: {
  readonly grant: GitHubGrantData;
  readonly onDirtyChange: SettingsSectionProps["onDirtyChange"];
  readonly onRedirect: (operation: "connect" | "install") => Promise<void>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const finalFocus = React.useRef<HTMLElement>(null);
  const disconnectMutation = useMutation(
    githubDisconnectMutationOptions(queryClient, identity.id, grant.id),
  );
  const connected =
    grant.status === "active" && grant.installationStatus === "active";
  const reconnect = async () => {
    setError(undefined);
    await onRedirect(
      grant.status === "reauthorization-required" ? "connect" : "install",
    );
  };
  const confirmDisconnect = async () => {
    setError(undefined);
    try {
      await disconnectMutation.mutateAsync();
      setDisconnectOpen(false);
      onDirtyChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <li className="github-installation">
      <div>
        <div className="github-installation-title">
          <strong>@{grant.account.login}</strong>
          <span>
            {grant.account.type === "organization"
              ? "Organization"
              : "Personal"}
          </span>
          <span
            className="github-integration-help"
            title="GitHub repository access"
            role="img"
            aria-label="GitHub repository access"
          >
            <CircleHelp />
          </span>
        </div>
        <span className="github-integration-summary">
          {connected
            ? "Connected"
            : grant.status === "reauthorization-required"
              ? "Authorization expired or was revoked."
              : "Installation needs attention."}
        </span>
      </div>
      <div className="github-integration-actions">
        {connected ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Configure @${grant.account.login}`}
            onClick={() => void onRedirect("install")}
          >
            Configure
          </Button>
        ) : (
          <Button
            size="xs"
            aria-label={`Reconnect @${grant.account.login}`}
            onClick={() => void reconnect()}
          >
            Reconnect
          </Button>
        )}
        {grant.status === "reauthorization-required" ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Disconnect @${grant.account.login}`}
            onClick={(event) => {
              finalFocus.current = event.currentTarget;
              setDisconnectOpen(true);
            }}
          >
            Disconnect
          </Button>
        )}
      </div>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {!disconnectOpen ? null : (
        <DisconnectConfirmation
          grant={grant}
          finalFocus={finalFocus}
          pending={disconnectMutation.isPending}
          error={error}
          onClose={() => setDisconnectOpen(false)}
          onConfirm={() => void confirmDisconnect()}
        />
      )}
    </li>
  );
}
