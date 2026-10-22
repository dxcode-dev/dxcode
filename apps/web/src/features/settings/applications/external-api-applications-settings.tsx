import "./applications.css";
import { Menu } from "@base-ui/react/menu";
import type {
  ExternalApiApplicationAuditEventData,
  ExternalApiApplicationData,
  ExternalApiApplicationSecretData,
} from "@dx/api";
import {
  type ExternalApiApplicationRotationOverlapSeconds,
  type ExternalApiApplicationScope,
  type ExternalApiApplicationStatus,
  externalApiApplicationScopes,
  type WorkspaceSlug,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import { Check, Copy, Ellipsis, Plus } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { applicationMutationOptions } from "./application-mutations.js";
import {
  applicationAuditQueryOptions,
  applicationsQueryOptions,
} from "./application-queries.js";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const toDate = (value: DateTime.Utc) => new Date(DateTime.formatIso(value));

const scopeLabels: Record<ExternalApiApplicationScope, string> = {
  "projects:read": "Read projects",
  "projects:write": "Create projects",
  "threads:read": "Read threads",
  "threads:write": "Create threads",
};

const statusLabels: Record<ExternalApiApplicationStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  revoked: "Revoked",
};

const auditActionLabels: Record<string, string> = {
  "external_api_application.create": "Created",
  "external_api_application.update": "Edited",
  "external_api_application.rotate": "Secret rotated",
  "external_api_application.enable": "Enabled",
  "external_api_application.disable": "Disabled",
  "external_api_application.revoke": "Revoked",
};

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function CopyField({
  id,
  label,
  value,
  copied,
  copy,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly copied: boolean;
  readonly copy: () => void;
}) {
  return (
    <div className="application-field">
      <label htmlFor={id}>{label}</label>
      <div className="application-copy-field">
        <Input
          id={id}
          value={value}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={copy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

type CopyStatus = {
  readonly label: "Client ID" | "Client secret";
  readonly ok: boolean;
};

function SecretDialog({
  secret,
  close,
}: {
  readonly secret: ExternalApiApplicationSecretData;
  readonly close: () => void;
}) {
  const [copyStatus, setCopyStatus] = React.useState<CopyStatus>();
  const copy = async (label: CopyStatus["label"], value: string) => {
    const outcome = await settle(() => navigator.clipboard.writeText(value));
    setCopyStatus({ label, ok: outcome.ok });
  };
  const copiedLabel = copyStatus?.ok === true ? copyStatus.label : undefined;
  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog">
        <DialogTitle>Save the client secret</DialogTitle>
        <DialogDescription>
          dx shows this secret once. Send the pair as HTTP Basic credentials.
        </DialogDescription>
        <CopyField
          id="application-client-id"
          label="Client ID"
          value={secret.application.clientId}
          copied={copiedLabel === "Client ID"}
          copy={() => void copy("Client ID", secret.application.clientId)}
        />
        <CopyField
          id="application-client-secret"
          label="Client secret"
          value={secret.clientSecret}
          copied={copiedLabel === "Client secret"}
          copy={() => void copy("Client secret", secret.clientSecret)}
        />
        <footer className="application-dialog-actions">
          <p className="application-copy-status" aria-live="polite">
            {copyStatus === undefined
              ? null
              : copyStatus.ok
                ? `${copyStatus.label} copied.`
                : "Copy failed. Select the value and copy it manually."}
          </p>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </footer>
      </DialogContent>
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
  const [name, setName] = React.useState(application?.name ?? "");
  const [scopes, setScopes] = React.useState<
    ReadonlyArray<ExternalApiApplicationScope>
  >(application?.scopes ?? []);
  const [rateLimit, setRateLimit] = React.useState(
    application?.rateLimitPerMinute ?? 60,
  );
  const [error, setError] = React.useState<string>();
  const selected = new Set(scopes);
  const toggle = (scope: ExternalApiApplicationScope) =>
    setScopes(
      selected.has(scope)
        ? scopes.filter((candidate) => candidate !== scope)
        : [...scopes, scope],
    );

  const submit = async () => {
    if (mutation.isPending) return;
    setError(undefined);
    const input = { name, scopes, rateLimitPerMinute: rateLimit };
    const outcome = await settle(() =>
      application === undefined
        ? mutation.mutateAsync({ kind: "create", input })
        : mutation.mutateAsync({
            kind: "update",
            applicationId: application.id,
            input,
          }),
    );
    mutation.reset();
    if (!outcome.ok) {
      setError(
        errorMessage(outcome.error, "The application could not be saved."),
      );
      return;
    }
    close();
    saved(outcome.value.secret);
  };

  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog">
        <DialogTitle>
          {application === undefined
            ? "Create Application"
            : `Edit ${application.name}`}
        </DialogTitle>
        <form
          className="application-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="application-field">
            <label htmlFor="application-name">Name</label>
            <Input
              id="application-name"
              autoFocus
              required
              maxLength={64}
              placeholder="Deploy bot"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset className="application-field application-scopes">
            <legend>Access</legend>
            {externalApiApplicationScopes.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={selected.has(scope)}
                  onChange={() => toggle(scope)}
                />
                {scopeLabels[scope]}
              </label>
            ))}
          </fieldset>
          <div className="application-field">
            <label htmlFor="application-rate-limit">Requests per minute</label>
            <Input
              id="application-rate-limit"
              type="number"
              min={10}
              max={1000}
              required
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.valueAsNumber)}
            />
          </div>
          {error === undefined ? null : (
            <p className="application-error" role="alert">
              {error}
            </p>
          )}
          <footer className="application-dialog-actions">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={mutation.isPending || scopes.length === 0}
            >
              {mutation.isPending
                ? "Saving…"
                : application === undefined
                  ? "Create"
                  : "Save"}
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

