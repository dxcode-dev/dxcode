import type { PersonalComposerDefaultsData, ProjectData } from "@dx/api";
import { type ModeId, ModelId, type ProjectId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Option, Schema } from "effect";
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
import { modelRoutingChoicesQueryOptions } from "../model-routing/model-routing-queries.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  composerDefaultsQueryOptions,
  updateComposerDefaultsMutationOptions,
} from "./composer-defaults-queries.js";
import { DictationSettingsCard } from "./dictation-settings.js";
import { DictationVocabularyCard } from "./dictation-vocabulary.js";

const NO_PROJECT = "";

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
        description="What a New Thread starts with, how dictation works, and how file edits save."
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
            onChange={(next) =>
              update.mutate(
                "mode" in next ? { mode: next.mode, model: null } : next,
              )
            }
          />
        </SettingsCard>
      )}
      <DictationSettingsCard />
      <DictationVocabularyCard
        target={{ scope: "personal" }}
        description="Names, technical terms, and other words that dictation should recognize. Enter one term per line, or separate terms with commas. Your workspace's terms are used after yours."
        onDirtyChange={onDirtyChange}
      />
      {defaults.data === undefined ? null : (
        <SettingsCard>
          <SettingsRow
            title="Autosave Files"
            description="Write edits in file tabs to disk 5 seconds after you stop typing. When off, edits stay a draft until you press Ctrl+S."
            control={
              <SettingsToggle
                label="Autosave Files"
                checked={defaults.data.autosaveFiles}
                pending={
                  update.isPending &&
                  update.variables?.autosaveFiles !== undefined
                }
                onCheckedChange={(autosaveFiles) =>
                  update.mutate({ autosaveFiles })
                }
              />
            }
          />
        </SettingsCard>
      )}
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

const RECOMMENDED = "recommended";
const CARRIED = "carried";

/**
 * The model a New Thread opens on: Recommended, or the model last picked in
 * the composer. Someone whose composer last started on a retired mode other
 * than Medium opens on that mode's model, as the composer does.
 */
function StartingModeRow({
  remembered,
  onChange,
}: {
  readonly remembered: PersonalComposerDefaultsData;
  readonly onChange: (
    next: { readonly mode: ModeId } | { readonly model: ModelId },
  ) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const choicesQuery = useQuery(modelRoutingChoicesQueryOptions(identity.id));
  const choices = choicesQuery.data;
  const pinnedModel = startingModel(
    remembered.model,
    choices?.models.map(({ canonical }) => canonical),
  );
  const nameOf = (canonical: string) =>
    modelDisplayName(
      choices?.models.find((model) => model.canonical === canonical)?.name ??
        canonical,
    );
  const mode = startingMode(remembered.mode);
  const recommended = choices?.modes.find((slot) => slot.mode === "medium");
  const carried =
    pinnedModel === undefined && mode !== "medium"
      ? choices?.modes.find((slot) => slot.mode === mode)
      : undefined;
  const models = (choices?.models ?? []).filter(
    ({ canonical }) => canonical !== pinnedModel,
  );
  const options: ReadonlyArray<SettingsSelectOption> = [
    [
      RECOMMENDED,
      recommended === undefined
        ? "Recommended"
        : `Recommended · ${modelDisplayName(recommended.modelName)}`,
    ],
    ...(carried === undefined
      ? []
      : [[CARRIED, modelDisplayName(carried.modelName)] as const]),
    ...(pinnedModel === undefined
      ? []
      : [[pinnedModel, nameOf(pinnedModel)] as const]),
    ...models.map(
      ({ canonical, name }): SettingsSelectOption => [
        canonical,
        modelDisplayName(name),
      ],
    ),
  ];
  return (
    <SettingsRow
      title="Model"
      description="The model a New Thread starts on. Picking one in the composer changes it here too."
      control={
        <SettingsSelect
          label="Model"
          value={pinnedModel ?? (carried === undefined ? RECOMMENDED : CARRIED)}
          options={options}
          onValueChange={(next) => {
            if (next === CARRIED) return;
            if (next === RECOMMENDED) {
              onChange({ mode: "medium" });
              return;
            }
            const model = Schema.decodeUnknownOption(ModelId)(next);
            if (Option.isSome(model)) onChange({ model: model.value });
          }}
        />
      }
    />
  );
}
