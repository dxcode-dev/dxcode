import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import type { GitHubGrantData, SettingsContextData } from "@dx/api";
import {
  canonicalPublicGitRepositoryLocator,
  isValidProjectName,
  normalizeProjectName,
  type ProviderRepositoryId,
} from "@dx/domain";
import {
  Building2,
  Check,
  ChevronDown,
  FolderGit,
  FolderGit2,
  Plus,
  Search,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import type { BitbucketRepository } from "../settings/integrations/bitbucket-queries.js";

export type ProjectOwner = "workspace" | "personal";
export type ProjectSource =
  | { readonly kind: "scratch" }
  | { readonly kind: "public-git-url"; readonly url: string }
  | {
      readonly kind: "repository";
      readonly provider: "github" | "bitbucket";
      readonly workspaceId?: string;
      readonly grantId: string;
      readonly providerRepositoryId: ProviderRepositoryId;
    };

export interface NewProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly owner: ProjectOwner;
  readonly source: ProjectSource;
}

interface RepositoryOption {
  readonly value: string;
  readonly label: string;
  readonly provider: "github" | "bitbucket";
  readonly grantId: string;
  readonly workspaceId?: string;
  readonly repositoryId: string;
  readonly fullName: string;
}

const isBitbucketUuid = (value: string) =>
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i.test(
    value,
  );

