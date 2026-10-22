import type {
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
} from "@dx/api";
import {
  CLAUDE_CODE_PROVIDER_ID,
  environmentVariableNameProblem,
  looksLikeSecretName,
  normalizeEnvironmentVariableName,
  type ProjectId,
  workspaceRoleHasPermission,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { modelConnectionsQueryOptions } from "../model-routing/model-routing-queries.js";
import { SettingsCard, SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  AddEnvironmentVariableActions,
  AddEnvironmentVariableDialog,
  BulkAddEnvironmentVariablesDialog,
  DeleteEnvironmentVariableDialog,
  EditEnvironmentVariableDialog,
  EnvironmentVariableHistory,
  EnvironmentVariableValues,
} from "./environment-variable-controls.js";
import {
  createEnvironmentVariableMutationOptions,
  type EnvironmentVariablesMutationAction,
  environmentVariablesMutationOptions,
  failureMessages,
} from "./environment-variables-mutations.js";
import {
  type EnvironmentVariablesTarget,
  environmentVariableHistoryQueryOptions,
  environmentVariablesQueryOptions,
} from "./environment-variables-queries.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

interface AddErrors {
  readonly name?: string;
  readonly value?: string;
  readonly form: ReadonlyArray<string>;
}

interface EditorState {
  readonly mode?: "add" | "bulk";
  readonly name: string;
  readonly value: string;
  /** The Secret checkbox once touched; until then the name decides. */
  readonly secret?: boolean;
  readonly addErrors: AddErrors;
  readonly contents: string;
  readonly autoDetect: boolean;
  readonly replace: boolean;
  readonly bulkErrors: ReadonlyArray<string>;
  readonly edit?: EnvironmentVariableData;
  readonly editValue: string;
  readonly editError?: string;
  readonly remove?: EnvironmentVariableData;
  readonly removeError?: string;
  readonly rowError?: string;
  readonly filter: string;
}

const noAddErrors: AddErrors = { form: [] };

const initialEditorState: EditorState = {
  name: "",
  value: "",
  addErrors: noAddErrors,
  contents: "",
  autoDetect: true,
  replace: false,
  bulkErrors: [],
  editValue: "",
  filter: "",
};

function useEnvironmentVariableController({
  target,
  workspace,
  onDirtyChange,
}: {
  readonly target: EnvironmentVariablesTarget;
  readonly workspace: SettingsSectionProps["workspace"];
  readonly onDirtyChange: SettingsSectionProps["onDirtyChange"];
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const list = useQuery(environmentVariablesQueryOptions(identity.id, target));
  const history = useInfiniteQuery(
    environmentVariableHistoryQueryOptions(identity.id, target),
  );
  // A Claude plan in Model Routing sets CLAUDE_CODE_OAUTH_TOKEN for Claude
  // Code runs, so the personal list shows it read-only.
  const modelConnections = useQuery({
    ...modelConnectionsQueryOptions({ scope: "personal" }, identity.id),
    enabled: target.scope === "personal",
  });
  const managed =
    target.scope === "personal" &&
    modelConnections.data?.some(
      ({ providerId }) => providerId === CLAUDE_CODE_PROVIDER_ID,
    )
      ? [{ name: "CLAUDE_CODE_OAUTH_TOKEN", detail: "Subscription" }]
      : [];
  const mutationOptions = environmentVariablesMutationOptions(
    queryClient,
    identity.id,
    target,
  );
  const mutation = useMutation(mutationOptions);
  const createMutation = useMutation(
    createEnvironmentVariableMutationOptions(queryClient, identity.id, target),
  );
  // Every action in flight, so concurrent row changes each show as pending.
  const pendingActions = useMutationState({
    filters: { mutationKey: mutationOptions.mutationKey, status: "pending" },
    select: (pending) =>
      pending.state.variables as EnvironmentVariablesMutationAction,
  });
  const [editor, setEditor] = React.useState(initialEditorState);
  const updateEditor = (patch: Partial<EditorState>) =>
    setEditor((current) => ({ ...current, ...patch }));
  const dialogTriggerRef = React.useRef<HTMLElement>(null);
  const fieldId = React.useId();
  const canMutate =
    target.scope !== "workspace" ||
    (workspace !== undefined &&
      workspaceRoleHasPermission(workspace.role, "workspace:update"));
  const execute = async (action: EnvironmentVariablesMutationAction) => {
    const outcome = await settle(() => mutation.mutateAsync(action));
    mutation.reset();
    return outcome;
  };
  const addAsSecret =
    editor.secret ??
    looksLikeSecretName(normalizeEnvironmentVariableName(editor.name));
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      environmentVariableNameProblem(editor.name) !== undefined ||
      (addAsSecret && editor.value.length === 0)
    )
      return;
    updateEditor({ addErrors: noAddErrors });
    const outcome = await settle(() =>
      createMutation.mutateAsync({
        name: normalizeEnvironmentVariableName(editor.name),
        value: editor.value,
        kind: addAsSecret ? "secret" : "variable",
      }),
    );
    createMutation.reset();
    if (outcome.ok) {
      updateEditor({ mode: undefined, name: "", value: "" });
      onDirtyChange(false);
      return;
    }
    const errors = failureMessages(outcome.error);
    updateEditor({
      addErrors: {
        name: errors.find(({ field }) => field === "name")?.message,
        value: errors.find(({ field }) => field === "value")?.message,
        form: errors.flatMap(({ field, message }) =>
          field === "name" || field === "value" ? [] : [message],
        ),
      },
    });
  };
  const applyBulk = async () => {
    updateEditor({ bulkErrors: [] });
    const outcome = await execute({
      type: "applyBulk",
      input: {
        kind: editor.autoDetect ? "auto" : "variable",
        contents: editor.contents,
        conflictBehavior: editor.replace ? "replace" : "reject",
      },
    });
    if (outcome.ok) {
      updateEditor({ mode: undefined, contents: "", replace: false });
      onDirtyChange(false);
      return;
    }
    updateEditor({
      bulkErrors: failureMessages(outcome.error).map(({ message }) => message),
    });
  };
  const saveEdit = async () => {
    if (editor.edit === undefined) return;
    updateEditor({ editError: undefined });
    const outcome = await execute({
      type: "rotate",
      item: editor.edit,
      value: editor.editValue,
    });
    updateEditor(
      outcome.ok
        ? { edit: undefined, editValue: "" }
        : {
            editError: failureMessages(outcome.error)
              .map(({ message }) => message)
              .join(" "),
          },
    );
  };
  const confirmRemove = async () => {
    if (editor.remove === undefined) return;
    updateEditor({ removeError: undefined });
    const outcome = await execute({ type: "delete", item: editor.remove });
    updateEditor(
      outcome.ok
        ? { remove: undefined }
        : { removeError: message(outcome.error) },
    );
  };
  const toggle = async (item: EnvironmentVariableData) => {
    updateEditor({ rowError: undefined });
    const outcome = await execute({
      type: "update",
      item,
      input: { enabled: !item.enabled },
    });
    if (!outcome.ok)
      updateEditor({
        rowError: `Could not ${item.enabled ? "disable" : "enable"} ${item.name}: ${message(outcome.error)}`,
      });
  };
  const closeEditor = () => {
    updateEditor({
      mode: undefined,
      name: "",
      value: "",
      contents: "",
      replace: false,
      addErrors: noAddErrors,
      bulkErrors: [],
    });
    onDirtyChange(false);
  };
  return {
    list,
    history,
    managed,
    editor,
    updateEditor,
    dialogTriggerRef,
    fieldId,
    canMutate,
    pendingActions,
    createPending: createMutation.isPending,
    addAsSecret,
    create,
    applyBulk,
    saveEdit,
    confirmRemove,
    toggle,
    closeEditor,
  };
}

