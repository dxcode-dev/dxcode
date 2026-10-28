import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsHeading, SettingsToggle } from "../settings-primitives.js";
import {
  IntegrationCard,
  IntegrationGroup,
  McpLogo,
} from "./integration-card.js";
import { MCP_TEMPLATES, type McpTemplate } from "./mcp-catalog.js";
import {
  beginMcpServerSignIn,
  mcpServersMutationOptions,
} from "./mcp-mutations.js";
import {
  type McpServerData,
  type McpServersTarget,
  mcpServersQueryOptions,
} from "./mcp-queries.js";
import {
  emptyMcpFields,
  type McpFieldErrors,
  type McpServerFields,
  mcpCreateInput,
  mcpFieldErrors,
  mcpFieldErrorsAfterEdit,
  mcpFieldErrorsShown,
  mcpFieldsComplete,
  mcpFieldsForTemplate,
  mcpServerStatus,
  mcpTemplateForEndpoint,
} from "./mcp-server-fields.js";
import { McpServerForm } from "./mcp-server-form.js";
import { type McpRun, McpServerSheet } from "./mcp-server-sheet.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/** A card that may be hidden by the search, with what the search matches. */
export interface IntegrationEntry {
  readonly key: string;
  readonly search: string;
  readonly node: React.ReactNode;
}

const matches = (entry: IntegrationEntry, query: string) =>
  query.trim() === "" ||
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => entry.search.toLowerCase().includes(word));

/** What the OAuth callback left in the URL, read once and then removed. */
const takeOAuthReturn = () => {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("mcpStatus");
  if (status === null) return undefined;
  return {
    serverId: params.get("mcp") ?? undefined,
    connected: status === "connected",
    message: params.get("mcpMessage") ?? undefined,
  };
};

function ConnectDialog({
  template,
  open,
  busy,
  workspace,
  onSubmit,
  onDirtyChange,
  onClose,
}: {
  readonly template?: McpTemplate;
  readonly open: boolean;
  readonly busy: boolean;
  readonly workspace: boolean;
  readonly onSubmit: (
    fields: McpServerFields,
    onFieldErrors: (errors: McpFieldErrors) => void,
  ) => Promise<void>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onClose: () => void;
}) {
  const id = React.useId();
  const [fields, setFields] = React.useState<McpServerFields>(() =>
    template === undefined ? emptyMcpFields : mcpFieldsForTemplate(template),
  );
  const [errors, setErrors] = React.useState<McpFieldErrors>({});
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <DialogContent className="mcp-connect-dialog">
          <DialogTitle>Add MCP Server</DialogTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await onSubmit(fields, setErrors);
            }}
          >
            <McpServerForm
              id={id}
              fields={fields}
              errors={errors}
              disabled={busy}
              template={template ?? mcpTemplateForEndpoint(fields.endpoint)}
              onChange={(next) => {
                setErrors(mcpFieldErrorsAfterEdit(errors, fields, next));
                setFields(next);
                onDirtyChange(true);
              }}
            />
            {workspace ? (
              <p className="mcp-form-help">
                Every member's Threads can use this server. With OAuth, each
                member signs in with their own account.
              </p>
            ) : null}
            <footer className="mcp-dialog-actions">
              <Button size="xs" variant="ghost" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="xs"
                type="submit"
                disabled={
                  busy ||
                  !mcpFieldsComplete(fields) ||
                  mcpFieldErrorsShown(errors)
                }
              >
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </footer>
          </form>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function PolicyCard({
  allowed,
  disabled,
  run,
}: {
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly run: McpRun;
}) {
  const [confirming, setConfirming] = React.useState<boolean>();
  return (
    <>
      <IntegrationCard
        label="Personal MCP servers"
        icon={<McpLogo />}
        title="Personal MCP Servers"
        action={
          <SettingsToggle
            checked={allowed}
            disabled={disabled}
            label="Allow personal MCP servers"
            onCheckedChange={setConfirming}
          />
        }
        description="Allow personal MCP servers: members' Threads also use the servers they add in personal settings."
      />
      <DialogRoot
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        {confirming === undefined ? null : (
          <DialogContent>
            <DialogTitle>
              {confirming ? "Allow" : "Block"} personal MCP servers?
            </DialogTitle>
            <DialogDescription>
              Members' next calls follow the new policy.
            </DialogDescription>
            <footer className="mcp-dialog-actions">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={async () => {
                  const done = await run(
                    { type: "updatePolicy", allowPersonalServers: confirming },
                    "Workspace MCP policy updated.",
                  );
                  if (done) setConfirming(undefined);
                }}
              >
                Confirm
              </Button>
            </footer>
          </DialogContent>
        )}
      </DialogRoot>
    </>
  );
}

