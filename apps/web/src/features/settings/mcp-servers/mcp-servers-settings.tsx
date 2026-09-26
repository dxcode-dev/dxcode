import type {
  EnvironmentVariableConfigReference,
  WorkspaceRole,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
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
import { environmentVariablesQueryOptions } from "../environment-variables/environment-variables-queries.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type McpServersMutationAction,
  mcpServersMutationOptions,
} from "./mcp-servers-mutations.js";
import {
  type EnvironmentVariableData,
  type McpServerData,
  type McpServerInput,
  type McpServersTarget,
  type McpToolData,
  mcpServerProjectsQueryOptions,
  mcpServersQueryOptions,
  type ProjectData,
} from "./mcp-servers-queries.js";

const roles = ["owner", "admin", "member"] as const;

interface EditorValue {
  readonly name: string;
  readonly endpoint: string;
  readonly authReferenceId: string;
  readonly timeoutMs: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<WorkspaceRole>;
}

const emptyEditor = (): EditorValue => ({
  name: "",
  endpoint: "",
  authReferenceId: "",
  timeoutMs: "10000",
  projectIds: [],
  roles: [...roles],
});

const editorFor = (server: McpServerData): EditorValue => ({
  name: server.name,
  endpoint: server.endpoint,
  authReferenceId: server.authReference?.id ?? "",
  timeoutMs: String(server.timeoutMs),
  projectIds: [...server.projectIds],
  roles: [...server.roles],
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

const authReference = (
  id: string,
  secrets: ReadonlyArray<EnvironmentVariableData>,
): EnvironmentVariableConfigReference | undefined =>
  secrets.find((secret) => secret.reference.id === id)?.reference;

const editorInput = (
  value: EditorValue,
  secrets: ReadonlyArray<EnvironmentVariableData>,
): McpServerInput => ({
  name: value.name,
  endpoint: value.endpoint,
  authReference: authReference(value.authReferenceId, secrets),
  timeoutMs: Number(value.timeoutMs),
  projectIds: value.projectIds,
  roles: value.roles,
});

function GrantFields({
  value,
  projects,
  hasMoreProjects,
  loadingMoreProjects,
  workspace,
  disabled,
  onLoadMoreProjects,
  onChange,
}: {
  readonly value: EditorValue;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly hasMoreProjects: boolean;
  readonly loadingMoreProjects: boolean;
  readonly workspace: boolean;
  readonly disabled: boolean;
  readonly onLoadMoreProjects: () => void;
  readonly onChange: (value: EditorValue) => void;
}) {
  const selectedProjects = new Set(value.projectIds);
  const selectedRoles = new Set(value.roles);
  const toggleProject = (projectId: string) =>
    onChange({
      ...value,
      projectIds: value.projectIds.includes(projectId)
        ? value.projectIds.filter((id) => id !== projectId)
        : [...value.projectIds, projectId],
    });
  const toggleRole = (role: WorkspaceRole) => {
    const selected = value.roles.includes(role);
    if (selected && value.roles.length === 1) return;
    onChange({
      ...value,
      roles: selected
        ? value.roles.filter((candidate) => candidate !== role)
        : [...value.roles, role],
    });
  };
  return (
    <div className="mcp-grants">
      <fieldset disabled={disabled}>
        <legend>Project access</legend>
        <p>
          No selection allows this server in every project owned by the current
          user.
        </p>
        <div className="mcp-check-list">
          {projects.length === 0 ? (
            <span>No projects available.</span>
          ) : (
            projects.map((project) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  checked={selectedProjects.has(project.id)}
                  onChange={() => toggleProject(project.id)}
                />
                {project.name}
              </label>
            ))
          )}
        </div>
        {hasMoreProjects ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled || loadingMoreProjects}
            onClick={onLoadMoreProjects}
          >
            {loadingMoreProjects ? "Loading…" : "More projects"}
          </Button>
        ) : null}
      </fieldset>
      {workspace ? (
        <fieldset disabled={disabled}>
          <legend>Workspace roles</legend>
          <div className="mcp-check-list mcp-role-list">
            {roles.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  checked={selectedRoles.has(role)}
                  onChange={() => toggleRole(role)}
                />
                {role}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function ServerEditor({
  id,
  value,
  secrets,
  projects,
  hasMoreProjects,
  loadingMoreProjects,
  workspace,
  disabled,
  submitLabel,
  onChange,
  onLoadMoreProjects,
  onSubmit,
}: {
  readonly id: string;
  readonly value: EditorValue;
  readonly secrets: ReadonlyArray<EnvironmentVariableData>;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly hasMoreProjects: boolean;
  readonly loadingMoreProjects: boolean;
  readonly workspace: boolean;
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly onChange: (value: EditorValue) => void;
  readonly onLoadMoreProjects: () => void;
  readonly onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form id={id} className="mcp-server-form" onSubmit={onSubmit}>
      <label htmlFor={`${id}-name`}>
        Name
        <Input
          id={`${id}-name`}
          value={value.name}
          maxLength={80}
          required
          disabled={disabled}
          placeholder="Build tools"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <label htmlFor={`${id}-endpoint`} className="mcp-endpoint-field">
        Streamable HTTP endpoint
        <Input
          id={`${id}-endpoint`}
          type="url"
          value={value.endpoint}
          maxLength={2048}
          required
          disabled={disabled}
          placeholder="https://mcp.example.com/mcp"
          onChange={(event) =>
            onChange({ ...value, endpoint: event.target.value })
          }
        />
      </label>
      <label htmlFor={`${id}-auth`}>
        Authentication secret
        <SettingsSelect
          id={`${id}-auth`}
          value={value.authReferenceId}
          label="Authentication secret"
          disabled={disabled}
          options={[
            ["", "No bearer token"],
            ...secrets.map(
              (secret) => [secret.reference.id, secret.name] as const,
            ),
          ]}
          onValueChange={(authReferenceId) =>
            onChange({ ...value, authReferenceId })
          }
        />
      </label>
      <label htmlFor={`${id}-timeout`}>
        Timeout (milliseconds)
        <Input
          id={`${id}-timeout`}
          type="number"
          min={1000}
          max={30000}
          step={1000}
          required
          disabled={disabled}
          value={value.timeoutMs}
          onChange={(event) =>
            onChange({ ...value, timeoutMs: event.target.value })
          }
        />
      </label>
      <GrantFields
        value={value}
        projects={projects}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        workspace={workspace}
        disabled={disabled}
        onLoadMoreProjects={onLoadMoreProjects}
        onChange={onChange}
      />
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
    </form>
  );
}

function ToolRow({
  tool,
  canMutate,
  onReview,
}: {
  readonly tool: McpToolData;
  readonly canMutate: boolean;
  readonly onReview: () => void;
}) {
  return (
    <SettingsRow
      title={<code>{tool.name}</code>}
      description={tool.description || "No description supplied by the server."}
      badge={tool.reviewRequired ? "Review required" : "Reviewed"}
      control={
        <SettingsToggle
          checked={tool.approved}
          disabled={!canMutate}
          label={`${tool.approved ? "Revoke" : "Review"} ${tool.name}`}
          onCheckedChange={onReview}
        />
      }
    />
  );
}

type FinalFocus = React.RefObject<HTMLElement | null>;
type RunMutation = (
  action: McpServersMutationAction,
  message: string,
) => Promise<boolean>;

function EditServerDialog({
  server,
  value,
  secrets,
  projects,
  hasMoreProjects,
  loadingMoreProjects,
  workspace,
  busy,
  formId,
  finalFocus,
  onClose,
  onChange,
  onLoadMoreProjects,
  onSubmit,
}: {
  readonly server?: McpServerData;
  readonly value: EditorValue;
  readonly secrets: ReadonlyArray<EnvironmentVariableData>;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly hasMoreProjects: boolean;
  readonly loadingMoreProjects: boolean;
  readonly workspace: boolean;
  readonly busy: boolean;
  readonly formId: string;
  readonly finalFocus: FinalFocus;
  readonly onClose: () => void;
  readonly onChange: (value: EditorValue) => void;
  readonly onLoadMoreProjects: () => void;
  readonly onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <DialogRoot
      open={server !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {server ? (
        <DialogContent finalFocus={finalFocus} className="mcp-editor-dialog">
          <DialogTitle>Edit {server.name}</DialogTitle>
          <DialogDescription>
            Changing the endpoint or authentication clears discovery and all
            reviewed tool approvals.
          </DialogDescription>
          <ServerEditor
            id={`${formId}-edit`}
            value={value}
            secrets={secrets}
            projects={projects}
            hasMoreProjects={hasMoreProjects}
            loadingMoreProjects={loadingMoreProjects}
            workspace={workspace}
            disabled={busy}
            submitLabel="Save changes"
            onChange={onChange}
            onLoadMoreProjects={onLoadMoreProjects}
            onSubmit={onSubmit}
          />
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function ReviewToolDialog({
  reviewing,
  busy,
  finalFocus,
  run,
  onClose,
}: {
  readonly reviewing?: {
    readonly server: McpServerData;
    readonly tool: McpToolData;
  };
  readonly busy: boolean;
  readonly finalFocus: FinalFocus;
  readonly run: RunMutation;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={reviewing !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {reviewing ? (
        <DialogContent finalFocus={finalFocus} className="mcp-review-dialog">
          <DialogTitle>
            {reviewing.tool.approved ? "Revoke" : "Approve"}{" "}
            {reviewing.tool.name}?
          </DialogTitle>
          <DialogDescription>
            {reviewing.tool.approved
              ? "Revocation blocks new calls without changing existing Thread history."
              : "Approval is bound to this exact name, description, and input schema hash. A changed contract requires a new review."}
          </DialogDescription>
          <dl className="mcp-review-contract">
            <div>
              <dt>Server</dt>
              <dd>{reviewing.server.name}</dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>{reviewing.server.endpoint}</dd>
            </div>
            <div>
              <dt>SHA-256 contract</dt>
              <dd>
                <code>{reviewing.tool.schemaHash}</code>
              </dd>
            </div>
          </dl>
          <pre>{JSON.stringify(reviewing.tool.inputSchema, null, 2)}</pre>
          <div className="mcp-dialog-actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const { server, tool } = reviewing;
                void run(
                  {
                    type: "reviewTool",
                    serverId: server.id,
                    toolName: tool.name,
                    schemaHash: tool.schemaHash,
                    approved: !tool.approved,
                  },
                  tool.approved ? "Tool access revoked." : "Tool approved.",
                ).then((success) => {
                  if (success) onClose();
                });
              }}
            >
              <ShieldCheck />
              {reviewing.tool.approved ? "Revoke tool" : "Approve exact tool"}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function RemoveServerDialog({
  server,
  busy,
  finalFocus,
  run,
  onClose,
}: {
  readonly server?: McpServerData;
  readonly busy: boolean;
  readonly finalFocus: FinalFocus;
  readonly run: RunMutation;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={server !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {server ? (
        <DialogContent finalFocus={finalFocus}>
          <DialogTitle>Remove {server.name}?</DialogTitle>
          <DialogDescription>
            New MCP calls are blocked immediately. Existing Thread history is
            retained by Flue and is not rewritten.
          </DialogDescription>
          <div className="mcp-dialog-actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                void run(
                  { type: "delete", serverId: server.id },
                  "Server removed; new calls are blocked.",
                ).then((success) => {
                  if (success) onClose();
                });
              }}
            >
              Remove server
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function WorkspacePolicyDialog({
  policy,
  busy,
  finalFocus,
  run,
  onClose,
}: {
  readonly policy?: boolean;
  readonly busy: boolean;
  readonly finalFocus: FinalFocus;
  readonly run: RunMutation;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={policy !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {policy !== undefined ? (
        <DialogContent finalFocus={finalFocus}>
          <DialogTitle>
            {policy ? "Allow" : "Block"} personal MCP servers?
          </DialogTitle>
          <DialogDescription>
            Current policy is checked again before every MCP request. This does
            not alter prior Thread history.
          </DialogDescription>
          <div className="mcp-dialog-actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                void run(
                  { type: "updatePolicy", allowPersonalServers: policy },
                  "Workspace MCP policy updated.",
                ).then((success) => {
                  if (success) onClose();
                });
              }}
            >
              Confirm policy
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function ConfiguredServersCard({
  items,
  loading,
  loadError,
  workspace,
  canMutate,
  busy,
  onReload,
  onToggle,
  onDiscover,
  onEdit,
  onRemove,
  onReview,
}: {
  readonly items: ReadonlyArray<McpServerData>;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly workspace: boolean;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onReload: () => void;
  readonly onToggle: (server: McpServerData, enabled: boolean) => void;
  readonly onDiscover: (server: McpServerData) => void;
  readonly onEdit: (server: McpServerData, trigger: HTMLElement) => void;
  readonly onRemove: (server: McpServerData, trigger: HTMLElement) => void;
  readonly onReview: (server: McpServerData, tool: McpToolData) => void;
}) {
  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className="mcp-list-state" aria-live="polite">
        <span className="tool-spinner" /> Loading MCP servers…
      </div>
    );
  } else if (loadError !== undefined) {
    content = (
      <div className="mcp-list-state" role="alert">
        <AlertTriangle /> {loadError}
        <Button variant="outline" size="xs" onClick={onReload}>
          Retry
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    content = (
      <div className="mcp-list-state">
        <Plus /> No MCP servers configured for this scope.
      </div>
    );
  } else {
    content = (
      <div className="mcp-server-list">
        {items.map((server) => (
          <article className="mcp-server" key={server.id}>
            <header className="mcp-server-header">
              <div>
                <div className="mcp-server-title">
                  <strong>{server.name}</strong>
                  <Badge>{server.transport}</Badge>
                  <Badge data-health={server.healthStatus}>
                    {server.healthStatus}
                  </Badge>
                </div>
                <code>{server.endpoint}</code>
              </div>
              <SettingsToggle
                checked={server.enabled}
                disabled={!canMutate || busy}
                label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                onCheckedChange={(enabled) => onToggle(server, enabled)}
              />
            </header>
            <div className="mcp-server-meta">
              <span>Timeout: {server.timeoutMs.toLocaleString()} ms</span>
              <span>Projects: {server.projectIds.length || "all owned"}</span>
              {workspace ? <span>Roles: {server.roles.join(", ")}</span> : null}
              <span>
                Auth: {server.authReference ? "secret reference" : "none"}
              </span>
            </div>
            <div className="mcp-server-actions">
              <Button
                size="xs"
                variant="outline"
                disabled={!canMutate || busy}
                onClick={() => onDiscover(server)}
              >
                <RefreshCw /> Discover tools
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canMutate || busy}
                onClick={(event) => onEdit(server, event.currentTarget)}
              >
                <Pencil /> Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canMutate || busy}
                onClick={(event) => onRemove(server, event.currentTarget)}
              >
                <Trash2 /> Remove
              </Button>
            </div>
            <section className="mcp-tools" aria-label={`${server.name} tools`}>
              {server.tools.length === 0 ? (
                <p>No tools discovered. Discovery never enables tools.</p>
              ) : (
                server.tools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    canMutate={canMutate && !busy}
                    onReview={() => onReview(server, tool)}
                  />
                ))
              )}
            </section>
          </article>
        ))}
      </div>
    );
  }

  return <SettingsCard title="Configured servers">{content}</SettingsCard>;
}

function TransportTrustBoundaryCard() {
  return (
    <SettingsCard title="Transport and trust boundary">
      <SettingsRow
        title="Streamable HTTP"
        badge="Supported"
        description="dx connects only to the exact public HTTPS endpoint, rejects redirects, checks public DNS answers, and bounds requests, responses, discovery pages, and timeouts."
      />
      <SettingsRow
        title="Local process and legacy SSE"
        badge="Unavailable"
        description="Cloudflare Workers cannot spawn local MCP processes. Flue 2.0.7 exposes SSE, but dx intentionally accepts only Streamable HTTP for this Worker deployment."
      />
      <SettingsRow
        title="Data exposure"
        description="Approved tools can receive arguments selected by the agent, including prompt or file content included in a call. Tool results are untrusted content. No other network destination is permitted by this server entry."
      />
      <SettingsRow
        title="Explicit tool review"
        description="Discovery never enables tools. Each exact name, description, and input schema hash must be reviewed; new or changed tools return to review-required."
      />
    </SettingsCard>
  );
}

function WorkspacePersonalServersPolicy({
  allowed,
  disabled,
  onChange,
}: {
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly onChange: (allowed: boolean) => void;
}) {
  return (
    <SettingsCard title="Workspace policy">
      <SettingsRow
        title="Allow personal MCP servers"
        description="When disabled, personal MCP tools stop being available to every member of this workspace on their next call."
        control={
          <SettingsToggle
            checked={allowed}
            disabled={disabled}
            label="Allow personal MCP servers"
            onCheckedChange={onChange}
          />
        }
      />
    </SettingsCard>
  );
}

function ProjectContinuationNotice({ error }: { readonly error: unknown }) {
  if (error === null) return null;
  return (
    <p className="mcp-form-note" role="alert">
      More projects could not be loaded: {errorMessage(error)}. Select More
      projects to retry.
    </p>
  );
}

export function McpServersSettings(props: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const workspace = props.workspaceSlug !== undefined;
  const target = React.useMemo<McpServersTarget>(
    () =>
      props.workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug: props.workspaceSlug },
    [props.workspaceSlug],
  );
  const resource = useQuery(mcpServersQueryOptions(identity.id, target));
  const environment = useQuery(
    environmentVariablesQueryOptions(identity.id, target),
  );
  const projectResource = useInfiniteQuery(
    mcpServerProjectsQueryOptions(identity.id),
  );
  const mutation = useMutation(
    mcpServersMutationOptions(queryClient, identity.id, target),
  );
  const [editor, setEditor] = React.useState<EditorValue>(emptyEditor);
  const [editing, setEditing] = React.useState<McpServerData>();
  const [editValue, setEditValue] = React.useState<EditorValue>(emptyEditor);
  const [reviewing, setReviewing] = React.useState<{
    readonly server: McpServerData;
    readonly tool: McpToolData;
  }>();
  const [removing, setRemoving] = React.useState<McpServerData>();
  const [policy, setPolicy] = React.useState<boolean>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const finalFocus = React.useRef<HTMLElement>(null);
  const formId = React.useId();
  const canMutate = resource.data?.canMutate ?? false;
  const secrets = (environment.data?.items ?? []).filter(
    (item) => item.kind === "secret" && item.enabled,
  );
  const projects =
    projectResource.data?.pages.flatMap((page) => page.items) ?? [];

  const handleFailure = (cause: unknown) => {
    setError(errorMessage(cause));
  };
  const run = async (action: McpServersMutationAction, message: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await mutation.mutateAsync(action);
      setNotice(message);
      return true;
    } catch (cause) {
      handleFailure(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const success = await run(
      { type: "create", input: editorInput(editor, secrets) },
      "Server added. Run discovery before approving any tools.",
    );
    if (success) {
      setEditor(emptyEditor());
      props.onDirtyChange(false);
    }
  };
  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editing === undefined) return;
    const input = editorInput(editValue, secrets);
    const success = await run(
      {
        type: "update",
        serverId: editing.id,
        input: { ...input, authReference: input.authReference ?? null },
      },
      "Server settings saved.",
    );
    if (success) setEditing(undefined);
  };
  const items = resource.data?.items ?? [];
  const loadError =
    resource.error ??
    environment.error ??
    (projectResource.isFetchNextPageError ? null : projectResource.error);
  const projectContinuationError = projectResource.isFetchNextPageError
    ? projectResource.error
    : null;

  return (
    <div className="mcp-servers-settings">
      <SettingsHeading
        title={workspace ? "Workspace MCP Servers" : "Personal MCP Servers"}
        description={
          workspace
            ? "Publish reviewed remote tools to allowed workspace roles and projects."
            : "Connect reviewed remote tools for your projects."
        }
      />
      <TransportTrustBoundaryCard />
      {workspace && resource.data?.allowPersonalServers !== undefined ? (
        <WorkspacePersonalServersPolicy
          allowed={resource.data.allowPersonalServers}
          disabled={!canMutate || busy}
          onChange={setPolicy}
        />
      ) : null}
      <SettingsCard title="Add server">
        <ServerEditor
          id={`${formId}-create`}
          value={editor}
          secrets={secrets}
          projects={projects}
          hasMoreProjects={projectResource.hasNextPage}
          loadingMoreProjects={projectResource.isFetchingNextPage}
          workspace={workspace}
          disabled={busy || !canMutate}
          submitLabel="Add server"
          onChange={(next) => {
            setEditor(next);
            props.onDirtyChange(true);
          }}
          onLoadMoreProjects={() => void projectResource.fetchNextPage()}
          onSubmit={(event) => void create(event)}
        />
        <ProjectContinuationNotice error={projectContinuationError} />
        {secrets.length === 0 ? (
          <p className="mcp-form-note">
            Optional bearer authentication uses an enabled secret from Secrets
            &amp; Env Vars; credentials are never entered or returned here.
          </p>
        ) : null}
      </SettingsCard>
      <ConfiguredServersCard
        items={items}
        loading={
          resource.isPending ||
          environment.isPending ||
          projectResource.isPending
        }
        loadError={loadError === null ? undefined : errorMessage(loadError)}
        workspace={workspace}
        canMutate={canMutate}
        busy={busy}
        onReload={() => {
          const failedReads = [resource, environment, projectResource].filter(
            (query) => query.error !== null,
          );
          void Promise.all(failedReads.map((query) => query.refetch()));
        }}
        onToggle={(server, enabled) =>
          void run(
            { type: "update", serverId: server.id, input: { enabled } },
            enabled
              ? "Server enabled."
              : "Server disabled; new tool calls are blocked.",
          )
        }
        onDiscover={(server) =>
          void run(
            { type: "discover", serverId: server.id },
            "Discovery complete. Review every new or changed tool.",
          )
        }
        onEdit={(server, trigger) => {
          finalFocus.current = trigger;
          setEditValue(editorFor(server));
          setEditing(server);
        }}
        onRemove={(server, trigger) => {
          finalFocus.current = trigger;
          setRemoving(server);
        }}
        onReview={(server, tool) => setReviewing({ server, tool })}
      />
      {notice ? (
        <div className="mcp-notice" role="status">
          <CheckCircle2 /> {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mcp-error" role="alert">
          <AlertTriangle /> {error}
        </div>
      ) : null}

      <EditServerDialog
        server={editing}
        value={editValue}
        secrets={secrets}
        projects={projects}
        hasMoreProjects={projectResource.hasNextPage}
        loadingMoreProjects={projectResource.isFetchingNextPage}
        workspace={workspace}
        busy={busy}
        formId={formId}
        finalFocus={finalFocus}
        onClose={() => setEditing(undefined)}
        onChange={setEditValue}
        onLoadMoreProjects={() => void projectResource.fetchNextPage()}
        onSubmit={(event) => void saveEdit(event)}
      />
      <ReviewToolDialog
        reviewing={reviewing}
        busy={busy}
        finalFocus={finalFocus}
        run={run}
        onClose={() => setReviewing(undefined)}
      />
      <RemoveServerDialog
        server={removing}
        busy={busy}
        finalFocus={finalFocus}
        run={run}
        onClose={() => setRemoving(undefined)}
      />
      {target.scope === "workspace" ? (
        <WorkspacePolicyDialog
          policy={policy}
          busy={busy}
          finalFocus={finalFocus}
          run={run}
          onClose={() => setPolicy(undefined)}
        />
      ) : null}
    </div>
  );
}
