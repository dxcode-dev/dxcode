import "./model-routing.css";
import type { CatalogProviderData, ConnectionData } from "@dx/api";
import {
  CLAUDE_CODE_PROVIDER_ID,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, UsersRound } from "lucide-react";
import {
  type Dispatch,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
  useState,
} from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { settingsContextQueryOptions } from "../settings-context-queries.js";
import { isWorkspaceAdmin } from "../settings-navigation.js";
import { SettingsHeading } from "../settings-primitives.js";
import {
  type SettingsSectionProps,
  settingsPath,
} from "../settings-registration.js";
import {
  ClaudeCodeNotice,
  ClaudeConnectDialog,
} from "./claude-code-connect.js";
import { ClaudePlanPanel } from "./claude-plan-usage.js";
import {
  AddConnectionMenu,
  ConnectionDialog,
  type ConnectionDialogSubmit,
  ConnectionRow,
  CopilotConnectDialog,
} from "./model-routing-controls.js";
import { ModelRoutingGraph } from "./model-routing-graph.js";
import {
  apiMessage,
  connectionMutationOptions,
  fieldErrorsOf,
  invalidateAllModelRouting,
} from "./model-routing-mutations.js";
import {
  modelCatalogQueryOptions,
  modelConnectionsQueryOptions,
  modelRoutingChoicesQueryOptions,
  modelRoutingGraphQueryOptions,
} from "./model-routing-queries.js";

const message = apiMessage;

type DialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "add-provider"; readonly provider: CatalogProviderData }
  | { readonly kind: "add-custom" }
  | { readonly kind: "edit"; readonly connection: ConnectionData }
  | { readonly kind: "copilot" }
  | { readonly kind: "claude"; readonly connection?: ConnectionData };

const isClaudeConnection = (connection: ConnectionData) =>
  connection.providerId === CLAUDE_CODE_PROVIDER_ID;

/** A Claude Pro/Max connection edits only its token, in its own dialog. */
const editDialog = (connection: ConnectionData): DialogState =>
  isClaudeConnection(connection)
    ? { kind: "claude", connection }
    : { kind: "edit", connection };

type FormDialog = Extract<
  DialogState,
  { readonly kind: "add-provider" | "add-custom" | "edit" }
>;

const formDialogKey = (dialog: FormDialog) =>
  dialog.kind === "add-provider"
    ? dialog.provider.id
    : dialog.kind === "edit"
      ? dialog.connection.id
      : "custom";

const formDialogProvider = (
  dialog: FormDialog,
  catalog:
    | { readonly providers: ReadonlyArray<CatalogProviderData> }
    | undefined,
) =>
  dialog.kind === "add-provider"
    ? dialog.provider
    : dialog.kind === "edit" && dialog.connection.kind === "provider"
      ? catalog?.providers.find(
          (provider) => provider.id === dialog.connection.providerId,
        )
      : undefined;

/**
 * Another scope's routing in its place in the order: members' own
 * connections come before the workspace's, and the workspace's after yours.
 */
function ScopeRow({
  label,
  icon,
  to,
  settingsReturnTo,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  /** The scope's Model Routing page, when this user can open it. */
  readonly to?: string;
  readonly settingsReturnTo?: string;
}) {
  const content = (
    <>
      {icon}
      <span className="model-routing-connection-name">{label}</span>
    </>
  );
  return (
    <li className="model-routing-scope-row">
      {to === undefined ? (
        <div className="model-routing-scope-content">{content}</div>
      ) : (
        <Link
          to={to}
          replace
          state={settingsNavigationState(settingsReturnTo)}
          className="model-routing-scope-content"
        >
          {content}
          <ChevronRight
            className="model-routing-connection-chevron"
            aria-hidden="true"
          />
        </Link>
      )}
    </li>
  );
}

