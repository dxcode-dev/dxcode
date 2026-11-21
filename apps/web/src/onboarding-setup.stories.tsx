import type {
  CatalogProviderData,
  GitHubGrantData,
  ProjectData,
} from "@dx/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { expect, screen, userEvent, within } from "storybook/test";
import {
  CodeStep,
  type CodeStepState,
  FirstThreadStep,
  INVITED_STEPS,
  type InvitedWorkspace,
  type JoinState,
  JoinStep,
  ModelStep,
  type ModelStepState,
  NEW_STEPS,
  OnboardingFrame,
  ProjectsStep,
  WelcomeStep,
} from "./features/onboarding/onboarding.js";
import { NewProjectDialog } from "./features/projects/new-project-dialog.js";
import { ProjectRepositoryIcon } from "./features/projects/project-repository-icon.js";
import type { BitbucketRepository } from "./features/settings/integrations/bitbucket-queries.js";
import { ClaudeConnectDialog } from "./features/settings/model-routing/claude-code-connect.js";
import { CopilotConnectDialog } from "./features/settings/model-routing/copilot-connect-dialog.js";
import { ProviderKeySheet } from "./features/settings/model-routing/provider-key-sheet.js";
// The Settings dialogs' styles load with the Models & Routing page.
import "./features/settings/model-routing/model-routing.css";
import { SetupChecklist } from "./features/home/setup-checklist.js";
import {
  STARTER_TASKS,
  StarterTasks,
} from "./features/onboarding/onboarding-tour.js";
import { Button } from "./shared/ui/button.js";
import { StoryQueryProvider } from "./testing/story-query-provider.js";

/**
 * New-person onboarding, proposed: the steps before the first thread. A new
 * account goes Welcome → Model → Code, then the thread tour
 * (Features/Onboarding/Thread tour). An invited person joins the workspace
 * first, skips Model when the workspace provides models, and picks one of
 * the workspace's projects instead of creating one.
 *
 * Connecting opens the real Settings dialogs (Claude, Copilot, API key, New
 * Project), so these stories follow them when they change. Switch the
 * toolbar's viewport to Phone for the phone layout.
 */