function RepositoryCombobox({
  options,
  value,
  loading,
  onValueChange,
}: {
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly value?: RepositoryOption;
  readonly loading?: string;
  readonly onValueChange: (value: string) => void;
}) {
  return (
    <Combobox.Root
      items={options}
      value={value ?? null}
      onValueChange={(option) => onValueChange(option?.value ?? "")}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      autoHighlight
    >
      <Combobox.InputGroup className="repository-combobox-control">
        <Search aria-hidden="true" />
        <Combobox.Input
          id="project-repository"
          placeholder="Search repositories"
          autoComplete="off"
          aria-busy={loading !== undefined}
        />
        <Combobox.Trigger aria-label="Open repository list">
          <ChevronDown aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          className="repository-combobox-positioner"
          sideOffset={4}
          align="start"
        >
          <Combobox.Popup className="repository-combobox-popup">
            <Combobox.Empty className="repository-combobox-empty">
              {loading ?? "No repositories found."}
            </Combobox.Empty>
            <Combobox.List className="repository-combobox-list">
              {(option) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="repository-combobox-item"
                >
                  <span>{option.label}</span>
                  <Combobox.ItemIndicator className="repository-combobox-indicator">
                    <Check aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function ProjectRepositoryField({
  owner,
  repositoryUrl,
  invalidRepositoryUrl,
  repositoryOptions,
  selectedRepository,
  repositoriesLoading,
  grantsError,
  onUrlChange,
  onValueChange,
  onReloadIntegrations,
}: {
  readonly owner: ProjectOwner;
  readonly repositoryUrl: string;
  readonly invalidRepositoryUrl: boolean;
  readonly repositoryOptions: ReadonlyArray<RepositoryOption>;
  readonly selectedRepository?: RepositoryOption;
  readonly repositoriesLoading?: string;
  readonly grantsError?: string;
  readonly onUrlChange: (value: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly onReloadIntegrations: () => void;
}) {
  return (
    <label className="project-repository-field" htmlFor="project-repository">
      <span>Repository</span>
      <Input
        id="project-repository-url"
        aria-label="Public Git repository URL"
        placeholder="https://git.example.com/owner/repository"
        value={repositoryUrl}
        onChange={(event) => onUrlChange(event.target.value)}
      />
      <small>
        Paste any public HTTPS Git repository URL. dx will clone it anonymously
        without a provider integration.
      </small>
      {invalidRepositoryUrl ? (
        <small className="form-error" role="alert">
          Enter a valid public HTTPS Git repository URL.
        </small>
      ) : null}
      {owner === "workspace" || repositoryOptions.length === 0 ? null : (
        <span>Or choose a connected repository</span>
      )}
      {owner === "workspace" ? null : (
        <RepositoryCombobox
          options={repositoryOptions}
          value={selectedRepository}
          loading={repositoriesLoading}
          onValueChange={onValueChange}
        />
      )}
      {owner === "personal" && repositoriesLoading !== undefined ? (
        <small role="status">{repositoriesLoading}</small>
      ) : null}
      {grantsError !== undefined ? (
        <small className="form-error">
          {grantsError}{" "}
          <button type="button" onClick={onReloadIntegrations}>
            Retry
          </button>
        </small>
      ) : repositoryOptions.length === 0 &&
        repositoriesLoading === undefined ? (
        <small>
          No connected repositories are available. A canonical URL still works
          when anonymous cloning is allowed by the provider.
        </small>
      ) : null}
    </label>
  );
}

export function NewProjectDialog({
  actionError,
  creating,
  open,
  initialOwner,
  grants,
  bitbucketConnectionId,
  bitbucketRepositories = [],
  grantsError,
  repositoriesLoading,
  personalName,
  workspace,
  onReloadIntegrations,
  onOpenChange,
  onCreate,
}: {
  readonly actionError?: string;
  readonly creating: boolean;
  readonly open: boolean;
  readonly initialOwner: ProjectOwner;
  readonly grants: ReadonlyArray<GitHubGrantData>;
  readonly bitbucketConnectionId?: string;
  readonly bitbucketRepositories?: ReadonlyArray<BitbucketRepository>;
  readonly grantsError?: string;
  readonly repositoriesLoading?: string;
  readonly personalName: string;
  readonly workspace?: SettingsContextData["workspace"];
  readonly onReloadIntegrations: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: NewProjectInput) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        className={`${buttonVariants({ size: "xs" })} projects-new-project-trigger`}
      >
        <Plus /> New Project
      </Dialog.Trigger>
      {open ? (
        <NewProjectForm
          key={`${initialOwner}:${open}`}
          actionError={actionError}
          creating={creating}
          initialOwner={initialOwner}
          grants={grants}
          bitbucketConnectionId={bitbucketConnectionId}
          bitbucketRepositories={bitbucketRepositories}
          grantsError={grantsError}
          repositoriesLoading={repositoriesLoading}
          personalName={personalName}
          workspace={workspace}
          onReloadIntegrations={onReloadIntegrations}
          onCreate={onCreate}
        />
      ) : null}
    </DialogRoot>
  );
}

function NewProjectForm({
  actionError,
  creating,
  initialOwner,
  grants,
  bitbucketConnectionId,
  bitbucketRepositories,
  grantsError,
  repositoriesLoading,
  personalName,
  workspace,
  onReloadIntegrations,
  onCreate,
}: {
  readonly actionError?: string;
  readonly creating: boolean;
  readonly initialOwner: ProjectOwner;
  readonly grants: ReadonlyArray<GitHubGrantData>;
  readonly bitbucketConnectionId?: string;
  readonly bitbucketRepositories: ReadonlyArray<BitbucketRepository>;
  readonly grantsError?: string;
  readonly repositoriesLoading?: string;
  readonly personalName: string;
  readonly workspace?: SettingsContextData["workspace"];
  readonly onReloadIntegrations: () => void;
  readonly onCreate: (input: NewProjectInput) => void;
}) {
  const [sourceKind, setSourceKind] = React.useState<
    "scratch" | "repository"
  >();
  const [repositoryKey, setRepositoryKey] = React.useState("");
  const [repositoryUrl, setRepositoryUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [showDescription, setShowDescription] = React.useState(false);
  const [owner, setOwner] = React.useState<ProjectOwner>(
    workspace === undefined ? "personal" : initialOwner,
  );
  const githubRepositories =
    owner === "workspace"
      ? []
      : grants.flatMap((grant) =>
          grant.ownerScope === "personal" &&
          grant.status === "active" &&
          grant.installationStatus === "active"
            ? grant.repositories.map((repository) => ({
                value: `github:${grant.id}:${repository.id}`,
                label: `GitHub · ${repository.fullName}`,
                provider: "github" as const,
                grantId: grant.id,
                repositoryId: repository.id,
                fullName: repository.fullName,
              }))
            : [],
        );
  const bitbucketOptions: ReadonlyArray<RepositoryOption> =
    owner === "personal" && bitbucketConnectionId !== undefined
      ? bitbucketRepositories.flatMap((repository) =>
          isBitbucketUuid(repository.id) &&
          isBitbucketUuid(repository.workspaceId)
            ? [
                {
                  value: `bitbucket:${bitbucketConnectionId}:${repository.id}`,
                  label: `Bitbucket · ${repository.fullName}`,
                  provider: "bitbucket" as const,
                  grantId: bitbucketConnectionId,
                  workspaceId: repository.workspaceId,
                  repositoryId: repository.id,
                  fullName: repository.fullName,
                },
              ]
            : [],
        )
      : [];
  const repositoryOptions: ReadonlyArray<RepositoryOption> = [
    ...githubRepositories,
    ...bitbucketOptions,
  ];
  const selectedRepository = repositoryOptions.find(
    (option) => option.value === repositoryKey,
  );
  const validName = isValidProjectName(name);
  const canonicalRepository =
    canonicalPublicGitRepositoryLocator(repositoryUrl);
  const invalidRepositoryUrl =
    repositoryUrl.trim() !== "" && canonicalRepository === undefined;
  const chooseRepository = (value: string) => {
    setRepositoryKey(value);
    if (value !== "") setRepositoryUrl("");
    const selected = repositoryOptions.find((option) => option.value === value);
    if (selected !== undefined && name.length === 0)
      setName(selected.fullName.split("/").at(-1) ?? selected.fullName);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedName = normalizeProjectName(name);
    if (
      sourceKind === undefined ||
      !isValidProjectName(normalizedName) ||
      (sourceKind === "repository" &&
        selectedRepository === undefined &&
        canonicalRepository === undefined)
    )
      return;
    const source: ProjectSource =
      sourceKind === "scratch"
        ? { kind: "scratch" }
        : selectedRepository === undefined
          ? {
              kind: "public-git-url",
              url: canonicalRepository?.webUrl ?? "",
            }
          : {
              kind: "repository",
              provider: selectedRepository.provider,
              grantId: selectedRepository.grantId,
              ...(selectedRepository.workspaceId === undefined
                ? {}
                : { workspaceId: selectedRepository.workspaceId }),
              providerRepositoryId:
                selectedRepository.repositoryId as ProviderRepositoryId,
            };
    onCreate({
      name: normalizedName,
      ...(description.trim() === "" ? {} : { description: description.trim() }),
      owner,
      source,
    });
  };
  return (
    <DialogContent className="new-project-dialog">
      <DialogTitle>New Project</DialogTitle>
      <DialogDescription className="visually-hidden">
        Choose a project source, owner, and project details.
      </DialogDescription>
      <form onSubmit={submit} className="dialog-form">
        <fieldset className="project-source-fieldset">
          <legend>Git Repository</legend>
          <div className="project-source-options">
            <button
              className={`project-source-option ${sourceKind === "scratch" ? "selected" : ""}`}
              type="button"
              aria-pressed={sourceKind === "scratch"}
              onClick={() => setSourceKind("scratch")}
            >
              <FolderGit />
              <span>
                <strong>Start From Scratch</strong>
                <small>A blank repository managed by dx</small>
              </span>
            </button>
            <button
              className={`project-source-option ${sourceKind === "repository" ? "selected" : ""}`}
              type="button"
              aria-pressed={sourceKind === "repository"}
              onClick={() => setSourceKind("repository")}
            >
              <FolderGit2 />
              <span>
                <strong>Use an Existing Repository</strong>
                <small>Connect code from GitHub or another remote</small>
              </span>
            </button>
          </div>
        </fieldset>
        {sourceKind === undefined ? null : (
          <div className="new-project-details">
            {sourceKind === "repository" ? (
              <ProjectRepositoryField
                owner={owner}
                repositoryUrl={repositoryUrl}
                invalidRepositoryUrl={invalidRepositoryUrl}
                repositoryOptions={repositoryOptions}
                selectedRepository={selectedRepository}
                repositoriesLoading={repositoriesLoading}
                grantsError={grantsError}
                onUrlChange={(value) => {
                  setRepositoryUrl(value);
                  if (value !== "") setRepositoryKey("");
                }}
                onValueChange={chooseRepository}
                onReloadIntegrations={onReloadIntegrations}
              />
            ) : null}
            <label className="project-name-field" htmlFor="project-name">
              Project Name
              <Input
                id="project-name"
                autoFocus
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset className="project-owner-fieldset">
              <legend>Owner</legend>
              <div className="project-owner-options">
                {workspace !== undefined ? (
                  <label className={owner === "workspace" ? "selected" : ""}>
                    <span className="owner-mark">
                      <Building2 />
                    </span>
                    <span className="project-owner-copy">
                      <strong>Workspace</strong>
                      <small>{workspace.displayName}</small>
                    </span>
                    <input
                      type="radio"
                      name="project-owner"
                      checked={owner === "workspace"}
                      onChange={() => {
                        setOwner("workspace");
                        setRepositoryKey("");
                      }}
                    />
                  </label>
                ) : null}
                <label className={owner === "personal" ? "selected" : ""}>
                  <span className="owner-mark personal">
                    <UserRound />
                  </span>
                  <span className="project-owner-copy">
                    <strong>Private</strong>
                    <small>{personalName}</small>
                  </span>
                  <input
                    type="radio"
                    name="project-owner"
                    checked={owner === "personal"}
                    onChange={() => {
                      setOwner("personal");
                      setRepositoryKey("");
                    }}
                  />
                </label>
              </div>
            </fieldset>
            {showDescription ? (
              <label htmlFor="project-description">
                Description
                <textarea
                  id="project-description"
                  maxLength={500}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setShowDescription(true)}
              >
                <Plus /> Add Description
              </Button>
            )}
          </div>
        )}
        {actionError === undefined ? null : (
          <div className="notice error-notice">{actionError}</div>
        )}
        <div className="dialog-actions">
          <Dialog.Close
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Cancel
          </Dialog.Close>
          <Button
            type="submit"
            size="sm"
            disabled={
              creating ||
              sourceKind === undefined ||
              !validName ||
              (sourceKind === "repository" &&
                selectedRepository === undefined &&
                canonicalRepository === undefined)
            }
          >
            {creating ? "Creating…" : "Create Project"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