function ConnectionList({
  rows,
  empty,
  leading,
  trailing,
  canMutate,
  checkingConnectionId,
  onReorder,
  onToggle,
  onCheckAccess,
  onEdit,
  onDelete,
  onDisconnect,
  expanded,
  onExpand,
  renderPanel,
}: {
  readonly renderPanel?: (connection: ConnectionData) => ReactNode;
  /** Shown in place of the rows when the scope has no connections. */
  readonly empty?: string;
  /** Rows of other scopes' routing before and after these connections. */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly expanded: ReadonlyArray<string>;
  readonly onExpand: (id: string) => void;
  readonly rows: ReadonlyArray<ConnectionData>;
  readonly canMutate: boolean;
  readonly checkingConnectionId?: string;
  readonly onReorder: (ids: ReadonlyArray<string>) => void;
  readonly onToggle: (connectionId: string, enabled: boolean) => void;
  readonly onCheckAccess: (connectionId: string) => void;
  readonly onEdit: (connection: ConnectionData) => void;
  readonly onDelete: (connection: ConnectionData) => void;
  readonly onDisconnect: (connection: ConnectionData) => void;
}) {
  const [drag, setDrag] = useState<
    { id: ConnectionData["id"]; insertion: number } | undefined
  >();
  const expandedIds = new Set(expanded);
  const insertionAt = (event: PointerEvent<HTMLButtonElement>) => {
    const elements = Array.from(
      event.currentTarget
        .closest("ol")
        ?.querySelectorAll("[data-connection-row]") ?? [],
    );
    const insertion = elements.findIndex((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    return insertion < 0 ? rows.length : insertion;
  };
  const drop = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const old = rows.findIndex((row) => row.id === drag.id);
    const ids = rows.flatMap((row) => (row.id === drag.id ? [] : [row.id]));
    const insertion = insertionAt(event);
    ids.splice(insertion > old ? insertion - 1 : insertion, 0, drag.id);
    setDrag(undefined);
    if (ids.some((id, index) => id !== rows[index]?.id)) onReorder(ids);
  };

  const move = (connection: ConnectionData, direction: -1 | 1) => {
    const index = rows.findIndex((row) => row.id === connection.id);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= rows.length) return;
    const ids = rows.map((row) => row.id);
    const id = ids[index];
    const swapId = ids[swap];
    if (id === undefined || swapId === undefined) return;
    ids[index] = swapId;
    ids[swap] = id;
    onReorder(ids);
  };

  return (
    <ol className="model-routing-connection-list">
      {leading}
      {rows.map((connection, index) => (
        <li
          key={connection.id}
          id={`routing-connection-${connection.id}`}
          data-connection-row
          data-dragging={drag?.id === connection.id || undefined}
          data-drop={
            drag && drag.insertion === index
              ? "above"
              : drag?.insertion === rows.length && index === rows.length - 1
                ? "below"
                : undefined
          }
        >
          <ConnectionRow
            connection={connection}
            canMutate={canMutate}
            canReorderUp={index > 0 && canMutate}
            canReorderDown={index < rows.length - 1 && canMutate}
            expanded={expandedIds.has(connection.id)}
            onExpand={() => onExpand(connection.id)}
            onPointerDown={(event) => {
              if (!canMutate || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ id: connection.id, insertion: index });
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              setDrag({ ...drag, insertion: insertionAt(event) });
            }}
            onPointerUp={drop}
            onPointerCancel={() => setDrag(undefined)}
            onToggle={(enabled) => onToggle(connection.id, enabled)}
            onMove={(direction) => move(connection, direction)}
            onCheckAccess={() => onCheckAccess(connection.id)}
            onEdit={() => onEdit(connection)}
            onDelete={() => onDelete(connection)}
            onDisconnect={() => onDisconnect(connection)}
            checkingAccess={checkingConnectionId === connection.id}
          >
            {renderPanel?.(connection)}
          </ConnectionRow>
        </li>
      ))}
      {empty === undefined ? null : <li className="routing-empty">{empty}</li>}
      {trailing}
    </ol>
  );
}

/**
 * The routing connections in priority order, then Claude Pro/Max in its own
 * card, with the row actions' progress and failures.
 */