const meta = {
  title: "Features/Onboarding/Setup",
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "desktop" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const NAME = "Nova";
const repositoryIcon = (
  provider: React.ComponentProps<typeof ProjectRepositoryIcon>["provider"],
) => <ProjectRepositoryIcon provider={provider} />;
const WORKSPACE: InvitedWorkspace = {
  displayName: "Acme Engineering",
  shortName: "acme",
};
const noop = () => {};

function Actions({
  primary,
  primaryDisabled,
  secondary,
  onPrimary,
  onSecondary,
}: {
  readonly primary: string;
  readonly primaryDisabled?: boolean;
  readonly secondary?: string;
  readonly onPrimary?: () => void;
  readonly onSecondary?: () => void;
}) {
  return (
    <div className="onboarding-actions">
      {secondary ? (
        <Button variant="ghost" onClick={onSecondary}>
          {secondary}
        </Button>
      ) : null}
      <Button disabled={primaryDisabled} onClick={onPrimary}>
        {primary}
      </Button>
    </div>
  );
}

// ─── Welcome ────────────────────────────────────────────────────────────────

/** A new account's first screen. */
export const Welcome: Story = {
  name: "1 · Welcome",
  render: () => (
    <OnboardingFrame
      footer={<Actions primary="Get started" secondary="Skip setup" />}
    >
      <WelcomeStep name={NAME} still />
    </OnboardingFrame>
  ),
};

// ─── Join the workspace (invited) ───────────────────────────────────────────

function Join({ state }: { readonly state: JoinState }) {
  const footer =
    state.kind === "unavailable" ? (
      <Actions primary="Go to dx" />
    ) : state.kind === "joined" ? (
      <Actions primary="Continue" />
    ) : (
      <Actions
        primary={state.kind === "joining" ? "Joining…" : "Join workspace"}
        primaryDisabled={state.kind === "joining"}
      />
    );
  return (
    <OnboardingFrame
      steps={state.kind === "unavailable" ? undefined : INVITED_STEPS}
      current="Workspace"
      footer={footer}
    >
      <JoinStep workspace={WORKSPACE} state={state} />
    </OnboardingFrame>
  );
}

/**
 * Invited: after signing up from the invite link, the workspace comes first.
 * Copy from `join-workspace-page.tsx`; joining is one click.
 */
export const JoinWorkspace: Story = {
  name: "Invited · 1 · Join workspace",
  render: () => <Join state={{ kind: "ready" }} />,
};
export const JoinWorkspaceJoining: Story = {
  name: "Invited · 1 · Joining",
  render: () => <Join state={{ kind: "joining" }} />,
};
export const JoinWorkspaceJoined: Story = {
  name: "Invited · 1 · Joined",
  render: () => <Join state={{ kind: "joined" }} />,
};
/** Accepting refused: one workspace per person (`members/service.ts`). */
export const JoinWorkspaceAlreadyInAnother: Story = {
  name: "Invited · 1 · Already in another workspace",
  render: () => (
    <Join
      state={{
        kind: "error",
        message:
          "You're already in Globex. Leave it before joining another workspace.",
      }}
    />
  ),
};
/** The link expired (`shared/invite-unavailable.ts`). */
export const JoinWorkspaceExpired: Story = {
  name: "Invited · 1 · Invite expired",
  render: () => (
    <Join
      state={{
        kind: "unavailable",
        message:
          "This invite link has expired. Ask a workspace admin for a new one.",
      }}
    />
  ),
};

// ─── Model ──────────────────────────────────────────────────────────────────

function Model({
  state,
  invited = false,
  dialog,
}: {
  readonly state: ModelStepState;
  readonly invited?: boolean;
  readonly dialog?: React.ReactNode;
}) {
  const ready = state.kind !== "choose";
  const provided = state.kind === "workspace" || state.kind === "included";
  return (
    <StoryQueryProvider>
      <OnboardingFrame
        steps={invited ? INVITED_STEPS : NEW_STEPS}
        current="Model"
        onBack={noop}
        onSkip={noop}
        footer={
          provided ? (
            <Actions primary="Continue" secondary="Connect my own" />
          ) : (
            <Actions
              primary="Continue"
              primaryDisabled={!ready}
              secondary={ready ? undefined : "Skip for now"}
            />
          )
        }
      >
        <ModelStep state={state} showCopilot={!invited} />
      </OnboardingFrame>
      {dialog}
    </StoryQueryProvider>
  );
}

/** Three ways to connect, as Settings → Models & Routing offers them. */
export const ModelChoose: Story = {
  name: "2 · Model · choose",
  render: () => <Model state={{ kind: "choose" }} />,
};

/** Claude Pro or Max: the real token dialog from Settings. */
export const ModelClaude: Story = {
  name: "2 · Model · Claude token",
  render: () => (
    <Model
      state={{ kind: "choose", picked: "claude" }}
      dialog={
        <ClaudeConnectDialog
          target={{ scope: "personal" }}
          name="Claude Max"
          onClose={noop}
        />
      }
    />
  ),
  play: async () => {
    await expect(
      await screen.findByRole("dialog", {
        name: "Connect Your Claude Subscription",
      }),
    ).toBeVisible();
  },
};

/** GitHub Copilot: the real device-code dialog. */
export const ModelCopilot: Story = {
  name: "2 · Model · GitHub Copilot",
  render: () => (
    <Model
      state={{ kind: "choose", picked: "copilot" }}
      dialog={<CopilotConnectDialog open onClose={noop} onConnected={noop} />}
    />
  ),
};

const ANTHROPIC = {
  id: "anthropic",
  name: "Anthropic",
  description: "Claude models through the Anthropic API.",
  connectionKind: "provider",
  transport: "proxy",
  fields: [],
  models: [],
} as unknown as CatalogProviderData;

/** An API key: the real provider sheet (keys are encrypted at rest). */
export const ModelApiKey: Story = {
  name: "2 · Model · API key",
  render: () => (
    <Model
      state={{ kind: "choose", picked: "api-key" }}
      dialog={
        <ProviderKeySheet
          provider={ANTHROPIC}
          defaultName="Anthropic"
          busy={false}
          fieldErrors={{}}
          onClose={noop}
          onSubmit={noop}
        />
      }
    />
  ),
};

/** The provider rejected the key: the sheet shows the field error. */
export const ModelApiKeyRejected: Story = {
  name: "2 · Model · API key rejected",
  render: () => (
    <Model
      state={{ kind: "choose", picked: "api-key" }}
      dialog={
        <ProviderKeySheet
          provider={ANTHROPIC}
          defaultName="Anthropic"
          busy={false}
          fieldErrors={{ apiKey: "Anthropic rejected this key." }}
          onClose={noop}
          onSubmit={noop}
        />
      }
    />
  ),
};

export const ModelConnected: Story = {
  name: "2 · Model · connected",
  render: () => (
    <Model state={{ kind: "connected", connection: "Claude Pro/Max" }} />
  ),
};

/**
 * Invited, and the workspace connected a model for members: nothing to do.
 * Routing tries the person's own connections, then the workspace's
 * (`model-routing/resolver.ts`).
 */
export const ModelWorkspaceProvides: Story = {
  name: "Invited · 2 · Model · workspace provides",
  render: () => (
    <Model
      invited
      state={{ kind: "workspace", workspace: WORKSPACE.displayName }}
    />
  ),
};

/** The deployment serves models itself ("Included with dx" in the picker). */
export const ModelIncluded: Story = {
  name: "2 · Model · included with dx",
  render: () => <Model state={{ kind: "included" }} />,
};

// ─── Code ───────────────────────────────────────────────────────────────────

const GRANTS = [
  {
    id: "grant-1",
    ownerScope: "personal",
    ownerId: "usr_nova",
    installationId: "7",
    status: "active",
    installationStatus: "active",
    account: { id: "9", login: "nova", type: "user" },
    repositorySelection: "selected",
    repositories: [
      {
        id: "101",
        fullName: "acme/storefront",
        webUrl: "https://github.com/acme/storefront",
        visibility: "private",
      },
      {
        id: "102",
        fullName: "acme/design-tokens",
        webUrl: "https://github.com/acme/design-tokens",
        visibility: "public",
      },
    ],
  },
] as unknown as ReadonlyArray<GitHubGrantData>;

const BITBUCKET_REPOS = [
  {
    id: "{22222222-2222-4222-8222-222222222222}",
    workspaceId: "{11111111-1111-4111-8111-111111111111}",
    fullName: "acme/payments-api",
    webUrl: "https://bitbucket.org/acme/payments-api",
    cloneUrl: "https://bitbucket.org/acme/payments-api.git",
    defaultBranch: "main",
    visibility: "private",
    archived: false,
  },
] satisfies ReadonlyArray<BitbucketRepository>;

function Code({
  state,
  dialog,
}: {
  readonly state: CodeStepState;
  readonly dialog?: React.ReactNode;
}) {
  return (
    <>
      <OnboardingFrame
        steps={NEW_STEPS}
        current="Code"
        onBack={noop}
        onSkip={noop}
        footer={
          state.kind === "created" ? (
            <Actions primary="Continue" />
          ) : (
            <Actions
              primary="Continue"
              primaryDisabled
              secondary="Skip for now"
            />
          )
        }
      >
        <CodeStep state={state} repositoryIcon={repositoryIcon} />
      </OnboardingFrame>
      {dialog}
    </>
  );
}

/** GitHub and Bitbucket are both first-party; or start from scratch. */
export const CodeChoose: Story = {
  name: "3 · Code · choose",
  render: () => <Code state={{ kind: "choose" }} />,
};

/** GitHub's connect flow is open in another tab; this page waits. */
export const CodeWaiting: Story = {
  name: "3 · Code · waiting for GitHub tab",
  render: () => (
    <Code state={{ kind: "choose", picked: "github", waiting: "github" }} />
  ),
};

/** GitHub connected; picking it opens New Project on its repositories. */
export const CodeGitHubConnected: Story = {
  name: "3 · Code · GitHub connected",
  render: () => (
    <Code
      state={{
        kind: "choose",
        github: { kind: "connected", account: "@nova" },
        bitbucket: { kind: "available" },
      }}
    />
  ),
};

/** Connected: the real New Project dialog lists GitHub and Bitbucket repos. */
export const CodePickRepository: Story = {
  name: "3 · Code · pick repository",
  render: () => (
    <Code
      state={{ kind: "choose", picked: "github" }}
      dialog={
        <NewProjectDialog
          open
          creating={false}
          initialOwner="personal"
          grants={GRANTS}
          bitbucketConnectionId="bb-connection"
          bitbucketRepositories={BITBUCKET_REPOS}
          personalName={NAME}
          onReloadIntegrations={noop}
          onOpenChange={noop}
          onCreate={noop}
        />
      }
    />
  ),
  play: async () => {
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /Use an Existing Repository/,
      }),
    );
    await userEvent.click(within(dialog).getByRole("combobox"));
    await expect(
      await screen.findByRole("option", { name: /acme\/payments-api/ }),
    ).toBeInTheDocument();
  },
};

