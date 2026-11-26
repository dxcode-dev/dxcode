import type { ProjectData } from "@dx/api";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FolderGit2,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  UsersRound,
} from "lucide-react";
import type * as React from "react";
import { DxMark } from "../../shared/brand/dx-mark.js";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { Card } from "../../shared/ui/card.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { GitHubIcon } from "../../shared/ui/github-icon.js";
import { NEW_STEPS } from "./onboarding-steps.js";
import "./onboarding.css";

/**
 * New-person onboarding, proposed: the setup steps before the first thread.
 * Copy states only what dx does today; each claim cites its source in the
 * stories. Connecting a model or code opens the real Settings dialogs.
 */

/** The page around every onboarding step: wordmark, progress, Skip, actions. */
export function OnboardingFrame({
  steps,
  current,
  onBack,
  onSkip,
  footer,
  children,
}: {
  /** The progress bar's labels; omit for no bar. */
  readonly steps?: ReadonlyArray<string>;
  readonly current?: string;
  readonly onBack?: () => void;
  readonly onSkip?: () => void;
  readonly footer?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const index = current === undefined ? -1 : (steps?.indexOf(current) ?? -1);
  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <div className="onboarding-header-start">
          {onBack ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <DxWordmark size="small" />
        </div>
        {steps === undefined ? null : (
          <nav aria-label="Setup progress">
            <ol
              className="onboarding-progress"
              style={{ "--steps": steps.length } as React.CSSProperties}
            >
              {steps.map((name, i) => (
                <li
                  key={name}
                  data-state={
                    i < index ? "done" : i === index ? "current" : "todo"
                  }
                  aria-current={i === index ? "step" : undefined}
                >
                  <span className="onboarding-progress-bar" />
                  <span className="onboarding-progress-label">{name}</span>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="onboarding-header-end">
          {onSkip ? (
            <Button variant="subtle" size="sm" onClick={onSkip}>
              Skip setup
            </Button>
          ) : null}
        </div>
      </header>
      <main className="onboarding-main">
        <div className="onboarding-step">{children}</div>
      </main>
      {footer ? <footer className="onboarding-footer">{footer}</footer> : null}
    </div>
  );
}

function StepHeading({
  title,
  description,
}: {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
}) {
  return (
    <div className="onboarding-heading">
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

/** A choice drawn as a card: icon, name, one line, and an optional badge. */
function OptionCard({
  icon,
  title,
  detail,
  badge,
  selected,
  disabledReason,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: React.ReactNode;
  readonly badge?: string;
  readonly selected?: boolean;
  /** Shown instead of the detail when the option can't be used. */
  readonly disabledReason?: string;
  readonly onClick?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="dx-card onboarding-option"
        data-variant="outline"
        data-interactive={disabledReason === undefined ? "" : undefined}
        aria-pressed={selected}
        disabled={disabledReason !== undefined}
        onClick={onClick}
      >
        <span className="onboarding-option-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="onboarding-option-text">
          <span className="onboarding-option-title">
            {title}
            {badge ? <Badge tone="info">{badge}</Badge> : null}
          </span>
          <span className="onboarding-option-detail">
            {disabledReason ?? detail}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One line of result under a step: done, working, or failed. */
function StatusLine({
  tone,
  action,
  children,
}: {
  readonly tone: "success" | "pending" | "error";
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="onboarding-status"
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      <span aria-hidden="true">
        {tone === "success" ? (
          <Check />
        ) : tone === "pending" ? (
          <LoaderCircle className="onboarding-spin" />
        ) : (
          <CircleAlert />
        )}
      </span>
      <span>{children}</span>
      {action}
    </div>
  );
}

// ─── Welcome ────────────────────────────────────────────────────────────────

export function WelcomeStep({
  name,
  steps = NEW_STEPS.length,
  still,
}: {
  readonly name: string;
  /** How many setup steps follow. */
  readonly steps?: number;
  /** Draws the mark still, as for reduced motion and tests. */
  readonly still?: boolean;
}) {
  return (
    <div className="onboarding-welcome">
      <DxMark state="idle" still={still} className="onboarding-welcome-mark" />
      <StepHeading
        title={`Welcome to dx, ${name}`}
        description="Give a coding agent a task. It works on its own cloud computer, an Orb, and you review the result."
      />
      <p className="onboarding-fine">
        {steps} steps, about two minutes. Change anything later in Settings.
      </p>
    </div>
  );
}

// ─── Workspace invite ───────────────────────────────────────────────────────

export interface InvitedWorkspace {
  readonly displayName: string;
  readonly shortName: string;
}

export type JoinState =
  | { readonly kind: "ready" }
  | { readonly kind: "joining" }
  | { readonly kind: "joined" }
  /** `POST /v1/invites/:token/accept` refused, with its message. */
  | { readonly kind: "error"; readonly message: string }
  /** The link is expired, revoked, used up, or not valid. */
  | { readonly kind: "unavailable"; readonly message: string };

/** The workspace an invite opens, shown first and prominently. */
function WorkspaceCard({
  workspace,
  joined,
}: {
  readonly workspace: InvitedWorkspace;
  readonly joined?: boolean;
}) {
  return (
    <Card variant="raised" padding="md" className="onboarding-workspace">
      <Avatar
        name={workspace.displayName}
        seed={workspace.shortName}
        className="onboarding-workspace-avatar"
      />
      <span className="onboarding-workspace-text">
        <span className="onboarding-workspace-name">
          {workspace.displayName}
        </span>
        <span className="onboarding-workspace-handle">
          <UsersRound aria-hidden="true" /> Workspace
        </span>
      </span>
      {joined ? <Badge tone="success">Joined</Badge> : null}
    </Card>
  );
}

export function JoinStep({
  workspace,
  state,
}: {
  readonly workspace: InvitedWorkspace;
  readonly state: JoinState;
}) {
  if (state.kind === "unavailable")
    return (
      <StepHeading title="Invite unavailable" description={state.message} />
    );
  return (
    <>
      <StepHeading
        title={
          state.kind === "joined"
            ? `You're in ${workspace.displayName}`
            : `Join ${workspace.displayName}`
        }
        description="You'll share its projects, secrets, and settings with the other members. Your personal threads and settings stay yours."
      />
      <WorkspaceCard workspace={workspace} joined={state.kind === "joined"} />
      {state.kind === "error" ? (
        <StatusLine tone="error">{state.message}</StatusLine>
      ) : null}
    </>
  );
}

// ─── Model ──────────────────────────────────────────────────────────────────

export type ModelPick = "claude" | "copilot" | "api-key";

export type ModelStepState =
  | { readonly kind: "choose"; readonly picked?: ModelPick }
  | { readonly kind: "connected"; readonly connection: string }
  /** The person's workspace connected a model for its members. */
  | { readonly kind: "workspace"; readonly workspace: string }
  /** The deployment serves models itself ("Included with dx"). */
  | { readonly kind: "included" };

export function ModelStep({
  state,
  showCopilot = true,
  onPick,
}: {
  readonly state: ModelStepState;
  /** GitHub Copilot connects in personal settings only. */
  readonly showCopilot?: boolean;
  readonly onPick?: (pick: ModelPick) => void;
}) {
  if (state.kind === "workspace")
    return (
      <>
        <StepHeading
          title={`${state.workspace} provides models`}
          description="Your threads can use the workspace's models now. Connect your own anytime; yours are tried first."
        />
        <StatusLine tone="success">Nothing to set up.</StatusLine>
      </>
    );
  if (state.kind === "included")
    return (
      <>
        <StepHeading
          title="Models are included"
          description="This dx serves models itself, so threads work now. Connect your own plan or key anytime in Settings."
        />
        <StatusLine tone="success">Nothing to set up.</StatusLine>
      </>
    );
  const picked = state.kind === "choose" ? state.picked : undefined;
  return (
    <>
      <StepHeading
        title="Connect a model"
        description="Threads run on a model you connect. dx adds no fees or limits on your own plan or keys."
      />
      <ul className="onboarding-options">
        <OptionCard
          icon={<ClaudeIcon />}
          title="Claude Pro or Max"
          detail={
            <>
              Run <code>claude setup-token</code>, paste the token. For Claude
              Code threads.
            </>
          }
          badge="Most popular"
          selected={picked === "claude"}
          onClick={() => onPick?.("claude")}
        />
        {showCopilot ? (
          <OptionCard
            icon={<GitHubIcon />}
            title="GitHub Copilot"
            detail="Sign in with a code from GitHub."
            selected={picked === "copilot"}
            onClick={() => onPick?.("copilot")}
          />
        ) : null}
        <OptionCard
          icon={<KeyRound />}
          title="API key"
          detail="Anthropic, OpenAI, Google AI Studio, OpenRouter, and more."
          selected={picked === "api-key"}
          onClick={() => onPick?.("api-key")}
        />
      </ul>
      {state.kind === "connected" ? (
        <StatusLine tone="success">{state.connection} connected.</StatusLine>
      ) : null}
    </>
  );
}

// ─── Code ───────────────────────────────────────────────────────────────────

export type CodePick = "github" | "bitbucket" | "scratch";

/** One source-control provider as Settings → Integrations reports it. */
export type ProviderStatus =
  | { readonly kind: "available" }
  | { readonly kind: "connected"; readonly account: string }
  /** The deployment has no GitHub App or Bitbucket OAuth consumer. */
  | { readonly kind: "unconfigured" };

export type CodeStepState =
  | {
      readonly kind: "choose";
      readonly picked?: CodePick;
      readonly github?: ProviderStatus;
      readonly bitbucket?: ProviderStatus;
      /** Connecting opened in another tab; this page refreshes on return. */
      readonly waiting?: "github" | "bitbucket";
    }
  | { readonly kind: "status-error"; readonly onRetry?: () => void }
  | {
      readonly kind: "created";
      readonly project: string;
      readonly repository?: string;
    };

const providerDetail = (
  status: ProviderStatus | undefined,
  available: string,
) =>
  status?.kind === "connected" ? `Connected as ${status.account}.` : available;

export function CodeStep({
  state,
  repositoryIcon,
  onPick,
}: {
  readonly state: CodeStepState;
  /** Draws a provider's mark, as the Projects page draws it. */
  readonly repositoryIcon: (
    provider: "github" | "bitbucket",
  ) => React.ReactNode;
  readonly onPick?: (pick: CodePick) => void;
}) {
  if (state.kind === "created")
    return (
      <>
        <StepHeading title={`${state.project} is ready`} />
        <StatusLine tone="success">
          {state.repository === undefined
            ? "Every Orb for this project starts with an empty repository."
            : `Every Orb for this project starts with a clone of ${state.repository}.`}
        </StatusLine>
      </>
    );
  const choose = state.kind === "choose" ? state : undefined;
  return (
    <>
      <StepHeading
        title="Connect your code"
        description="Each thread's Orb starts with a clone of your repository."
      />
      {state.kind === "status-error" ? (
        <StatusLine
          tone="error"
          action={
            <Button variant="outline" size="xs" onClick={state.onRetry}>
              Retry
            </Button>
          }
        >
          Connection status is unavailable.
        </StatusLine>
      ) : null}
      <ul className="onboarding-options">
        <OptionCard
          icon={repositoryIcon("github")}
          title="GitHub"
          detail={providerDetail(
            choose?.github,
            "Use your GitHub repositories.",
          )}
          badge={choose?.github?.kind === "connected" ? "Connected" : undefined}
          selected={choose?.picked === "github"}
          disabledReason={
            choose?.github?.kind === "unconfigured"
              ? "Not configured on this deployment."
              : undefined
          }
          onClick={() => onPick?.("github")}
        />
        <OptionCard
          icon={repositoryIcon("bitbucket")}
          title="Bitbucket"
          detail={providerDetail(
            choose?.bitbucket,
            "Use your Bitbucket repositories.",
          )}
          badge={
            choose?.bitbucket?.kind === "connected" ? "Connected" : undefined
          }
          selected={choose?.picked === "bitbucket"}
          disabledReason={
            choose?.bitbucket?.kind === "unconfigured"
              ? "Not configured on this deployment."
              : undefined
          }
          onClick={() => onPick?.("bitbucket")}
        />
        <OptionCard
          icon={<FolderPlus />}
          title="Start from scratch"
          detail="A blank repository managed by dx."
          selected={choose?.picked === "scratch"}
          onClick={() => onPick?.("scratch")}
        />
      </ul>
      {choose?.waiting === undefined ? null : (
        <StatusLine tone="pending">
          Finish connecting{" "}
          {choose.waiting === "github" ? "GitHub" : "Bitbucket"} in the new tab,
          then come back here.
        </StatusLine>
      )}
      <p className="onboarding-fine">
        Public repository? Paste its URL when you create the project.
      </p>
    </>
  );
}

// ─── Thread view ────────────────────────────────────────────────────────────

/**
 * Detailed or Simple threads, before the first one: someone who never reads
 * commands picks Simple; Settings → Appearance changes it later.
 */
export function ThreadViewStep({
  picker,
}: {
  /** The choice itself: `ThreadViewPicker`, which saves as it changes. */
  readonly picker: React.ReactNode;
}) {
  return (
    <>
      <StepHeading
        title="How much of the agent's work do you want to see?"
        description="You can change this any time in Settings, under Appearance."
      />
      {picker}
    </>
  );
}

// ─── First thread ───────────────────────────────────────────────────────────

/** The last setup step: pick a starter task, then open the composer. */
export function FirstThreadStep({
  project,
  starters,
}: {
  /** The project the thread starts in, when one is chosen. */
  readonly project?: string;
  /** Starter tasks; picking one fills the composer. */
  readonly starters: React.ReactNode;
}) {
  return (
    <>
      <StepHeading
        title="Give your agent a first task"
        description={
          project === undefined
            ? "Start small so you can check the result in a few minutes."
            : `Start small in ${project} so you can check the result in a few minutes.`
        }
      />
      {starters}
    </>
  );
}

// ─── Workspace projects ─────────────────────────────────────────────────────

const PROVIDER_LABEL = { github: "GitHub", bitbucket: "Bitbucket" } as const;

/** An invited person picks one of the workspace's projects; nothing to create. */
export function ProjectsStep({
  workspace,
  projects,
  selected,
  repositoryIcon,
  onSelect,
}: {
  readonly workspace: string;
  /** Draws a repository provider's mark, as the Projects page draws it. */
  readonly repositoryIcon: (
    provider: NonNullable<ProjectData["repository"]>["provider"],
  ) => React.ReactNode;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly selected?: string;
  readonly onSelect?: (projectId: string) => void;
}) {
  return (
    <>
      <StepHeading
        title="Pick a project"
        description={`${workspace} already has projects. Start in one; nothing to create.`}
      />
      <ul className="onboarding-repos" aria-label="Workspace projects">
        {projects.map((project) => {
          const threads = project.viewerAccess?.threads;
          const ready = threads === undefined || threads.status === "available";
          const repository = project.repository;
          return (
            <li key={project.id}>
              <button
                type="button"
                className="onboarding-repo onboarding-project"
                aria-pressed={selected === project.id}
                disabled={!ready}
                onClick={() => onSelect?.(project.id)}
              >
                {repository === undefined ? (
                  <FolderGit2 aria-hidden="true" />
                ) : (
                  repositoryIcon(repository.provider)
                )}
                <span className="onboarding-repo-name">
                  {project.name}
                  {repository === undefined ? null : (
                    <span className="onboarding-repo-owner">
                      {" "}
                      {repository.fullName}
                    </span>
                  )}
                </span>
                {ready ? (
                  selected === project.id ? (
                    <Check
                      className="onboarding-repo-check"
                      aria-hidden="true"
                    />
                  ) : (
                    <span />
                  )
                ) : (
                  <span className="onboarding-repo-updated">
                    {threads.status === "connect"
                      ? `Connect ${PROVIDER_LABEL[threads.provider]}`
                      : `No ${PROVIDER_LABEL[threads.provider]} access`}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="onboarding-fine">
        Threads clone through your own GitHub or Bitbucket connection.
      </p>
    </>
  );
}