function RoutingConnections({
  target,
  leading,
  trailing,
  routingRows,
  claudeRows,
  canMutate,
  expanded,
  setExpanded,
  onEdit,
}: {
  readonly target: ModelRoutingTarget;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly routingRows: ReadonlyArray<ConnectionData>;
  readonly claudeRows: ReadonlyArray<ConnectionData>;
  readonly canMutate: boolean;
  readonly expanded: ReadonlyArray<string>;
  readonly setExpanded: Dispatch<SetStateAction<ReadonlyArray<string>>>;
  readonly onEdit: (connection: ConnectionData) => void;
}) {
  const queryClient = useQueryClient();
  const options = connectionMutationOptions(queryClient, target);
  const enabledMutation = useMutation(options.setEnabled);
  const reorderMutation = useMutation(options.reorder);
  const checkAccessMutation = useMutation(options.checkAccess);
  const removeMutation = useMutation(options.remove);
  const disconnectMutation = useMutation(options.disconnectSubscription);
  const listProps = {
    expanded,
    onExpand: (id: string) =>
      setExpanded((current) =>
        current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id],
      ),
    canMutate,
    checkingConnectionId: checkAccessMutation.isPending
      ? checkAccessMutation.variables
      : undefined,
    onToggle: (connectionId: string, enabled: boolean) =>
      enabledMutation.mutate({ connectionId, enabled }),
    onCheckAccess: (connectionId: string) =>
      checkAccessMutation.mutate(connectionId),
    onEdit,
    onDelete: (connection: ConnectionData) => {
      if (confirm(`Delete ${connection.name}?`)) {
        removeMutation.mutate(connection.id);
      }
    },
    onDisconnect: (connection: ConnectionData) => {
      if (confirm(`Disconnect ${connection.name}?`)) {
        disconnectMutation.mutate(connection.id);
      }
    },
  };
  return (
    <>
      {routingRows.length > 0 ||
      claudeRows.length === 0 ||
      leading !== undefined ||
      trailing !== undefined ? (
        <ConnectionList
          {...listProps}
          leading={leading}
          trailing={trailing}
          empty={
            routingRows.length === 0 && claudeRows.length === 0
              ? `No ${target.scope} connections yet.`
              : undefined
          }
          rows={routingRows}
          // Reorder lists every connection; Claude Pro/Max keeps its place.
          onReorder={(ids) =>
            reorderMutation.mutate([...ids, ...claudeRows.map(({ id }) => id)])
          }
        />
      ) : null}
      {claudeRows.length > 0 ? (
        <ConnectionList
          {...listProps}
          rows={claudeRows}
          onReorder={() => undefined}
          renderPanel={(connection) =>
            connection.claudePlan === undefined ? null : (
              <ClaudePlanPanel
                connection={connection}
                plan={connection.claudePlan}
                target={target}
                canMutate={canMutate}
              />
            )
          }
        />
      ) : null}
      {[
        reorderMutation,
        enabledMutation,
        checkAccessMutation,
        removeMutation,
        disconnectMutation,
      ].some((m) => m.isPending) ? (
        <p className="routing-status" role="status">
          Updating connection…
        </p>
      ) : null}
      {[
        reorderMutation,
        enabledMutation,
        checkAccessMutation,
        removeMutation,
        disconnectMutation,
      ]
        .filter((m) => m.isError)
        .map((m) => (
          <p
            key={message(m.error)}
            className="model-routing-field-error"
            role="alert"
          >
            {message(m.error)}
          </p>
        ))}
    </>
  );
}

