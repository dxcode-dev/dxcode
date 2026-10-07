import "./mode-dial.css";
import type { ModeId, ThinkingLevel } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ModelRoutingTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  modelRoutingChoicesQueryOptions,
  modeProfileQueryOptions,
} from "../model-routing/model-routing-queries.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { ModeDialControl, ReasoningEffort } from "./mode-dial-controls.js";
import { modeDialMutationOptions } from "./mode-dial-mutations.js";
import { MODE_LABELS, MODES } from "./mode-dial-values.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
interface ModeDraft {
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

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
  const [drafts, setDrafts] = useState<Partial<Record<ModeId, ModeDraft>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const profile = useQuery(modeProfileQueryOptions(identity.id, target));
  const choices = useQuery(
    modelRoutingChoicesQueryOptions(identity.id, target),
  );
  const options = modeDialMutationOptions(queryClient, target);
  const saveMutation = useMutation(options.save);
  const resetMutation = useMutation(options.reset);
  const saved = profile.data?.modes[selected];
  const effective = drafts[selected] ?? saved?.config.agent;
  const dirtyModes = MODES.filter((mode) => {
    const draft = drafts[mode],
      baseline = profile.data?.modes[mode]?.config.agent;
    return (
      draft !== undefined &&
      baseline !== undefined &&
      (draft.model !== baseline.model || draft.thinking !== baseline.thinking)
    );
  });
  const dirty = dirtyModes.length > 0;
  const updateDrafts = (
    next: Partial<Record<ModeId, ModeDraft>>,
    baseline = profile.data,
  ) => {
    setDrafts(next);
    onDirtyChange(
      MODES.some((mode) => {
        const draft = next[mode];
        const savedAgent = baseline?.modes[mode].config.agent;
        return (
          draft !== undefined &&
          savedAgent !== undefined &&
          (draft.model !== savedAgent.model ||
            draft.thinking !== savedAgent.thinking)
        );
      }),
    );
  };
  const busy = saving || resetMutation.isPending;
  const servedModels = choices.data?.models ?? [];
  const servingModel = servedModels.find(
    (model) => model.canonical === effective?.model,
  );
  const modelName = servingModel?.name ?? effective?.model ?? "Loading…";
  const select = (mode: ModeId) => {
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...previous, mode }),
    } as Parameters<typeof navigate>[0]);
  };
  const patch = (next: Partial<ModeDraft>) => {
    if (!effective) return;
    setError(undefined);
    updateDrafts({
      ...drafts,
      [selected]: { ...effective, ...next },
    });
  };
  const save = async () => {
    if (!profile.data || saving) return;
    const baseline = profile.data;
    setSaving(true);
    setError(undefined);
    try {
      // Profile responses contain all modes, so apply writes sequentially.
      let remaining = { ...drafts };
      const saveDraft = async (mode: ModeId) => {
        const draft = drafts[mode];
        if (!draft) return;
        const result = await saveMutation.mutateAsync({
          mode,
          config: { ...baseline.modes[mode].config, agent: draft },
        });
        queryClient.setQueryData(
          modeProfileQueryOptions(identity.id, target).queryKey,
          result,
        );
        remaining = { ...remaining, [mode]: undefined };
        updateDrafts(remaining, result);
      };
      await dirtyModes.reduce(
        (previous, mode) => previous.then(() => saveDraft(mode)),
        Promise.resolve(),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    setError(undefined);
    try {
      const result = await resetMutation.mutateAsync(selected);
      queryClient.setQueryData(
        modeProfileQueryOptions(identity.id, target).queryKey,
        result,
      );
      updateDrafts({ ...drafts, [selected]: undefined }, result);
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <div className="mode-tuning-page">
      <header className="mode-tuning-heading">
        <h1>Mode Dial</h1>
        <p>
          {target.scope === "personal"
            ? "Choose the main-agent model and reasoning effort for each mode. Models come from your connections in Model Routing."
            : "Set each mode's main-agent model and reasoning effort for members who have not tuned it themselves. Models come from the workspace's connections."}
        </p>
      </header>
      <div className="tuning-section-label">Tune Modes</div>
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
            thinking={effective?.thinking ?? "—"}
            served={servingModel !== undefined}
            disabled={busy}
          />
          <div className="tuning-editor-column">
            <div className="tuning-mode-heading">
              <h2>
                {MODE_LABELS[selected]}
                {saved?.source === "override" ||
                dirtyModes.includes(selected) ? (
                  <span> · Tuned</span>
                ) : saved?.source === "workspace" ? (
                  <span> · Workspace</span>
                ) : null}
              </h2>
              {saved?.source === "override" ? (
                <button
                  type="button"
                  onClick={() => void reset()}
                  disabled={busy}
                >
                  {target.scope === "personal" ? "Reset" : "Reset to default"}
                </button>
              ) : null}
            </div>
            <div className="tuning-agent-card">
              <label htmlFor="mode-dial-model">Main Agent</label>
              {profile.isError ? (
                <p role="alert">{message(profile.error)}</p>
              ) : !effective ? (
                <p role="status">Loading mode…</p>
              ) : (
                <>
                  <select
                    id="mode-dial-model"
                    value={effective.model}
                    disabled={busy || choices.isPending || choices.isError}
                    onChange={(e) => {
                      const model = servedModels.find(
                        (m) => m.canonical === e.target.value,
                      );
                      patch({
                        model: e.target.value,
                        thinking:
                          model?.reasoning === false
                            ? "off"
                            : effective.thinking,
                      });
                    }}
                  >
                    {!servingModel ? (
                      <option value={effective.model} disabled>
                        {effective.model} · Not served
                      </option>
                    ) : null}
                    {servedModels.map((model) => (
                      <option key={model.canonical} value={model.canonical}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <ReasoningEffort
                    value={effective.thinking}
                    disabled={busy || servingModel?.reasoning !== true}
                    onChange={(thinking) => patch({ thinking })}
                  />
                  <p className="tuning-serving" role="status">
                    {choices.isPending
                      ? "Loading available models…"
                      : choices.isError
                        ? message(choices.error)
                        : servingModel
                          ? `Served by ${servingModel.connectionName}`
                          : "Not served. Add or enable a connection in Model Routing."}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
        <footer className="tuning-footer">
          <span className="tuning-save-state" data-dirty={dirty}>
            {dirty ? "● Unsaved changes" : "In sync"}
          </span>
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
              dirtyModes.some(
                (mode) =>
                  !servedModels.some(
                    (model) => model.canonical === drafts[mode]?.model,
                  ),
              )
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
