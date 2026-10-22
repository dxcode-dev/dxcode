import type { PersonalComposerDefaultsData, ProjectData } from "@dx/api";
import { MODE_IDS, type ModeId, type ProjectId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import {
  canStartThreadsIn,
  rememberedProjectToResolve,
  startingMode,
  startingModel,
  startingProjectId,
} from "../../../shared/composer-start.js";
import { modelDisplayName } from "../../../shared/model-display-name.js";
import {
  projectQueryOptions,
  projectsQueryOptions,
} from "../../projects/project-queries.js";
import { MODE_LABELS } from "../mode-dial/mode-dial-values.js";
import { modelRoutingChoicesQueryOptions } from "../model-routing/model-routing-queries.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  composerDefaultsQueryOptions,
  updateComposerDefaultsMutationOptions,
} from "./composer-defaults-queries.js";
import { DictationVocabularyCard } from "./dictation-vocabulary.js";

const NO_PROJECT = "";
const PINNED_MODEL = "pinned-model";

/**
 * What the next New Thread starts with. The New Thread composer writes these
 * whenever its Project or mode changes, so each row shows the value it will
 * open with, resolved the same way the composer resolves it.
 */
export function ComposerSettings({ onDirtyChange }: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const defaults = useQuery(composerDefaultsQueryOptions(identity.id));
  const update = useMutation(
    updateComposerDefaultsMutationOptions(queryClient, identity.id),
  );
  return (
    <div className="composer-settings">
      <SettingsHeading
        title="Composer"
        description="What a New Thread starts with and which words dictation recognizes."
      />
      {defaults.isError ? (
        <SettingsBackgroundError onRetry={() => void defaults.refetch()}>
          Composer settings could not be loaded.
        </SettingsBackgroundError>
      ) : null}
      {update.isError ? (
        <SettingsBackgroundError
          onRetry={() => update.mutate(update.variables)}
        >
          The change was not saved.
        </SettingsBackgroundError>
      ) : null}
      {defaults.data === undefined ? (
        defaults.isPending ? (
          <DxLoading label="Loading composer settings…" />
        ) : null
      ) : (
        <SettingsCard>
          <StartingProjectRow
            remembered={defaults.data.project}
            onChange={(project) => update.mutate({ project })}
          />
          <StartingModeRow
            remembered={defaults.data}
            onChange={(mode) => update.mutate({ mode, model: null })}
          />
        </SettingsCard>
      )}
      <DictationVocabularyCard
        target={{ scope: "personal" }}
        description="Names, technical terms, and other words that dictation should recognize. Enter one term per line, or separate terms with commas. Your workspace's terms are used after yours."
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

/**
 * Workspace composer settings: the vocabulary every member's dictation uses
 * after their own. Members read it; admins change it.
 */
export function WorkspaceComposerSettings({
  onDirtyChange,
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) return null;
  return (
    <div className="composer-settings">
      <SettingsHeading
        title="Composer"
        description="Which words dictation recognizes for everyone in this workspace."
      />
      <DictationVocabularyCard
        target={{ scope: "workspace", workspaceSlug }}
        description="Names, technical terms, and other words that dictation should recognize for every member. Enter one term per line, or separate terms with commas. A member's own terms are used first."
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

function StartingProjectRow({
  remembered,
  onChange,
}: {
  readonly remembered: PersonalComposerDefaultsData["project"];
  readonly onChange: (project: ProjectId | "none") => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const listed: ReadonlyArray<ProjectData> = (
    projectsQuery.data?.pages.flatMap((page) => page.items) ?? []
  ).filter(canStartThreadsIn);
  const listedProjectIds = listed.map(({ id }) => id);
  // As in the composer, a remembered Project beyond the first page is
  // fetched by ID rather than replaced by the first listed Project.
  const unlistedId = projectsQuery.isPending
    ? undefined
    : rememberedProjectToResolve({
        explicit: undefined,
        remembered,
        listedProjectIds,
      });
  const unlistedQuery = useQuery({
    ...projectQueryOptions(identity.id, unlistedId as ProjectId),
    enabled: unlistedId !== undefined,
    retry: false,
  });
  const projects =
    unlistedQuery.data === undefined || unlistedId === undefined
      ? listed
      : [unlistedQuery.data, ...listed];
  const loading =
    projectsQuery.isPending ||
    (unlistedId !== undefined && unlistedQuery.isPending);
  const value = loading
    ? NO_PROJECT
    : startingProjectId({
        explicit: undefined,
        remembered,
        listedProjectIds: projects.map(({ id }) => id),
      });
  const options: ReadonlyArray<SettingsSelectOption> = [
    [NO_PROJECT, loading ? "Loading Projects…" : "No Project"],
    ...projects.map(
      (project): SettingsSelectOption => [project.id, project.name],
    ),
  ];
  return (
    <SettingsRow
      title="Project"
      description="The Project a New Thread opens in."
      control={
        <SettingsSelect
          label="Project"
          value={value}
          options={options}
          disabled={loading}
          onValueChange={(next) =>
            onChange(next === NO_PROJECT ? "none" : (next as ProjectId))
          }
        />
      }
    />
  );
}

function StartingModeRow({
  remembered,
  onChange,
}: {
  readonly remembered: PersonalComposerDefaultsData;
  readonly onChange: (mode: ModeId) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const choicesQuery = useQuery(modelRoutingChoicesQueryOptions(identity.id));
  const pinnedModel = startingModel(
    remembered.model,
    choicesQuery.data?.models.map(({ canonical }) => canonical),
  );
  const pinnedModelName =
    pinnedModel === undefined
      ? undefined
      : modelDisplayName(
          choicesQuery.data?.models.find(
            ({ canonical }) => canonical === pinnedModel,
          )?.name ?? pinnedModel,
        );
  // A model picked in the composer replaces the mode until a mode is chosen
  // again, so it shows as its own option; choosing a mode clears it.
  const options: ReadonlyArray<SettingsSelectOption> = [
    ...(pinnedModelName === undefined
      ? []
      : [[PINNED_MODEL, pinnedModelName] as const]),
    ...MODE_IDS.map((mode): SettingsSelectOption => [mode, MODE_LABELS[mode]]),
  ];
  return (
    <SettingsRow
      title="Mode"
      description={
        pinnedModelName === undefined
          ? "Where the Mode Dial starts."
          : "Starts on the model you picked in the composer until you choose a mode."
      }
      control={
        <SettingsSelect
          label="Mode"
          value={
            pinnedModelName === undefined
              ? startingMode(remembered.mode)
              : PINNED_MODEL
          }
          options={options}
          onValueChange={(next) => {
            if (next !== PINNED_MODEL) onChange(next as ModeId);
          }}
        />
      }
    />
  );
}
