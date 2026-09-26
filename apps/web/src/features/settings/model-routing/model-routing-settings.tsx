import "./model-routing.css";
import type { CatalogProviderData, ConnectionData } from "@dx/api";
import { workspaceRoleHasPermission } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type PointerEvent } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settingsContextQueryOptions } from "../settings-context-queries.js";
import type { SettingsSectionProps } from "../settings-registration.js";
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
  | { readonly kind: "copilot" };

function ConnectionList({
  rows,
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
}: {
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
            priority={index + 1}
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
          />
        </li>
      ))}
    </ol>
  );
}

export const ModelRoutingSettings = ({
  workspace,
  workspaceSlug,
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
  const enabledMutation = useMutation(options.setEnabled);
  const reorderMutation = useMutation(options.reorder);
  const checkAccessMutation = useMutation(options.checkAccess);
  const removeMutation = useMutation(options.remove);
  const disconnectMutation = useMutation(options.disconnectSubscription);

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

  const copilotRow = rows.find(
    (connection) => connection.kind === "subscription",
  );

  return (
    <div className="model-routing-settings routing-parity">
      <header className="model-routing-page-heading">
        <h1>Model Routing</h1>
        {canMutate ? (
          <AddConnectionMenu
            showCopilot={personal && copilotRow === undefined}
            onPick={(pick) =>
              setDialog({ kind: pick === "copilot" ? "copilot" : "add-custom" })
            }
          />
        ) : null}
      </header>
      {connections.isError ? (
        <p className="model-routing-field-error">
          {message(connections.error)}
        </p>
      ) : null}
      <ConnectionList
        rows={rows}
        expanded={expanded}
        onExpand={(id) =>
          setExpanded((current) =>
            current.includes(id)
              ? current.filter((value) => value !== id)
              : [...current, id],
          )
        }
        canMutate={canMutate}
        checkingConnectionId={
          checkAccessMutation.isPending
            ? checkAccessMutation.variables
            : undefined
        }
        onReorder={(ids) => reorderMutation.mutate(ids)}
        onToggle={(connectionId, enabled) =>
          enabledMutation.mutate({ connectionId, enabled })
        }
        onCheckAccess={(connectionId) =>
          checkAccessMutation.mutate(connectionId)
        }
        onEdit={(connection) => setDialog({ kind: "edit", connection })}
        onDelete={(connection) => {
          if (confirm(`Delete ${connection.name}?`)) {
            removeMutation.mutate(connection.id);
          }
        }}
        onDisconnect={(connection) => {
          if (confirm(`Disconnect ${connection.name}?`)) {
            disconnectMutation.mutate(connection.id);
          }
        }}
      />
      {connections.isPending ? (
        <p className="routing-empty" role="status">
          Loading connections…
        </p>
      ) : rows.length === 0 && !connections.isError ? (
        <p className="routing-empty">
          No connections yet. Add GitHub Copilot or a Custom URL to serve your
          models.
        </p>
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
          dictationAvailable={settingsContext.data?.dictationAvailable === true}
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
        <p role="status" className="routing-empty">
          Loading routes…
        </p>
      )}
      {catalog.isError || (personal && choices.isError) ? (
        <p className="model-routing-field-error" role="alert">
          Some model details could not be loaded.{" "}
          {message(catalog.error ?? choices.error)}
        </p>
      ) : null}
      {dialog.kind === "add-provider" ? (
        <ConnectionDialog
          key={dialog.provider.id}
          open
          provider={dialog.provider}
          busy={createMutation.isPending}
          fieldErrors={fieldErrors}
          submitError={submitError}
          onClose={closeDialog}
          onSubmit={submit}
        />
      ) : null}
      {dialog.kind === "add-custom" ? (
        <ConnectionDialog
          key="custom"
          open
          busy={createMutation.isPending}
          fieldErrors={fieldErrors}
          submitError={submitError}
          onClose={closeDialog}
          onSubmit={submit}
        />
      ) : null}
      {dialog.kind === "edit" ? (
        <ConnectionDialog
          key={dialog.connection.id}
          open
          provider={
            dialog.connection.kind === "provider"
              ? catalog.data?.providers.find(
                  (provider) => provider.id === dialog.connection.providerId,
                )
              : undefined
          }
          existing={dialog.connection}
          busy={updateMutation.isPending}
          fieldErrors={fieldErrors}
          submitError={submitError}
          onClose={closeDialog}
          onSubmit={submit}
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
