import "./mode-dial.css";
import { isClaudeCodeModel, type ModeId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import {
  modelRoutingChoicesQueryOptions,
  modeProfileQueryOptions,
} from "../model-routing/model-routing-queries.js";
import { SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { ModeDialControl } from "./mode-dial-controls.js";
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

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

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
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { mode?: unknown };
  const selected = MODES.find((mode) => mode === search.mode) ?? "medium";
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const profile = useQuery(modeProfileQueryOptions(identity.id, target));
  // The workspace page names the modes the viewer's own pins replace.
  const personalProfile = useQuery({
    ...modeProfileQueryOptions(identity.id),
    enabled: target.scope === "workspace",
  });
  const choices = useQuery(
    modelRoutingChoicesQueryOptions(identity.id, target),
  );
  const options = modeDialMutationOptions(queryClient, target);
  const saveMutation = useMutation(options.save);
  const resetMutation = useMutation(options.reset);
  const savedModes = profile.data?.modes as SavedModes | undefined;
  const saved = savedModes?.[selected];
  const pinned = saved?.source === "override";
  const draft = drafts[selected];
  const choice: ModeDraft | undefined =
    draft ??
    (saved === undefined ? undefined : pinned ? saved.config.agent : AUTO);
  // What the main agent runs: a pin, or what Auto resolves to. Auto on a
  // pinned mode resolves only after Save, so it has no known slot yet.
  const effective: ModeSlot | undefined =
    choice === undefined
      ? undefined
      : choice !== AUTO
        ? choice
        : pinned
          ? undefined
          : saved?.config.agent;
  const dirtyModes = changedModes(drafts, savedModes);
  const dirty = dirtyModes.length > 0;
  const updateDrafts = (next: Drafts, savedProfile?: SavedModes) => {
    setDrafts(next);
    onDirtyChange(changedModes(next, savedProfile ?? savedModes).length > 0);
  };
  const busy = saving || resetMutation.isPending;
  // Claude Code models run as Claude Code mode, never in a Mode Dial slot.
  const servedModels = (choices.data?.models ?? []).filter(
    ({ canonical }) => !isClaudeCodeModel(canonical),
  );
  const servingModel = servedModels.find(
    (model) => model.canonical === effective?.model,
  );
  const modelName =
    effective === undefined
      ? choice === AUTO
        ? "Auto"
        : "Loading…"
      : (servingModel?.name ?? effective.model);
  const autoLabel =
    saved === undefined || pinned
      ? "Auto"
      : `${saved.source === "workspace" ? "Workspace" : "Auto"} · ${
          servedModels.find((m) => m.canonical === saved.config.agent.model)
            ?.name ?? saved.config.agent.model
        }`;
  const personallyPinned =
    target.scope === "workspace"
      ? MODES.filter(
          (mode) =>
            (personalProfile.data?.modes as SavedModes | undefined)?.[mode]
              .source === "override",
        )
      : [];
  const select = (mode: ModeId) => {
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...previous, mode }),
    } as Parameters<typeof navigate>[0]);
  };
  const choose = (next: ModeDraft) => {
    setError(undefined);
    updateDrafts({ ...drafts, [selected]: next });
  };
  const save = async () => {
    if (!savedModes || saving) return;
    const baseline = savedModes;
    setSaving(true);
    setError(undefined);
    const outcome = await settle(async () => {
      // Profile responses contain all modes, so apply writes sequentially.
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
  const reset = async () => {
    setError(undefined);
    const outcome = await settle(() => resetMutation.mutateAsync(selected));
    if (!outcome.ok) {
      setError(message(outcome.error));
      return;
    }
    queryClient.setQueryData(
      modeProfileQueryOptions(identity.id, target).queryKey,
      outcome.value,
    );
    updateDrafts(
      { ...drafts, [selected]: undefined },
      outcome.value.modes as SavedModes,
    );
  };
  return (
    <div className="mode-tuning-page">
      <SettingsHeading
        title="Mode Dial"
        description={
          target.scope === "personal"
            ? "Pin the model and reasoning effort behind each mode's main agent. Your pin for a mode replaces your workspace's pin for it; a mode left on Auto follows the workspace's pin, or dx's default when there is none."
            : "Pin the model and reasoning effort behind each mode's main agent for everyone in this workspace. A member's own pin for a mode replaces this one; a mode left on Auto uses dx's default."
        }
      />
      {personallyPinned.length > 0 ? (
        <p className="tuning-notice">
          Your own pins for {listModes(personallyPinned)} replace these in your
          Threads. Edit them in{" "}
          <SettingsSectionLink
            target={{ scope: "personal" }}
            section="mode-dial"
          >
            your Mode Dial
          </SettingsSectionLink>
          .
        </p>
      ) : null}
      <section
        className="mode-tuning-workbench"
        data-mode={selected}
        aria-label="Tune Modes"
      >
        <div className="tuning-workbench-body">
          <ModeDialControl
            selected={selected}
            onSelect={select}
            model={modelName}
            thinking={effective?.thinking ?? (choice === AUTO ? "Auto" : "—")}
            served={servingModel !== undefined}
            disabled={busy}
          />
          <div className="tuning-editor-column">
            <div className="tuning-mode-heading">
              <h2>
                {MODE_LABELS[selected]}
                {(draft === undefined ? pinned : draft !== AUTO) ? (
                  <span> · Tuned</span>
                ) : draft === undefined && saved?.source === "workspace" ? (
                  <span> · Workspace</span>
                ) : null}
              </h2>
              {pinned ? (
                <button
                  type="button"
                  onClick={() => void reset()}
                  disabled={busy}
                >
                  Reset to default
                </button>
              ) : null}
            </div>
            <div className="tuning-agent-card" data-auto={choice === AUTO}>
              <label htmlFor="mode-dial-model">Main Agent</label>
              {profile.isError ? (
                <p role="alert">{message(profile.error)}</p>
              ) : choice === undefined ? (
                <p role="status">Loading mode…</p>
              ) : (
                <MainAgentRole
                  choice={choice}
                  effective={effective}
                  autoLabel={autoLabel}
                  servedModels={servedModels}
                  choicesPending={choices.isPending}
                  choicesError={
                    choices.isError ? message(choices.error) : undefined
                  }
                  busy={busy}
                  target={target}
                  onChoose={choose}
                />
              )}
            </div>
          </div>
        </div>
        <footer className="tuning-footer">
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() => {
              updateDrafts({});
              setError(undefined);
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="tuning-save"
            disabled={
              !dirty ||
              busy ||
              choices.isError ||
              dirtyModes.some((mode) => {
                const next = drafts[mode];
                return (
                  next !== undefined &&
                  next !== AUTO &&
                  !servedModels.some((m) => m.canonical === next.model)
                );
              })
            }
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
        {error ? (
          <p className="tuning-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
};
