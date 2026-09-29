import type { PersonalComposerDefaultsData } from "@dx/api";
import type {
  ModeId,
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
} from "@dx/domain";

type ProjectChoice = ProjectId | "";

/**
 * Project the composer starts on. An explicit invocation (recovery, sidebar
 * "+", `?project=`) wins, then the remembered Project if it is still listed,
 * then the first listed Project.
 */
export const startingProjectId = ({
  explicit,
  remembered,
  listedProjectIds,
}: {
  readonly explicit: ProjectChoice | undefined;
  readonly remembered: PersonalComposerDefaultsData["project"];
  readonly listedProjectIds: ReadonlyArray<ProjectId>;
}): ProjectChoice => {
  if (explicit !== undefined) return explicit;
  if (remembered === "none") return "";
  if (remembered !== null && listedProjectIds.includes(remembered))
    return remembered;
  return listedProjectIds[0] ?? "";
};

/**
 * The remembered Project to fetch by ID before choosing a starting Project.
 * Projects load a page at a time, so a remembered Project may exist without
 * being in the first page. Deciding from that page alone would silently
 * switch the next thread to the first listed Project.
 */
export const rememberedProjectToResolve = ({
  explicit,
  remembered,
  listedProjectIds,
}: {
  readonly explicit: ProjectChoice | undefined;
  readonly remembered: PersonalComposerDefaultsData["project"];
  readonly listedProjectIds: ReadonlyArray<ProjectId>;
}): ProjectId | undefined =>
  explicit === undefined &&
  remembered !== null &&
  remembered !== "none" &&
  !listedProjectIds.includes(remembered)
    ? remembered
    : undefined;

export const startingMode = (remembered: ModeId | null): ModeId =>
  remembered ?? "medium";

/**
 * A remembered model is used only while it is still offered. Until the offered
 * models load, it is trusted; thread creation still rejects an unserved model.
 */
export const startingModel = (
  remembered: string | null,
  offeredModels: ReadonlyArray<string> | undefined,
): string | undefined =>
  remembered !== null &&
  (offeredModels === undefined || offeredModels.includes(remembered))
    ? remembered
    : undefined;

/**
 * Orb size precedence: this composer's pick, then the selected Project's own
 * size, then the remembered size (only when no Project is selected and it is
 * still available and allowed), then the personal or workspace default.
 */
export const effectiveRunnerProfileId = ({
  override,
  projectSelected,
  projectRunnerProfileId,
  remembered,
  catalog,
  allowed,
  fallback,
}: {
  readonly override: RunnerProfileId | undefined;
  readonly projectSelected: boolean;
  readonly projectRunnerProfileId: RunnerProfileId | undefined;
  readonly remembered: RunnerProfileId | null;
  readonly catalog: ReadonlyArray<RunnerProfile> | undefined;
  readonly allowed: ReadonlyArray<RunnerProfileId> | null | undefined;
  readonly fallback: RunnerProfileId | undefined;
}): RunnerProfileId | undefined => {
  if (override !== undefined) return override;
  if (projectSelected) return projectRunnerProfileId ?? fallback;
  const rememberedUsable =
    remembered !== null &&
    catalog?.some(
      ({ id, availability }) =>
        id === remembered && availability === "available",
    ) === true &&
    (allowed === null || allowed === undefined || allowed.includes(remembered));
  return rememberedUsable ? remembered : fallback;
};