export const ModelRoutingSettings = ({
  workspace,
  workspaceSlug,
  settingsReturnTo,
}: SettingsSectionProps) => {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target: ModelRoutingTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };

  const connections = useQuery(
    modelConnectionsQueryOptions(target, identity.id),
  );
  const catalog = useQuery(modelCatalogQueryOptions(target, identity.id));
  const graph = useQuery(modelRoutingGraphQueryOptions(target, identity.id));
  const choices = useQuery({
    ...modelRoutingChoicesQueryOptions(identity.id),
    enabled: workspaceSlug === undefined,
  });
  const settingsContext = useQuery(
    settingsContextQueryOptions(identity.id, target),
  );

  const options = connectionMutationOptions(queryClient, target);
  const createMutation = useMutation(options.create);
  const updateMutation = useMutation(options.update);

  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([]);
  const [submitError, setSubmitError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >({});

  const personal = target.scope === "personal";
  const canMutate =
    personal ||
    (workspace !== undefined &&
      workspaceRoleHasPermission(workspace.role, "workspace:update"));
  const rows = connections.data ?? [];

  const closeDialog = () => {
    setDialog({ kind: "closed" });
    setSubmitError(undefined);
    setFieldErrors({});
  };

  const submit = (input: ConnectionDialogSubmit) => {
    setSubmitError(undefined);
    setFieldErrors({});
    const fail = (error: unknown) => {
      setSubmitError(message(error));
      setFieldErrors(fieldErrorsOf(error));
    };
    if (dialog.kind === "edit") {
      updateMutation.mutate(
        {
          connectionId: dialog.connection.id,
          patch: {
            name: input.name,
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.format === undefined ? {} : { format: input.format }),
            fields: input.fields,
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.models === undefined ? {} : { models: input.models }),
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
          },
        },
        { onSuccess: closeDialog, onError: fail },
      );
      return;
    }
    const custom = dialog.kind === "add-custom";
    createMutation.mutate(
      {
        name: input.name,
        kind: custom ? "custom" : "provider",
        providerId: custom
          ? "dx-custom"
          : dialog.kind === "add-provider"
            ? dialog.provider.id
            : "dx-custom",
        ...(typeof input.baseUrl === "string"
          ? { baseUrl: input.baseUrl }
          : {}),
        ...(input.format === undefined ? {} : { format: input.format }),
        fields: input.fields,
        headers: input.headers ?? [],
        ...(input.models === undefined ? {} : { models: input.models }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        enabled: input.enabled,
      },
      { onSuccess: closeDialog, onError: fail },
    );
  };

  // Personal Threads use the user's one workspace's connections after theirs.
  const personalWorkspace =
    settingsContext.data?.activeScope === "personal"
      ? settingsContext.data.workspace
      : undefined;
  const copilotRow = rows.find(
    (connection) => connection.kind === "subscription",
  );
  const claudeRows = rows.filter(isClaudeConnection);
  const claudeRow = claudeRows[0];
  const routingRows = rows.filter(
    (connection) => !isClaudeConnection(connection),
  );

  return (
    <div className="model-routing-settings routing-parity">
      <SettingsHeading
        title="Model Routing"
        actions={
          canMutate ? (
            <AddConnectionMenu
              showCopilot={personal && copilotRow === undefined}
              showClaude={personal}
              onPick={(pick) =>
                setDialog(
                  // One plan per owner: picking it again replaces the token.
                  pick === "claude" && claudeRow !== undefined
                    ? editDialog(claudeRow)
                    : { kind: pick === "custom" ? "add-custom" : pick },
                )
              }
            />
          ) : undefined
        }
      />
      {personal && claudeRow === undefined && connections.isSuccess ? (
        <ClaudeCodeNotice onConnect={() => setDialog({ kind: "claude" })} />
      ) : null}
      {connections.isError ? (
        <p className="model-routing-field-error">
          {message(connections.error)}
        </p>
      ) : null}
      {connections.isPending ? (
        <DxLoading label="Loading connections…" />
      ) : connections.isError ? null : (
        <RoutingConnections
          target={target}
          leading={
            personal ? undefined : (
              <ScopeRow
                label="Members' personal model routing"
                icon={
                  <UsersRound
                    className="routing-connection-icon"
                    aria-hidden="true"
                  />
                }
              />
            )
          }
          trailing={
            personalWorkspace === undefined ? undefined : (
              <ScopeRow
                label={`${personalWorkspace.displayName} workspace model routing`}
                icon={
                  <span className="settings-workspace-mark" aria-hidden="true">
                    W
                  </span>
                }
                settingsReturnTo={settingsReturnTo}
                to={
                  isWorkspaceAdmin(personalWorkspace.role)
                    ? settingsPath({
                        scope: "workspace",
                        workspaceSlug: personalWorkspace.shortName,
                        section: "model-routing",
                      })
                    : undefined
                }
              />
            )
          }
          routingRows={routingRows}
          claudeRows={claudeRows}
          canMutate={canMutate}
          expanded={expanded}
          setExpanded={setExpanded}
          onEdit={(connection) => setDialog(editDialog(connection))}
        />
      )}
      {graph.isError ? (
        <p className="model-routing-field-error" role="alert">
          {message(graph.error)}
        </p>
      ) : graph.data ? (
        <ModelRoutingGraph
          graph={graph.data}
          catalog={catalog.data}
          choices={personal ? choices.data : undefined}
          connections={rows}
          dictation={
            settingsContext.data?.activeScope === "personal"
              ? settingsContext.data.dictation
              : undefined
          }
          onConnectionClick={(id) => {
            void navigate({ hash: id, replace: true, resetScroll: false });
            setExpanded((current) =>
              current.includes(id) ? current : [...current, id],
            );
            requestAnimationFrame(() => {
              const element = document.getElementById(
                `routing-connection-${id}`,
              );
              element?.scrollIntoView({
                block: "nearest",
                behavior: "instant",
              });
              element
                ?.querySelector<HTMLButtonElement>(
                  ".model-routing-connection-disclosure",
                )
                ?.focus({ preventScroll: true });
            });
          }}
        />
      ) : (
        <DxLoading label="Loading routes…" />
      )}
      {catalog.isError || (personal && choices.isError) ? (
        <p className="model-routing-field-error" role="alert">
          Some model details could not be loaded.{" "}
          {message(catalog.error ?? choices.error)}
        </p>
      ) : null}
      {dialog.kind === "add-provider" ||
      dialog.kind === "add-custom" ||
      dialog.kind === "edit" ? (
        <ConnectionDialog
          key={formDialogKey(dialog)}
          open
          provider={formDialogProvider(dialog, catalog.data)}
          {...(dialog.kind === "edit" ? { existing: dialog.connection } : {})}
          busy={
            (dialog.kind === "edit" ? updateMutation : createMutation).isPending
          }
          fieldErrors={fieldErrors}
          submitError={submitError}
          onClose={closeDialog}
          onSubmit={submit}
        />
      ) : null}
      {dialog.kind === "claude" ? (
        <ClaudeConnectDialog
          target={target}
          connection={dialog.connection}
          onClose={closeDialog}
        />
      ) : null}
      {dialog.kind === "copilot" ? (
        <CopilotConnectDialog
          open
          onClose={closeDialog}
          onConnected={() => {
            invalidateAllModelRouting(queryClient);
            closeDialog();
          }}
        />
      ) : null}
    </div>
  );
};
