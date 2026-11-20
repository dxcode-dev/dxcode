import type { SkillImportBundle, WorkspaceSlug } from "@dx/domain";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { settle } from "../../../shared/settle.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { Tab, Tabs, TabsList, TabsPanel } from "../../../shared/ui/tabs.js";
import { AskDxPrompt } from "../ask-dx-prompt.js";
import { MemberPolicyToggle } from "../member-policy-toggle.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../settings-primitives.js";
import {
  type SettingsSectionProps,
  settingsPath,
} from "../settings-registration.js";
import { SkillBrowser } from "./skill-browser.js";
import {
  SkillFormDialog,
  SkillImportDialog,
  SkillProposalDialog,
  SkillReviewDialog,
} from "./skill-dialogs.js";
import {
  GitHubSkillDialog,
  type InstallTarget,
  SkillDiscover,
} from "./skill-discover.js";
import "./skills.css";
import {
  skillErrorMessage as errorMessage,
  type SkillDraft,
  type SkillPreview,
  type SkillSaveFailure,
  type SkillsMutationAction,
  type SkillToggle,
  skillAuthorMutationOptions,
  skillErrorField,
  skillFileSaveMutationOptions,
  skillPreviewMutationOptions,
  skillsMutationOptions,
  skillToggleMutationKey,
  skillToggleMutationOptions,
} from "./skills-mutations.js";
import {
  type SkillData,
  type SkillInstallSource,
  type SkillProposalData,
  type SkillsTarget,
  skillsQueryOptions,
} from "./skills-queries.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's text, decoded strictly: a file that is not UTF-8 text, such as an
 * image, is refused here, by name, instead of reaching dx as replacement
 * characters.
 */
const textOf = async (file: File, path: string) => {
  try {
    return utf8.decode(await file.arrayBuffer());
  } catch {
    throw new Error(
      `${path}: Only valid UTF-8 text without NUL bytes is allowed.`,
    );
  }
};

const filesBundle = async (selected: FileList): Promise<SkillImportBundle> => {
  if (selected.length === 1) {
    const file = selected[0];
    if (file?.name.endsWith(".skill.json")) {
      const exported = JSON.parse(await file.text()) as {
        readonly source?: SkillImportBundle["source"];
        readonly files?: SkillImportBundle["files"];
      };
      if (exported.source && exported.files) {
        return { source: exported.source, files: exported.files };
      }
    }
  }
  // Hidden files, such as .DS_Store or .gitignore, are never skill files.
  const visible = Array.from(selected).filter(
    (file) =>
      !(file.webkitRelativePath || file.name)
        .split("/")
        .some((segment) => segment.startsWith(".")),
  );
  const files = await Promise.all(
    visible.map(async (file) => {
      const relative = file.webkitRelativePath || file.name;
      const segments = relative.split("/");
      const suppliedPath =
        segments.length > 1 ? segments.slice(1).join("/") : relative;
      const path =
        suppliedPath === "manifest.json" ? "skill.json" : suppliedPath;
      return {
        path,
        kind: "file" as const,
        mediaType: file.type,
        encoding: "utf-8" as const,
        content: await textOf(file, path),
      };
    }),
  );
  return {
    source: { type: "browser-files", label: "Browser file selection" },
    files,
  } as SkillImportBundle;
};

/** Pending keys, so only the control that is saving shows it. */
const POLICY_KEY = "policy";

type OpenDialog =
  | { readonly kind: "new" }
  | { readonly kind: "import" }
  | { readonly kind: "github" }
  | { readonly kind: "proposal"; readonly proposalId: string }
  | {
      readonly kind: "review";
      readonly preview: SkillPreview;
      readonly bundle: SkillImportBundle;
    };

const otherScopeLink = (
  scope: SkillsTarget["scope"],
  workspace: SettingsSectionProps["workspace"],
) =>
  scope === "workspace"
    ? {
        label: "Personal Skills",
        to: settingsPath({ scope: "personal", section: "skills" }),
      }
    : workspace === undefined
      ? undefined
      : {
          label: "Workspace Skills",
          to: settingsPath({
            scope: "workspace",
            workspaceSlug: workspace.shortName as WorkspaceSlug,
            section: "skills",
          }),
        };

