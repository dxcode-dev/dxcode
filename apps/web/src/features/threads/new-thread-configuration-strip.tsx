import { Select } from "@base-ui/react/select";
import type { ChoicesData, GraphData, ProjectData } from "@dx/api";
import type {
  ModeId,
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
} from "@dx/domain";
import { ArrowRight, Check, Folder } from "lucide-react";
import type { ReactNode } from "react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { Button } from "../../shared/ui/button.js";
import {
  angularDistance,
  DIAL_MODE_ORDER,
  DIAL_POSITION_BY_MODE,
} from "../../shared/ui/mode-dial-geometry.js";
import { ModeDialPlate } from "../../shared/ui/mode-dial-plate.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { modelDisplayName } from "./model-display-name.js";
import { ServingBadge } from "./model-picker-presentation.js";
import { REASONING_MODES } from "./new-thread-modal-utils.js";

const shortcutSnapshot = () => 0;

const focusModeDial = () =>
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>('[role="slider"][aria-label="Mode dial"]')
      ?.focus(),
  );

function ModeDialIcon({ profile }: { readonly profile: ModeId }) {
  return (
    <svg
      className="new-thread-mode-dial-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.73 17.75A10 10 0 1 1 21.27 17.75" />
      <line
        x1="12"
        y1="14"
        x2="12"
        y2="8.34"
        transform={`rotate(${DIAL_POSITION_BY_MODE[profile].angle - 282} 12 14)`}
      />
    </svg>
  );
}

