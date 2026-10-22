import type { GitHubGrantData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { SettingsHeading } from "../settings-primitives.js";
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

/** One integration account: its mark, name, a muted line, and its actions. */
function IntegrationRow({
  icon,
  title,
  badge,
  description,
  actions,
}: {
  readonly icon: React.ReactNode;
  readonly title: React.ReactNode;
  readonly badge?: string;
  readonly description?: React.ReactNode;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="integration-row">
      <span className="integration-row-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="integration-row-copy">
        <div className="integration-row-title">
          <h3>{title}</h3>
          {badge === undefined ? null : <span>{badge}</span>}
        </div>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : (
        <div className="integration-row-actions">{actions}</div>
      )}
    </div>
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
  const reconnectRequired = connection?.status === "reauthorization-required";
  return (
    <section className="integration-card" aria-label="Bitbucket integration">
      <IntegrationRow
        icon={<BitbucketIcon />}
        title={active ? `${connection.accountName} on Bitbucket` : "Bitbucket"}
        description={
          connectionQuery.isPending
            ? "Checking connection…"
            : unavailable
              ? "Connection status is unavailable."
              : configured === false
                ? "Bitbucket is not configured on this deployment."
                : reconnectRequired
                  ? "Authorization expired or was revoked. Reconnect to continue."
                  : active
                    ? undefined
                    : "Use your Bitbucket repositories in personal projects."
        }
        actions={
          <>
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
          </>
        }
      />
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
  const target: McpServersTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  return (
    <div className="integrations-settings">
      <SettingsHeading
        title="Integrations & MCP"
        description={
          workspaceSlug === undefined
            ? "Connect dx to the tools and services you use through integrations and MCP servers."
            : "Connect this workspace to the tools and services it uses through MCP servers."
        }
        actions={<span aria-live="polite">{status}</span>}
      />
      <section aria-labelledby="integrations-section-title">
        <header className="integrations-section-heading">
          <h2 id="integrations-section-title">Integrations</h2>
        </header>
        {workspaceSlug === undefined ? (
          <>
            <GitHubIntegration
              onDirtyChange={onDirtyChange}
              settingsReturnTo={settingsReturnTo}
            />
            <BitbucketIntegration />
          </>
        ) : (
          <section
            className="integration-card"
            aria-label="Source control integration"
          >
            <IntegrationRow
              icon={<GitHubIcon />}
              title="GitHub and Bitbucket"
              description="Each member connects their own account in personal settings to work in the workspace's repositories."
              actions={
                <Link
                  to="/settings/$section"
                  params={{ section: "integrations" }}
                  state={(previous) => previous}
                  className={buttonVariants({ variant: "outline", size: "xs" })}
                >
                  Personal integrations
                </Link>
              }
            />
          </section>
        )}
      </section>
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
  return (
    <>
      <section className="integration-card" aria-label="GitHub integration">
        {grants.length === 0 ? (
          <IntegrationRow
            icon={<GitHubIcon />}
            title="GitHub"
            description={
              grantsQuery.isPending
                ? "Checking connection…"
                : grantsQuery.error !== null
                  ? "Connection status is unavailable."
                  : configured === false
                    ? "GitHub is not configured on this deployment."
                    : "Use your GitHub repositories in dx projects."
            }
            actions={
              grantsQuery.error !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void grantsQuery.refetch()}
                >
                  Retry
                </Button>
              ) : configured === false ? undefined : (
                <Button
                  size="xs"
                  disabled={grantsQuery.isPending}
                  onClick={() => void redirect("connect")}
                >
                  Connect GitHub
                </Button>
              )
            }
          />
        ) : (
          grants.map((grant, index) => (
            <GitHubInstallation
              key={grant.id}
              grant={grant}
              connectAnother={index === 0}
              onDirtyChange={onDirtyChange}
              onRedirect={redirect}
            />
          ))
        )}
      </section>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </>
  );
}

function GitHubInstallation({
  grant,
  connectAnother,
  onDirtyChange,
  onRedirect,
}: {
  readonly grant: GitHubGrantData;
  /** The first account's row also offers connecting another account. */
  readonly connectAnother: boolean;
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
    <>
      <IntegrationRow
        icon={<GitHubIcon />}
        title={`@${grant.account.login} on GitHub`}
        badge={
          grant.account.type === "organization" ? "Organization" : undefined
        }
        description={
          connected
            ? undefined
            : grant.status === "reauthorization-required"
              ? "Authorization expired or was revoked."
              : "Installation needs attention."
        }
        actions={
          <>
            {connectAnother ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void onRedirect("install")}
              >
                Connect another account
              </Button>
            ) : null}
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
          </>
        }
      />
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
    </>
  );
}