function SkillsHeading({
  scope,
  canMutate,
  busy,
  status,
  otherScope,
  settingsReturnTo,
  onBrowse,
  onFromGitHub,
  onUpload,
  onNew,
}: {
  readonly scope: SkillsTarget["scope"];
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly status?: string;
  readonly otherScope?: { readonly label: string; readonly to: string };
  readonly settingsReturnTo?: string;
  readonly onBrowse: () => void;
  readonly onFromGitHub: () => void;
  readonly onUpload: () => void;
  readonly onNew: () => void;
}) {
  return (
    <SettingsHeading
      title="Skills"
      detail={scope === "workspace" ? "Workspace" : "Personal"}
      actions={
        <div className="skills-heading-actions">
          <span aria-live="polite">{status}</span>
          {otherScope === undefined ? null : (
            <Link
              to={otherScope.to}
              replace
              state={settingsNavigationState(settingsReturnTo)}
              className={buttonVariants({ size: "sm", variant: "ghost" })}
            >
              {otherScope.label}
            </Link>
          )}
          {canMutate ? (
            <MenuRoot>
              <MenuTrigger render={<Button size="sm" disabled={busy} />}>
                <Plus aria-hidden="true" /> Add skill
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={onBrowse}>Browse skills.sh</MenuItem>
                <MenuItem onClick={onFromGitHub}>From a GitHub URL</MenuItem>
                <MenuItem onClick={onUpload}>Upload a folder</MenuItem>
                <MenuItem onClick={onNew}>Write a new skill</MenuItem>
              </MenuPopup>
            </MenuRoot>
          ) : null}
        </div>
      }
      description={
        scope === "workspace" ? (
          <>
            Skills teach dx a workflow in every Thread that members of this
            workspace start, in dx and Claude Code mode. A member's personal
            skill with the same name replaces a workspace skill.{" "}
            {canMutate
              ? "New Threads load the active version of each skill that is on; running Threads keep theirs."
              : "Only workspace admins can change them."}
          </>
        ) : (
          <>
            Skills teach dx a workflow in every Thread you start, in dx and
            Claude Code mode. New Threads load the ones that are on; running
            Threads keep theirs. Ask dx in any Thread to write, import, or
            update one.
          </>
        )
      }
    />
  );
}

/** Skill changes dx proposed for this scope, each waiting for a decision. */
function SkillProposals({
  proposals,
  skills,
  onReview,
}: {
  readonly proposals: ReadonlyArray<SkillProposalData>;
  readonly skills: ReadonlyArray<SkillData>;
  readonly onReview: (
    proposal: SkillProposalData,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  return (
    <section className="skill-proposals" aria-label="Proposed by dx">
      <h3>Proposed by dx</h3>
      <SettingsCard>
        {proposals.map((proposal) => {
          const current = skills.find(({ name }) => name === proposal.name);
          return (
            <div key={proposal.id} className="skill-row">
              <div className="skill-row-copy">
                <div className="skill-row-title">
                  <strong>{proposal.name}</strong>
                  <span>
                    {current === undefined
                      ? "New skill"
                      : `Version ${Math.max(...current.versions) + 1}`}
                  </span>
                  <span>from {proposal.threadTitle ?? "a Thread"}</span>
                </div>
                <p>{proposal.note || proposal.manifest.description}</p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => onReview(proposal, event.currentTarget)}
              >
                Review
              </Button>
            </div>
          );
        })}
      </SettingsCard>
    </section>
  );
}

function PersonalSkillsPolicy({
  allowed,
  disabled,
  pending,
  onChange,
}: {
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onChange: (allowed: boolean) => Promise<boolean>;
}) {
  return (
    <SettingsCard>
      <SettingsRow
        title="Members can use personal skills"
        description="When off, only workspace skills load in members' Threads."
        control={
          <MemberPolicyToggle
            checked={allowed}
            disabled={disabled}
            pending={pending}
            label="Members can use personal skills"
            subject="personal skills"
            description="Members' next Threads follow the new policy."
            onConfirm={onChange}
          />
        }
      />
    </SettingsCard>
  );
}

/**
 * The page's saving actions: one runs at a time, under the key `pending`
 * names, and each reports its outcome through `report`.
 */
function useSkillActions(
  target: SkillsTarget,
  report: (message: string | undefined) => void,
) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    skillsMutationOptions(queryClient, identity.id, target),
  );
  const [pending, setPending] = React.useState<string>();
  const busy = pending !== undefined;
  const run = async (
    action: SkillsMutationAction,
    success: string,
    key?: string,
  ) => {
    if (busy) return false;
    setPending(key ?? action.type);
    report(undefined);
    const outcome = await settle(() => mutation.mutateAsync(action));
    report(outcome.ok ? success : errorMessage(outcome.error));
    setPending(undefined);
    mutation.reset();
    return outcome.ok;
  };
  return { run, pending, setPending, busy };
}

