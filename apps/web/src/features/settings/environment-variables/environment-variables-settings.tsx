import type {
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
} from "@dx/api";
import { type ProjectId, workspaceRoleHasPermission } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { SettingsCard } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type BulkPreview,
  CompactEnvironmentVariableDialogs,
  ConfiguredEnvironmentVariables,
  EnvironmentVariableDialogs,
  EnvironmentVariableHistory,
} from "./environment-variable-controls.js";
import {
  createEnvironmentVariableMutationOptions,
  type EnvironmentVariablesMutationAction,
  environmentVariablesMutationOptions,
  environmentVariablesPreviewMutationOptions,
} from "./environment-variables-mutations.js";
import {
  type EnvironmentVariablesTarget,
  environmentVariableHistoryQueryOptions,
  environmentVariablesQueryOptions,
} from "./environment-variables-queries.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

interface EnvironmentVariableEditorState {
  readonly name: string;
  readonly value: string;
  readonly kind: "secret" | "variable";
  readonly error?: string;
  readonly bulk: string;
  readonly preview?: BulkPreview;
  readonly conflictBehavior: "reject" | "replace";
  readonly rotate?: EnvironmentVariableData;
  readonly remove?: EnvironmentVariableData;
  readonly editorMode?: "add" | "bulk";
}

const initialEditorState: EnvironmentVariableEditorState = {
  name: "",
  value: "",
  kind: "secret",
  bulk: "",
  conflictBehavior: "reject",
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
  const mutation = useMutation(
    environmentVariablesMutationOptions(queryClient, identity.id, target),
  );
  const createMutation = useMutation(
    createEnvironmentVariableMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    environmentVariablesPreviewMutationOptions(identity.id, target),
  );
  const [editor, setEditor] = React.useState(initialEditorState);
  const updateEditor = (patch: Partial<EnvironmentVariableEditorState>) =>
    setEditor((current) => ({ ...current, ...patch }));
  const nameRef = React.useRef<HTMLInputElement>(null);
  const dialogTriggerRef = React.useRef<HTMLElement>(null);
  const fieldId = React.useId();
  const canMutate =
    target.scope !== "workspace" ||
    (workspace !== undefined &&
      workspaceRoleHasPermission(workspace.role, "workspace:update"));
  const handleError = (cause: unknown) => {
    updateEditor({ error: message(cause) });
  };
  const execute = async (action: EnvironmentVariablesMutationAction) => {
    updateEditor({ error: undefined });
    try {
      const result = await mutation.mutateAsync(action);
      return { success: true as const, result };
    } catch (cause) {
      handleError(cause);
      return { success: false as const };
    } finally {
      mutation.reset();
    }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(editor.name)) {
      updateEditor({
        error:
          "Use uppercase letters, numbers, and underscores; the name cannot start with a number.",
      });
      nameRef.current?.focus();
      return;
    }
    if (!editor.value) {
      updateEditor({ error: "Value is required." });
      return;
    }
    updateEditor({ error: undefined });
    try {
      await createMutation.mutateAsync({
        name: editor.name,
        value: editor.value,
        kind: editor.kind,
      });
      updateEditor({ name: "", value: "", editorMode: undefined });
      onDirtyChange(false);
    } catch (cause) {
      handleError(cause);
    } finally {
      createMutation.reset();
    }
  };
  const previewBulk = async () => {
    updateEditor({ error: undefined });
    try {
      const preview = await previewMutation.mutateAsync({
        kind: editor.kind,
        contents: editor.bulk,
      });
      updateEditor({ preview });
    } catch (cause) {
      handleError(cause);
    } finally {
      previewMutation.reset();
    }
  };
  const applyBulk = async () => {
    let nextPreview = editor.preview;
    if (nextPreview === undefined) {
      updateEditor({ error: undefined });
      try {
        nextPreview = await previewMutation.mutateAsync({
          kind: editor.kind,
          contents: editor.bulk,
        });
      } catch (cause) {
        handleError(cause);
        return;
      } finally {
        previewMutation.reset();
      }
      updateEditor({ preview: nextPreview });
    }
    if (!nextPreview.canApply) return;
    const result = await execute({
      type: "applyBulk",
      input: {
        kind: editor.kind,
        contents: editor.bulk,
        conflictBehavior: editor.conflictBehavior,
      },
    });
    if (!result.success) return;
    updateEditor({
      bulk: "",
      preview: undefined,
      editorMode: undefined,
    });
    onDirtyChange(false);
  };
  const rotateValue = async () => {
    if (editor.rotate === undefined) return;
    const result = await execute({
      type: "rotate",
      item: editor.rotate,
      value: editor.value,
    });
    if (result.success) updateEditor({ value: "", rotate: undefined });
  };
  const removeValue = async () => {
    if (editor.remove === undefined) return;
    const result = await execute({ type: "delete", item: editor.remove });
    if (result.success) updateEditor({ remove: undefined });
  };
  const closeEditor = () => {
    updateEditor({
      editorMode: undefined,
      name: "",
      value: "",
      bulk: "",
      preview: undefined,
      error: undefined,
    });
    onDirtyChange(false);
  };
  return {
    list,
    history,
    editor,
    updateEditor,
    nameRef,
    dialogTriggerRef,
    fieldId,
    canMutate,
    execute,
    create,
    previewBulk,
    applyBulk,
    rotateValue,
    removeValue,
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
  const target = React.useMemo(
    () => ({ scope: "project" as const, projectId }),
    [projectId],
  );
  return (
    <EnvironmentVariablesContent
      key={`${target.scope}:${projectId}`}
      target={target}
      onDirtyChange={onDirtyChange}
    />
  );
}

