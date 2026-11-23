import "./mode-dial.css";
import { isClaudeCodeModel, type ModeId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { MODES } from "../../../shared/mode-labels.js";
import { settle } from "../../../shared/settle.js";
import {
  modelRoutingChoicesQueryOptions,
  modeProfileQueryOptions,
} from "../model-routing/model-routing-queries.js";
import { ModelRoutingSettings } from "../model-routing/model-routing-settings.js";
import { settingsContextQueryOptions } from "../settings-context-queries.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsRow,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  AUTO,
  changedModes,
  type Drafts,
  listModes,
  type ModeDraft,
  type ModeSlot,
  type SavedModes,
} from "./mode-dial-drafts.js";
import { modeDialMutationOptions } from "./mode-dial-mutations.js";
import { MainAgentRole, SettingsSectionLink } from "./mode-dial-role.js";
import { useSpaceAgentRow } from "./space-agent-role.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/** The slot whose model is Recommended: new Threads start on it. */
const RECOMMENDED: ModeId = "medium";

/**
 * Settings → Models & Routing: Model Routing's connections, then one Models
 * card with the Recommended model new Threads start on, for the person or
 * (by an admin) the workspace, and, on the personal page, the model new
 * Spaces' coordinators run on, saved together. A Thread keeps the model it
 * starts with; picking another model is a composer choice.
 */