/**
 * Skill switches. Each saves on its own, so several can be in flight at
 * once, and each reports its outcome through `report`.
 */
function useSkillToggles(
  target: SkillsTarget,
  report: (message: string | undefined) => void,
) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    skillToggleMutationOptions(queryClient, identity.id, target),
  );
  const toggling = new Set(
    useMutationState({
      filters: {
        mutationKey: skillToggleMutationKey(identity.id, target),
        status: "pending",
      },
      select: (pending) => (pending.state.variables as SkillToggle).skill.id,
    }),
  );
  const toggle = async (skill: SkillData, enabled: boolean) => {
    report(undefined);
    const outcome = await settle(() =>
      mutation.mutateAsync({ skill, enabled }),
    );
    const turned = `${skill.name} ${enabled ? "on" : "off"}`;
    report(
      outcome.ok
        ? `${skill.name} turned ${enabled ? "on" : "off"}.`
        : `Could not turn ${turned}: ${errorMessage(outcome.error)}`,
    );
  };
  return { toggling, toggle };
}

/** Saves an edited skill file as the skill's next version. */
function useSkillFileSave(
  target: SkillsTarget,
  report: (message: string | undefined) => void,
) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    skillFileSaveMutationOptions(queryClient, identity.id, target),
  );
  return async (skill: SkillData, path: string, content: string) => {
    report(undefined);
    const outcome = await settle(() =>
      mutation.mutateAsync({ skill, path, content }),
    );
    mutation.reset();
    if (!outcome.ok) {
      report(`Could not save ${path}: ${errorMessage(outcome.error)}`);
      // The view keeps the draft open.
      throw outcome.error;
    }
    report(`${skill.name} version ${outcome.value.activeVersion} saved.`);
  };
}

/**
 * dx's skill proposals: the list, and the review dialog a Review button or a
 * review link (`?proposal=`) opens. A linked proposal stays closed once the
 * person closes it.
 */