function RawModelList({
  choices,
  routingGraph,
  selectedModel,
  query,
  onSelect,
}: {
  readonly choices: ChoicesData | undefined;
  readonly routingGraph?: GraphData;
  readonly query: string;
  readonly selectedModel: string | undefined;
  readonly onSelect: (modelId: string) => void;
}) {
  const normalized = query.trim().toLowerCase();
  const models = (choices?.models ?? []).filter(
    (model) =>
      normalized === "" ||
      modelDisplayName(model.name).toLowerCase().includes(normalized) ||
      model.canonical.toLowerCase().includes(normalized) ||
      model.connectionName.toLowerCase().includes(normalized),
  );
  return (
    <div className="reasoning-raw-panel">
      {choices === undefined ? (
        <p className="reasoning-raw-empty">Loading models…</p>
      ) : models.length === 0 ? (
        <p className="reasoning-raw-empty">
          {choices.models.length === 0
            ? "No models available. Add a provider connection in Settings."
            : `No models match “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="reasoning-raw-list">
          {models.map((model) => (
            <li key={`${model.connectionId}:${model.canonical}`}>
              <button
                type="button"
                className="reasoning-raw-option"
                data-selected={selectedModel === model.canonical || undefined}
                aria-pressed={selectedModel === model.canonical}
                onClick={() => onSelect(model.canonical)}
              >
                <span className="reasoning-raw-option-main">
                  <span className="mode-option-heading">
                    <strong>{modelDisplayName(model.name)}</strong>
                    <ServingBadge
                      name={model.connectionName}
                      connection={routingGraph?.connections.find(
                        (c) => c.connectionId === model.connectionId,
                      )}
                    />
                  </span>
                  <small>
                    {modelDisplayName(model.name)} ·{" "}
                    {Math.round(model.contextWindow / 1000)}k context
                  </small>
                </span>
                <span className="reasoning-raw-option-meta">
                  {selectedModel === model.canonical ? (
                    <Check aria-label="Selected" />
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReasoningModeConsole({
  profile,
  onProfileChange,
  onFocusDial,
  choices,
  routingGraph,
  selectedModel,
  onModelChange,
  pickerTab,
  onPickerTabChange,
}: {
  readonly profile: ModeId;
  readonly onProfileChange: (profile: ModeId) => void;
  readonly onFocusDial: () => void;
  readonly choices: ChoicesData | undefined;
  readonly routingGraph?: GraphData;
  readonly selectedModel: string | undefined;
  readonly onModelChange: (model: string | undefined) => void;
  readonly pickerTab: "modes" | "raw";
  readonly onPickerTabChange: (tab: "modes" | "raw") => void;
}) {
  const [query, setQuery] = React.useState("");
  const mode =
    REASONING_MODES.find(({ id }) => id === profile) ?? REASONING_MODES[2];
  const modeIndex = DIAL_MODE_ORDER.indexOf(mode.id);
  const selectedAngle = DIAL_POSITION_BY_MODE[mode.id].angle;
  const selectMode = (nextMode: ModeId) => {
    onProfileChange(nextMode);
    if (selectedModel !== undefined) onModelChange(undefined);
  };
  const selectModeFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const angle =
      (Math.atan2(
        event.clientY - bounds.top - bounds.height / 2,
        event.clientX - bounds.left - bounds.width / 2,
      ) *
        180) /
      Math.PI;
    const nextMode = DIAL_MODE_ORDER.reduce((closest, candidate) =>
      angularDistance(angle, DIAL_POSITION_BY_MODE[candidate].angle) <
      angularDistance(angle, DIAL_POSITION_BY_MODE[closest].angle)
        ? candidate
        : closest,
    );
    selectMode(nextMode);
  };
  const moveModeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      !["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)
    )
      return;
    event.preventDefault();
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
    const nextIndex = Math.max(
      0,
      Math.min(DIAL_MODE_ORDER.length - 1, modeIndex + direction),
    );
    selectMode(DIAL_MODE_ORDER[nextIndex] ?? "medium");
  };
  const tier = choices?.modes.find(({ mode: id }) => id === mode.id);
  const pickedModel = choices?.models.find(
    ({ canonical }) => canonical === selectedModel,
  );
  const activeModel =
    pickedModel ??
    choices?.models.find((m) => m.canonical === tier?.config.model);
  const displayModel = modelDisplayName(
    activeModel?.name ?? tier?.config.model ?? "—",
  );
  const agentEffort = tier?.config.thinking.toUpperCase() ?? "—";
  const resolutionLabel =
    selectedModel !== undefined
      ? pickedModel?.connectionName
        ? `SERVED BY ${pickedModel.connectionName}`
        : "NOT SERVED"
      : tier?.served
        ? `SERVED BY ${tier.servingConnectionName ?? "CONNECTED PROVIDER"}`
        : "NOT SERVED";
  return (
    <div className="reasoning-console">
      <div className="reasoning-console-toolbar">
        {pickerTab === "raw" ? (
          <input
            className="reasoning-picker-search"
            type="search"
            aria-label="Search models"
            placeholder="Choose a Model…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
          />
        ) : (
          <span>Choose a mode</span>
        )}
        <button
          type="button"
          className="reasoning-console-shortcut"
          aria-label="Focus mode dial"
          onClick={onFocusDial}
        >
          <ShortcutKeycaps keycaps={["⌃", "S"]} />
        </button>
        <div className="reasoning-console-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={pickerTab === "modes"}
            data-active={pickerTab === "modes" || undefined}
            onClick={() => onPickerTabChange("modes")}
          >
            dx Modes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pickerTab === "raw"}
            data-active={pickerTab === "raw" || undefined}
            onClick={() => onPickerTabChange("raw")}
          >
            Raw Models
          </button>
        </div>
      </div>
      {pickerTab === "raw" ? (
        <RawModelList
          choices={choices}
          routingGraph={routingGraph}
          selectedModel={selectedModel}
          query={query}
          onSelect={(modelId) => onModelChange(modelId)}
        />
      ) : (
        <div className="reasoning-console-plate-wrap">
          <ModeDialPlate
            profile={mode.id}
            selectedAngle={selectedAngle}
            agentEffort={agentEffort}
            displayModel={displayModel}
            resolutionLabel={resolutionLabel}
            agentOnly
          />
          <div
            className="reasoning-console-dial-target"
            role="slider"
            aria-label="Mode dial"
            aria-valuemin={0}
            aria-valuemax={DIAL_MODE_ORDER.length - 1}
            aria-valuenow={modeIndex}
            aria-valuetext={mode.label}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
            tabIndex={0}
            onKeyDown={moveModeWithKeyboard}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              selectModeFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.stopPropagation();
                selectModeFromPointer(event);
              }
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              event.stopPropagation();
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function ModePicker({
  profile,
  model,
  choices,
  routingGraph,
  locked,
  open,
  onOpenChange,
  onProfileChange,
  onModelChange,
}: {
  readonly profile: ModeId;
  readonly model: string | undefined;
  readonly choices: ChoicesData | undefined;
  readonly routingGraph?: GraphData;
  readonly locked: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onProfileChange: (profile: ModeId) => void;
  readonly onModelChange: (model: string | undefined) => void;
}) {
  const [pickerTab, setPickerTab] = React.useState<"modes" | "raw">("modes");

  return (
    <Select.Root
      value={profile}
      disabled={locked}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={(value) => {
        // Switching picker tabs unmounts Select items and emits a cleared value.
        if (value === null) return;
        onModelChange(undefined);
        onProfileChange(value);
      }}
    >
      <Select.Trigger
        className="new-thread-config-pill new-thread-mode"
        aria-label={
          model === undefined ? `Reasoning mode: ${profile}` : `Model: ${model}`
        }
        title={
          model === undefined ? `Reasoning mode: ${profile}` : `Model: ${model}`
        }
      >
        <ModeDialIcon profile={profile} />
        {model === undefined ? (
          <>
            <span className="new-thread-mode-label">Mode: </span>
            <Select.Value />
          </>
        ) : (
          <>
            <span className="new-thread-mode-label">Model: </span>
            <span className="new-thread-mode-value">
              {modelDisplayName(
                choices?.models.find(({ canonical }) => canonical === model)
                  ?.name ?? model,
              )}
            </span>
          </>
        )}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="reasoning-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="reasoning-popup">
            <ReasoningModeConsole
              profile={profile}
              onProfileChange={onProfileChange}
              onFocusDial={focusModeDial}
              choices={choices}
              routingGraph={routingGraph}
              selectedModel={model}
              onModelChange={(value) => {
                onModelChange(value);
                if (value !== undefined) onOpenChange(false);
              }}
              pickerTab={pickerTab}
              onPickerTabChange={setPickerTab}
            />
            {pickerTab === "modes" ? (
              <Select.List className="reasoning-list">
                {REASONING_MODES.map((mode) => (
                  <Select.Item
                    key={mode.id}
                    value={mode.id}
                    className="reasoning-option"
                    aria-describedby={`reasoning-${mode.id}-description`}
                  >
                    <Select.ItemIndicator className="reasoning-check">
                      <Check />
                    </Select.ItemIndicator>
                    <span>
                      <span className="mode-option-heading">
                        <Select.ItemText>{mode.id}</Select.ItemText>
                        <ServingBadge
                          compact
                          name={
                            choices?.modes.find((m) => m.mode === mode.id)
                              ?.servingConnectionName
                          }
                          connection={routingGraph?.connections.find(
                            (c) =>
                              c.connectionId ===
                              routingGraph.edges.find((e) => e.mode === mode.id)
                                ?.connectionId,
                          )}
                        />
                      </span>
                      <small id={`reasoning-${mode.id}-description`}>
                        {mode.description}
                      </small>
                    </span>
                  </Select.Item>
                ))}
              </Select.List>
            ) : null}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

const REPOSITORY_LABELS = {
  git: "Git",
  github: "GitHub",
  bitbucket: "Bitbucket",
  gitlab: "GitLab",
  forgejo: "Forgejo",
} as const;
function ProjectOption({ project }: { readonly project: ProjectData }) {
  return (
    <Select.Item value={project.id} className="project-picker-option">
      <Select.ItemText className="project-picker-name" title={project.name}>
        {project.name}
      </Select.ItemText>
      {project.repository ? (
        <span
          className="project-picker-repository"
          title={project.repository.fullName}
        >
          <span>{project.repository.fullName}</span>
          <small>{REPOSITORY_LABELS[project.repository.provider]}</small>
        </span>
      ) : null}
      <Select.ItemIndicator className="project-picker-check">
        <Check />
      </Select.ItemIndicator>
    </Select.Item>
  );
}

function ProjectPicker({
  projects,
  projectId,
  locked,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
  onProjectChange,
  projectTriggerRef,
}: {
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  readonly locked: boolean;
  readonly hasMoreProjects: boolean;
  readonly loadingMoreProjects: boolean;
  readonly onLoadMoreProjects: () => void;
  readonly onProjectChange: (id: ProjectId | "") => void;
  readonly projectTriggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [projectQuery, setProjectQuery] = React.useState("");
  const [recentProjectIds, setRecentProjectIds] = React.useState<
    ReadonlyArray<ProjectId>
  >([]);
  const projectName =
    projects.find(({ id }) => id === projectId)?.name ?? "No Project";
  const visibleProjects = projects.filter((project) =>
    [project.name, project.repository?.fullName ?? ""].some((value) =>
      value.toLowerCase().includes(projectQuery.trim().toLowerCase()),
    ),
  );
  const recentIds = new Set([
    ...(projectId ? [projectId] : []),
    ...recentProjectIds,
  ]);
  const recentProjects = visibleProjects.filter((project) =>
    recentIds.has(project.id),
  );
  const otherProjects = visibleProjects.filter(
    (project) => !recentIds.has(project.id),
  );
  return (
    <Select.Root
      value={projectId || "no-project"}
      disabled={locked}
      onOpenChange={(open) => {
        if (!open) setProjectQuery("");
      }}
      onValueChange={(value) => {
        if (value === null) return;
        if (value !== "no-project")
          setRecentProjectIds((current) =>
            [value as ProjectId, ...current.filter((id) => id !== value)].slice(
              0,
              5,
            ),
          );
        onProjectChange(value === "no-project" ? "" : (value as ProjectId));
      }}
    >
      <Select.Trigger
        ref={projectTriggerRef}
        className="new-thread-config-pill new-thread-project"
        aria-label={`Project: ${projectName}`}
        title={`Project: ${projectName}`}
      >
        <Folder aria-hidden="true" />
        <span className="new-thread-project-prefix">Project: </span>
        <Select.Value>{projectName}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="thread-context-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="thread-context-popup project-picker-popup">
            <label className="thread-context-search">
              <input
                type="search"
                aria-label="Filter projects"
                placeholder="Choose a project…"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              />
              <ShortcutKeycaps keycaps={["⌃", "J"]} />
            </label>
            <Select.List className="thread-context-list">
              <Select.Item value="no-project" className="project-picker-option">
                <Select.ItemText className="project-picker-name">
                  No Project
                </Select.ItemText>
                <Select.ItemIndicator className="project-picker-check">
                  <Check />
                </Select.ItemIndicator>
              </Select.Item>
              {recentProjects.length > 0 ? (
                <>
                  <div className="project-picker-heading">Recent</div>
                  {recentProjects.map((project) => (
                    <ProjectOption key={project.id} project={project} />
                  ))}
                </>
              ) : null}
              {otherProjects.length > 0 ? (
                <>
                  <div className="project-picker-heading">Projects</div>
                  {otherProjects.map((project) => (
                    <ProjectOption key={project.id} project={project} />
                  ))}
                </>
              ) : null}
              {visibleProjects.length === 0 ? (
                <p className="project-picker-empty">
                  {projectQuery.trim()
                    ? "No projects found."
                    : "No projects yet."}
                </p>
              ) : null}
              {hasMoreProjects ? (
                <button
                  type="button"
                  className="thread-context-load-more"
                  disabled={loadingMoreProjects}
                  onClick={onLoadMoreProjects}
                >
                  {loadingMoreProjects ? "Loading…" : "More projects"}
                </button>
              ) : null}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function NewThreadConfigurationStrip({
  projects,
  projectId,
  profile,
  model,
  choices,
  routingGraph,
  locked,
  submitting,
  ready,
  retrying,
  hasMoreProjects = false,
  loadingMoreProjects = false,
  onLoadMoreProjects = () => undefined,
  onProjectChange,
  runnerProfiles = [],
  runnerProfileId,
  runnerProfileLoading = false,
  allowedRunnerProfileIds,
  onRunnerProfileChange,
  onRunnerProfileRetry,
  onProfileChange,
  onModelChange,
  dictationControls,
  dictationActive = false,
  dictationHideSubmit = false,
}: {
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  readonly profile: ModeId;
  readonly model?: string;
  readonly choices?: ChoicesData;
  readonly routingGraph?: GraphData;
  readonly locked: boolean;
  readonly submitting: boolean;
  readonly ready: boolean;
  readonly retrying: boolean;
  readonly hasMoreProjects?: boolean;
  readonly loadingMoreProjects?: boolean;
  readonly onLoadMoreProjects?: () => void;
  readonly onProjectChange: (projectId: ProjectId | "") => void;
  readonly runnerProfiles?: ReadonlyArray<RunnerProfile>;
  readonly runnerProfileId?: RunnerProfileId;
  readonly runnerProfileLoading?: boolean;
  readonly allowedRunnerProfileIds?: ReadonlyArray<RunnerProfileId> | null;
  readonly onRunnerProfileChange?: (runnerProfileId: RunnerProfileId) => void;
  readonly onRunnerProfileRetry?: () => void;
  readonly onProfileChange: (profile: ModeId) => void;
  readonly onModelChange: (model: string | undefined) => void;
  readonly dictationControls?: ReactNode;
  readonly dictationActive?: boolean;
  readonly dictationHideSubmit?: boolean;
}) {
  const [modePickerOpen, setModePickerOpen] = React.useState(false);
  const projectTriggerRef = React.useRef<HTMLButtonElement>(null);
  const openAndFocusModePicker = React.useCallback(() => {
    setModePickerOpen(true);
    focusModeDial();
  }, []);
  const shortcutHandler = React.useCallback(
    (event: KeyboardEvent) => {
      if (
        locked ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !["s", "j"].includes(event.key.toLowerCase())
      )
        return;
      event.preventDefault();
      if (event.key.toLowerCase() === "j") projectTriggerRef.current?.click();
      else openAndFocusModePicker();
    },
    [locked, openAndFocusModePicker],
  );
  const subscribeToShortcut = React.useCallback(
    (_onStoreChange: () => void) => {
      window.addEventListener("keydown", shortcutHandler);
      return () => window.removeEventListener("keydown", shortcutHandler);
    },
    [shortcutHandler],
  );
  React.useSyncExternalStore(
    subscribeToShortcut,
    shortcutSnapshot,
    shortcutSnapshot,
  );
  const selectedRunnerProfile = runnerProfiles.find(
    ({ id }) => id === runnerProfileId,
  );
  const canRetryRunnerProfiles = onRunnerProfileRetry !== undefined;
  const allowedRunnerProfileIdSet = React.useMemo(
    () =>
      allowedRunnerProfileIds === null || allowedRunnerProfileIds === undefined
        ? undefined
        : new Set(allowedRunnerProfileIds),
    [allowedRunnerProfileIds],
  );

  return (
    <footer className="new-thread-config-strip">
      {selectedRunnerProfile === undefined ? (
        <button
          type="button"
          className="new-thread-config-pill new-thread-orb-size"
          aria-label={
            runnerProfileLoading
              ? "Orb"
              : canRetryRunnerProfiles
                ? "Orb options unavailable. Retry"
                : "Orb options unavailable"
          }
          title={
            runnerProfileLoading
              ? "Loading Orb options"
              : canRetryRunnerProfiles
                ? "Orb options unavailable. Retry"
                : "Orb options unavailable"
          }
          disabled={locked || runnerProfileLoading || !canRetryRunnerProfiles}
          onClick={onRunnerProfileRetry}
        >
          <OrbIcon aria-hidden="true" />
          <span>Orb</span>
        </button>
      ) : (
        <Select.Root
          value={selectedRunnerProfile.id}
          disabled={locked || onRunnerProfileChange === undefined}
          onValueChange={(value) =>
            onRunnerProfileChange?.(value as RunnerProfileId)
          }
        >
          <Select.Trigger
            className="new-thread-config-pill new-thread-orb-size"
            aria-label={`Orb: ${selectedRunnerProfile.label}`}
            title={`Orb: ${selectedRunnerProfile.label}`}
          >
            <OrbIcon aria-hidden="true" />
            <span>{selectedRunnerProfile.label}</span>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner
              className="thread-context-positioner"
              side="bottom"
              align="start"
              sideOffset={8}
              alignItemWithTrigger={false}
            >
              <Select.Popup className="thread-context-popup">
                <Select.List className="thread-context-list">
                  {runnerProfiles.map((runnerProfile) => (
                    <Select.Item
                      key={runnerProfile.id}
                      value={runnerProfile.id}
                      className="thread-context-option"
                      disabled={
                        runnerProfile.availability !== "available" ||
                        (allowedRunnerProfileIdSet !== undefined &&
                          !allowedRunnerProfileIdSet.has(runnerProfile.id))
                      }
                    >
                      <OrbIcon aria-hidden="true" />
                      <span className="thread-context-orb-details">
                        <Select.ItemText>{runnerProfile.label}</Select.ItemText>
                        <small>
                          {runnerProfile.resources.cpuCores} CPU ·{" "}
                          {runnerProfile.resources.memoryMb / 1024} GB
                        </small>
                      </span>
                      <Select.ItemIndicator className="orb-picker-check">
                        <Check />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      )}
      <ProjectPicker
        projects={projects}
        projectId={projectId}
        locked={locked}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        onLoadMoreProjects={onLoadMoreProjects}
        onProjectChange={onProjectChange}
        projectTriggerRef={projectTriggerRef}
      />
      <ModePicker
        profile={profile}
        model={model}
        choices={choices}
        routingGraph={routingGraph}
        locked={locked}
        open={modePickerOpen}
        onOpenChange={setModePickerOpen}
        onProfileChange={onProfileChange}
        onModelChange={onModelChange}
      />
      <span className="new-thread-config-spacer" />
      {dictationControls}
      {dictationHideSubmit ? null : (
        <Button
          type="submit"
          size="icon-sm"
          className="new-thread-submit"
          aria-label={
            retrying ? "Retry sending message" : "Create thread and send"
          }
          disabled={submitting || (!ready && !dictationActive)}
        >
          {submitting ? (
            <span className="tool-spinner" />
          ) : retrying ? (
            "↻"
          ) : (
            <ArrowRight />
          )}
        </Button>
      )}
    </footer>
  );
}