export function EnvironmentVariablesSettings(props: SettingsSectionProps) {
  const target: EnvironmentVariablesTarget =
    props.workspaceSlug !== undefined
      ? { scope: "workspace", workspaceSlug: props.workspaceSlug }
      : { scope: "personal" };
  return (
    <EnvironmentVariablesContent
      key={
        target.scope === "personal"
          ? target.scope
          : `${target.scope}:${target.workspaceSlug}`
      }
      {...props}
      target={target}
      intro={
        <SettingsHeading
          title="Secrets & Env Vars"
          description={
            target.scope === "personal" ? (
              <>
                Secrets and environment variables are set in the Orbs that run
                your dx Threads, in <code>~/.env</code> and new Terminal shells.
                All values are encrypted at rest. Personal entries override
                project and workspace entries with the same name.
              </>
            ) : (
              <>
                Secrets and environment variables are set in the Orbs that run
                this workspace's dx Threads, in <code>~/.env</code> and new
                Terminal shells. All values are encrypted at rest. Project
                entries override workspace entries, and personal entries
                override both.
              </>
            )
          }
        />
      }
    />
  );
}

export function ProjectEnvironmentVariablesSettings({
  projectId,
  onDirtyChange,
}: {
  readonly projectId: ProjectId;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const target = { scope: "project" as const, projectId };
  return (
    <EnvironmentVariablesContent
      key={`${target.scope}:${projectId}`}
      target={target}
      onDirtyChange={onDirtyChange}
    />
  );
}

/** Who made the latest loaded change to each value. */
const latestActors = (
  history: ReadonlyArray<EnvironmentVariableAuditEventData>,
) => {
  const latest = new Map<string, EnvironmentVariableAuditEventData>();
  for (const event of history) {
    const current = latest.get(event.variableId);
    if (
      current === undefined ||
      DateTime.toEpochMillis(event.occurredAt) >
        DateTime.toEpochMillis(current.occurredAt)
    )
      latest.set(event.variableId, event);
  }
  return new Map(
    [...latest].map(([variableId, event]) => [variableId, event.actorName]),
  );
};

function EnvironmentVariablesContent({
  target,
  onDirtyChange,
  workspace,
  intro,
}: SettingsSectionProps & {
  readonly target: EnvironmentVariablesTarget;
  readonly intro?: React.ReactNode;
}) {
  const controller = useEnvironmentVariableController({
    target,
    workspace,
    onDirtyChange,
  });
  const { editor, dialogTriggerRef, updateEditor } = controller;
  const historyItemsById = new Map<
    EnvironmentVariableAuditEventData["id"],
    EnvironmentVariableAuditEventData
  >();
  for (const page of controller.history.data?.pages ?? []) {
    for (const item of page.items) historyItemsById.set(item.id, item);
  }
  const historyItems = [...historyItemsById.values()];
  const items = controller.list.data?.items ?? [];
  const pendingIds = new Set(
    controller.pendingActions.flatMap((action) =>
      action.type === "applyBulk" ? [] : [action.item.reference.id],
    ),
  );
  const pendingFor = (type: EnvironmentVariablesMutationAction["type"]) =>
    controller.pendingActions.some((action) => action.type === type);
  const nameError =
    editor.name.length === 0
      ? undefined
      : (environmentVariableNameProblem(editor.name) ?? editor.addErrors.name);
  return (
    <div className="environment-variables-settings">
      {intro}
      {!controller.canMutate ? (
        <SettingsCard title="Read-only workspace values">
          <p>
            Your workspace role does not include configuration changes. Only
            Workspace Owners and Admins can create, rotate, disable, or delete
            values.
          </p>
        </SettingsCard>
      ) : null}
      <EnvironmentVariableValues
        filter={editor.filter}
        onFilterChange={(filter) => updateEditor({ filter })}
        actions={
          controller.canMutate ? (
            <AddEnvironmentVariableActions
              onBulkAdd={() =>
                updateEditor({
                  mode: "bulk",
                  contents: "",
                  autoDetect: true,
                  replace: false,
                  bulkErrors: [],
                })
              }
              onAdd={() =>
                updateEditor({
                  mode: "add",
                  name: "",
                  value: "",
                  secret: undefined,
                  addErrors: noAddErrors,
                })
              }
            />
          ) : undefined
        }
        loading={controller.list.isPending}
        loadError={
          controller.list.error === null
            ? undefined
            : message(controller.list.error)
        }
        items={items}
        managed={controller.managed}
        updatedBy={latestActors(historyItems)}
        pendingIds={pendingIds}
        canMutate={controller.canMutate}
        onReload={() => void controller.list.refetch()}
        onEdit={(item, trigger) => {
          dialogTriggerRef.current = trigger;
          // An env var opens with its value, since saving empty is allowed.
          updateEditor({
            edit: item,
            editValue: item.kind === "variable" ? item.value : "",
            editError: undefined,
          });
        }}
        onToggle={(item) => void controller.toggle(item)}
        onDelete={(item, trigger) => {
          dialogTriggerRef.current = trigger;
          updateEditor({ remove: item, removeError: undefined });
        }}
      />
      {editor.rowError === undefined ? null : (
        <p className="environment-field-error" role="alert">
          {editor.rowError}
        </p>
      )}
      <EnvironmentVariableHistory
        loading={controller.history.isPending}
        loadError={
          controller.history.isError && !controller.history.isFetchNextPageError
            ? message(controller.history.error)
            : undefined
        }
        moreError={
          controller.history.isFetchNextPageError
            ? message(controller.history.error)
            : undefined
        }
        items={historyItems}
        hasMore={controller.history.hasNextPage}
        loadingMore={controller.history.isFetchingNextPage}
        onReload={() => void controller.history.refetch()}
        onLoadMore={() => void controller.history.fetchNextPage()}
      />
      {controller.canMutate ? (
        <>
          <AddEnvironmentVariableDialog
            open={editor.mode === "add"}
            fieldId={controller.fieldId}
            name={editor.name}
            value={editor.value}
            secret={controller.addAsSecret}
            nameError={nameError}
            valueError={editor.addErrors.value}
            formErrors={editor.addErrors.form}
            pending={controller.createPending}
            onNameChange={(name) => {
              updateEditor({
                name,
                addErrors: { ...editor.addErrors, name: undefined },
              });
              onDirtyChange(true);
            }}
            onValueChange={(value) => {
              updateEditor({
                value,
                addErrors: { ...editor.addErrors, value: undefined },
              });
              onDirtyChange(true);
            }}
            onSecretChange={(secret) => updateEditor({ secret })}
            onSubmit={(event) => void controller.create(event)}
            onClose={controller.closeEditor}
          />
          <BulkAddEnvironmentVariablesDialog
            open={editor.mode === "bulk"}
            fieldId={controller.fieldId}
            contents={editor.contents}
            autoDetect={editor.autoDetect}
            replace={editor.replace}
            existingKinds={new Map(items.map(({ name, kind }) => [name, kind]))}
            serverErrors={editor.bulkErrors}
            pending={pendingFor("applyBulk")}
            onContentsChange={(contents) => {
              updateEditor({ contents, bulkErrors: [] });
              onDirtyChange(true);
            }}
            onAutoDetectChange={(autoDetect) => updateEditor({ autoDetect })}
            onReplaceChange={(replace) => updateEditor({ replace })}
            onSubmit={() => void controller.applyBulk()}
            onClose={controller.closeEditor}
          />
          <EditEnvironmentVariableDialog
            fieldId={controller.fieldId}
            item={editor.edit}
            value={editor.editValue}
            error={editor.editError}
            pending={pendingFor("rotate")}
            finalFocus={dialogTriggerRef}
            onValueChange={(editValue) =>
              updateEditor({ editValue, editError: undefined })
            }
            onClose={() =>
              updateEditor({
                edit: undefined,
                editValue: "",
                editError: undefined,
              })
            }
            onSubmit={() => void controller.saveEdit()}
          />
          <DeleteEnvironmentVariableDialog
            item={editor.remove}
            error={editor.removeError}
            pending={pendingFor("delete")}
            finalFocus={dialogTriggerRef}
            onClose={() =>
              updateEditor({ remove: undefined, removeError: undefined })
            }
            onConfirm={() => void controller.confirmRemove()}
          />
        </>
      ) : null}
    </div>
  );
}
