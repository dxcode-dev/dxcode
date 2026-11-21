import type { ProjectData } from "@dx/api";
import type { ProjectId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  lazyRouteComponent,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import * as React from "react";
import {
  CodeStep,
  type CodeStepState,
  FirstThreadStep,
  INVITED_STEPS,
  JoinStep,
  type ModelPick,
  ModelStep,
  type ModelStepState,
  NEW_STEPS,
  OnboardingFrame,
  ProjectsStep,
  type ProviderStatus,
  WelcomeStep,
} from "./features/onboarding/onboarding.js";
import { markOnboardingMutationOptions } from "./features/onboarding/onboarding-queries.js";
import { StarterTasks } from "./features/onboarding/onboarding-tour.js";
import { projectsQueryOptions } from "./features/projects/project-queries.js";
import { ProjectRepositoryIcon } from "./features/projects/project-repository-icon.js";
import {
  bitbucketAuthorizeMutationOptions,
  bitbucketConnectionQueryOptions,
} from "./features/settings/integrations/bitbucket-queries.js";
import {
  beginPersonalGitHubAuthorization,
  beginPersonalGitHubInstallation,
} from "./features/settings/integrations/integration-mutations.js";
import {
  githubIntegrationQueryOptions,
  invalidatePersonalIntegrations,
} from "./features/settings/integrations/integration-queries.js";
import { invalidateAllModelRouting } from "./features/settings/model-routing/model-routing-mutations.js";
import { modelRoutingChoicesQueryOptions } from "./features/settings/model-routing/model-routing-queries.js";
import { settingsContextQueryOptions } from "./features/settings/settings-context-queries.js";
import { useAuthenticatedIdentity } from "./shared/auth/auth-context.js";
import { useEventSubscription } from "./shared/hooks/use-event-subscription.js";
import { AppFrame } from "./shared/layout/app-frame.js";
import { settingsNavigationState } from "./shared/navigation/settings-return.js";
import { Button } from "./shared/ui/button.js";
// The connect dialogs' styles load with the Models & Routing page.
import "./features/settings/model-routing/model-routing.css";

// Settings' dialogs load the first time a step opens one, so neither this
// page nor the app shell carries them.
const ClaudeConnectDialog = lazyRouteComponent(
  () => import("./features/settings/model-routing/claude-code-connect.js"),
  "ClaudeConnectDialog",
);
const CopilotConnectDialog = lazyRouteComponent(
  () => import("./features/settings/model-routing/copilot-connect-dialog.js"),
  "CopilotConnectDialog",
);
const NewProject = lazyRouteComponent(
  () => import("./features/projects/new-project.js"),
  "NewProject",
);

/** Where `/welcome?step=` opens; the home checklist links to model and code. */
export type WelcomeStepName = "model" | "code";

type Step = "intro" | "model" | "code" | "thread";

const repositoryIcon = (
  provider: React.ComponentProps<typeof ProjectRepositoryIcon>["provider"],
) => <ProjectRepositoryIcon provider={provider} />;

/** Focus comes back after connecting GitHub or Bitbucket in another tab. */
const subscribeFocus = (listener: (event: unknown) => void) => {
  window.addEventListener("focus", listener);
  return () => window.removeEventListener("focus", listener);
};

/**
 * Opens a connect flow in a new tab, so this page keeps its place; the
 * provider's own pages finish in Settings there. The tab opens before the
 * request so the browser treats it as the click's.
 */
const connectInNewTab = async (start: () => Promise<string>) => {
  const tab = window.open("", "_blank");
  const destination = await start().catch(() => undefined);
  if (destination === undefined) {
    tab?.close();
    return false;
  }
  if (tab === null) window.location.assign(destination);
  else tab.location.href = destination;
  return true;
};

const allProjects = (
  pages: ReadonlyArray<{ items: ReadonlyArray<ProjectData> }> | undefined,
) => (pages ?? []).flatMap((page) => page.items);

/**
 * `/welcome`: a new account's setup. A person who joined a workspace sees it
 * first, then Model (skipped when the workspace or deployment serves models),
 * then a project (the workspace's own, when it has some), then a first task.
 * Every step reads the same data as Settings and opens Settings' own dialogs.
 */
export function WelcomePage() {
  const { identity } = useAuthenticatedIdentity();
  const userId = identity.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    readonly step?: WelcomeStepName;
  };

  const settings = useQuery(settingsContextQueryOptions(userId));
  const choices = useQuery(modelRoutingChoicesQueryOptions(userId));
  const github = useQuery(githubIntegrationQueryOptions(userId));
  const bitbucket = useQuery(bitbucketConnectionQueryOptions(userId));
  const projects = useInfiniteQuery(projectsQueryOptions(userId));
  const mark = useMutation(markOnboardingMutationOptions(queryClient, userId));
  const authorizeBitbucket = useMutation(
    bitbucketAuthorizeMutationOptions(userId),
  );

  const [step, setStep] = React.useState<Step>(search.step ?? "intro");
  const [dialog, setDialog] = React.useState<
    "claude" | "copilot" | "project"
  >();
  const [waiting, setWaiting] = React.useState<"github" | "bitbucket">();
  const [created, setCreated] = React.useState<ProjectData>();
  const [chosen, setChosen] = React.useState<string>();
  const [task, setTask] = React.useState<string>();

  // Back from connecting in another tab: read the connections again.
  useEventSubscription(subscribeFocus, () => {
    void invalidatePersonalIntegrations(queryClient, userId);
    void projects.refetch();
    if (waiting !== undefined) setWaiting(undefined);
  });

  const workspace = settings.data?.workspace;
  const steps = workspace === undefined ? NEW_STEPS : INVITED_STEPS;
  const label: Record<Step, string | undefined> = {
    intro: workspace === undefined ? undefined : "Workspace",
    model: "Model",
    code: workspace === undefined ? "Code" : "Project",
    thread: "First thread",
  };

  // Model: the person's own connection, else the workspace's, else dx's.
  const models = choices.data?.models ?? [];
  const own = models.find(
    (model) =>
      model.connectionScope !== "workspace" &&
      model.connectionKind !== "deployment",
  );
  const modelState: ModelStepState =
    own !== undefined
      ? { kind: "connected", connection: own.connectionName }
      : workspace !== undefined &&
          models.some((model) => model.connectionScope === "workspace")
        ? { kind: "workspace", workspace: workspace.displayName }
        : models.some((model) => model.connectionKind === "deployment")
          ? { kind: "included" }
          : {
              kind: "choose",
              picked:
                dialog === "claude" || dialog === "copilot"
                  ? dialog
                  : undefined,
            };
  const pickModel = (pick: ModelPick) => {
    if (pick === "api-key")
      void navigate({
        to: "/settings/$section",
        params: { section: "models" },
        state: settingsNavigationState("/welcome?step=model"),
      });
    else setDialog(pick);
  };

  // Code: the person's projects, or the workspace's for a member.
  const listed = allProjects(projects.data?.pages);
  const workspaceProjects =
    workspace === undefined
      ? []
      : listed.filter((project) => project.workspaceId === workspace.id);
  const ownProject =
    created ?? listed.find((project) => project.workspaceId === undefined);
  const githubStatus: ProviderStatus | undefined =
    github.data === undefined
      ? undefined
      : !github.data.configured
        ? { kind: "unconfigured" }
        : github.data.grants.some(
              (grant) =>
                grant.status === "active" &&
                grant.installationStatus === "active",
            )
          ? {
              kind: "connected",
              account: `@${github.data.grants.find((grant) => grant.status === "active")?.account.login ?? ""}`,
            }
          : { kind: "available" };
  const bitbucketStatus: ProviderStatus | undefined =
    bitbucket.data === undefined
      ? undefined
      : !bitbucket.data.configured
        ? { kind: "unconfigured" }
        : bitbucket.data.connection?.status === "active"
          ? {
              kind: "connected",
              account: bitbucket.data.connection.accountName,
            }
          : { kind: "available" };
  const codeState: CodeStepState =
    ownProject !== undefined
      ? {
          kind: "created",
          project: ownProject.name,
          repository: ownProject.repository?.fullName,
        }
      : github.isError && bitbucket.isError
        ? {
            kind: "status-error",
            onRetry: () =>
              void invalidatePersonalIntegrations(queryClient, userId),
          }
        : {
            kind: "choose",
            github: githubStatus,
            bitbucket: bitbucketStatus,
            waiting,
          };
  const pickCode = async (pick: "github" | "bitbucket" | "scratch") => {
    if (
      pick === "scratch" ||
      (pick === "github" && githubStatus?.kind === "connected") ||
      (pick === "bitbucket" && bitbucketStatus?.kind === "connected")
    ) {
      setDialog("project");
      return;
    }
    const opened =
      pick === "github"
        ? await connectInNewTab(() =>
            github.data?.authorization?.status === "active"
              ? beginPersonalGitHubInstallation("/welcome?step=code")
              : beginPersonalGitHubAuthorization("/welcome?step=code"),
          )
        : await connectInNewTab(() => authorizeBitbucket.mutateAsync());
    if (opened) setWaiting(pick);
  };
  const projectChosen =
    workspaceProjects.find((project) => project.id === chosen) ?? ownProject;

  // Finishing: setup is done once, and the next screen opens.
  const finish = (then: () => void) => {
    mark.mutate("setup");
    then();
  };
  const skip = () => finish(() => void navigate({ to: "/" }));
  // /new: its composer, in the page on a wide screen and a dialog on a
  // phone, starts in the project with the task.
  const startThread = () =>
    finish(
      () =>
        void navigate({
          to: "/new",
          search: {
            project: projectChosen?.id as ProjectId | undefined,
            ...(task === undefined ? {} : { prompt: task }),
          },
        }),
    );

  const back = (to: Step) => () => setStep(to);
  const actions = (primary: React.ReactNode, secondary?: React.ReactNode) => (
    <div className="onboarding-actions">
      {secondary}
      {primary}
    </div>
  );

  let content: React.ReactNode;
  let footer: React.ReactNode;
  let onBack: (() => void) | undefined;
  if (step === "intro") {
    content =
      workspace === undefined ? (
        <WelcomeStep name={identity.name.split(" ")[0] ?? identity.name} />
      ) : (
        <JoinStep workspace={workspace} state={{ kind: "joined" }} />
      );
    footer = actions(
      <Button onClick={() => setStep("model")}>
        {workspace === undefined ? "Get started" : "Continue"}
      </Button>,
      <Button variant="ghost" onClick={skip}>
        Skip setup
      </Button>,
    );
  } else if (step === "model") {
    onBack = back("intro");
    const ready = modelState.kind !== "choose";
    content = <ModelStep state={modelState} showCopilot onPick={pickModel} />;
    footer = actions(
      <Button disabled={!ready} onClick={() => setStep("code")}>
        Continue
      </Button>,
      ready ? undefined : (
        <Button variant="ghost" onClick={() => setStep("code")}>
          Skip for now
        </Button>
      ),
    );
  } else if (step === "code") {
    onBack = back("model");
    const pickWorkspaceProject = workspaceProjects.length > 0;
    content = pickWorkspaceProject ? (
      <ProjectsStep
        workspace={workspace?.displayName ?? ""}
        projects={workspaceProjects}
        selected={chosen}
        repositoryIcon={repositoryIcon}
        onSelect={setChosen}
      />
    ) : (
      <CodeStep
        state={codeState}
        repositoryIcon={repositoryIcon}
        onPick={(pick) => void pickCode(pick)}
      />
    );
    const ready = pickWorkspaceProject
      ? chosen !== undefined
      : ownProject !== undefined;
    footer = actions(
      <Button disabled={!ready} onClick={() => setStep("thread")}>
        Continue
      </Button>,
      <>
        <Button variant="ghost" onClick={() => setStep("thread")}>
          Skip for now
        </Button>
        <Button variant="outline" onClick={() => setDialog("project")}>
          New project
        </Button>
      </>,
    );
  } else {
    onBack = back("code");
    content = (
      <FirstThreadStep
        project={projectChosen?.name}
        starters={<StarterTasks picked={task} onPick={setTask} />}
      />
    );
    footer = actions(
      <Button onClick={startThread}>Start a thread</Button>,
      <Button
        variant="ghost"
        onClick={() => finish(() => void navigate({ to: "/welcome/tour" }))}
      >
        Take the tour first
      </Button>,
    );
  }

  return (
    <AppFrame>
      <OnboardingFrame
        steps={label[step] === undefined ? undefined : steps}
        current={label[step]}
        onBack={onBack}
        onSkip={step === "intro" ? undefined : skip}
        footer={footer}
      >
        {content}
      </OnboardingFrame>
      <React.Suspense fallback={null}>
        {dialog === "claude" ? (
          <ClaudeConnectDialog
            target={{ scope: "personal" }}
            name="Claude Pro/Max"
            onClose={() => setDialog(undefined)}
          />
        ) : dialog === "copilot" ? (
          <CopilotConnectDialog
            open
            onClose={() => setDialog(undefined)}
            onConnected={() => {
              invalidateAllModelRouting(queryClient);
              setDialog(undefined);
            }}
          />
        ) : dialog === "project" ? (
          // The dialog's own trigger button stays hidden; the steps open it.
          <div className="onboarding-new-project">
            <NewProject
              open
              onOpenChange={(open) => setDialog(open ? "project" : undefined)}
              onCreated={(project) => {
                setCreated(project);
                setDialog(undefined);
              }}
            />
          </div>
        ) : null}
      </React.Suspense>
    </AppFrame>
  );
}