/**
 * The Integrations & MCP page body: heading, search, and the Enabled,
 * Disabled, and Available groups. Source control cards come from the page;
 * MCP servers, templates, and their dialogs live here.
 */
export function McpIntegrations({
  target,
  description,
  scopeLink,
  integrations,
  onDirtyChange,
}: {
  readonly target: McpServersTarget;
  readonly description: string;
  /** The link to the other settings scope, beside Add MCP Server. */
  readonly scopeLink?: React.ReactNode;
  readonly integrations: {
    readonly enabled: ReadonlyArray<IntegrationEntry>;
    readonly available: ReadonlyArray<IntegrationEntry>;
  };
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const resource = useQuery(mcpServersQueryOptions(identity.id, target));
  const mutation = useMutation(
    mcpServersMutationOptions(queryClient, identity.id, target),
  );
  const [returned] = React.useState(takeOAuthReturn);
  const [status, setStatus] = React.useState<string | undefined>(() =>
    returned === undefined
      ? undefined
      : returned.connected
        ? "Signed in."
        : (returned.message ?? "The sign-in failed."),
  );
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [connecting, setConnecting] = React.useState<{
    readonly template?: McpTemplate;
  }>();
  const [openServerId, setOpenServerId] = React.useState(returned?.serverId);
  useMountEffect(() => {
    if (returned === undefined) return;
    const url = new URL(window.location.href);
    for (const key of ["mcp", "mcpStatus", "mcpMessage"])
      url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  });
  const run: McpRun = async (action, message, onFieldErrors) => {
    setBusy(true);
    setStatus(undefined);
    const outcome = await settle(async () => {
      await mutation.mutateAsync(action);
      setStatus(message);
    });
    if (!outcome.ok) {
      const fieldErrors =
        onFieldErrors === undefined ? undefined : mcpFieldErrors(outcome.error);
      if (fieldErrors === undefined) setStatus(errorMessage(outcome.error));
      else onFieldErrors?.(fieldErrors);
    }
    setBusy(false);
    return outcome.ok;
  };
  const signIn = async (server: McpServerData) => {
    setBusy(true);
    setStatus(undefined);
    const outcome = await settle(() => beginMcpServerSignIn(target, server.id));
    if (outcome.ok) {
      onDirtyChange(false);
      window.location.assign(outcome.value);
      return;
    }
    setStatus(errorMessage(outcome.error));
    setBusy(false);
  };
  const connect = async (
    fields: McpServerFields,
    onFieldErrors: (errors: McpFieldErrors) => void,
  ) => {
    setBusy(true);
    setStatus(undefined);
    const outcome = await settle(() =>
      mutation.mutateAsync({ type: "create", input: mcpCreateInput(fields) }),
    );
    if (!outcome.ok) {
      const fieldErrors = mcpFieldErrors(outcome.error);
      if (fieldErrors === undefined) setStatus(errorMessage(outcome.error));
      else onFieldErrors(fieldErrors);
      setBusy(false);
      return;
    }
    const created = outcome.value as McpServerData;
    setConnecting(undefined);
    onDirtyChange(false);
    setBusy(false);
    if (created.authType === "oauth") {
      await signIn(created);
      return;
    }
    setStatus(
      created.healthStatus === "unhealthy"
        ? `${created.name} was added, but dx could not connect to it.`
        : `${created.name} connected.`,
    );
    setOpenServerId(created.id);
  };
  const canMutate = resource.data?.canMutate ?? false;
  const servers = resource.data?.items ?? [];
  const workspace = target.scope === "workspace";
  const usedTemplates = new Set(
    servers.flatMap((server) => {
      const template = mcpTemplateForEndpoint(server.endpoint);
      return template === undefined ? [] : [template.id];
    }),
  );
  const serverEntry = (server: McpServerData): IntegrationEntry => {
    const template = mcpTemplateForEndpoint(server.endpoint);
    return {
      key: server.id,
      search: `${server.name} ${server.endpoint} ${template?.description ?? ""}`,
      node: (
        <IntegrationCard
          key={server.id}
          label={`${server.name} MCP server`}
          icon={<McpLogo template={template} />}
          title={server.name}
          mcp
          action={
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Configure ${server.name}`}
              onClick={() => setOpenServerId(server.id)}
            >
              Configure
            </Button>
          }
          description={template?.description ?? new URL(server.endpoint).host}
          status={mcpServerStatus(server)}
        />
      ),
    };
  };
  const templateEntry = (template: McpTemplate): IntegrationEntry => ({
    key: `template-${template.id}`,
    search: `${template.name} ${template.description}`,
    node: (
      <IntegrationCard
        key={`template-${template.id}`}
        label={`${template.name} MCP server`}
        icon={<McpLogo template={template} />}
        title={template.name}
        mcp
        action={
          canMutate ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${workspace ? "Enable" : "Connect"} ${template.name} MCP server`}
              onClick={() => setConnecting({ template })}
            >
              {workspace ? "Enable" : "Connect"}
            </Button>
          ) : undefined
        }
        description={template.description}
      />
    ),
  });
  const policy =
    workspace && resource.data?.allowPersonalServers !== undefined
      ? {
          key: "policy",
          search: "personal mcp servers policy",
          node: (
            <PolicyCard
              key="policy"
              allowed={resource.data.allowPersonalServers}
              disabled={!canMutate || busy}
              run={run}
            />
          ),
        }
      : undefined;
  const visible = (entry: IntegrationEntry) => matches(entry, query);
  const enabled = [
    ...integrations.enabled,
    ...(policy === undefined ? [] : [policy]),
    ...servers.flatMap((server) =>
      server.enabled ? [serverEntry(server)] : [],
    ),
  ].filter(visible);
  const disabled = servers.flatMap((server) => {
    if (server.enabled) return [];
    const entry = serverEntry(server);
    return visible(entry) ? [entry] : [];
  });
  const available = [
    ...integrations.available,
    ...MCP_TEMPLATES.flatMap((template) =>
      usedTemplates.has(template.id) ? [] : [templateEntry(template)],
    ),
  ].filter(visible);
  const openServer = servers.find(({ id }) => id === openServerId);
  return (
    <div className="integrations-settings">
      <SettingsHeading
        title="Integrations & MCP"
        description={description}
        actions={
          <div className="integrations-heading-actions">
            {scopeLink}
            {canMutate ? (
              <Button size="sm" onClick={() => setConnecting({})}>
                <Plus /> Add MCP Server
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="integrations-search">
        <Search aria-hidden="true" />
        <Input
          type="search"
          aria-label="Search integrations"
          placeholder="Search integrations…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {status === undefined ? null : (
        <p className="integrations-status" role="status">
          {status}
        </p>
      )}
      {resource.error === null ? null : (
        <p className="integrations-status" role="alert">
          {errorMessage(resource.error)}{" "}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void resource.refetch()}
          >
            Retry
          </Button>
        </p>
      )}
      <IntegrationGroup title="Enabled">
        {enabled.map((entry) => entry.node)}
      </IntegrationGroup>
      <IntegrationGroup title="Disabled">
        {disabled.map((entry) => entry.node)}
      </IntegrationGroup>
      <IntegrationGroup title="Available">
        {available.map((entry) => entry.node)}
      </IntegrationGroup>
      {enabled.length + disabled.length + available.length === 0 ? (
        <p className="integrations-empty">
          {resource.isPending ? "Loading…" : "No integrations match."}
        </p>
      ) : null}
      <ConnectDialog
        key={connecting?.template?.id ?? (connecting ? "custom" : "idle")}
        template={connecting?.template}
        open={connecting !== undefined}
        busy={busy}
        workspace={workspace}
        onSubmit={connect}
        onDirtyChange={onDirtyChange}
        onClose={() => {
          setConnecting(undefined);
          onDirtyChange(false);
        }}
      />
      <McpServerSheet
        key={openServer?.id ?? "closed"}
        server={openServer}
        canMutate={canMutate}
        busy={busy}
        run={run}
        onSignIn={(server) => void signIn(server)}
        onDirtyChange={onDirtyChange}
        onClose={() => setOpenServerId(undefined)}
      />
    </div>
  );
}