function SkillProposalReview({
  proposals,
  skills,
  dialog,
  busy,
  pending,
  onReview,
  onDialogChange,
  onAction,
}: {
  readonly proposals: ReadonlyArray<SkillProposalData>;
  readonly skills: ReadonlyArray<SkillData>;
  readonly dialog: OpenDialog | undefined;
  readonly busy: boolean;
  readonly pending: string | undefined;
  readonly onReview: (
    proposal: SkillProposalData,
    trigger: HTMLButtonElement,
  ) => void;
  readonly onDialogChange: (dialog: OpenDialog | undefined) => void;
  readonly onAction: (
    action: SkillsMutationAction,
    success: string,
    key?: string,
  ) => Promise<boolean>;
}) {
  const requestedProposal = useRouterState({
    select: (routerState) =>
      new URLSearchParams(routerState.location.searchStr).get("proposal") ??
      undefined,
  });
  /** The linked proposal the person closed, so it stays closed. */
  const [dismissedProposal, setDismissedProposal] = React.useState<string>();
  const linked =
    requestedProposal !== undefined && requestedProposal !== dismissedProposal
      ? requestedProposal
      : undefined;
  const reviewing = proposals.find(
    ({ id }) =>
      id ===
      (dialog?.kind === "proposal"
        ? dialog.proposalId
        : dialog === undefined
          ? linked
          : undefined),
  );
  const closeProposal = () => {
    setDismissedProposal(requestedProposal);
    onDialogChange(undefined);
  };
  const decide = async (
    proposal: SkillProposalData,
    decision: "approve" | "reject",
  ) => {
    const done = await onAction(
      decision === "approve"
        ? {
            type: "approveProposal",
            proposalId: proposal.id,
            reviewedIntegrity: proposal.integrity,
          }
        : { type: "rejectProposal", proposalId: proposal.id },
      decision === "approve"
        ? `${proposal.name} saved. New Threads load it.`
        : `Rejected dx's proposal for ${proposal.name}.`,
      `proposal-${decision}`,
    );
    if (done) closeProposal();
  };
  return (
    <>
      {proposals.length === 0 ? null : (
        <SkillProposals
          proposals={proposals}
          skills={skills}
          onReview={onReview}
        />
      )}
      {reviewing === undefined ? null : (
        <SkillProposalDialog
          proposal={reviewing}
          current={skills.find(({ name }) => name === reviewing.name)}
          busy={busy}
          pending={
            pending === "proposal-approve"
              ? "approve"
              : pending === "proposal-reject"
                ? "reject"
                : undefined
          }
          onApprove={() => void decide(reviewing, "approve")}
          onReject={() => void decide(reviewing, "reject")}
          onClose={closeProposal}
        />
      )}
    </>
  );
}

/** The hidden pickers behind Upload a folder and a version upload. */
function SkillFileInputs({
  folderRef,
  exportInput,
  onSelect,
}: {
  readonly folderRef: React.RefCallback<HTMLInputElement>;
  readonly exportInput: React.RefObject<HTMLInputElement | null>;
  readonly onSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <input
        ref={folderRef}
        className="skill-file-input"
        type="file"
        aria-label="Select skill folder"
        multiple
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={onSelect}
      />
      <input
        ref={exportInput}
        className="skill-file-input"
        type="file"
        aria-label="Select exported skill"
        accept=".skill.json,application/json"
        onChange={onSelect}
      />
    </>
  );
}

/** Installed (the skill browser) and Discover (skills.sh), as two tabs. */
function SkillsTabs({
  tab,
  onTabChange,
  target,
  skills,
  canMutate,
  toggling,
  targets,
  opened,
  onOpen,
  onToggle,
  onRemove,
  onSaveFile,
  onFromGitHub,
}: {
  readonly tab: "installed" | "discover";
  readonly onTabChange: (tab: "installed" | "discover") => void;
  readonly target: SkillsTarget;
  /** Undefined until the list loads. */
  readonly skills: ReadonlyArray<SkillData> | undefined;
  readonly canMutate: boolean;
  readonly toggling: ReadonlySet<SkillData["id"]>;
  readonly targets: ReadonlyArray<InstallTarget>;
  readonly opened: SkillInstallSource | undefined;
  readonly onOpen: (source: SkillInstallSource | undefined) => void;
  readonly onToggle: (skill: SkillData, enabled: boolean) => void;
  readonly onRemove: (skill: SkillData) => Promise<boolean>;
  readonly onSaveFile: (
    skill: SkillData,
    path: string,
    content: string,
  ) => Promise<unknown>;
  readonly onFromGitHub: () => void;
}) {
  const [discoverVisited, setDiscoverVisited] = React.useState(
    tab === "discover",
  );
  if (tab === "discover" && !discoverVisited) setDiscoverVisited(true);
  return (
    <Tabs
      className="skills-tabs"
      value={tab}
      onValueChange={(value) => onTabChange(value as typeof tab)}
    >
      <TabsList>
        <Tab value="installed">
          Installed{" "}
          {skills === undefined ? null : <Badge>{skills.length}</Badge>}
        </Tab>
        <Tab value="discover">Discover</Tab>
      </TabsList>
      <TabsPanel value="installed">
        {skills === undefined ? null : (
          <SkillBrowser
            target={target}
            skills={skills}
            canMutate={canMutate}
            toggling={toggling}
            empty={
              <div className="settings-card-empty ask-dx-empty">
                <p>
                  {canMutate
                    ? `No ${target.scope} skills yet. Install one from skills.sh, upload a skill folder, or ask dx in any Thread:`
                    : `No ${target.scope} skills yet.`}
                </p>
                {canMutate ? (
                  <>
                    <AskDxPrompt
                      text={`Create a ${target.scope} skill for writing our release notes`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onTabChange("discover")}
                    >
                      Browse skills.sh
                    </Button>
                  </>
                ) : null}
              </div>
            }
            onToggle={onToggle}
            onRemove={onRemove}
            onSaveFile={onSaveFile}
          />
        )}
      </TabsPanel>
      <TabsPanel value="discover" keepMounted>
        {/* Mounted from the first visit on, so coming back keeps the search and the open skill without reading skills.sh again. */}
        {discoverVisited ? (
          <SkillDiscover
            target={target}
            installed={skills ?? []}
            targets={targets}
            opened={opened}
            onOpen={onOpen}
            onFromGitHub={onFromGitHub}
          />
        ) : null}
      </TabsPanel>
    </Tabs>
  );
}

