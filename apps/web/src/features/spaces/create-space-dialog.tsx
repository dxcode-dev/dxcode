import type { SpaceSharing, SpaceSuggestion } from "@dx/api";
import {
  isClaudeCodeModel,
  type ModelConnectionId,
  type ProjectId,
  type UserId,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, X } from "lucide-react";
import * as React from "react";
import type { ClaudePlanPickerSlot } from "../../shared/claude-plan-picker-slot.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import { cn } from "../../shared/utils.js";
import { projectsQueryOptions } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { useComposerDraft } from "../threads/composer-draft-queries.js";
import {
  refreshSpaceAgentModel,
  spaceAgentModelQueryOptions,
} from "./space-agent-model-queries.js";
import {
  EnterKeycap,
  SpaceFieldRow,
  SpaceGoalField,
  SpaceProjectCombobox,
  SpaceSharingSelect,
} from "./space-form-fields.js";
import type { SpaceModelPick } from "./space-model-field.js";
import { SpaceModelRows } from "./space-model-rows.js";
import {
  spaceSuggestionsQueryOptions,
  useCreateSpace,
} from "./space-queries.js";
import "./spaces.css";

/** "2 recent threads · dx" under a suggestion. */
const suggestionMeta = (suggestion: SpaceSuggestion) =>
  `${suggestion.threadCount} recent ${suggestion.threadCount === 1 ? "thread" : "threads"} · ${suggestion.projectName}`;

/** A Space dx proposes from recent threads; choosing it fills the form. */
function SuggestionCard({
  suggestion,
  chosen,
  onChoose,
}: {
  readonly suggestion: SpaceSuggestion;
  readonly chosen: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="space-suggestion"
        aria-pressed={chosen}
        onClick={onChoose}
      >
        <span className="space-suggestion-text">
          <strong>{suggestion.name}</strong>
          <span>{suggestion.goal}</span>
          <small>{suggestionMeta(suggestion)}</small>
        </span>
        {chosen ? (
          <Check className="space-suggestion-check" aria-label="Chosen" />
        ) : null}
      </button>
    </li>
  );
}

/**
 * New Space, full screen: on the left what the Space is for, with Spaces dx
 * proposes from recent threads; on the right its name, goal, Project, and
 * who it is shared with. Creating it opens the Space.
 */
interface SpaceDraft {
  readonly name: string;
  readonly goal: string;
}

/** The New Space draft as Core keeps it: its name and goal as JSON. */
const decodeSpaceDraft = (text: string): SpaceDraft => {
  try {
    const value = JSON.parse(text) as Partial<
      Record<keyof SpaceDraft, unknown>
    >;
    return {
      name: typeof value.name === "string" ? value.name : "",
      goal: typeof value.goal === "string" ? value.goal : "",
    };
  } catch {
    return { name: "", goal: "" };
  }
};

const encodeSpaceDraft = (draft: SpaceDraft) =>
  draft.name === "" && draft.goal === "" ? "" : JSON.stringify(draft);

