import "./mode-dial.css";
import { isClaudeCodeModel, type ModeId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { DisclosureTrigger } from "../../../shared/ui/disclosure.js";
import {
  modelRoutingChoicesQueryOptions,
  modeProfileQueryOptions,
} from "../model-routing/model-routing-queries.js";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
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
import { MODE_LABELS, MODES } from "./mode-dial-values.js";
import { SpaceAgentRole } from "./space-agent-role.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/** The slot whose model is Recommended: new Threads start on it. */
const RECOMMENDED: ModeId = "medium";
/** Retired modes: only Threads started on them before still run on them. */
const OLDER: ReadonlyArray<ModeId> = ["low", "high", "ultra"];

/**
 * Settings → Models: the Recommended model and effort new Threads start on,
 * for the person or (by an admin) the workspace, and the models older Threads
 * started on a retired mode still run on. A Thread keeps the model it starts
 * with; picking another model is a New Thread composer choice.
 */
export const ModeDialSettings = ({
  onDirtyChange,
  workspaceSlug,
}: SettingsSectionProps) => {
  const { identity } = useAuthenticatedIdentity();
  const target: ModelRoutingTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
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
  // Spaces have their own model, beside these: personal only.
  const spaces = target.scope === "personal";
  const options = modeDialMutationOptions(queryClient, target);
  const saveMutation = useMutation(options.save);
  const resetMutation = useMutation(options.reset);
  const savedModes = profile.data?.modes as SavedModes | undefined;
  const dirtyModes = changedModes(drafts, savedModes);
  const dirty = dirtyModes.length > 0;
  const updateDrafts = (next: Drafts, savedProfile?: SavedModes) => {
    setDrafts(next);
    onDirtyChange(changedModes(next, savedProfile ?? savedModes).length > 0);
  };
  const busy = saving || resetMutation.isPending;
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
    if (!savedModes || saving) return;
    const baseline = savedModes;
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
    });
    if (!outcome.ok) setError(message(outcome.error));
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
      <div className="tuning-agent-card" data-auto={choice === AUTO}>
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
  const olderPinned = OLDER.filter(
    (mode) => savedModes?.[mode].source === "override",
  );
  return (
    <div className="mode-tuning-page">
      <SettingsHeading
        title="Models"
        description={
          target.scope === "personal"
            ? "New Threads start on the Recommended model. Pick any other model for one Thread in the New Thread composer, where each model shows who pays for it. A Thread keeps the model and effort it started with."
            : "The Recommended model everyone in this workspace starts new Threads on. A member's own Recommended model replaces this one; Auto uses dx's pick."
        }
      />
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
      <SettingsCard
        title="Recommended model"
        description={
          target.scope === "personal"
            ? "Auto follows your workspace's pick, or dx's when it has none."
            : "Auto uses dx's pick."
        }
      >
        {slotEditor(RECOMMENDED, "Recommended")}
      </SettingsCard>
      <SettingsCard
        variant="outline"
        title="Older mode Threads"
        description={`Threads started on the Low, High, or Ultra mode before modes were retired still run on these. New Threads never do.${olderPinned.length > 0 ? ` Picked: ${listModes(olderPinned)}.` : ""}`}
        actions={
          <DisclosureTrigger
            expanded={olderOpen}
            onClick={() => setOlderOpen(!olderOpen)}
          >
            {olderOpen ? "Hide" : "Show"}
          </DisclosureTrigger>
        }
      >
        {olderOpen ? (
          <div className="models-older-modes">
            {OLDER.map((mode) => (
              <section key={mode} aria-label={`${MODE_LABELS[mode]} mode`}>
                <h3>{MODE_LABELS[mode]}</h3>
                {slotEditor(mode, `${MODE_LABELS[mode]} mode`)}
              </section>
            ))}
          </div>
        ) : null}
      </SettingsCard>
      <SettingsFormActions
        dirty={dirty}
        saving={busy}
        message={
          profile.isPending
            ? "Loading…"
            : profile.isError
              ? "Unavailable"
              : busy
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : "In sync"
        }
        {...(error === undefined ? {} : { error })}
        resetLabel="Discard"
        onReset={() => {
          updateDrafts({});
          setError(undefined);
        }}
        onSave={() => {
          if (!choices.isError && !unservedDraft) void save();
        }}
      />
      {spaces ? <SpaceAgentRole /> : null}
    </div>
  );
};
