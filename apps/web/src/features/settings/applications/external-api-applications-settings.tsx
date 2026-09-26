import type {
  ExternalApiApplicationAuditEventData,
  ExternalApiApplicationData,
  ExternalApiApplicationSecretData,
} from "@dx/api";
import {
  type ExternalApiApplicationRotationOverlapSeconds,
  type ExternalApiApplicationScope,
  externalApiApplicationScopes,
  type WorkspaceSlug,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  Activity,
  ClipboardCopy,
  KeyRound,
  Pencil,
  Power,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { applicationMutationOptions } from "./application-mutations.js";
import {
  applicationAuditQueryOptions,
  applicationsQueryOptions,
} from "./application-queries.js";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatDateTime = (value: DateTime.Utc): string =>
  dateTimeFormatter.format(new Date(DateTime.formatIso(value)));

const scopeLabels: Record<ExternalApiApplicationScope, string> = {
  "projects:read": "Read projects",
  "projects:write": "Create projects",
  "threads:read": "Read threads",
  "threads:write": "Create threads",
};

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function ApplicationsState({
  loading,
  error,
  empty,
  retry,
}: {
  readonly loading?: boolean;
  readonly error?: string;
  readonly empty?: string;
  readonly retry?: () => void;
}) {
  if (loading) {
    return (
      <div className="applications-state" aria-busy="true">
        <span className="tool-spinner" /> Loading applications…
      </div>
    );
  }
  if (error !== undefined) {
    return (
      <div className="applications-state" role="alert">
        <ShieldAlert aria-hidden="true" />
        <span>{error}</span>
        {retry === undefined ? null : (
          <Button size="xs" variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return empty === undefined ? null : (
    <div className="applications-state">{empty}</div>
  );
}

function ScopeSelector({
  scopes,
  onChange,
}: {
  readonly scopes: ReadonlyArray<ExternalApiApplicationScope>;
  readonly onChange: (
    scopes: ReadonlyArray<ExternalApiApplicationScope>,
  ) => void;
}) {
  const selected = React.useMemo(() => new Set(scopes), [scopes]);
  const toggle = (scope: ExternalApiApplicationScope) =>
    onChange(
      selected.has(scope)
        ? scopes.filter((candidate) => candidate !== scope)
        : [...scopes, scope],
    );
  return (
    <fieldset className="application-scopes">
      <legend>Product API scopes</legend>
      {externalApiApplicationScopes.map((scope) => (
        <label key={scope}>
          <input
            type="checkbox"
            checked={selected.has(scope)}
            onChange={() => toggle(scope)}
          />
          <span>
            <strong>{scopeLabels[scope]}</strong>
            <code>{scope}</code>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function SecretDialog({
  secret,
  close,
}: {
  readonly secret?: ExternalApiApplicationSecretData;
  readonly close: () => void;
}) {
  const [copyStatus, setCopyStatus] = React.useState("");
  const closeDialog = () => {
    setCopyStatus("");
    close();
  };
  const copy = async () => {
    if (secret === undefined) return;
    try {
      await navigator.clipboard.writeText(
        `${secret.application.clientId}:${secret.clientSecret}`,
      );
      setCopyStatus("Client credentials copied.");
    } catch {
      setCopyStatus("Select each value and copy it manually.");
    }
  };
  return (
    <DialogRoot
      open={secret !== undefined}
      onOpenChange={(open) => !open && closeDialog()}
    >
      {secret === undefined ? null : (
        <DialogContent className="application-dialog application-secret-dialog">
          <DialogTitle>
            Copy {secret.application.name} credentials now
          </DialogTitle>
          <DialogDescription>
            The client secret is shown once. dx stores only its SHA-256 hash and
            cannot display it again.
          </DialogDescription>
          <div className="application-secret-values">
            <label htmlFor="application-client-id">
              Client ID
              <Input
                id="application-client-id"
                aria-label="Client ID"
                value={secret.application.clientId}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <label htmlFor="application-client-secret">
              Client secret
              <Input
                id="application-client-secret"
                aria-label="Client secret"
                value={secret.clientSecret}
                readOnly
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          </div>
          <p className="application-credential-note">
            Send these as HTTP Basic credentials to stable `/v1/projects` and
            `/v1/threads` routes. No user authorization flow is available.
          </p>
          <p aria-live="polite">{copyStatus}</p>
          <footer className="application-dialog-actions">
            <Button variant="outline" onClick={() => void copy()}>
              <ClipboardCopy aria-hidden="true" /> Copy both
            </Button>
            <Button onClick={closeDialog}>I’ve saved them</Button>
          </footer>
        </DialogContent>
      )}
    </DialogRoot>
  );
}

function ApplicationEditorDialog({
  workspaceSlug,
  application,
  close,
  saved,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly application?: ExternalApiApplicationData;
  readonly close: () => void;
  readonly saved: (secret?: ExternalApiApplicationSecretData) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    applicationMutationOptions(queryClient, identity.id, workspaceSlug),
  );
  const editing = application !== undefined;
  const [name, setName] = React.useState(application?.name ?? "");
  const [scopes, setScopes] = React.useState<
    ReadonlyArray<ExternalApiApplicationScope>
  >(application?.scopes ?? []);
  const [rateLimit, setRateLimit] = React.useState(
    application?.rateLimitPerMinute ?? 60,
  );
  const [error, setError] = React.useState<string>();

  const submit = async () => {
    if (mutation.isPending) return;
    setError(undefined);
    try {
      const input = { name, scopes, rateLimitPerMinute: rateLimit };
      if (application === undefined) {
        const result = await mutation.mutateAsync({ kind: "create", input });
        saved(result.secret);
      } else {
        await mutation.mutateAsync({
          kind: "update",
          applicationId: application.id,
          input,
        });
        saved();
      }
      close();
    } catch (cause) {
      setError(errorMessage(cause, "The application could not be saved."));
    } finally {
      mutation.reset();
    }
  };

  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog">
        <DialogTitle>
          {editing ? `Edit ${application.name}` : "Create an API application"}
        </DialogTitle>
        <DialogDescription>
          Machine credentials act as your dx identity and can access only the
          stable product actions selected below.
        </DialogDescription>
        <form
          className="application-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="application-name">
            Application name
            <Input
              id="application-name"
              autoFocus
              required
              maxLength={64}
              placeholder="Deployment automation"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ScopeSelector scopes={scopes} onChange={setScopes} />
          <label htmlFor="application-rate-limit">
            Requests per minute
            <Input
              id="application-rate-limit"
              type="number"
              min={10}
              max={1000}
              required
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.valueAsNumber)}
            />
          </label>
          {error === undefined ? null : <p role="alert">{error}</p>}
          <footer>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || scopes.length === 0}
            >
              {mutation.isPending
                ? "Saving…"
                : editing
                  ? "Save application"
                  : "Create application"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

type ApplicationAction = {
  readonly kind: "rotate" | "disable" | "revoke";
  readonly application: ExternalApiApplicationData;
};

function ApplicationActionDialog({
  workspaceSlug,
  action,
  close,
  completed,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly action: ApplicationAction;
  readonly close: () => void;
  readonly completed: (secret?: ExternalApiApplicationSecretData) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    applicationMutationOptions(queryClient, identity.id, workspaceSlug),
  );
  const [overlapSeconds, setOverlapSeconds] =
    React.useState<ExternalApiApplicationRotationOverlapSeconds>(0);
  const [error, setError] = React.useState<string>();
  const mutate = async () => {
    if (mutation.isPending) return;
    setError(undefined);
    try {
      if (action.kind === "rotate") {
        const result = await mutation.mutateAsync({
          kind: "rotate",
          applicationId: action.application.id,
          overlapSeconds,
        });
        completed(result.secret);
      } else if (action.kind === "disable") {
        await mutation.mutateAsync({
          kind: "enabled",
          applicationId: action.application.id,
          enabled: false,
        });
        completed();
      } else {
        await mutation.mutateAsync({
          kind: "revoke",
          applicationId: action.application.id,
        });
        completed();
      }
      close();
    } catch (cause) {
      setError(errorMessage(cause, "The application could not be updated."));
    } finally {
      mutation.reset();
    }
  };
  const title =
    action.kind === "rotate"
      ? `Rotate ${action.application.name} secret?`
      : action.kind === "disable"
        ? `Disable ${action.application.name}?`
        : `Revoke ${action.application.name}?`;
  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {action.kind === "rotate"
            ? "A replacement secret will be shown once. Choose the shortest overlap your machine rollout needs."
            : action.kind === "disable"
              ? "All credentials stop authenticating immediately. You can enable the application later."
              : "All credentials stop authenticating immediately. Revocation is permanent."}
        </DialogDescription>
        {action.kind === "rotate" ? (
          <label className="application-overlap">
            Previous secret overlap
            <select
              value={overlapSeconds}
              onChange={(event) =>
                setOverlapSeconds(
                  Number(
                    event.target.value,
                  ) as ExternalApiApplicationRotationOverlapSeconds,
                )
              }
            >
              <option value={0}>No overlap</option>
              <option value={300}>5 minutes</option>
              <option value={3600}>1 hour</option>
              <option value={86400}>24 hours (maximum)</option>
            </select>
          </label>
        ) : null}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <footer className="application-dialog-actions">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={action.kind === "revoke" ? "destructive" : "default"}
            disabled={mutation.isPending}
            onClick={() => void mutate()}
          >
            {mutation.isPending
              ? "Working…"
              : action.kind === "rotate"
                ? "Rotate secret"
                : action.kind === "disable"
                  ? "Disable application"
                  : "Revoke permanently"}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function AuditDialog({
  workspaceSlug,
  application,
  close,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly application: ExternalApiApplicationData;
  readonly close: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const auditQuery = useInfiniteQuery(
    applicationAuditQueryOptions(identity.id, workspaceSlug, application.id),
  );
  const events = auditQuery.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog application-audit-dialog">
        <DialogTitle>{application.name} audit events</DialogTitle>
        <DialogDescription>
          Immutable events use stable application, credential, actor, and
          request IDs instead of mutable display names.
        </DialogDescription>
        {auditQuery.isPending ||
        (auditQuery.error !== null && !auditQuery.isFetchNextPageError) ? (
          <ApplicationsState
            loading={auditQuery.isPending}
            error={
              auditQuery.error instanceof Error
                ? auditQuery.error.message
                : undefined
            }
            retry={() => void auditQuery.refetch()}
          />
        ) : events.length === 0 ? (
          <ApplicationsState empty="No audit events have been recorded." />
        ) : (
          <div className="application-audit-list">
            {events.map((event) => (
              <AuditEventRow event={event} key={event.id} />
            ))}
          </div>
        )}
        {auditQuery.isFetchNextPageError ? (
          <p role="alert">
            {errorMessage(
              auditQuery.error,
              "Older audit events could not be loaded.",
            )}
          </p>
        ) : null}
        {!auditQuery.hasNextPage ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={auditQuery.isFetchingNextPage}
            onClick={() => void auditQuery.fetchNextPage()}
          >
            {auditQuery.isFetchingNextPage ? "Loading…" : "Load older events"}
          </Button>
        )}
        <footer className="application-dialog-actions">
          <Button onClick={close}>Done</Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function AuditEventRow({
  event,
}: {
  readonly event: ExternalApiApplicationAuditEventData;
}) {
  return (
    <article>
      <Activity aria-hidden="true" />
      <div>
        <strong>{event.action.replaceAll("_", " ")}</strong>
        <small>
          {event.outcome} · {formatDateTime(event.createdAt)}
        </small>
        <code>{event.requestId}</code>
      </div>
      {event.scope === undefined ? null : <Badge>{event.scope}</Badge>}
    </article>
  );
}

function ApplicationRow({
  application,
  canManage,
  edit,
  act,
  audit,
  enable,
}: {
  readonly application: ExternalApiApplicationData;
  readonly canManage: boolean;
  readonly edit: () => void;
  readonly act: (kind: ApplicationAction["kind"]) => void;
  readonly audit: () => void;
  readonly enable: () => void;
}) {
  return (
    <article className="application-row">
      <span className="application-icon" aria-hidden="true">
        <KeyRound />
      </span>
      <div className="application-identity">
        <div>
          <strong>{application.name}</strong>
          <Badge data-status={application.status}>{application.status}</Badge>
        </div>
        <code>{application.clientId}</code>
        <small>
          Owner {application.owner.name} ·{" "}
          {application.lastUsedAt === undefined
            ? "Never used"
            : `Last used ${formatDateTime(application.lastUsedAt)}`}
        </small>
        <div className="application-scope-badges">
          {application.scopes.map((scope) => (
            <Badge key={scope}>{scope}</Badge>
          ))}
          <Badge>{application.rateLimitPerMinute}/min</Badge>
        </div>
      </div>
      <div className="application-actions">
        <Button size="xs" variant="ghost" onClick={audit}>
          <Activity aria-hidden="true" /> Audit
        </Button>
        {canManage && application.status !== "revoked" ? (
          <>
            <Button size="xs" variant="outline" onClick={edit}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
            {application.status === "active" ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => act("rotate")}
                >
                  <RefreshCw aria-hidden="true" /> Rotate
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => act("disable")}
                >
                  <Power aria-hidden="true" /> Disable
                </Button>
              </>
            ) : (
              <Button size="xs" variant="outline" onClick={enable}>
                <Power aria-hidden="true" /> Enable
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => act("revoke")}>
              <Trash2 aria-hidden="true" /> Revoke
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

export function ExternalApiApplicationsSettings({
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) {
    return <ApplicationsState error="A workspace route is required." />;
  }
  return <WorkspaceApplications workspaceSlug={workspaceSlug} />;
}

function WorkspaceApplications({
  workspaceSlug,
}: {
  readonly workspaceSlug: WorkspaceSlug;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const applicationsQuery = useInfiniteQuery(
    applicationsQueryOptions(identity.id, workspaceSlug),
  );
  const mutation = useMutation(
    applicationMutationOptions(queryClient, identity.id, workspaceSlug),
  );
  const [editor, setEditor] = React.useState<
    ExternalApiApplicationData | "create"
  >();
  const [action, setAction] = React.useState<ApplicationAction>();
  const [audit, setAudit] = React.useState<ExternalApiApplicationData>();
  const [secret, setSecret] =
    React.useState<ExternalApiApplicationSecretData>();
  const [error, setError] = React.useState<string>();
  const pages = applicationsQuery.data?.pages;
  const applications = pages?.flatMap((page) => page.items) ?? [];
  const canManage =
    pages?.[0]?.permissions.includes("applications:manage") ?? false;
  const changed = (nextSecret?: ExternalApiApplicationSecretData) => {
    setSecret(nextSecret);
  };
  const enable = async (application: ExternalApiApplicationData) => {
    setError(undefined);
    try {
      await mutation.mutateAsync({
        kind: "enabled",
        applicationId: application.id,
        enabled: true,
      });
    } catch (cause) {
      setError(errorMessage(cause, "The application could not be enabled."));
    }
  };
  return (
    <div className="external-api-applications-settings">
      <SettingsHeading
        title="External API Applications"
        description="Workspace-owned machine clients with narrow access to stable dx product APIs."
      />
      <SettingsCard title="Credential architecture">
        <SettingsRow
          title="Machine client credentials"
          badge="No user delegation"
          description="Client secrets are shown once and hashed at rest. Redirect URIs and authorization-code flows are intentionally omitted."
        />
        <SettingsRow
          title="Stable product actions only"
          description="Applications can read or create projects and threads. Settings, administration, experimental endpoints, and Flue-native agent routes cannot be granted."
        />
      </SettingsCard>
      <SettingsCard title="Applications">
        <div className="application-toolbar">
          <div>
            <strong>Workspace applications</strong>
            <p>
              Per-app rate limits and immutable attribution are enforced in
              Core.
            </p>
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setEditor("create")}>
              <KeyRound aria-hidden="true" /> Create application
            </Button>
          ) : null}
        </div>
        {error === undefined ? null : <p role="alert">{error}</p>}
        {applicationsQuery.isPending ||
        (applicationsQuery.error !== null &&
          !applicationsQuery.isFetchNextPageError) ? (
          <ApplicationsState
            loading={applicationsQuery.isPending}
            error={
              applicationsQuery.error instanceof Error
                ? applicationsQuery.error.message
                : undefined
            }
            retry={() => void applicationsQuery.refetch()}
          />
        ) : applications.length === 0 ? (
          <ApplicationsState empty="No external API applications have been created." />
        ) : (
          <div className="application-list">
            {applications.map((application) => (
              <ApplicationRow
                application={application}
                canManage={canManage}
                key={application.id}
                edit={() => setEditor(application)}
                audit={() => setAudit(application)}
                act={(kind) => setAction({ kind, application })}
                enable={() => void enable(application)}
              />
            ))}
          </div>
        )}
        {applicationsQuery.isFetchNextPageError ? (
          <p role="alert">
            {errorMessage(
              applicationsQuery.error,
              "More applications could not be loaded.",
            )}
          </p>
        ) : null}
        {!applicationsQuery.hasNextPage ? null : (
          <div className="applications-more">
            <Button
              size="sm"
              variant="outline"
              disabled={applicationsQuery.isFetchingNextPage}
              onClick={() => void applicationsQuery.fetchNextPage()}
            >
              {applicationsQuery.isFetchingNextPage
                ? "Loading…"
                : "Load more applications"}
            </Button>
          </div>
        )}
      </SettingsCard>
      {editor === undefined ? null : (
        <ApplicationEditorDialog
          workspaceSlug={workspaceSlug}
          application={editor === "create" ? undefined : editor}
          close={() => setEditor(undefined)}
          saved={changed}
        />
      )}
      {action === undefined ? null : (
        <ApplicationActionDialog
          workspaceSlug={workspaceSlug}
          action={action}
          close={() => setAction(undefined)}
          completed={changed}
        />
      )}
      {audit === undefined ? null : (
        <AuditDialog
          workspaceSlug={workspaceSlug}
          application={audit}
          close={() => setAudit(undefined)}
        />
      )}
      <SecretDialog secret={secret} close={() => setSecret(undefined)} />
    </div>
  );
}