/**
 * Where Discover can install: this page's scope first, then the other one
 * the person has. Installing to a scope they cannot change fails there.
 */
const installTargets = (
  target: SkillsTarget,
  workspace: SettingsSectionProps["workspace"],
  canMutate: boolean,
): ReadonlyArray<InstallTarget> => {
  const workspaceTarget =
    target.scope === "workspace"
      ? target
      : workspace === undefined
        ? undefined
        : {
            scope: "workspace" as const,
            workspaceSlug: workspace.shortName as WorkspaceSlug,
          };
  const personal = {
    target: { scope: "personal" as const },
    label: "Personal",
  };
  const shared =
    workspaceTarget === undefined
      ? undefined
      : {
          target: workspaceTarget,
          label: `Workspace · ${workspace?.displayName ?? workspaceTarget.workspaceSlug}`,
        };
  if (target.scope === "workspace")
    return [...(canMutate && shared !== undefined ? [shared] : []), personal];
  return shared === undefined ? [personal] : [personal, shared];
};

export function SkillsSettings({
  workspace,
  workspaceSlug,
  settingsReturnTo,
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target: SkillsTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const state = useQuery(skillsQueryOptions(identity.id, target));
  const authorMutation = useMutation(
    skillAuthorMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    skillPreviewMutationOptions(identity.id, target),
  );
  const [dialog, setDialog] = React.useState<OpenDialog>();
  const [tab, setTab] = React.useState<"installed" | "discover">("installed");
  /** The skills.sh or GitHub skill Discover shows, if any. */
  const [opened, setOpened] = React.useState<SkillInstallSource>();
  const [message, setMessage] = React.useState<string>();
  const { run, pending, setPending, busy } = useSkillActions(
    target,
    setMessage,
  );
  const folderInput = React.useRef<HTMLInputElement>(null);
  const exportInput = React.useRef<HTMLInputElement>(null);
  const finalFocus = React.useRef<HTMLElement | null>(null);

  const { toggling, toggle } = useSkillToggles(target, setMessage);
  const saveFile = useSkillFileSave(target, setMessage);
  const closeDialog = () => {
    setDialog(undefined);
    onDirtyChange(false);
  };
  const create = async (
    draft: SkillDraft,
  ): Promise<SkillSaveFailure | undefined> => {
    setPending("save");
    setMessage(undefined);
    const outcome = await settle(() => authorMutation.mutateAsync({ draft }));
    setPending(undefined);
    authorMutation.reset();
    if (!outcome.ok)
      return {
        message: errorMessage(outcome.error),
        field: skillErrorField(outcome.error),
      };
    setMessage(`${draft.name} published.`);
    closeDialog();
    return undefined;
  };
  const selectFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;
    setMessage(undefined);
    const outcome = await settle(async () => {
      const bundle = await filesBundle(files);
      const preview = await previewMutation.mutateAsync(bundle);
      setDialog({ kind: "review", preview, bundle });
    });
    if (!outcome.ok) setMessage(errorMessage(outcome.error));
    previewMutation.reset();
    event.target.value = "";
  };
  const confirmReview = async (
    review: Extract<OpenDialog, { kind: "review" }>,
  ) => {
    const done = await run(
      {
        type: "import",
        bundle: review.bundle,
        reviewedIntegrity: review.preview.integrity,
      },
      `${review.preview.manifest.name} imported. Switch it on to use it.`,
    );
    if (done) setDialog(undefined);
  };

  const data = state.data;
  const skills = data?.items ?? [];
  const canMutate = data?.canMutate ?? false;

  return (
    <div className="skills-page">
      <SkillsHeading
        scope={target.scope}
        canMutate={canMutate}
        busy={busy}
        status={
          state.isPending
            ? "Loading skills…"
            : state.error !== null
              ? errorMessage(state.error)
              : message
        }
        otherScope={otherScopeLink(target.scope, workspace)}
        settingsReturnTo={settingsReturnTo}
        onBrowse={() => {
          setOpened(undefined);
          setTab("discover");
        }}
        onFromGitHub={() => setDialog({ kind: "github" })}
        onUpload={() => setDialog({ kind: "import" })}
        onNew={() => setDialog({ kind: "new" })}
      />
      <SkillProposalReview
        proposals={data?.proposals ?? []}
        skills={skills}
        dialog={dialog}
        busy={busy}
        pending={pending}
        onReview={(proposal, trigger) => {
          finalFocus.current = trigger;
          setDialog({ kind: "proposal", proposalId: proposal.id });
        }}
        onDialogChange={setDialog}
        onAction={run}
      />
      <SkillsTabs
        tab={tab}
        onTabChange={setTab}
        target={target}
        skills={data === undefined ? undefined : skills}
        canMutate={canMutate}
        toggling={toggling}
        targets={installTargets(target, workspace, canMutate)}
        opened={opened}
        onOpen={setOpened}
        onToggle={(skill, enabled) => void toggle(skill, enabled)}
        onRemove={(skill) =>
          run(
            { type: "remove", skillId: skill.id },
            `${skill.name} removed.`,
            `remove:${skill.id}`,
          )
        }
        onSaveFile={saveFile}
        onFromGitHub={() => setDialog({ kind: "github" })}
      />
      {target.scope === "workspace" &&
      data?.allowPersonalSkills !== undefined ? (
        <PersonalSkillsPolicy
          allowed={data.allowPersonalSkills}
          disabled={!canMutate}
          pending={pending === POLICY_KEY}
          onChange={(value) =>
            run(
              { type: "updatePolicy", allowPersonalSkills: value },
              value
                ? "Members' personal skills load again."
                : "Members' personal skills are blocked.",
              POLICY_KEY,
            )
          }
        />
      ) : null}
      <SkillFileInputs
        folderRef={(node) => {
          folderInput.current = node;
        }}
        exportInput={exportInput}
        onSelect={(event) => void selectFiles(event)}
      />
      {dialog?.kind === "new" ? (
        <SkillFormDialog
          busy={busy}
          onDirtyChange={onDirtyChange}
          onSave={create}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <SkillImportDialog
          onChooseFolder={() => {
            setDialog(undefined);
            folderInput.current?.click();
          }}
          onChooseExport={() => {
            setDialog(undefined);
            exportInput.current?.click();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "github" ? (
        <GitHubSkillDialog
          onOpen={(source) => {
            setDialog(undefined);
            setOpened(source);
            setTab("discover");
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "review" ? (
        <SkillReviewDialog
          preview={dialog.preview}
          busy={busy}
          onCancel={() => setDialog(undefined)}
          onConfirm={() => void confirmReview(dialog)}
        />
      ) : null}
    </div>
  );
}