/** The deployment has no Bitbucket OAuth consumer (real Settings copy). */
export const CodeBitbucketUnconfigured: Story = {
  name: "3 · Code · Bitbucket not configured",
  render: () => (
    <Code state={{ kind: "choose", bitbucket: { kind: "unconfigured" } }} />
  ),
};

/** The integrations status failed to load. */
export const CodeStatusError: Story = {
  name: "3 · Code · status unavailable",
  render: () => <Code state={{ kind: "status-error" }} />,
};

export const CodeCreated: Story = {
  name: "3 · Code · project created",
  render: () => (
    <Code
      state={{
        kind: "created",
        project: "Storefront",
        repository: "acme/storefront",
      }}
    />
  ),
};

// ─── Workspace projects (invited) ───────────────────────────────────────────

const workspaceProject = (
  id: string,
  name: string,
  provider: "github" | "bitbucket",
  fullName: string,
  threads: NonNullable<ProjectData["viewerAccess"]>["threads"],
) =>
  ({
    id: `prj_00000000-0000-4000-8000-0000000000${id}`,
    name,
    repository: {
      provider,
      bindingRevision: 1,
      fullName,
      webUrl: `https://${provider === "github" ? "github.com" : "bitbucket.org"}/${fullName}`,
    },
    viewerAccess: { canManage: false, threads },
  }) as unknown as ProjectData;