export const ModeDialSettings = (props: SettingsSectionProps) => {
  const { onDirtyChange, workspaceSlug } = props;
  const { identity } = useAuthenticatedIdentity();
  const target: ModelRoutingTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const profile = useQuery(modeProfileQueryOptions(identity.id, target));
  // The workspace page names the slots the viewer's own picks replace.
  const personalProfile = useQuery({
    ...modeProfileQueryOptions(identity.id),
    enabled: target.scope === "workspace",
  });
  const choices = useQuery(
    modelRoutingChoicesQueryOptions(identity.id, target),
  );
  // Spaces have their own model, beside these: personal only, and only on a
  // deployment with Spaces on.
  const settingsContext = useQuery(settingsContextQueryOptions(identity.id));
  const spaces =
    target.scope === "personal" && settingsContext.data?.spaces === true;
  const options = modeDialMutationOptions(queryClient, target);
  const saveMutation = useMutation(options.save);
  const resetMutation = useMutation(options.reset);
  const savedModes = profile.data?.modes as SavedModes | undefined;
  const dirtyModes = changedModes(drafts, savedModes);
  const dirty = dirtyModes.length > 0;
  const space = useSpaceAgentRow({
    enabled: spaces,
    onDirtyChange: (spaceDirty) => onDirtyChange(spaceDirty || dirty),
  });
  const updateDrafts = (next: Drafts, savedProfile?: SavedModes) => {
    setDrafts(next);
    onDirtyChange(
      changedModes(next, savedProfile ?? savedModes).length > 0 || space.dirty,
    );
  };
  const busy = saving || resetMutation.isPending || space.saving;
  // Claude Code models run as Claude Code, picked per Thread, never here.
  const servedModels = (choices.data?.models ?? []).filter(
    ({ canonical }) => !isClaudeCodeModel(canonical),
  );
  // The server names each model from the model catalog, as Model Routing
  // does; a slot's model has a name even when no connection serves it.
  const catalogNames = new Map<string, string>([
    ...(choices.data?.modes ?? []).map(
      (mode) => [mode.config.model, mode.modelName] as const,
    ),
    ...servedModels.map((model) => [model.canonical, model.name] as const),
  ]);
  const nameOf = (model: string) => catalogNames.get(model) ?? model;
  const personallyPinned =
    target.scope === "workspace"
      ? MODES.filter(
          (mode) =>
            (personalProfile.data?.modes as SavedModes | undefined)?.[mode]
              .source === "override",
        )
      : [];
  const save = async () => {
    if (saving || (!savedModes && !space.dirty)) return;
    const baseline = savedModes as SavedModes;
    setSaving(true);
    setError(undefined);
    const outcome = await settle(async () => {
      // Profile responses contain all slots, so apply writes sequentially.
      let remaining = { ...drafts };
      const saveDraft = async (mode: ModeId) => {
        const next = drafts[mode];
        if (next === undefined) return;
        const result =
          next === AUTO
            ? await resetMutation.mutateAsync(mode)
            : await saveMutation.mutateAsync({
                mode,
                config: { ...baseline[mode].config, agent: next },
              });
        queryClient.setQueryData(
          modeProfileQueryOptions(identity.id, target).queryKey,
          result,
        );
        remaining = { ...remaining, [mode]: undefined };
        updateDrafts(remaining, result.modes as SavedModes);
      };
      await dirtyModes.reduce(
        (previous, mode) => previous.then(() => saveDraft(mode)),
        Promise.resolve(),
      );
      await space.save();
    });
    if (outcome.ok) onDirtyChange(false);
    else setError(message(outcome.error));
    setSaving(false);
  };
  const unservedDraft = dirtyModes.some((mode) => {
    const next = drafts[mode];
    return (
      next !== undefined &&
      next !== AUTO &&
      !servedModels.some((m) => m.canonical === next.model)
    );
  });
  /** One slot's model and effort: Auto, or a pick. */
  const slotEditor = (mode: ModeId, label: string) => {
    const saved = savedModes?.[mode];
    const pinned = saved?.source === "override";
    const draft = drafts[mode];
    const choice: ModeDraft | undefined =
      draft ??
      (saved === undefined ? undefined : pinned ? saved.config.agent : AUTO);
    // Auto on a picked slot resolves only after Save.
    const effective: ModeSlot | undefined =
      choice === undefined
        ? undefined
        : choice !== AUTO
          ? choice
          : pinned
            ? undefined
            : saved?.config.agent;
    const autoLabel =
      saved === undefined || pinned
        ? "Auto"
        : `${saved.source === "workspace" ? "Workspace" : "Auto"} · ${nameOf(
            saved.config.agent.model,
          )}`;
    return profile.isError ? (
      <p role="alert">{message(profile.error)}</p>
    ) : choice === undefined ? (
      <p role="status">Loading…</p>
    ) : (
      <div className="models-slot" data-auto={choice === AUTO}>
        <MainAgentRole
          id={`models-${mode}`}
          label={`${label} model`}
          choice={choice}
          effective={effective}
          autoLabel={autoLabel}
          servedModels={servedModels}
          nameOf={nameOf}
          choicesPending={choices.isPending}
          choicesError={choices.isError ? message(choices.error) : undefined}
          busy={busy}
          target={target}
          onChoose={(next) => {
            setError(undefined);
            updateDrafts({ ...drafts, [mode]: next });
          }}
        />
      </div>
    );
  };
  return (
    <div className="mode-tuning-page">
      <ModelRoutingSettings {...props} />
      <h2 className="models-section-heading">Models</h2>
      {personallyPinned.length > 0 ? (
        <p className="tuning-notice">
          Your own picks for{" "}
          {personallyPinned.includes(RECOMMENDED)
            ? "the Recommended model"
            : listModes(personallyPinned)}{" "}
          replace these in your Threads. Edit them in{" "}
          <SettingsSectionLink target={{ scope: "personal" }} section="models">
            your Models settings
          </SettingsSectionLink>
          .
        </p>
      ) : null}
      <SettingsCard>
        <SettingsRow
          title="New Threads"
          description={
            target.scope === "personal"
              ? "The Recommended model. Auto follows your workspace's pick, or dx's when it has none."
              : "The Recommended model. Auto uses dx's pick."
          }
          control={slotEditor(RECOMMENDED, "Recommended")}
        />
        {space.row}
      </SettingsCard>
      <SettingsFormActions
        dirty={dirty || space.dirty}
        saving={busy}
        showStatus={false}
        {...(error === undefined ? {} : { error })}
        resetLabel="Discard"
        onReset={() => {
          space.discard();
          setDrafts({});
          // Nothing is left unsaved in either row.
          onDirtyChange(false);
          setError(undefined);
        }}
        onSave={() => {
          if (!choices.isError && !unservedDraft) void save();
        }}
      />
    </div>
  );
};