function EnvironmentVariablesContent({
  target,
  onDirtyChange,
  workspace,
}: SettingsSectionProps & {
  readonly target: EnvironmentVariablesTarget;
}) {
  const controller = useEnvironmentVariableController({
    target,
    workspace,
    onDirtyChange,
  });
  const { editor } = controller;
  const historyItemsById = new Map<
    EnvironmentVariableAuditEventData["id"],
    EnvironmentVariableAuditEventData
  >();
  for (const page of controller.history.data?.pages ?? []) {
    for (const item of page.items) historyItemsById.set(item.id, item);
  }
  const historyItems = [...historyItemsById.values()];
  return (
    <div className="environment-variables-settings">
      {!controller.canMutate ? (
        <SettingsCard title="Read-only workspace values">
          <p>
            Your workspace role does not include configuration changes. Only
            Workspace Owners and Admins can create, rotate, disable, or delete
            values.
          </p>
        </SettingsCard>
      ) : null}
      <ConfiguredEnvironmentVariables
        title="Values"
        emptyMessage="No secrets or environment variables configured."
        actions={
          controller.canMutate ? (
            <div className="environment-card-actions">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  controller.updateEditor({
                    bulk: "",
                    preview: undefined,
                    kind: "secret",
                    editorMode: "bulk",
                  });
                }}
              >
                Bulk Add
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  controller.updateEditor({
                    name: "",
                    value: "",
                    kind: "variable",
                    editorMode: "add",
                  });
                }}
              >
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>
          ) : undefined
        }
        loading={controller.list.isPending}
        loadError={
          controller.list.error === null
            ? undefined
            : message(controller.list.error)
        }
        items={controller.list.data?.items ?? []}
        canMutate={controller.canMutate}
        onReload={() => void controller.list.refetch()}
        onRotate={(item, trigger) => {
          controller.dialogTriggerRef.current = trigger;
          controller.updateEditor({ rotate: item });
        }}
        onToggle={(item) =>
          void controller.execute({
            type: "update",
            item,
            input: { enabled: !item.enabled },
          })
        }
        onDelete={(item, trigger) => {
          controller.dialogTriggerRef.current = trigger;
          controller.updateEditor({ remove: item });
        }}
      />
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
        <CompactEnvironmentVariableDialogs
          fieldId={controller.fieldId}
          mode={editor.editorMode}
          name={editor.name}
          value={editor.value}
          kind={editor.kind}
          bulk={editor.bulk}
          preview={editor.preview}
          conflictBehavior={editor.conflictBehavior}
          error={editor.error}
          nameRef={controller.nameRef}
          onNameChange={(next) => {
            controller.updateEditor({ name: next });
            onDirtyChange(true);
          }}
          onValueChange={(next) => {
            controller.updateEditor({ value: next });
            onDirtyChange(true);
          }}
          onKindChange={(next) => {
            controller.updateEditor({ kind: next });
            onDirtyChange(true);
          }}
          onBulkChange={(next) => {
            controller.updateEditor({ bulk: next, preview: undefined });
            onDirtyChange(true);
          }}
          onConflictBehavior={(conflictBehavior) =>
            controller.updateEditor({ conflictBehavior })
          }
          onCreate={(event) => void controller.create(event)}
          onApplyBulk={() => void controller.applyBulk()}
          onClose={controller.closeEditor}
        />
      ) : null}
      {editor.error ? (
        <div className="environment-error" role="alert">
          {editor.error}
          <Button size="xs" onClick={() => void controller.list.refetch()}>
            Refresh
          </Button>
        </div>
      ) : null}
      {controller.canMutate ? (
        <EnvironmentVariableDialogs
          fieldId={controller.fieldId}
          rotate={editor.rotate}
          remove={editor.remove}
          value={editor.value}
          finalFocus={controller.dialogTriggerRef}
          onValueChange={(value) => controller.updateEditor({ value })}
          onRotateOpenChange={(open) =>
            !open && controller.updateEditor({ rotate: undefined, value: "" })
          }
          onRotate={() => void controller.rotateValue()}
          onRemoveOpenChange={(open) =>
            !open && controller.updateEditor({ remove: undefined })
          }
          onRemove={() => void controller.removeValue()}
        />
      ) : null}
    </div>
  );
}