const WORKSPACE_PROJECTS = [
  workspaceProject("01", "Storefront", "github", "acme/storefront", {
    status: "available",
  }),
  workspaceProject("02", "Payments API", "bitbucket", "acme/payments-api", {
    status: "connect",
    provider: "bitbucket",
  }),
  workspaceProject("03", "Infra", "github", "acme/infra", {
    status: "no-repository-access",
    provider: "github",
  }),
];

function Projects({ selected }: { readonly selected?: string }) {
  return (
    <OnboardingFrame
      steps={INVITED_STEPS}
      current="Project"
      onBack={noop}
      onSkip={noop}
      footer={
        <Actions
          primary="Continue"
          primaryDisabled={selected === undefined}
          secondary="New project"
        />
      }
    >
      <ProjectsStep
        workspace={WORKSPACE.displayName}
        projects={WORKSPACE_PROJECTS}
        selected={selected}
        repositoryIcon={repositoryIcon}
      />
    </OnboardingFrame>
  );
}

/**
 * Invited, and the workspace has projects: pick one. A project the person
 * can't clone yet says why, as the composer's project picker does.
 */
export const InvitedProjects: Story = {
  name: "Invited · 3 · Pick a workspace project",
  render: () => <Projects selected={WORKSPACE_PROJECTS[0]?.id} />,
};

// ─── First thread ───────────────────────────────────────────────────────────

/**
 * The last step: pick a starter task, then Start a thread opens `/new` with
 * it and the project, so it lands in home's own composer (in the page on a
 * wide screen, the dialog on a phone). Home and its setup checklist are in
 * Features/Home (New account).
 */
function FirstThread({ project }: { readonly project?: string }) {
  const [task, setTask] = React.useState<string>();
  return (
    <OnboardingFrame
      steps={NEW_STEPS}
      current="First thread"
      onBack={noop}
      onSkip={noop}
      footer={
        <Actions primary="Start a thread" secondary="Take the tour first" />
      }
    >
      <FirstThreadStep
        project={project}
        starters={<StarterTasks picked={task} onPick={setTask} />}
      />
    </OnboardingFrame>
  );
}