export function CreateSpaceDialog({
  userId,
  dictation,
  PlanPicker,
  onClose,
  onCreated,
}: {
  readonly userId: UserId;
  readonly dictation?: DictationSlot;
  /** The New Thread composer's Claude plan list, for the Agent row. */
  readonly PlanPicker?: ClaudePlanPickerSlot;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const navigate = useNavigate();
  const fieldId = React.useId();
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(userId));
  const settingsQuery = useQuery(settingsContextQueryOptions(userId));
  const suggestions = useQuery(spaceSuggestionsQueryOptions(userId)).data;
  const projects = projectsQuery.data?.pages.flatMap((page) => page.items);
  const workspace = settingsQuery.data?.workspace;
  // The name and goal keep in Core as the New Thread prompt does, so
  // closing the dialog, a reload, or another device shows them again.
  const [form, setForm] = useComposerDraft(
    settingsQuery.data === undefined
      ? undefined
      : { workspace: workspace?.id ?? "personal", slot: "new-space" },
  );
  const { name, goal } = decodeSpaceDraft(form);
  const setName = (next: string) =>
    setForm((current) =>
      encodeSpaceDraft({ ...decodeSpaceDraft(current), name: next }),
    );
  const setGoal = (next: string) =>
    setForm((current) =>
      encodeSpaceDraft({ ...decodeSpaceDraft(current), goal: next }),
    );
  const [chosenProjectId, setProjectId] = React.useState<ProjectId>();
  const [chosenSharing, setSharing] = React.useState<SpaceSharing>();
  const [chosenSuggestion, setChosenSuggestion] =
    React.useState<SpaceSuggestion>();
  const create = useCreateSpace(userId);
  // Where the Space will run, picked once at creation: Claude Code on a
  // plan, or Model Routing. Nothing serving it asks for another model first.
  // Read again each time the dialog opens: the plan or the Space model may
  // have changed since.
  const agent = useQuery({
    ...spaceAgentModelQueryOptions(userId),
    refetchOnMount: "always",
  });
  const queryClient = useQueryClient();
  // A model picked for this Space; undefined runs the Space model from
  // Settings → Models.
  const [coordinatorModel, setCoordinatorModel] =
    React.useState<SpaceModelPick>();
  // The model the Space's threads run on; undefined: the coordinator's.
  const [threadModel, setThreadModel] = React.useState<SpaceModelPick>();
  // A plan picked from the Agent row's list; none is Auto, or the first
  // plan, which Core picks the same way.
  const [chosenPlan, setPlan] = React.useState<string>();
  const route = agent.data?.route;
  // The plan list shows while the coordinator runs on Claude Code, picked
  // or by default.
  const plan = (
    coordinatorModel === undefined
      ? route?.kind === "claude-code"
      : isClaudeCodeModel(coordinatorModel.model)
  )
    ? chosenPlan
    : undefined;
  const agentUnavailable =
    coordinatorModel === undefined && route?.kind === "unavailable";
  // Until the person picks, the first Project and the workspace when there
  // is one.
  const projectId = chosenProjectId ?? projects?.[0]?.id;
  const sharing: SpaceSharing =
    workspace === undefined ? "private" : (chosenSharing ?? "workspace");
  const canCreate =
    name.trim().length > 0 && projectId !== undefined && !create.isPending;
  // The chosen suggestion stays checked while the form still holds it.
  const chosen =
    chosenSuggestion !== undefined &&
    chosenSuggestion.name === name &&
    chosenSuggestion.goal === goal
      ? chosenSuggestion
      : undefined;
  const choose = (suggestion: SpaceSuggestion) => {
    setChosenSuggestion(suggestion);
    setName(suggestion.name);
    setGoal(suggestion.goal);
    if (projects?.some((project) => project.id === suggestion.projectId))
      setProjectId(suggestion.projectId);
  };
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    // The coordinator row says why and asks for another model.
    if (agentUnavailable) return;
    create.mutate(
      {
        name: name.trim(),
        ...(goal.trim() === "" ? {} : { goal: goal.trim() }),
        projectId,
        sharing,
        ...(plan === undefined
          ? {}
          : { claudeConnectionId: plan as ModelConnectionId }),
        ...(coordinatorModel === undefined
          ? {}
          : { agentModel: coordinatorModel as never }),
        ...(threadModel === undefined
          ? {}
          : { threadModel: threadModel as never }),
      },
      {
        // The route changed after the dialog read it (a plan disabled, the
        // model changed elsewhere): read it again and ask for a model.
        onError: (error) => {
          if (
            (error as { readonly code?: string }).code ===
            "SPACE_MODEL_UNAVAILABLE"
          )
            void refreshSpaceAgentModel(queryClient, userId);
        },
        onSuccess: (space) => {
          setForm("");
          onCreated();
          void navigate({
            to: "/threads/$threadId",
            params: { threadId: space.threadId },
          });
        },
      },
    );
  };
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        size="page"
        layer="panel"
        showClose={false}
        className="space-create"
        aria-label="Create Space"
      >
        <header className="space-create-bar">
          <Button
            variant="subtle"
            size="icon-xs"
            className="space-icon-button"
            aria-label="Back"
            title="Back"
            onClick={onClose}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <nav className="space-create-breadcrumb" aria-label="Breadcrumb">
            <span>Spaces</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Create</span>
          </nav>
          <DialogClose
            className={cn(
              buttonVariants({ variant: "subtle", size: "icon-xs" }),
              "space-icon-button space-create-close",
            )}
            aria-label="Close"
            title="Close"
          >
            <X aria-hidden="true" />
          </DialogClose>
        </header>
        <div className="space-create-body">
          <section className="space-create-intro">
            <div className="space-create-intro-inner">
              <DialogTitle className="space-create-title">
                What's this Space for?
              </DialogTitle>
              <DialogDescription className="space-create-lede">
                Pick up something you have been working on, or start something
                new.
              </DialogDescription>
              {suggestions === undefined || suggestions.length === 0 ? null : (
                <>
                  <h3 className="space-create-eyebrow">
                    From your recent threads
                  </h3>
                  <ul className="space-suggestions">
                    {suggestions.map((suggestion) => (
                      <SuggestionCard
                        key={`${suggestion.projectId}:${suggestion.name}`}
                        suggestion={suggestion}
                        chosen={chosen === suggestion}
                        onChoose={() => choose(suggestion)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>
          <section className="space-create-form-pane">
            <form className="space-create-card" onSubmit={onSubmit}>
              <SpaceFieldRow
                label="Name"
                help="Shown in the sidebar and at the top of the Space."
                htmlFor={`${fieldId}-name`}
              >
                <Input
                  id={`${fieldId}-name`}
                  autoFocus
                  autoComplete="off"
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </SpaceFieldRow>
              <SpaceFieldRow
                label="Goal"
                optional
                help="What the work here is for. dx keeps the Space's threads directed toward it."
                htmlFor={`${fieldId}-goal`}
              >
                <SpaceGoalField
                  id={`${fieldId}-goal`}
                  value={goal}
                  onChange={setGoal}
                  dictation={dictation}
                />
              </SpaceFieldRow>
              <SpaceFieldRow
                label="Project"
                help="The project the Space's threads run in."
                htmlFor={`${fieldId}-project`}
              >
                <SpaceProjectCombobox
                  id={`${fieldId}-project`}
                  projects={projects}
                  value={projectId}
                  onChange={setProjectId}
                />
              </SpaceFieldRow>
              <SpaceFieldRow
                label="Shared with"
                help="Who can see the Space and chat in it."
                htmlFor={`${fieldId}-sharing`}
              >
                <SpaceSharingSelect
                  id={`${fieldId}-sharing`}
                  workspaceName={workspace?.displayName}
                  value={sharing}
                  onChange={setSharing}
                />
              </SpaceFieldRow>
              <SpaceModelRows
                fieldId={fieldId}
                userId={userId}
                route={route}
                routePending={agent.isPending}
                locked={create.isPending}
                coordinatorModel={coordinatorModel}
                onCoordinatorModelChange={setCoordinatorModel}
                threadModel={threadModel}
                onThreadModelChange={setThreadModel}
                plan={plan}
                onPlanChange={setPlan}
                PlanPicker={PlanPicker}
              />
              {create.error === null ||
              // The Agent row and the picker say this one.
              (create.error as { readonly code?: string }).code ===
                "SPACE_MODEL_UNAVAILABLE" ? null : (
                <p className="space-dialog-error" role="alert">
                  {create.error instanceof Error
                    ? create.error.message
                    : "The Space could not be created."}
                </p>
              )}
              <footer className="space-create-footer">
                <Button
                  type="submit"
                  className="space-primary-button"
                  disabled={!canCreate}
                >
                  {create.isPending ? "Creating…" : "Create Space"}
                  <EnterKeycap />
                </Button>
              </footer>
            </form>
          </section>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