const actionCopy = {
  rotate: {
    title: "Rotate secret?",
    body: "dx shows the new secret once. The current secret stops working after the overlap you choose.",
    confirm: "Rotate",
  },
  disable: {
    title: "Disable application?",
    body: "Requests with its credentials fail until you enable it again.",
    confirm: "Disable",
  },
  revoke: {
    title: "Revoke application?",
    body: "Its credentials stop working for good. The audit log stays.",
    confirm: "Revoke",
  },
} as const;

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
  const applicationId = action.application.id;
  const mutate = async () => {
    if (mutation.isPending) return;
    setError(undefined);
    const outcome = await settle(() =>
      action.kind === "rotate"
        ? mutation.mutateAsync({
            kind: "rotate",
            applicationId,
            overlapSeconds,
          })
        : action.kind === "disable"
          ? mutation.mutateAsync({
              kind: "enabled",
              applicationId,
              enabled: false,
            })
          : mutation.mutateAsync({ kind: "revoke", applicationId }),
    );
    mutation.reset();
    if (!outcome.ok) {
      setError(
        errorMessage(outcome.error, "The application could not be updated."),
      );
      return;
    }
    close();
    completed(outcome.value.secret);
  };
  const copy = actionCopy[action.kind];
  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <DialogContent className="application-dialog">
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body}</DialogDescription>
        {action.kind === "rotate" ? (
          <div className="application-field">
            <label htmlFor="application-overlap">Keep the current secret</label>
            <select
              id="application-overlap"
              className="settings-select"
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
              <option value={86400}>24 hours</option>
            </select>
          </div>
        ) : null}
        {error === undefined ? null : (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
        <footer className="application-dialog-actions">
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={action.kind === "rotate" ? "default" : "destructive"}
            disabled={mutation.isPending}
            onClick={() => void mutate()}
          >
            {mutation.isPending ? "Working…" : copy.confirm}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

const auditEventLabel = (event: ExternalApiApplicationAuditEventData) =>
  event.action === "external_api_application.request"
    ? `${event.method ?? "Request"} ${event.path ?? ""}`.trim()
    : (auditActionLabels[event.action] ?? event.action);

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
        <DialogTitle>{application.name} audit</DialogTitle>
        {auditQuery.isPending ? (
          <p className="application-empty" role="status">
            Loading…
          </p>
        ) : auditQuery.isError && events.length === 0 ? (
          <div className="application-error" role="alert">
            {errorMessage(auditQuery.error, "The audit could not be loaded.")}{" "}
            <Button
              size="xs"
              variant="outline"
              disabled={auditQuery.isFetching}
              onClick={() => void auditQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p className="application-empty">No events yet.</p>
        ) : (
          <ul className="application-audit-list">
            {events.map((event) => (
              <li key={event.id}>
                <span className="application-audit-action">
                  {auditEventLabel(event)}
                </span>
                {event.outcome === "rejected" ? (
                  <span className="application-audit-rejected">Rejected</span>
                ) : null}
                <time dateTime={DateTime.formatIso(event.createdAt)}>
                  {dateTimeFormatter.format(toDate(event.createdAt))}
                </time>
              </li>
            ))}
          </ul>
        )}
        {auditQuery.isFetchNextPageError ? (
          <p className="application-error" role="alert">
            {errorMessage(
              auditQuery.error,
              "Older events could not be loaded.",
            )}
          </p>
        ) : null}
        <footer className="application-dialog-actions">
          {auditQuery.hasNextPage ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={auditQuery.isFetchingNextPage}
              onClick={() => void auditQuery.fetchNextPage()}
            >
              {auditQuery.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null}
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function ApplicationMenu({
  application,
  canManage,
  edit,
  act,
  audit,
  enable,
  enabling,
}: {
  readonly application: ExternalApiApplicationData;
  readonly canManage: boolean;
  readonly edit: () => void;
  readonly act: (kind: ApplicationAction["kind"]) => void;
  readonly audit: () => void;
  readonly enable: () => void;
  readonly enabling: boolean;
}) {
  const manageable = canManage && application.status !== "revoked";
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Manage ${application.name}`}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup">
            {manageable ? (
              <>
                <Menu.Item className="thread-menu-item" onClick={edit}>
                  Edit
                </Menu.Item>
                {application.status === "active" ? (
                  <>
                    <Menu.Item
                      className="thread-menu-item"
                      onClick={() => act("rotate")}
                    >
                      Rotate Secret
                    </Menu.Item>
                    <Menu.Item
                      className="thread-menu-item"
                      onClick={() => act("disable")}
                    >
                      Disable
                    </Menu.Item>
                  </>
                ) : (
                  <Menu.Item
                    className="thread-menu-item"
                    disabled={enabling}
                    onClick={enable}
                  >
                    {enabling ? "Enabling…" : "Enable"}
                  </Menu.Item>
                )}
              </>
            ) : null}
            <Menu.Item className="thread-menu-item" onClick={audit}>
              View Audit
            </Menu.Item>
            {manageable ? (
              <Menu.Item
                className="thread-menu-item application-danger"
                onClick={() => act("revoke")}
              >
                Revoke
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ExternalApiApplicationsSettings({
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) {
    return (
      <p className="application-error" role="alert">
        A workspace route is required.
      </p>
    );
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
  const [enablingId, setEnablingId] =
    React.useState<ExternalApiApplicationData["id"]>();
  const enable = async (application: ExternalApiApplicationData) => {
    if (enablingId !== undefined) return;
    setEnablingId(application.id);
    setError(undefined);
    const outcome = await settle(() =>
      mutation.mutateAsync({
        kind: "enabled",
        applicationId: application.id,
        enabled: true,
      }),
    );
    setEnablingId(undefined);
    if (!outcome.ok) {
      setError(
        errorMessage(outcome.error, "The application could not be enabled."),
      );
    }
  };
  return (
    <div className="applications-settings">
      <SettingsHeading title="External API Apps" />
      <SettingsCard
        className="applications-card"
        title="Applications"
        description="Machine clients for dx's Project and Thread APIs. Each one signs in with a client ID and secret."
        actions={
          canManage ? (
            <Button size="xs" onClick={() => setEditor("create")}>
              <Plus aria-hidden="true" /> Create Application
            </Button>
          ) : undefined
        }
      >
        {error === undefined ? null : (
          <p className="application-error" role="alert">
            {error}
          </p>
        )}
        {applicationsQuery.isPending ? (
          <p className="application-empty" role="status">
            Loading applications…
          </p>
        ) : applicationsQuery.isError && applications.length === 0 ? (
          <div className="application-empty" role="alert">
            {errorMessage(
              applicationsQuery.error,
              "Applications could not be loaded.",
            )}{" "}
            <Button
              size="xs"
              variant="outline"
              onClick={() => void applicationsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : applications.length === 0 ? (
          <p className="application-empty">No applications yet.</p>
        ) : (
          applications.map((application) => (
            <div
              className="application-row"
              data-status={application.status}
              key={application.id}
            >
              <div className="application-identity">
                <strong>{application.name}</strong>
                <code>{application.clientId}</code>
              </div>
              <div className="application-meta">
                <span className="application-status" aria-live="polite">
                  {enablingId === application.id
                    ? "Enabling…"
                    : statusLabels[application.status]}
                </span>
                <time
                  className="application-created"
                  dateTime={DateTime.formatIso(application.createdAt)}
                >
                  {dateFormatter.format(toDate(application.createdAt))}
                </time>
              </div>
              <div className="application-row-actions">
                <ApplicationMenu
                  application={application}
                  canManage={canManage}
                  edit={() => setEditor(application)}
                  audit={() => setAudit(application)}
                  act={(kind) => setAction({ kind, application })}
                  enable={() => void enable(application)}
                  enabling={enablingId === application.id}
                />
              </div>
            </div>
          ))
        )}
        {applicationsQuery.isFetchNextPageError ? (
          <p className="application-error" role="alert">
            {errorMessage(
              applicationsQuery.error,
              "More applications could not be loaded.",
            )}
          </p>
        ) : null}
        {applicationsQuery.hasNextPage ? (
          <div className="application-more">
            <Button
              size="xs"
              variant="ghost"
              disabled={applicationsQuery.isFetchingNextPage}
              onClick={() => void applicationsQuery.fetchNextPage()}
            >
              {applicationsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </SettingsCard>
      {editor === undefined ? null : (
        <ApplicationEditorDialog
          workspaceSlug={workspaceSlug}
          application={editor === "create" ? undefined : editor}
          close={() => setEditor(undefined)}
          saved={setSecret}
        />
      )}
      {action === undefined ? null : (
        <ApplicationActionDialog
          workspaceSlug={workspaceSlug}
          action={action}
          close={() => setAction(undefined)}
          completed={setSecret}
        />
      )}
      {audit === undefined ? null : (
        <AuditDialog
          workspaceSlug={workspaceSlug}
          application={audit}
          close={() => setAudit(undefined)}
        />
      )}
      {secret === undefined ? null : (
        <SecretDialog secret={secret} close={() => setSecret(undefined)} />
      )}
    </div>
  );
}