export const FirstThreadTasks: Story = {
  name: "4 · First thread · starter tasks",
  render: () => <FirstThread project="Storefront" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const task = page.getByRole("button", { name: STARTER_TASKS[1] });
    await userEvent.click(task);
    await expect(task).toHaveAttribute("aria-pressed", "true");
  },
};

/** The home page's checklist card, as Features/Home shows it. */
export const Checklist: Story = {
  name: "5 · Home checklist card",
  parameters: { layout: "centered" },
  render: () => <SetupChecklist done={["model"]} />,
};

// ─── Phone ──────────────────────────────────────────────────────────────────

const phone = { globals: { viewport: { value: "phone" } } } as const;

export const PhoneWelcome: Story = {
  ...phone,
  ...Welcome,
  name: "Phone · 1 · Welcome",
};
export const PhoneJoin: Story = {
  ...phone,
  ...JoinWorkspace,
  name: "Phone · Invited · Join workspace",
};
export const PhoneModel: Story = {
  ...phone,
  ...ModelChoose,
  name: "Phone · 2 · Model",
};
export const PhoneModelClaude: Story = {
  ...phone,
  ...ModelClaude,
  name: "Phone · 2 · Model · Claude token",
};
export const PhoneCode: Story = {
  ...phone,
  ...CodeChoose,
  name: "Phone · 3 · Code",
};
export const PhoneProjects: Story = {
  ...phone,
  ...InvitedProjects,
  name: "Phone · Invited · Pick a project",
};
export const PhoneFirstThread: Story = {
  ...phone,
  render: () => <FirstThread project="Storefront" />,
  name: "Phone · 4 · First thread",
};

// ─── Whole flow ─────────────────────────────────────────────────────────────

type Step = "join" | "model" | "project" | "thread";

/** The invited flow, clickable end to end. */
function InvitedFlow() {
  const [step, setStep] = React.useState<Step>("join");
  const [join, setJoin] = React.useState<JoinState>({ kind: "ready" });
  const [project, setProject] = React.useState<string>();
  if (step === "join")
    return (
      <OnboardingFrame
        steps={INVITED_STEPS}
        current="Workspace"
        footer={
          join.kind === "joined" ? (
            <Actions primary="Continue" onPrimary={() => setStep("model")} />
          ) : (
            <Actions
              primary="Join workspace"
              onPrimary={() => setJoin({ kind: "joined" })}
            />
          )
        }
      >
        <JoinStep workspace={WORKSPACE} state={join} />
      </OnboardingFrame>
    );
  if (step === "model")
    return (
      <OnboardingFrame
        steps={INVITED_STEPS}
        current="Model"
        footer={
          <Actions
            primary="Continue"
            secondary="Connect my own"
            onPrimary={() => setStep("project")}
          />
        }
      >
        <ModelStep
          state={{ kind: "workspace", workspace: WORKSPACE.displayName }}
        />
      </OnboardingFrame>
    );
  if (step === "project")
    return (
      <OnboardingFrame
        steps={INVITED_STEPS}
        current="Project"
        footer={
          <Actions
            primary="Continue"
            primaryDisabled={project === undefined}
            onPrimary={() => setStep("thread")}
          />
        }
      >
        <ProjectsStep
          workspace={WORKSPACE.displayName}
          projects={WORKSPACE_PROJECTS}
          selected={project}
          repositoryIcon={repositoryIcon}
          onSelect={setProject}
        />
      </OnboardingFrame>
    );
  return (
    <OnboardingFrame steps={INVITED_STEPS} current="First thread">
      <FirstThreadStep
        project={WORKSPACE_PROJECTS.find(({ id }) => id === project)?.name}
        starters={<StarterTasks />}
      />
    </OnboardingFrame>
  );
}

/**
 * Invited, end to end: join, skip Model because the workspace provides
 * models, pick an existing project, then its first task.
 */
export const InvitedFlowInteractive: Story = {
  name: "0 · Invited flow (interactive)",
  render: () => <InvitedFlow />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(page.getByRole("button", { name: "Join workspace" }));
    await expect(page.getByText("Joined")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(
      page.getByRole("heading", { name: "Acme Engineering provides models" }),
    ).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(page.getByRole("button", { name: /Infra/ })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: /Storefront/ }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(
      page.getByText("Start small in Storefront", { exact: false }),
    ).toBeVisible();
  },
};
